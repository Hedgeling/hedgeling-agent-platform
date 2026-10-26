import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createActionsRouter } from "../src/actions.js";
import { requireProjectPermission, requireOrganizationPermission } from "../src/authorization.js";
import { validateLocalAuthentication, localRequestAllowed, authenticateLocal } from "../src/local-auth.js";
import { CONSOLE_ACTIONS } from "@hedgeling/api-contract";

const userId = "11111111-1111-4111-8111-111111111111";
const localEnv = () => ({
  NODE_ENV: "development", HEDGELING_AUTH_MODE: "local",
  DATABASE_URL: "postgresql://localhost/hedgeling_disposable",
  HEDGELING_LOCAL_USER_ID: userId, HEDGELING_LOCAL_AUTH_TOKEN: "t".repeat(43),
  HEDGELING_LOCAL_AUTH_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
  HEDGELING_TRUST_PROXY_HOPS: "0",
});
function localRequest(headers = {}, remote = "127.0.0.1") {
  return { socket: { localAddress: "127.0.0.1", remoteAddress: remote },
    get: (key) => ({ host: "127.0.0.1:8080", ...headers })[key] || "" };
}

test("local troubleshooting rejects production, remote databases, proxies, weak and expired credentials", () => {
  const env = localEnv();
  assert.doesNotThrow(() => validateLocalAuthentication(env));
  for (const override of [
    { NODE_ENV: "production" }, { NODE_ENV: "test" },
    { DATABASE_URL: "postgresql://db.example.com/customer" },
    { DATABASE_URL: "postgresql://localhost/db?host=db.example.com" },
    { HEDGELING_TRUST_PROXY_HOPS: "1" }, { HEDGELING_LOCAL_AUTH_TOKEN: "password" },
    { HEDGELING_LOCAL_AUTH_EXPIRES_AT: new Date(0).toISOString() },
    { HEDGELING_LOCAL_AUTH_EXPIRES_AT: new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString() },
  ]) assert.throws(() => validateLocalAuthentication({ ...env, ...override }));
  assert.equal(localRequestAllowed(localRequest(), env), true);
  assert.equal(localRequestAllowed(localRequest({}, "203.0.113.1"), env), false);
  assert.equal(localRequestAllowed(localRequest({ host: "attacker.example" }), env), false);
  assert.equal(localRequestAllowed(localRequest({ "x-forwarded-for": "127.0.0.1" }), env), false);
  assert.equal(localRequestAllowed(localRequest(), { ...env, NODE_ENV: "production" }), false);
});

test("local login resolves an active named user without synthesizing platform authority", async () => {
  const env = localEnv();
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    let calls = 0;
    const database = { query: async (sql, args) => {
      calls++;
      assert.match(sql, /status = 'active' and platform_staff = false/);
      assert.deepEqual(args, [userId]);
      return { rows: [{ id: userId, status: "active", platformStaff: false }] };
    } };
    assert.equal(await authenticateLocal(localRequest(), "wrong", database), null);
    assert.equal(calls, 0);
    const auth = await authenticateLocal(localRequest(), env.HEDGELING_LOCAL_AUTH_TOKEN, database);
    assert.equal(auth.principalType, "user");
    assert.equal(auth.user.id, userId);
    assert.equal(auth.platformAdmin, undefined);
    assert.equal(await authenticateLocal(localRequest(), env.HEDGELING_LOCAL_AUTH_TOKEN,
      { query: async () => ({ rows: [] }) }), null);
    process.env.HEDGELING_LOCAL_AUTH_EXPIRES_AT = new Date(0).toISOString();
    assert.equal(await authenticateLocal(localRequest(), env.HEDGELING_LOCAL_AUTH_TOKEN, database), null);
    assert.equal(calls, 1, "expired sessions are rejected before user lookup");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("human decision gates deny machines even with platform flags, before querying grants", async () => {
  for (const auth of [
    { principalType: "service_account", platformAdmin: true },
    { principalType: "system_agent" },
    { principalType: "user", user: { id: userId }, executionType: "agent" },
  ]) {
    for (const gate of [requireProjectPermission("translations.approve"), requireOrganizationPermission("access_requests.approve")]) {
      let status; let body;
      await gate({ auth }, { status(value) { status = value; return this; }, json(value) { body = value; } },
        () => assert.fail("machine reached approval handler"));
      assert.equal(status, 403);
      assert.equal(body.code, "human_decision_required");
    }
  }
});

test("action transport validates scopes, reauthorizes, and returns the versioned contract", async (t) => {
  const app = express();
  app.use(express.json());
  let lookedUp = 0;
  app.use((req, _res, next) => { req.auth = { principalType: "service_account" }; req.correlationId = "test-request"; next(); });
  app.use("/api/actions", createActionsRouter({
    listProjects: async (auth) => { assert.equal(auth.principalType, "service_account"); return [{ slug: "allowed" }]; },
    authorizeProject: (permission) => (req, res, next) => {
      assert.equal(permission, "strings.view");
      if (req.body.projectSlug !== "allowed") return res.status(403).json({ error: "denied" });
      req.authorizedProject = { id: "authorized-id" }; next();
    },
    syncStatus: async (id) => { lookedUp++; assert.equal(id, "authorized-id"); return { lastPushAt: null }; },
  }));
  const server = await new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const invoke = (action, input, query = "") => fetch(`${origin}/api/actions/${action}${query}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  const catalog = await fetch(`${origin}/api/actions`).then((r) => r.json());
  assert.deepEqual(catalog.actions, CONSOLE_ACTIONS);
  assert.equal((await invoke("project.sync.status", { projectSlug: "forbidden" })).status, 403);
  assert.equal((await invoke("project.sync.status", { projectSlug: "allowed", actor: "admin" })).status, 400);
  assert.equal((await invoke("project.sync.status", { projectSlug: "allowed" }, "?project=forbidden")).status, 400);
  assert.equal(lookedUp, 0);
  const response = await invoke("project.sync.status", { projectSlug: "allowed" });
  assert.deepEqual(await response.json(), {
    version: 1, action: "project.sync.status", correlationId: "test-request",
    result: { projectId: "authorized-id", lastPushAt: null },
  });
  const projects = await invoke("projects.list", {});
  assert.deepEqual((await projects.json()).result.projects, [{ slug: "allowed" }]);
});
