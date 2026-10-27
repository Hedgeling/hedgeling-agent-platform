import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const required = (name) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; };
const region = required("AWS_REGION");
const cluster = required("ECS_CLUSTER");
const service = required("ECS_SERVICE");
const family = required("ECS_TASK_FAMILY");
const containerName = required("ECS_CONTAINER_NAME");
const image = required("RELEASE_IMAGE");
const origin = new URL(required("DEMO_PUBLIC_ORIGIN"));
if (!/^hedgeling-demo(?:-[a-z0-9-]+)*$/.test(service) || !/^hedgeling-demo(?:-[a-z0-9-]+)*$/.test(family)) throw new Error("This workflow may only deploy the demo service and task family");
if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("DEMO_PUBLIC_ORIGIN must be an exact HTTPS origin");
const aws = (args) => JSON.parse(execFileSync("aws", [...args, "--region", region, "--output", "json"], { encoding: "utf8", env: { ...process.env, AWS_PAGER: "" } }) || "{}");
const account = aws(["sts", "get-caller-identity"]).Account;
if (!image.startsWith(`${account}.dkr.ecr.${region}.amazonaws.com/hedgeling-demo`) || !/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("A demo image digest in the current account is required");
if (process.env.AUTOMATIC_RELEASE === 'true') {
  const main = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { encoding: 'utf8' }).split(/\s/)[0];
  if (main !== process.env.RELEASE_SHA) { console.log('Skipping superseded automatic release.'); process.exit(0); }
}
const before = aws(["ecs", "describe-services", "--cluster", cluster, "--services", service]);
if (before.failures?.length || before.services?.length !== 1) throw new Error("Bootstrap the demo service before using the deployment workflow");
const current = before.services[0];
const task = aws(["ecs", "describe-task-definition", "--task-definition", current.taskDefinition]).taskDefinition;
if (task.family !== family) throw new Error("Service task family does not match the configured demo family");
const container = task.containerDefinitions.find((item) => item.name === containerName);
if (!container) throw new Error("Demo container not found");
container.image = image;
for (const key of ["taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities", "registeredAt", "registeredBy"]) delete task[key];
const folder = mkdtempSync(join(tmpdir(), "hedgeling-demo-release-"));
try {
  const filename = join(folder, "task.json");
  writeFileSync(filename, JSON.stringify(task), { mode: 0o600 });
  const next = aws(["ecs", "register-task-definition", "--cli-input-json", `file://${filename}`]).taskDefinition.taskDefinitionArn;
  aws(["ecs", "update-service", "--cluster", cluster, "--service", service, "--task-definition", next]);
  execFileSync("aws", ["ecs", "wait", "services-stable", "--region", region, "--cluster", cluster, "--services", service], { stdio: "inherit" });
  const after = aws(["ecs", "describe-services", "--cluster", cluster, "--services", service]).services[0];
  if (after.taskDefinition !== next || after.runningCount < 1 || after.runningCount !== after.desiredCount) throw new Error("ECS did not retain the requested release; check the deployment rollback events");
  const health = await fetch(new URL("/api/health", origin), { redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!health.ok) throw new Error("Deployed health check failed");
  const protectedRoute = await fetch(new URL("/api/agent/config", origin), { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(15000) });
  if (protectedRoute.status !== 401) throw new Error("Anonymous agent access was not rejected as expected");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Demo deployment is healthy; anonymous agent access is denied. Previous task revision: \`${current.taskDefinition.split("/").at(-1)}\`. Current: \`${next.split("/").at(-1)}\`.\n`);
  console.log("Demo deployment verified.");
} finally { rmSync(folder, { recursive: true, force: true }); }
