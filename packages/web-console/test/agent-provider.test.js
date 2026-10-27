import test from "node:test";
import assert from "node:assert/strict";
import { generateGeminiResponse, providerConfiguration, nextAgentTurn } from "../src/agent-provider.js";
import { pool } from "../src/db.js";
import { validateActionInput, WORKSPACE_ACTIONS } from "@hedgeling/api-contract";

const config = { model: "configured-test-model", key: "test-only-placeholder" };
test("Gemini adapter keeps credentials in headers and preserves structured model state", async () => {
  const body = { contents: [{ role: "user", parts: [{ text: "List projects" }] }], tools: [{ functionDeclarations: [{ name: "console_list_projects", parametersJsonSchema: { type: "object", properties: {} } }] }] };
  const expected = { candidates: [{ content: { role: "model", parts: [{ thoughtSignature: "opaque-provider-state", functionCall: { id: "call-1", name: "console_list_projects", args: {} } }] } }], usageMetadata: { totalTokenCount: 12 } };
  const raw = await generateGeminiResponse({ config, body, signal: new AbortController().signal, fetchImpl: async (url, init) => {
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/configured-test-model:generateContent");
    assert.equal(init.headers["x-goog-api-key"], config.key);
    assert.ok(!init.body.includes(config.key)); assert.deepEqual(JSON.parse(init.body), body);
    assert.equal(init.redirect, "error");
    return Response.json(expected);
  } });
  assert.deepEqual(raw, expected);
});
test("Gemini cancellation, provider errors and excessive response size fail closed", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(generateGeminiResponse({ config, body: {}, signal: controller.signal, fetchImpl: () => assert.fail("A cancelled request must not be sent") }), { name: "AbortError" });
  for (const [response, pattern] of [[new Response("private provider error", { status: 429 }), /\(429\)/], [new Response("x".repeat(524289)), /size limit/]]) {
    await assert.rejects(generateGeminiResponse({ config, body: {}, signal: new AbortController().signal, fetchImpl: async () => response }), (error) => pattern.test(error.message) && !error.message.includes("private provider error"));
  }
});
test("demo provider is unavailable outside local troubleshooting", () => {
  const before = { ...process.env };
  try {
    process.env.HEDGELING_AGENT_PROVIDER = "fixture";
    process.env.HEDGELING_AUTH_MODE = "cognito";
    assert.throws(providerConfiguration, /restricted to local/);
    process.env.HEDGELING_AUTH_MODE = "local"; process.env.NODE_ENV = "production";
    assert.throws(providerConfiguration, /restricted to local/);
    process.env.NODE_ENV = "test"; assert.equal(providerConfiguration().ready, true);
  } finally {
    for (const key of ["HEDGELING_AGENT_PROVIDER", "HEDGELING_AUTH_MODE", "NODE_ENV"]) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
  }
});
test("confirmation checkpoints are trusted only when server-flagged and stripped from provider requests", async (t) => {
  const settings = { HEDGELING_AGENT_PROVIDER: "fixture", HEDGELING_AUTH_MODE: "local", NODE_ENV: "test" };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const access = { checkAccess: async () => ({ allowed: true, limits: {} }) };
  const turn = (history) => nextAgentTurn({ run: { id: "test-run", organization_id: null }, auth: { user: { id: "test-user" } }, history, tools: [], signal: new AbortController().signal }, access);
  // User text that mimics the sentinel is an ordinary message, never a parsed confirmation.
  const spoofed = await turn([{ role: "user", parts: [{ text: "Confirmed result: {not json" }] }]);
  assert.equal(spoofed.parts[0].functionCall.name, "console_list_organizations");
  // Only the server-written checkpoint, marked with the confirmation flag, advances the flow.
  const confirmed = await turn([{ role: "user", confirmation: true, parts: [{ text: 'Confirmed result: {"organization":{"id":"org-1"}}' }] }]);
  assert.equal(confirmed.parts[0].functionCall.name, "console_propose_business_unit");
  // The server-side marker never reaches the provider API.
  Object.assign(process.env, { HEDGELING_AGENT_PROVIDER: "gemini", HEDGELING_AGENT_GEMINI_MODEL: config.model, HEDGELING_GEMINI_API_KEY: config.key });
  t.after(() => { delete process.env.HEDGELING_AGENT_GEMINI_MODEL; delete process.env.HEDGELING_GEMINI_API_KEY; });
  t.mock.method(pool, "connect", async () => ({ release() {}, async query(sql) {
    if (sql.includes(" as tokens from agent_model_usage")) return { rows: [{ tokens: 0 }] };
    if (sql.startsWith("insert into agent_model_usage")) return { rows: [{ id: "test-reservation" }] };
    return { rows: [] };
  } }));
  t.mock.method(pool, "query", async () => ({ rows: [] }));
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    for (const content of JSON.parse(init.body).contents) assert.ok(!Object.hasOwn(content, "confirmation"));
    return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }], usageMetadata: { totalTokenCount: 5 } });
  });
  const reply = await turn([{ role: "user", confirmation: true, parts: [{ text: 'Confirmed result: {"organization":{"id":"org-1"}}' }] }]);
  assert.equal(reply.parts[0].text, "ok");
});
test("shared action schemas reject authority flags, blank names and malformed locale arrays", () => {
  const action = WORKSPACE_ACTIONS.find((a) => a.name === "project.create");
  const valid = { businessUnitId: "f3812e6d-572b-41b7-9f5e-06699394ad96", name: "Website", sourceLocale: "en", targetLocales: ["fr"] };
  assert.equal(validateActionInput(action, valid), null);
  for (const input of [{ ...valid, executionType: "human" }, { ...valid, name: " " }, { ...valid, targetLocales: [3] }, { ...valid, targetLocales: ["fr", "fr"] }, { ...valid, businessUnitId: "wrong" }]) assert.ok(validateActionInput(action, input));
});

