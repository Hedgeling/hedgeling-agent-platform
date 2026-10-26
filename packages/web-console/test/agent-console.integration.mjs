import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { localConsole, eventually } from "../test-support/local-console.mjs";

test("agent creates a hierarchy only through individually confirmed, scoped, idempotent proposals", { skip: process.env.HEDGELING_REQUIRE_AGENT_TEST_DATABASE !== "true" }, async (t) => {
  const app = await localConsole(process.env.TEST_DATABASE_URL);
  t.after(app.close);
  const { request, database } = app;
  const controllerId = crypto.randomUUID();
  let response = await request("/api/agent/runs", { controllerId });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const runId = response.body.run.id;
  response = await request(`/api/agent/runs/${runId}/messages`, { controllerId, text: "Set up demo workspace" });
  assert.equal(response.status, 200);
  const waitProposal = () => eventually(() => request(`/api/agent/runs/${runId}`), (r) => r.body.run?.status === "awaiting_confirmation");
  const initial = await waitProposal();
  assert.equal((await database.query("select count(*)::int as n from organizations where name='Demo organization'")).rows[0].n, 0);
  const first = initial.body.proposals[0];
  assert.ok(initial.body.events.some((event) => event.kind === "activity" && event.data.tool === "console_propose_organization" && event.data.status === "working"));
  assert.equal(initial.body.events.find((event) => event.kind === "proposal").data.uiTarget.action, "organization.create");
  const observerId = crypto.randomUUID();
  assert.equal((await request(`/api/agent/runs/${runId}/heartbeat`, { controllerId: observerId })).status, 409);
  assert.equal((await request(`/api/agent/proposals/${first.id}/confirm`, { controllerId: observerId, fingerprint: first.fingerprint })).status, 409);
  const observed = await fetch(`${app.origin}/api/agent/runs/${runId}/events?controllerId=${observerId}`, { headers: { cookie: app.cookie } });
  const reader = observed.body.getReader(); await reader.read(); await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await request(`/api/agent/runs/${runId}`)).body.run.status, "awaiting_confirmation");
  await request(`/api/agent/runs/${runId}/pause`, { controllerId });
  assert.equal((await request(`/api/agent/proposals/${first.id}/confirm`, { controllerId, fingerprint: first.fingerprint })).status, 409);
  assert.equal((await request(`/api/agent/runs/${runId}/resume`, { controllerId })).status, 200);
  assert.equal((await request(`/api/agent/proposals/${first.id}/confirm`, { controllerId, fingerprint: first.fingerprint }, { authorization: `Bearer ${app.token}` })).status, 403);
  const results = [];
  for (const name of ["organization.create", "business_unit.create", "project.create", "localization_job.create"]) {
    const snapshot = await waitProposal();
    const proposal = snapshot.body.proposals.find((p) => p.preview.action === name);
    assert.ok(proposal, JSON.stringify(snapshot.body));
    assert.equal((await request(`/api/agent/proposals/${proposal.id}/confirm`, { controllerId, fingerprint: "tampered" })).status, 409);
    const confirmed = await request(`/api/agent/proposals/${proposal.id}/confirm`, { controllerId, fingerprint: proposal.fingerprint });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const replay = await request(`/api/agent/proposals/${proposal.id}/confirm`, { controllerId, fingerprint: proposal.fingerprint });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replayed, true);
    assert.deepEqual(replay.body.result, confirmed.body.result);
    const result = confirmed.body.result;
    const resource = result.organization || result.businessUnit || result.project || result.job;
    assert.equal(result.uiTarget.action, name);
    assert.equal(result.uiTarget.resource.id, resource.id);
    assert.equal(result.uiTarget.resource.type, { "organization.create": "organization", "business_unit.create": "business_unit", "project.create": "project", "localization_job.create": "job" }[name]);
    results.push(result);
    assert.equal((await request(`/api/agent/runs/${runId}/continue`, { controllerId })).status, 200);
  }
  await eventually(() => request(`/api/agent/runs/${runId}`), (r) => r.body.run?.status === "awaiting_input");
  const organizationId = results[0].organization.id;
  assert.equal((await database.query("select count(*)::int as n from business_units where organization_id=$1", [organizationId])).rows[0].n, 1);
  assert.equal((await database.query("select count(*)::int as n from billing_accounts where organization_id=$1", [organizationId])).rows[0].n, 0);
  assert.equal((await database.query("select count(*)::int as n from service_accounts where organization_id=$1", [organizationId])).rows[0].n, 0);
  const jobs = (await database.query("select * from localization_jobs where project_id=$1", [results[2].project.id])).rows;
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, "draft"); assert.deepEqual(jobs[0].source_snapshot, []);
  assert.equal((await request(`/api/agent/runs/${crypto.randomUUID()}`)).status, 404);
  assert.equal((await request("/api/actions/project.create", { businessUnitId: results[1].businessUnit.id, name: "Invalid", sourceLocale: "en", targetLocales: [3], executionType: "human" })).status, 400);
  // Optimistic preview conflicts are rejected without creating a resource.
  const pending = await request("/api/actions/business_unit.create", { organizationId, name: "Stale" });
  await database.query("update organizations set updated_at=now() where id=$1", [organizationId]);
  const proposal = pending.body.result.proposal;
  assert.equal((await request(`/api/agent/proposals/${proposal.id}/confirm`, { controllerId, fingerprint: proposal.fingerprint })).status, 409);
  assert.equal((await database.query("select count(*)::int as n from business_units where organization_id=$1", [organizationId])).rows[0].n, 1);
  const userId = (await request("/api/me")).body.auth.user.id;
  await database.query("update organization_memberships set status='suspended' where organization_id=$1 and user_id=$2", [organizationId, userId]);
  assert.equal((await request(`/api/agent/runs/${runId}`)).status, 403);
  assert.equal((await request("/api/actions/workspace.get", { organizationId })).status, 403);
  assert.equal((await request("/api/actions/localization_jobs.list", { projectSlug: results[2].project.slug })).status, 403);
});

