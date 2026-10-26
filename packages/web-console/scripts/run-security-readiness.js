import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(packageDirectory, "..", "..");
const outputPath = path.resolve(
  process.env.HEDGELING_SECURITY_EVIDENCE_PATH
    || path.join(packageDirectory, "test-results", "security-readiness.json"),
);
const checks = [];

function record(id, passed, details) {
  checks.push({ id, passed: Boolean(passed), details });
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(repositoryRoot, relativePath), "utf8"));
}

async function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
}

async function scanTrackedSecrets(files) {
  const patterns = [
    ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
    ["stripe-live-secret", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g],
    ["stripe-webhook-secret", /\bwhsec_[A-Za-z0-9]{16,}\b/g],
    ["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
    ["hedgeling-credential", /\bhdlg_(?:sa|scim)_[A-Za-z0-9_-]{20,}\b/g],
    [
      "private-key",
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{40,}/g,
    ],
  ];
  const findings = [];
  for (const relativePath of files) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    let stat;
    try {
      stat = await fs.stat(absolutePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 2_000_000) continue;
    let value;
    try {
      value = await fs.readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    if (value.includes("\u0000")) continue;
    for (const [type, pattern] of patterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(value);
      if (match) {
        findings.push({
          type,
          path: relativePath,
          line: value.slice(0, match.index).split("\n").length,
          fingerprint: crypto.createHash("sha256").update(match[0]).digest("hex").slice(0, 12),
        });
      }
    }
  }
  return findings;
}

function validateExceptions(exceptions) {
  const now = Date.now();
  const errors = [];
  const ids = new Set();
  for (const entry of exceptions) {
    if (!entry.id || ids.has(entry.id)) errors.push("Every exception needs a unique id");
    ids.add(entry.id);
    if (!["low", "moderate", "high", "critical"].includes(entry.severity)) {
      errors.push(`${entry.id || "unknown"} has an invalid severity`);
    }
    if (!entry.finding || !entry.owner || !entry.rationale || !entry.approvedBy) {
      errors.push(`${entry.id || "unknown"} is missing finding, owner, rationale, or approvedBy`);
    }
    const expiresAt = Date.parse(entry.expiresAt || "");
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      errors.push(`${entry.id || "unknown"} is expired or has no valid expiry`);
    }
    if (!/^https:\/\//.test(entry.evidenceUrl || "")) {
      errors.push(`${entry.id || "unknown"} must link durable HTTPS evidence`);
    }
  }
  return errors;
}

const [
  packageJson,
  lockfile,
  exceptionsDocument,
  serverSource,
  securitySource,
] = await Promise.all([
  readJson("packages/web-console/package.json"),
  readJson("package-lock.json"),
  readJson("docs/platform/security-exceptions.json"),
  fs.readFile(path.join(packageDirectory, "src", "server.js"), "utf8"),
  fs.readFile(path.join(packageDirectory, "src", "http-security.js"), "utf8"),
]);

record(
  "stripe-sdk-pinned",
  /^\d+\.\d+\.\d+$/.test(packageJson.dependencies?.stripe || "")
    && lockfile.packages?.["node_modules/stripe"]?.version === packageJson.dependencies.stripe,
  `declared=${packageJson.dependencies?.stripe || "missing"} lock=${lockfile.packages?.["node_modules/stripe"]?.version || "missing"}`,
);
record(
  "playwright-pinned",
  /^\d+\.\d+\.\d+$/.test(packageJson.devDependencies?.["@playwright/test"] || "")
    && lockfile.packages?.["node_modules/@playwright/test"]?.version
      === packageJson.devDependencies["@playwright/test"],
  `declared=${packageJson.devDependencies?.["@playwright/test"] || "missing"} lock=${lockfile.packages?.["node_modules/@playwright/test"]?.version || "missing"}`,
);

const rawBillingIndex = serverSource.indexOf('"/api/billing/stripe/webhook"');
const rawConnectIndex = serverSource.indexOf('"/api/vendor-payments/stripe/webhook"');
const jsonIndex = serverSource.indexOf("app.use(express.json");
record(
  "webhooks-before-json-parser",
  rawBillingIndex >= 0
    && rawConnectIndex >= 0
    && jsonIndex > rawBillingIndex
    && jsonIndex > rawConnectIndex
    && serverSource.slice(rawBillingIndex, jsonIndex).includes("express.raw")
    && serverSource.slice(rawConnectIndex, jsonIndex).includes("express.raw"),
  "Both Stripe boundaries must retain raw request bytes before global JSON parsing",
);
record(
  "http-boundary-mounted-first",
  serverSource.indexOf("app.use(requestCorrelation)") < rawBillingIndex
    && serverSource.indexOf("app.use(requestOutcomeTelemetry)") < rawBillingIndex
    && serverSource.indexOf("app.use(securityHeaders)") < rawBillingIndex
    && serverSource.indexOf("app.use(requireSameOriginMutation)") < rawBillingIndex
    && serverSource.includes('app.disable("x-powered-by")'),
  "Correlation, headers, cross-origin mutation defense, and Express disclosure control",
);
record(
  "strict-browser-policy",
  [
    "Content-Security-Policy",
    "Strict-Transport-Security",
    "includeSubDomains",
    "Cross-Origin-Opener-Policy",
    "X-Content-Type-Options",
    "cross_origin_mutation_denied",
    "HEDGELING_PUBLIC_ORIGIN is required in production",
  ].every((value) => securitySource.includes(value)),
  "Required response-header and browser mutation controls are present",
);
record(
  "generic-unhandled-errors",
  securitySource.includes(': "Internal error"')
    && serverSource.includes("logRequestError")
    && serverSource.includes("publicError"),
  "Unhandled errors must not disclose internal provider or database messages",
);

const exceptionErrors = validateExceptions(exceptionsDocument.exceptions || []);
record(
  "security-exceptions-valid",
  exceptionErrors.length === 0,
  exceptionErrors.length ? exceptionErrors : "No expired or malformed accepted findings",
);

const files = await trackedFiles();
const secretFindings = await scanTrackedSecrets(files);
record(
  "tracked-secret-scan",
  secretFindings.length === 0,
  secretFindings.length ? secretFindings : `Scanned ${files.length} tracked paths`,
);

const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  commit,
  node: process.version,
  status: checks.every((check) => check.passed) ? "passed" : "failed",
  checks,
  note: "Repository controls only; target-environment scans and human launch approval remain separate evidence.",
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);

if (evidence.status !== "passed") {
  for (const check of checks.filter((item) => !item.passed)) {
    console.error(`[security-readiness] FAIL ${check.id}`, check.details);
  }
  process.exitCode = 1;
} else {
  console.log(`[security-readiness] Passed ${checks.length} controls for ${commit}`);
  console.log(`[security-readiness] Evidence: ${outputPath}`);
}