test("assistant budget blocks dispatch; cancellation and unknown outcomes retain truthful charges", async (t) => {
  const settings = { HEDGELING_AGENT_PROVIDER: "gemini", HEDGELING_AGENT_GEMINI_MODEL: config.model, HEDGELING_GEMINI_API_KEY: config.key };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let used = 500000, dispatched = 0;
  const updates = [];
  const client = { release() {}, async query(sql) {
    if (sql.includes(" as tokens from agent_model_usage")) return { rows: [{ tokens: used }] };
    if (sql.startsWith("insert into agent_model_usage")) return { rows: [{ id: "test-reservation" }] };
    return { rows: [] };
  } };
  t.mock.method(pool, "connect", async () => client);
  t.mock.method(pool, "query", async (_sql, args) => { updates.push(args); return { rows: [] }; });
  t.mock.method(globalThis, "fetch", async () => { dispatched++; return new Response("private upstream details", { status: 500 }); });
  const input = { run: { id: "test-run", organization_id: null }, auth: { user: { id: "test-user" } }, history: [{ role: "user", parts: [{ text: "Hello" }] }], tools: [] };
  await assert.rejects(nextAgentTurn({ ...input, signal: new AbortController().signal }), (error) => error.code === "agent_plan_required");
  const access = { checkAccess: async () => ({ allowed: true, limits: {} }) };
  await assert.rejects(nextAgentTurn({ ...input, signal: new AbortController().signal }, access), (error) => error.status === 429);
  assert.equal(dispatched, 0); assert.deepEqual(updates, []);
  used = 0;
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(nextAgentTurn({ ...input, signal: stopped.signal }, access), { name: "AbortError" });
  assert.equal(dispatched, 0); assert.deepEqual(updates.at(-1), ["test-reservation", 0, "not_dispatched"]);
  await assert.rejects(nextAgentTurn({ ...input, signal: new AbortController().signal }, access), (error) => error.status === 502 && !error.message.includes("private"));
  assert.equal(dispatched, 1); assert.ok(updates.at(-1)[1] > 0); assert.equal(updates.at(-1)[2], "unknown");
});

test("explicit chat allowance grants admit usage above the default but retain finite, validated limits", async (t) => {
  const settings = { HEDGELING_AGENT_PROVIDER: "gemini", HEDGELING_AGENT_GEMINI_MODEL: config.model, HEDGELING_GEMINI_API_KEY: config.key };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let used = 600000, dispatched = 0, reservations = 0;
  const updates = [];
  t.mock.method(pool, "connect", async () => ({ release() {}, async query(sql) {
    if (sql.includes(" as tokens from agent_model_usage")) return { rows: [{ tokens: used }] };
    if (sql.startsWith("insert into agent_model_usage")) { reservations++; return { rows: [{ id: "test-grant" }] }; }
    return { rows: [] };
  } }));
  t.mock.method(pool, "query", async (_sql, args) => { updates.push(args); return { rows: [] }; });
  t.mock.method(globalThis, "fetch", async () => { dispatched++; return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }], usageMetadata: { totalTokenCount: 23 } }); });
  const input = { run: { id: "test-run", organization_id: null }, auth: { user: { id: "test-user" } }, history: [{ role: "user", parts: [{ text: "Hello" }] }], tools: [], signal: new AbortController().signal };
  const turn = (limits) => nextAgentTurn(input, { checkAccess: async () => ({ allowed: true, limits }) });
  await assert.rejects(turn({}), (error) => error.status === 429);
  assert.equal((await turn({ dailyUserTokens: 10000000 })).parts[0].text, "ok");
  assert.deepEqual(updates, [["test-grant", 23, "succeeded"]]);
  used = 9999999; // A reservation cannot cross the configured ceiling.
  await assert.rejects(turn({ dailyUserTokens: 10000000 }), (error) => error.status === 429);
  used = 10000000;
  await assert.rejects(turn({ dailyUserTokens: 20000000 }), (error) => error.status === 429);
  used = 100;
  await assert.rejects(turn({ dailyUserTokens: 100 }), (error) => error.status === 429);
  used = 0;
  await assert.rejects(turn({ dailyUserTokens: 0 }), (error) => error.status === 429);
  for (const dailyUserTokens of [-1, 1.5, "10000000", "invalid", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(turn({ dailyUserTokens }), (error) => error.code === "agent_allowance_invalid");
  }
  assert.equal(dispatched, 1); assert.equal(reservations, 1);
});
