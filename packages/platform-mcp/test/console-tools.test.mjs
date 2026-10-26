import assert from "node:assert/strict";
import test from "node:test";
import { callConsoleTool, consoleTools } from "../dist/consoleTools.js";
import { CONSOLE_ACTIONS } from "@hedgeling/api-contract";

test("console tools preserve the API contract, explicit scope and bearer identity", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://console.example.com/api/actions/project.sync.status");
    assert.equal(init.headers.authorization, "Bearer test-service-token");
    assert.equal(init.redirect, "error");
    assert.deepEqual(JSON.parse(init.body), { projectSlug: "selected" });
    return new Response(JSON.stringify({ version: 1, action: "project.sync.status", result: { lastPushAt: null } }));
  });
  const values = {
    HEDGELING_CONSOLE_URL: "https://console.example.com",
    HEDGELING_CONSOLE_TOKEN: "test-service-token",
    HEDGELING_PROJECT_SLUG: "must-not-override-input",
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  assert.deepEqual(consoleTools.map((tool) => tool.inputSchema), CONSOLE_ACTIONS.map((action) => action.inputSchema));
  assert.deepEqual(consoleTools.map((tool) => tool.annotations.readOnlyHint), CONSOLE_ACTIONS.map((action) => action.readOnly));
  assert.deepEqual(consoleTools.map((tool) => tool.annotations.idempotentHint), CONSOLE_ACTIONS.map((action) => action.readOnly));
  assert.ok(!consoleTools.some((tool) => /confirm|approve/.test(tool.name)));
  const result = await callConsoleTool("console_get_sync_status", { projectSlug: "selected" });
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).action, "project.sync.status");
  assert.equal(await callConsoleTool("unrelated_tool", {}), null);
  const invalid = await callConsoleTool("console_get_sync_status", { projectSlug: "selected", actor: "admin" });
  assert.equal(invalid.isError, true);
  assert.equal(globalThis.fetch.mock.callCount(), 1);
  globalThis.fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ error: "Project access denied" }), { status: 403 }));
  const denied = await callConsoleTool("console_list_projects", {});
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /403.*Project access denied/);
  globalThis.fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ version: 99, action: "projects.list" })));
  const mismatch = await callConsoleTool("console_list_projects", {});
  assert.equal(mismatch.isError, true);
  assert.match(mismatch.content[0].text, /Unsupported console action response/);
});


test("report tools forward typed filters and pagination without altering the shared query", async (t) => {
  const previous = { origin: process.env.HEDGELING_CONSOLE_URL, token: process.env.HEDGELING_CONSOLE_TOKEN };
  process.env.HEDGELING_CONSOLE_URL = "https://console.example.com";
  process.env.HEDGELING_CONSOLE_TOKEN = "test-service-token";
  t.after(() => {
    if (previous.origin === undefined) delete process.env.HEDGELING_CONSOLE_URL; else process.env.HEDGELING_CONSOLE_URL = previous.origin;
    if (previous.token === undefined) delete process.env.HEDGELING_CONSOLE_TOKEN; else process.env.HEDGELING_CONSOLE_TOKEN = previous.token;
  });
  const input = { organizationId: "11111111-1111-4111-8111-111111111111", groupBy: "project", targetLocale: "fr", limit: 50, cursor: "opaque-continuation" };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://console.example.com/api/actions/reports.jobs.summary");
    assert.deepEqual(JSON.parse(init.body), input);
    return Response.json({ version: 1, action: "reports.jobs.summary", result: { totals: { jobs: 150 }, groups: [], page: { nextCursor: null } } });
  });
  const result = await callConsoleTool("console_report_jobs", input);
  assert.equal(JSON.parse(result.content[0].text).result.totals.jobs, 150);
});
