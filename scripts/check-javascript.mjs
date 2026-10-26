import { readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "test-results", "playwright-report", ".git"].includes(entry.name)) continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) check(file);
    else if (/\.(m?js)$/.test(entry.name)) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
  }
}
check(resolve(process.argv[2] || "."));
