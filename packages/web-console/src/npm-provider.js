import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function required(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required for npm provisioning`);
  return normalized;
}

export function npmProvisioningConfiguration() {
  const organization = required(
    process.env.HEDGELING_NPM_ORGANIZATION,
    "HEDGELING_NPM_ORGANIZATION",
  ).replace(/^@/, "");
  const customerTeam = required(
    process.env.HEDGELING_NPM_CUSTOMER_TEAM,
    "HEDGELING_NPM_CUSTOMER_TEAM",
  ).replace(/^@/, "");
  if (customerTeam === `${organization}:developers` || customerTeam === "developers") {
    throw new Error(
      "Customer npm readers must use a dedicated team, not the default developers team",
    );
  }
  return {
    organization,
    customerTeam: customerTeam.includes(":")
      ? customerTeam
      : `${organization}:${customerTeam}`,
    packageName: required(
      process.env.HEDGELING_NPM_PACKAGE || "@hedgeling/i18n",
      "HEDGELING_NPM_PACKAGE",
    ),
    registry: process.env.HEDGELING_NPM_REGISTRY || "https://registry.npmjs.org/",
    token: required(process.env.HEDGELING_NPM_TOKEN, "HEDGELING_NPM_TOKEN"),
  };
}

export function npmProvisioningCommands(operation, username, config) {
  if (operation === "invite") {
    return [
      ["org", "set", config.organization, username, "developer"],
      ["team", "add", config.customerTeam, username],
    ];
  }
  if (operation === "revoke") {
    return [
      ["team", "rm", config.customerTeam, username],
      ["org", "rm", config.organization, username],
    ];
  }
  if (operation === "reconcile") {
    return [
      ["org", "ls", config.organization, username, "--json"],
      ["team", "ls", config.customerTeam, "--json"],
    ];
  }
  throw new Error(`Unsupported npm provisioning operation: ${operation}`);
}

function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-20000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-20000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const error = new Error(
        `npm exited ${code}: ${stderr.trim() || stdout.trim()}`,
      );
      error.exitCode = code;
      error.stdout = stdout;
      error.stderr = stderr;
      return reject(error);
    });
  });
}

export function isIdempotentNpmAbsence(operation, error) {
  if (operation !== "revoke") return false;
  const message = String(
    error?.stderr || error?.stdout || error?.message || "",
  );
  return (
    /\bnot (?:a )?member\b/i.test(message)
    || /\bis not in (?:the |this )?(?:team|org|organization)\b/i.test(message)
    || /\bno such (?:member|user)\b/i.test(message)
  );
}

export async function provisionNpmSeat(
  operation,
  username,
  config = npmProvisioningConfiguration(),
) {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "hedgeling-npm-"),
  );
  const userConfig = path.join(temporaryDirectory, "npmrc");
  const registryUrl = new URL(config.registry);
  const authPath = `${registryUrl.host}${registryUrl.pathname}`
    .replace(/\/+$/, "");
  await fs.writeFile(
    userConfig,
    [
      `registry=${registryUrl.toString()}`,
      `//${authPath}/:_authToken=${config.token}`,
      "fund=false",
      "audit=false",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const results = [];
  try {
    for (const args of npmProvisioningCommands(operation, username, config)) {
      try {
        results.push(await runCommand(
          process.env.HEDGELING_NPM_CLI || "npm",
          [...args, "--registry", config.registry, "--userconfig", userConfig],
          {
            ...process.env,
            NPM_CONFIG_USERCONFIG: userConfig,
          },
        ));
      } catch (error) {
        if (!isIdempotentNpmAbsence(operation, error)) throw error;
        results.push({
          stdout: error.stdout || "",
          stderr: error.stderr || "",
          idempotentAbsence: true,
        });
      }
    }
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
  return {
    operation,
    username,
    organization: config.organization,
    customerTeam: config.customerTeam,
    packageName: config.packageName,
    commandCount: results.length,
  };
}
