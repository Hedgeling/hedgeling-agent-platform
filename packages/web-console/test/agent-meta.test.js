import test from "node:test";
import assert from "node:assert/strict";
import { metaRequest, normalizeMetaResponse, generateMetaResponse } from "../src/agent-meta.js";
import { providerConfiguration } from "../src/agent-provider.js";

const tools = [{ name: "console_list_projects", description: "List projects", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];
const config = { model: "configured-meta-model", key: "test-key-not-a-credential" };
const reply = {
  status: "completed", output: [
    { type: "reasoning", id: "rs_1", encrypted_content: "opaque-encrypted-state", summary: [] },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "console_list_projects", arguments: "{}", status: "completed" },
  ],
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 12 } },
};

test("Meta preserves encrypted reasoning and matching tool call IDs across a stateless tool loop", async () => {
  const history = [{ role: "user", parts: [{ text: "List my projects" }] }];
  const body = metaRequest({ model: config.model, history, tools, instructions: "Use the authorized tools." });
  const raw = await generateMetaResponse({ config, body, signal: new AbortController().signal, fetchImpl: async (url, init) => {
    assert.equal(url, "https://api.meta.ai/v1/responses");
    assert.equal(init.headers.authorization, `Bearer ${config.key}`);
    assert.equal(init.redirect, "error");
    assert.ok(!init.body.includes(config.key));
    assert.equal(JSON.parse(init.body).store, false);
    assert.deepEqual(JSON.parse(init.body).include, ["reasoning.encrypted_content"]);
    return Response.json(reply);
  } });
  const model = raw.candidates[0].content;
  assert.deepEqual(model.parts, [{ functionCall: { id: "call_1", name: "console_list_projects", args: {} } }]);
  assert.equal(raw.usageMetadata.totalTokenCount, 30);
  assert.equal(raw.usageMetadata.thoughtsTokenCount, 12);
  const resumed = metaRequest({ model: config.model, tools, instructions: "Use the authorized tools.", history: [
    ...history, model,
    { role: "user", parts: [{ functionResponse: { id: "call_1", name: "console_list_projects", response: { projects: [] } } }] },
    { role: "user", confirmation: true, parts: [{ text: "Confirmed result: {}" }] },
  ] });
  assert.deepEqual(resumed.input.slice(1, 3), reply.output);
  assert.deepEqual(resumed.input[3], { type: "function_call_output", call_id: "call_1", output: '{"projects":[]}' });
  assert.ok(!JSON.stringify(resumed).includes('"confirmation"'));
  assert.deepEqual(resumed.tools[0].parameters, tools[0].inputSchema);
});

test("Meta history conversion supports legacy calls while keeping Gemini thoughts private", () => {
  const request = metaRequest({ model: config.model, tools, history: [
    { role: "model", parts: [{ text: "hidden", thought: true }, { functionCall: { name: "console_list_projects", args: {} }, thoughtSignature: "gemini-only" }] },
    { role: "user", parts: [{ functionResponse: { name: "console_list_projects", response: {} } }] },
  ] });
  assert.equal(request.input[0].call_id, request.input[1].call_id);
  assert.ok(!JSON.stringify(request).includes("gemini-only"));
  assert.ok(!JSON.stringify(request).includes("hidden"));
  assert.throws(() => metaRequest({ model: config.model, tools, history: [{ role: "user", parts: [{ functionResponse: { name: "unknown", response: {} } }] }] }), /cannot be resumed/);
});

test("Meta rejects partial or invalid tool results and never reveals provider errors", async () => {
  for (const raw of [
    { ...reply, status: "incomplete" },
    { ...reply, output: [{ ...reply.output[1], arguments: "not-json" }] },
    { ...reply, output: [reply.output[1], reply.output[1]] },
    { ...reply, output: [reply.output[0]] },
  ]) assert.throws(() => normalizeMetaResponse(raw));
  assert.equal(normalizeMetaResponse({ ...reply, usage: { total_tokens: -1 } }).usageMetadata, undefined);
  for (const response of [new Response("secret-provider-detail", { status: 401 }), new Response("x".repeat(524289)), new Response("invalid-json")]) {
    await assert.rejects(generateMetaResponse({ config, body: {}, signal: new AbortController().signal, fetchImpl: async () => response }), (error) => error.status === 502 && !error.message.includes("secret-provider-detail"));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(generateMetaResponse({ config, body: {}, signal: controller.signal, fetchImpl: () => assert.fail("Cancelled turn must not be dispatched") }), { name: "AbortError" });
});

test("Meta requires its own explicit key and model; unsupported providers cannot fall back to Gemini", () => {
  const names = ["HEDGELING_AGENT_PROVIDER", "HEDGELING_META_API_KEY", "HEDGELING_AGENT_META_MODEL", "GEMINI_API_KEY"];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.HEDGELING_AGENT_PROVIDER = "meta";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    delete process.env.HEDGELING_META_API_KEY;
    process.env.HEDGELING_AGENT_META_MODEL = config.model;
    assert.equal(providerConfiguration().ready, false);
    process.env.HEDGELING_META_API_KEY = config.key;
    assert.equal(providerConfiguration().ready, true);
    delete process.env.HEDGELING_AGENT_META_MODEL;
    assert.equal(providerConfiguration().ready, false);
    process.env.HEDGELING_AGENT_PROVIDER = "unimplemented-provider";
    assert.throws(providerConfiguration, /not supported/);
  } finally {
    for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