test("pause and confirmation serialize on the same run; no write can follow the pause barrier", { skip: process.env.HEDGELING_REQUIRE_AGENT_TEST_DATABASE !== "true" }, async (t) => {
  const app = await localConsole(process.env.TEST_DATABASE_URL); t.after(app.close);
  const { request, database } = app;
  const controllerId = crypto.randomUUID();
  const run = (await request("/api/agent/runs", { controllerId })).body.run;
  await request(`/api/agent/runs/${run.id}/messages`, { controllerId, text: "Set up demo workspace" });
  const ready = await eventually(() => request(`/api/agent/runs/${run.id}`), (r) => r.body.run?.status === "awaiting_confirmation");
  const proposal = ready.body.proposals[0];
  const [confirmed, paused] = await Promise.all([
    request(`/api/agent/proposals/${proposal.id}/confirm`, { controllerId, fingerprint: proposal.fingerprint }),
    request(`/api/agent/runs/${run.id}/pause`, { controllerId }),
  ]);
  assert.ok([200, 409].includes(confirmed.status), JSON.stringify(confirmed.body));
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal((await request(`/api/agent/runs/${run.id}`)).body.run.status, "paused");
  assert.equal((await request(`/api/agent/runs/${run.id}/continue`, { controllerId })).status, 409);
  const expectedCount = confirmed.status === 200 ? 1 : 0;
  assert.equal((await database.query("select count(*)::int as n from organizations where name='Demo organization'")).rows[0].n, expectedCount);
  if (!expectedCount) assert.equal((await request(`/api/agent/proposals/${proposal.id}/confirm`, { controllerId, fingerprint: proposal.fingerprint })).status, 409);
});

