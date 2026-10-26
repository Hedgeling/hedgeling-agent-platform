import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { validateLocalDatabase } from "../src/local-auth.js";

export async function localConsole(connectionString, serverEnvironment = {}) {
  validateLocalDatabase({ DATABASE_URL: connectionString });
  const admin = new pg.Pool({ connectionString });
  const schema = `agent_console_${process.pid}_${Date.now()}`;
  await admin.query(`create schema ${schema}`);
  const url = new URL(connectionString); url.searchParams.set("options", `-csearch_path=${schema},public`);
  const database = new pg.Pool({ connectionString: url.toString() });
  let child, exited;
  const close = async () => {
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await exited; }
    await database.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end();
  };
  try {
    const listener = net.createServer().listen(0, "127.0.0.1"); await once(listener, "listening");
    const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/dev-local.js", import.meta.url))], {
      env: { PATH: process.env.PATH, USER: process.env.USER, DATABASE_URL: url.toString(), PORT: String(port), HEDGELING_AGENT_ENABLED: "true", HEDGELING_AGENT_ORG_CREATION_ENABLED: "true", HEDGELING_AGENT_PROVIDER: "fixture", ...serverEnvironment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    exited = once(child, "exit");
    let output = "", diagnostics = "";
    child.stderr.on("data", (chunk) => { diagnostics += chunk; });
    const token = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Local console did not start: ${diagnostics}`)), 45000);
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Local console exited ${code}: ${diagnostics}`)); });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const found = /Local login token \(keep private\): ([A-Za-z0-9_-]+)/.exec(output);
        if (found && output.includes("web console listening")) { clearTimeout(timer); resolve(found[1]); }
      });
    });
    const login = await fetch(`${origin}/api/auth/local`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token }) });
    if (!login.ok) throw new Error("Local test login failed");
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const request = async (path, body, headers = {}) => {
      const response = await fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin, cookie, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    return { origin, database, request, cookie, token, close };
  } catch (error) { await close(); throw error; }
}
export async function eventually(fn, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await fn(); if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for console state: ${JSON.stringify(value)}`);
}
