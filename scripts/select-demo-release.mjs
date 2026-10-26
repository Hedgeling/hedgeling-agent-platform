import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const run = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
const requested = process.env.REQUESTED_REF || "main";
if (requested !== "main" && !/^[a-f0-9]{40}$/.test(requested)) throw new Error("Select main or a full commit SHA from main");
const sha = run("git", ["rev-parse", `${requested === "main" ? "origin/main" : requested}^{commit}`]);
run("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
const repository = process.env.GITHUB_REPOSITORY;
if (!repository) throw new Error("GITHUB_REPOSITORY is required");
const checks = JSON.parse(run("gh", ["api", `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=100`]));
if (!checks.workflow_runs.some((item) => item.head_sha === sha && item.head_repository?.full_name === repository && item.event === "push" && item.conclusion === "success")) {
  throw new Error("This commit has no successful Public platform checks run yet. Wait for CI, then deploy.");
}
run("git", ["checkout", "--detach", sha]);
if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
console.log(`Selected verified release ${sha}`);
