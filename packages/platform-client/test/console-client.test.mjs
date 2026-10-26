import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleClient, consoleClientFromEnv } from "../dist/index.js";

test("console credentials never fall back to Basic Auth", () => {
  const config = { HEDGELING_CONSOLE_URL: "https://console.example.com", HEDGELING_CONSOLE_PASSWORD: "removed" };
  assert.match(consoleClientFromEnv(config).error, /TOKEN/);
  assert.equal(consoleClientFromEnv({ ...config, HEDGELING_CONSOLE_TOKEN: "test" }).origin, config.HEDGELING_CONSOLE_URL);
  for (const origin of ["http://console.example.com", "https://user:password@console.example.com", "https://console.example.com/path"]) {
    assert.throws(() => createConsoleClient({ origin, token: "test" }));
  }
  assert.doesNotThrow(() => createConsoleClient({ origin: "http://127.0.0.1:8080", token: "test" }));
});

test("console transport keeps credentials on its origin and uses explicit action scope", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://console.example.com/api/actions/projects.list");
    assert.equal(options.headers.authorization, "Bearer test-token");
    assert.equal(options.redirect, "error");
    return new Response(JSON.stringify({ ok: true }));
  });
  const client = createConsoleClient({ origin: "https://console.example.com", token: "test-token", projectSlug: "default" });
  for (const path of ["@attacker.example/api", "//attacker.example/api", "https://attacker.example/api"]) {
    await assert.rejects(client.request("GET", path));
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0);
  assert.deepEqual(await client.request("POST", "/api/actions/projects.list", {}, { projectQuery: false }), { ok: true });
});
