import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/import-source-catalog.js", import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hedgeling-source-import-"));
  // The script also checks ../../.env. Keep both locations inside the fixture.
  const cwd = path.join(root, "workspace", "console");
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = path.join(cwd, "source.json");
  const config = path.join(cwd, "config.json");
  await fs.writeFile(catalog, JSON.stringify({
    schemaVersion: 1,
    entries: [{ key: "source-key", source: "Create project", contexts: [{
      purpose: "button", locations: [{ file: "apps/studio/Button.tsx", line: 4, kind: "jsx" }],
    }] }],
  }));
  await fs.writeFile(config, JSON.stringify({ locales: ["fr-FR"] }));
  return {
    cwd, catalog,
    run(extraEnv = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script], {
          cwd,
          // No developer credentials or AWS configuration enter these tests.
          env: {
            PATH: path.dirname(process.execPath),
            HEDGELING_SOURCE_JSON: catalog,
            HEDGELING_CONFIG_PATH: config,
            HEDGELING_PROJECT_SLUG: "supabase-studio-soak",
            HEDGELING_PROJECT_NAME: "Supabase Studio Soak",
            ...extraEnv,
          },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => { stdout += data; });
        child.stderr.on("data", (data) => { stderr += data; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    },
  };
}

async function consoleServer(t, status = 200) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { counts: { sourceStrings: 1 } } : { error: "Import denied" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { requests, origin: `http://127.0.0.1:${server.address().port}` };
}

test("source-only bootstrap exports offline without credentials and refuses to overwrite state", async (t) => {
  const files = await fixture(t);
  const output = path.join(files.cwd, "console-source-state.json");
  const result = await files.run({ HEDGELING_STATE_OUTPUT: output });
  assert.equal(result.code, 0, result.stderr);
  const state = JSON.parse(await fs.readFile(output, "utf8"));
  assert.deepEqual(state.locales, ["fr-FR"]);
  const entry = state.files["public/i18n/source.html"].entries["source-key"];
  assert.equal(entry.sourceText, "Create project");
  assert.equal(entry.contextVariants[0].file, "apps/studio/Button.tsx");
  assert.deepEqual(entry.translations, {});
  const original = await fs.readFile(output, "utf8");
  const repeated = await files.run({ HEDGELING_STATE_OUTPUT: output });
  assert.notEqual(repeated.code, 0);
  assert.match(repeated.stderr, /EEXIST/);
  assert.equal(await fs.readFile(output, "utf8"), original);
});

test("hosted imports prefer bearer auth, preserve human edits, and do not prune by default", async (t) => {
  const files = await fixture(t);
  const console = await consoleServer(t);
  const token = "test-console-token";
  const result = await files.run({
    HEDGELING_CONSOLE_URL: console.origin,
    HEDGELING_CONSOLE_TOKEN: token,
    ADMIN_PASSWORD: "unused-basic-password",
    HEDGELING_ADMIN_PASSWORD_SECRET_ID: "must-not-fetch-this-secret",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(console.requests.length, 1);
  assert.equal(console.requests[0].authorization, `Bearer ${token}`);
  assert.equal(console.requests[0].path, "/api/import-state");
  assert.equal(console.requests[0].body.projectSlug, "supabase-studio-soak");
  assert.equal(console.requests[0].body.overwriteHuman, false);
  assert.equal(console.requests[0].body.pruneMissing, false);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(token));
});

test("local imports use bearer credentials and support explicit pruning", async (t) => {
  const files = await fixture(t);
  const console = await consoleServer(t);
  const result = await files.run({
    HEDGELING_CONSOLE_URL: console.origin,
    HEDGELING_CONSOLE_TOKEN: "local-test-token",
    HEDGELING_IMPORT_PRUNE_MISSING: "true",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(console.requests[0].authorization, "Bearer local-test-token");
  assert.equal(console.requests[0].body.pruneMissing, true);
});

test("missing credentials fail explicitly without AWS discovery or an HTTP request", async (t) => {
  const files = await fixture(t);
  const console = await consoleServer(t);
  const result = await files.run({ HEDGELING_CONSOLE_URL: console.origin, HEDGELING_CONSOLE_PASSWORD: "legacy-password" });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Set HEDGELING_CONSOLE_TOKEN/);
  assert.doesNotMatch(result.stderr, /spawnSync aws/);
  assert.equal(console.requests.length, 0);
});

test("newer catalog schemas fail before writing output or contacting a console", async (t) => {
  const files = await fixture(t);
  await fs.writeFile(files.catalog, JSON.stringify({ schemaVersion: 999, entries: [] }));
  const output = path.join(files.cwd, "state.json");
  const result = await files.run({ HEDGELING_STATE_OUTPUT: output });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /newer than this importer supports/);
  await assert.rejects(fs.stat(output), { code: "ENOENT" });
});

test("failed imports distinguish login, project provisioning, permissions, and subscription setup", async (t) => {
  for (const [status, hint] of [
    [401, /bearer credential is active/],
    [402, /active subscription with state_imports/],
    [403, /imports.run permission/],
    [404, /Provision the project first/],
  ]) {
    await t.test(`HTTP ${status}`, async (t) => {
      const files = await fixture(t);
      const console = await consoleServer(t, status);
      const result = await files.run({
        HEDGELING_CONSOLE_URL: console.origin,
        HEDGELING_CONSOLE_TOKEN: "test-console-token",
      });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, hint);
      assert.match(result.stderr, new RegExp(`HTTP ${status}`));
    });
  }
});