test("manual actions share previews; source conflicts, expired grants and cross-organization tools cannot bypass scope", { skip: process.env.HEDGELING_REQUIRE_AGENT_TEST_DATABASE !== "true" }, async (t) => {
  const app = await localConsole(process.env.TEST_DATABASE_URL); t.after(app.close);
  const { request, database } = app;
  const controllerId = crypto.randomUUID();
  const userId = (await request("/api/me")).body.auth.user.id;
  const create = async (action, input) => {
    const preview = await request(`/api/actions/${action}`, input);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const proposal = preview.body.result.proposal;
    const response = await request(`/api/agent/proposals/${proposal.id}/confirm`, { controllerId, fingerprint: proposal.fingerprint });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.result;
  };
  const { organization } = await create("organization.create", { name: "Manual workspace" });
  const { businessUnit } = await create("business_unit.create", { organizationId: organization.id, name: "Content" });
  const { project } = await create("project.create", { businessUnitId: businessUnit.id, name: "Help center", sourceLocale: "en", targetLocales: ["fr", "de"] });
  const projects = (await request("/api/actions/projects.list", {})).body.result.projects;
  assert.equal(projects.find((p) => p.slug === project.slug).organizationId, organization.id);
  const workspace = (await request("/api/actions/workspace.get", { organizationId: organization.id })).body.result;
  assert.equal(workspace.projects[0].canCreateJob, true);
  await database.query("insert into source_strings(project_id,source_hash,source_text) values($1,'test-source','Hello')", [project.id]);
  const jobInput = { projectSlug: project.slug, name: "French help", targetLocales: ["fr"], steps: ["machine_translation", "review"] };
  const stale = (await request("/api/actions/localization_job.create", jobInput)).body.result.proposal;
  await database.query("update source_strings set source_text='Hello again',updated_at=now() where project_id=$1", [project.id]);
  assert.equal((await request(`/api/agent/proposals/${stale.id}/confirm`, { controllerId, fingerprint: stale.fingerprint })).status, 409);
  const { job } = await create("localization_job.create", jobInput);
  const snapshot = (await database.query("select source_snapshot from localization_jobs where id=$1", [job.id])).rows[0].source_snapshot;
  assert.equal(snapshot[0].source_text, "Hello again");
  const pending = (await request("/api/actions/business_unit.create", { organizationId: organization.id, name: "Expired" })).body.result.proposal;
  await database.query("update agent_proposals set expires_at=now()-interval '1 second' where id=$1", [pending.id]);
  assert.equal((await request(`/api/agent/proposals/${pending.id}/confirm`, { controllerId, fingerprint: pending.fingerprint })).status, 409);
  assert.equal((await request(`/api/agent/proposals/${pending.id}/reject`, {})).status, 200);
  // The agent's real MCP read receives only the conversation's organization.
  const run = (await request("/api/agent/runs", { controllerId, organizationId: organization.id })).body.run;
  await request(`/api/agent/runs/${run.id}/messages`, { controllerId, text: "Show my projects" });
  await eventually(() => request(`/api/agent/runs/${run.id}`), (r) => r.body.run?.status === "awaiting_input");
  const history = (await database.query("select model_history from agent_runs where id=$1", [run.id])).rows[0].model_history;
  const read = history.flatMap((h) => h.parts).find((p) => p.functionResponse)?.functionResponse.response.projects;
  assert.deepEqual(read.map((p) => p.slug), [project.slug]);
  // Unsupported tool requests return errors; they cannot create a new org in
  // an existing-org conversation, even if the fixture model asks them to.
  await request(`/api/agent/runs/${run.id}/messages`, { controllerId, text: "Set up demo workspace" });
  await eventually(() => request(`/api/agent/runs/${run.id}`), (r) => r.body.run?.status === "awaiting_input");
  assert.equal((await database.query("select count(*)::int as n from agent_proposals where run_id=$1", [run.id])).rows[0].n, 0);
  const cancelled = await request(`/api/agent/runs/${run.id}/cancel`, { controllerId });
  assert.equal(cancelled.body.run.status, "cancelled");
  assert.equal((await request(`/api/agent/runs/${run.id}/pause`, { controllerId })).body.run.status, "cancelled");
  assert.equal((await request(`/api/agent/runs/${run.id}/resume`, { controllerId })).status, 409);
  // Keep translator access after owner access expires. Conversation replay must
  // still be denied because it contains previously privileged information.
  await database.query(`insert into role_assignments(principal_type,principal_id,role_id,scope_type,scope_id,conditions)
    select 'user',$1,id,'project',$2,'{"locales":["fr"]}' from roles where key='translator' and organization_id is null`, [userId, project.id]);
  await database.query("update role_assignments set expires_at=now()+interval '2 seconds' where principal_id=$1 and scope_type='organization' and scope_id=$2", [userId, organization.id]);
  const expiring = (await request("/api/agent/runs", { controllerId, organizationId: organization.id })).body.run;
  assert.equal((await request(`/api/agent/runs/${expiring.id}`)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.equal((await request(`/api/agent/runs/${expiring.id}`)).status, 403);
  const translatorWorkspace = (await request("/api/actions/workspace.get", { organizationId: organization.id })).body.result;
  assert.equal(translatorWorkspace.projects[0].canCreateJob, false);
  assert.equal((await request("/api/actions/localization_job.create", jobInput)).status, 403);
  assert.equal((await request("/api/actions/business_unit.create", { organizationId: organization.id, name: "Denied" })).status, 403);
});
