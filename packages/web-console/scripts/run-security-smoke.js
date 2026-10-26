import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseUrl = String(process.env.HEDGELING_SECURITY_SMOKE_BASE_URL || "")
  .replace(/\/+$/, "");
const outputPath = path.resolve(
  process.env.HEDGELING_SECURITY_SMOKE_EVIDENCE_PATH
    || path.join(packageDirectory, "test-results", "security-smoke.json"),
);
const allowHttp = process.env.HEDGELING_SECURITY_SMOKE_ALLOW_HTTP === "true";
if (!baseUrl || (!allowHttp && !baseUrl.startsWith("https://"))) {
  throw new Error(
    "HEDGELING_SECURITY_SMOKE_BASE_URL must be the approved HTTPS console origin",
  );
}

const checks = [];
function record(id, passed, details) {
  checks.push({ id, passed: Boolean(passed), details });
}

const health = await fetch(`${baseUrl}/api/health`, {
  redirect: "error",
  signal: AbortSignal.timeout(10_000),
});
record("liveness", health.status === 200, `status=${health.status}`);
for (const [header, expected] of [
  ["content-security-policy", "frame-ancestors 'none'"],
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
  ["referrer-policy", "no-referrer"],
  ["cache-control", "no-store"],
]) {
  const actual = health.headers.get(header) || "";
  record(`header-${header}`, actual.includes(expected), actual || "missing");
}
if (baseUrl.startsWith("https://")) {
  const hsts = health.headers.get("strict-transport-security") || "";
  record("header-hsts", hsts.includes("max-age="), hsts || "missing");
}
record(
  "server-disclosure",
  !health.headers.has("x-powered-by"),
  health.headers.get("x-powered-by") || "not disclosed",
);
record(
  "correlation-id",
  /^[A-Za-z0-9._:-]{1,128}$/.test(health.headers.get("x-correlation-id") || ""),
  health.headers.get("x-correlation-id") || "missing",
);

const readiness = await fetch(`${baseUrl}/api/ready`, {
  redirect: "error",
  signal: AbortSignal.timeout(10_000),
});
record("database-readiness", readiness.status === 200, `status=${readiness.status}`);

const authConfigResponse = await fetch(`${baseUrl}/api/auth/config`, {
  redirect: "error",
  signal: AbortSignal.timeout(10_000),
});
const authConfigText = await authConfigResponse.text();
let authConfig = {};
try {
  authConfig = JSON.parse(authConfigText);
} catch {
  // The status and parse check below produce the evidence without echoing content.
}
record(
  "auth-config-public-shape",
  authConfigResponse.status === 200
    && !/(secret|password|token)/i.test(JSON.stringify(Object.keys(authConfig))),
  `status=${authConfigResponse.status}`,
);

const hostileOrigin = "https://cross-origin-readiness.invalid";
const denied = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: hostileOrigin,
    "sec-fetch-site": "cross-site",
  },
  body: JSON.stringify({ username: "readiness-invalid", password: "invalid" }),
  redirect: "error",
  signal: AbortSignal.timeout(10_000),
});
const deniedBody = await denied.json().catch(() => ({}));
record(
  "cross-origin-mutation",
  denied.status === 403 && deniedBody.code === "cross_origin_mutation_denied",
  `status=${denied.status} code=${deniedBody.code || "missing"}`,
);

const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  targetOrigin: baseUrl,
  status: checks.every((check) => check.passed) ? "passed" : "failed",
  checks,
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`[security-smoke] ${evidence.status}: ${outputPath}`);
if (evidence.status !== "passed") process.exitCode = 1;
