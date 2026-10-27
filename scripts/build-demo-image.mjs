import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const region = process.env.AWS_REGION;
const repository = process.env.ECR_REPOSITORY;
const sha = process.env.RELEASE_SHA;
const archive = process.env.RELEASE_ARCHIVE;
if (!archive) throw new Error('The image archive from successful CI is required');
if (!region || !/^hedgeling-demo(?:-[a-z0-9-]+)*$/.test(repository || "") || !/^[a-f0-9]{40}$/.test(sha || "")) throw new Error("Explicit demo repository, region and tested commit are required");
const aws = (args) => execFileSync("aws", [...args, "--region", region, "--output", "json"], { encoding: "utf8", env: { ...process.env, AWS_PAGER: "" } }).trim();
const account = JSON.parse(aws(["sts", "get-caller-identity"])).Account;
const registry = `${account}.dkr.ecr.${region}.amazonaws.com`;
const image = `${registry}/${repository}:${sha}`;
execFileSync('docker', ['load', '--input', archive], { stdio: 'inherit' });
const tested = `hedgeling-demo-tested:${sha}`;
const inspected = JSON.parse(execFileSync('docker', ['image', 'inspect', tested], { encoding: 'utf8' }))[0];
if (inspected.Config.Labels?.['org.opencontainers.image.revision'] !== sha || inspected.Architecture !== 'amd64') throw new Error('CI image revision or platform does not match the release');
const existing = spawnSync("aws", ["ecr", "describe-images", "--region", region, "--repository-name", repository, "--image-ids", `imageTag=${sha}`, "--output", "json"], { encoding: "utf8" });
if (existing.status !== 0) {
  if (!existing.stderr.includes("ImageNotFoundException")) throw new Error("Could not inspect the demo image repository");
  const password = execFileSync("aws", ["ecr", "get-login-password", "--region", region], { encoding: "utf8" });
  execFileSync("docker", ["login", "--username", "AWS", "--password-stdin", registry], { input: password, stdio: ["pipe", "inherit", "inherit"] });
  try {
    execFileSync("docker", ["tag", tested, image], { stdio: "inherit" });
    execFileSync("docker", ["push", image], { stdio: "inherit" });
  } finally {
    spawnSync("docker", ["logout", registry], { stdio: "ignore" });
  }
}
const details = JSON.parse(aws(["ecr", "describe-images", "--repository-name", repository, "--image-ids", `imageTag=${sha}`]));
const digest = details.imageDetails[0].imageDigest;
if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid image digest");
const uri = `${registry}/${repository}@${digest}`;
// ECR's config digest is the Docker image ID. Never reuse a tag containing a
// different rebuild of the same source commit.
const manifest = JSON.parse(aws(['ecr', 'batch-get-image', '--repository-name', repository, '--image-ids', `imageDigest=${digest}`]));
const configDigest = JSON.parse(manifest.images?.[0]?.imageManifest || '{}').config?.digest;
if (configDigest !== inspected.Id) throw new Error('Registry image differs from the container tested by CI');
if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
appendFileSync(process.env.GITHUB_OUTPUT, `uri=${uri}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Built or reused tested commit \`${sha}\` at immutable digest \`${digest}\`.\n`);
