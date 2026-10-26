import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";

// Scan tracked files plus untracked, non-ignored work before the first commit.
// Report locations only: a finding must never echo a credential into CI logs.
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const allowed = new Set(["api-contract", "platform-client", "platform-mcp", "design-system", "web-console"]);
const failures = [];
const fail = (file, reason) => failures.push(`${file}: ${reason}`);
const patterns = [
  ["AWS credential", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Google credential", /\bAIza[A-Za-z0-9_-]{30,}\b/],
  ["GitHub credential", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["Stripe credential", /\b(?:(?:sk|rk)_(?:live|test)|whsec)_[A-Za-z0-9]{16,}\b/],
  ["Hedgeling credential", /\bhdlg_(?:sa|scim)_[A-Za-z0-9_-]{20,}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{40,}/],
  ["deployment endpoint", /https?:\/\/[^\s/"'`]*(?:\.awsapprunner\.com|\.elb\.amazonaws\.com|\.rds\.amazonaws\.com|\.execute-api\.[\w-]+\.amazonaws\.com|platform\.thehedgeling\.com)/],
];
for (const file of new Set(files)) {
  const parts = file.split("/");
  if (parts[0] === "packages" && !allowed.has(parts[1])) fail(file, "package outside public allowlist");
  if (parts.some((part) => ["node_modules", "dist", "dist-bundle", ".aws", ".hedgeling"].includes(part))
      || /(?:^|\/)(?:\.env(?:\..+)?|\.npmrc|credentials)$/.test(file) && !file.endsWith(".env.example")
      || /\.(?:map|tgz|pem|key)$/.test(file)) fail(file, "private/generated artifact");
  if (lstatSync(file).isSymbolicLink()) { fail(file, "symlink needs public-boundary review"); continue; }
  const source = readFileSync(file);
  if (source.includes(0)) continue;
  const text = source.toString("utf8");
  for (const [reason, pattern] of patterns) {
    const match = pattern.exec(text);
    if (match) fail(file, `${reason} at line ${text.slice(0, match.index).split("\n").length}`);
  }
  if (/\.(?:m?js|ts)$/.test(file) && /(?:from\s*|import\s*\(|require\s*\()\s*["']@hedgeling\/(?:i18n|mcp-server|vscode)/.test(text)) {
    fail(file, "private implementation import");
  }
  if (file.endsWith("package.json")) {
    const manifest = JSON.parse(text);
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies })) {
      if (/^@hedgeling\//.test(name) && !allowed.has(name.split("/")[1])) fail(file, "private package dependency");
    }
  }
}
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
for (const [name, entry] of Object.entries(lock.packages)) {
  if (/^packages\//.test(name) && !allowed.has(name.split("/")[1])) fail("package-lock.json", "excluded workspace retained");
  if (entry.link && !/^packages\/(?:api-contract|platform-client|platform-mcp|design-system|web-console)$/.test(entry.resolved)) fail("package-lock.json", "workspace link outside public boundary");
  if (entry.resolved && !entry.link && !entry.resolved.startsWith("https://registry.npmjs.org/")) fail("package-lock.json", "non-public dependency source");
}
if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
else console.log(`Public boundary passed for ${new Set(files).size} files and ${allowed.size} packages.`);
