import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import express from "express";
import { localConsole, eventually } from "../test-support/local-console.mjs";

test("platform-only access cannot enter chat; explicit scoped roles work and revocation blocks replay", { skip: process.env.HEDGELING_REQUIRE_AGENT_TEST_DATABASE !== "true" }, async (t) => {
  const fixture = await localConsole(process.env.TEST_DATABASE_URL);
  process.env.DATABASE_URL = fixture.database.options.connectionString;
  process.env.HEDGELING_AGENT_ENABLED = "true";
  process.env.HEDGELING_AGENT_PROVIDER = "fixture";
  process.env.HEDGELING_AUTH_MODE = "local";
  process.env.NODE_ENV = "test";
  const { default: router } = await import("../src/agent-runtime.js");
  const { pool } = await import("../src/db.js");
  // localConsole imports the database module for URL validation before this
  // isolated schema exists. No parent-process query has opened a client yet.
  pool.options.connectionString = fixture.database.options.connectionString;
  const { accessibleOrganizations, authorizationStamp } = await import("../src/workspace-actions.js");
  const user = (await fixture.request("/api/me")).body.auth.user;
  const { id: organizationId } = (await fixture.database.query("select id from organizations where slug='hedgeling-local'")).rows[0];
  const { id: projectId } = (await fixture.database.query("select id from projects where slug='hedgeling-local'")).rows[0];
  // This isolated harness injects trusted server identity, not a client-supplied
  // platform flag. The application's local-auth mode still rejects staff users.
  let auth = { principalType: "user", platformAdmin: true, user: { ...user, platformStaff: true } };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.auth = auth; next(); });
  app.use("/api/agent", router);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await pool.end(); await fixture.close(); });
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agent${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  await fixture.database.query("update role_assignments set revoked_at=now() where principal_id=$1", [user.id]);
  const controllerId = crypto.randomUUID();
  for (const flags of [{ platformAdmin: true, platformStaff: false }, { platformAdmin: false, platformStaff: true }]) {
    auth = { ...auth, platformAdmin: flags.platformAdmin, user: { ...user, platformStaff: flags.platformStaff } };
    const config = await request("/config");
    assert.equal(config.status, 200, JSON.stringify(config.body));
    const org = config.body.organizations.find((org) => org.id === organizationId);
    assert.ok(org.permissions.includes("organization.update"), "manual platform permissions remain available");
    assert.equal(org.chat.allowed, true, "the local plan permits chat; this is a separate role restriction");
    assert.equal(org.agentAccess.allowed, false);
    assert.match(org.agentAccess.message, /Platform-admin access alone/);
    const denied = await request("/runs", { organizationId, controllerId });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, "agent_organization_access_required");
    assert.equal((await accessibleOrganizations(auth)).some((org) => org.id === organizationId), true);
  }
  assert.equal((await fixture.database.query("select count(*)::int as n from agent_runs")).rows[0].n, 0);
  assert.equal((await fixture.database.query("select count(*)::int as n from agent_model_usage")).rows[0].n, 0);
  // Old conversations admitted through platform access must not replay or run.
  const old = (await fixture.database.query(`insert into agent_runs(user_id,organization_id,authorization_stamp)
    values($1,$2,$3) returning id`, [user.id, organizationId, await authorizationStamp(auth)])).rows[0];
  for (const [path, body] of [[`/runs/${old.id}`], [`/runs/${old.id}/messages`, { controllerId, text: "Show my projects" }]]) {
    const response = await request(path, body);
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "agent_organization_access_required");
  }
  // A project-only linguist role is enough; no owner or platform elevation is needed.
  await fixture.database.query(`insert into role_assignments(principal_type,principal_id,role_id,scope_type,scope_id)
    select 'user',$1,id,'project',$2 from roles where key='translator' and organization_id is null`, [user.id, projectId]);
  assert.equal((await request("/config")).body.organizations.find((org) => org.id === organizationId).agentAccess.allowed, true);
  const created = await request("/runs", { organizationId, controllerId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const runId = created.body.run.id;
  assert.equal((await request(`/runs/${runId}/messages`, { controllerId, text: "Show my projects" })).status, 200);
  const completed = await eventually(() => request(`/runs/${runId}`), (result) => result.body.run?.status === "awaiting_input");
  assert.ok(completed.body.events.some((event) => event.kind === "activity" && event.data.tool === "console_list_projects" && event.data.status === "complete"));
  const history = (await fixture.database.query("select model_history from agent_runs where id=$1", [runId])).rows[0].model_history;
  const projects = history.flatMap((item) => item.parts).find((part) => part.functionResponse)?.functionResponse.response.projects;
  assert.deepEqual(projects.map((project) => project.slug), ["hedgeling-local"]);
  await fixture.database.query("update role_assignments set revoked_at=now() where principal_id=$1", [user.id]);
  assert.equal((await request(`/runs/${runId}`)).status, 403, "platform access cannot bypass a revoked chat grant");
  assert.equal((await request(`/runs/${runId}/resume`, { controllerId })).status, 403);
});
