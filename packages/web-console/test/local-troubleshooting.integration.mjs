import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import http from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { validateLocalDatabase } from "../src/local-auth.js";

const connectionString = process.env.TEST_DATABASE_URL;
// Run separately from the authorization suite: PostgreSQL extensions are
// database-wide, so concurrent schema bootstrap/cleanup is not isolated.
if (process.env.HEDGELING_REQUIRE_LOCAL_TEST_DATABASE !== "true") {
  console.log("Local troubleshooting integration: run npm run test:local with TEST_DATABASE_URL.");
  process.exit(0);
}
if (!connectionString) throw new Error("TEST_DATABASE_URL must point to disposable loopback PostgreSQL");
validateLocalDatabase({ DATABASE_URL: connectionString });
const schema = `hedgeling_local_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString });
const databaseUrl = new URL(connectionString);
databaseUrl.searchParams.set("options", `-csearch_path=${schema},public`);
let child;
let database;
let childClosed;
await admin.query(`create schema ${schema}`);
try {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/dev-local.js", import.meta.url))], {
    env: { PATH: process.env.PATH, USER: process.env.USER, DATABASE_URL: databaseUrl.toString(), PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  childClosed = once(child, "exit");
  // Capture the generated token privately; never put it in test output.
  let output = "";
  let diagnostics = "";
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Local server did not start within 30 seconds")), 30_000);
    const failed = (code) => { clearTimeout(timer); reject(new Error(`Local server exited ${code}: ${diagnostics}`)); };
    child.once("exit", failed);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /Local login token \(keep private\): ([A-Za-z0-9_-]+)/.exec(output);
      if (match && output.includes("web console listening")) {
        clearTimeout(timer); child.off("exit", failed); resolve(match[1]);
      }
    });
  });
  database = new pg.Pool({ connectionString: databaseUrl.toString() });
  const request = (path, options = {}) => fetch(`${origin}${path}`, { redirect: "manual", ...options });
  const invoke = (action, input, headers = {}) => request(`/api/actions/${action}`, {
    method: "POST", headers: { "content-type": "application/json", origin, ...headers }, body: JSON.stringify(input),
  });
  assert.equal((await request("/api/me")).status, 401);
  assert.equal((await request("/", { headers: { accept: "text/html" } })).headers.get("location"), "/local-login");
  assert.equal((await request("/local-login")).status, 200);
  assert.equal((await request("/login")).headers.get("location"), "/local-login");
  assert.equal((await request("/api/me", { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "127.0.0.1" } })).status, 403);
  // Fetch normalizes Host; use raw HTTP to exercise DNS-rebinding protection.
  const hostileHostStatus = await new Promise((resolve, reject) => {
    http.get(`${origin}/api/me`, { headers: { host: "attacker.example", authorization: `Bearer ${token}` } }, (response) => {
      response.resume(); resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await invoke("projects.list", {})).status, 401);
  const login = await request("/api/auth/local", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookie = setCookie.split(";")[0];
  const me = await request("/api/me", { headers: { cookie } }).then((response) => response.json());
  assert.equal(me.auth.principalType, "user");
  assert.equal(me.auth.method, "local");
  assert.equal(me.auth.user.platformStaff, false);
  assert.equal(me.auth.platformAdmin, undefined);
  const projects = await invoke("projects.list", {}, { cookie }).then((response) => response.json());
  assert.deepEqual(projects.result.projects.map((project) => project.slug), ["hedgeling-local"]);
  assert.equal((await invoke("project.sync.status", { projectSlug: "hedgeling-local" }, { cookie })).status, 200);
  assert.equal((await invoke("project.sync.status", { projectSlug: "not-granted" }, { cookie })).status, 404);
  assert.equal((await request("/api/me", { headers: { cookie, authorization: "Basic cmVtb3ZlZDpyZW1vdmVk" } })).status, 401);
  await database.query("update organization_memberships set status = 'suspended' where user_id = $1", [me.auth.user.id]);
  assert.equal((await invoke("project.sync.status", { projectSlug: "hedgeling-local" }, { cookie })).status, 403);
  await database.query("update users set status = 'suspended' where id = $1", [me.auth.user.id]);
  assert.equal((await request("/api/me", { headers: { cookie } })).status, 401);
  const logout = await request("/api/auth/refresh/logout", { method: "POST", headers: { cookie, origin } });
  assert.equal(logout.status, 200);
  assert.ok(logout.headers.getSetCookie().some((value) => value.startsWith("hedgeling_local_session=;") && value.includes("Max-Age=0")));
  console.log("Local troubleshooting: startup, cookie login/logout, bearer access, host/proxy restrictions, project isolation and revocation passed.");
} finally {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await childClosed; }
  await database?.end();
  await admin.query(`drop schema ${schema} cascade`);
  await admin.end();
}
