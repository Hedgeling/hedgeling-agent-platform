import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadEnv(file) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (!key || process.env[key] != null) continue;
    if (["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"].includes(key)) continue;
    value = value.replace(/\s+\\$/, "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function authorizationHeader() {
  const token = process.env.HEDGELING_CONSOLE_TOKEN?.trim();
  if (!token) throw new Error("Set HEDGELING_CONSOLE_TOKEN to a scoped bearer credential. Basic Auth has been removed.");
  return `Bearer ${token}`;
}

async function apiRequest(pathname, options = {}) {
  const baseUrl = process.env.HEDGELING_CONSOLE_URL?.replace(/\/+$/, "");
  if (!baseUrl) throw new Error("HEDGELING_CONSOLE_URL is required");
  const origin = new URL(baseUrl);
  if (origin.origin !== baseUrl || origin.username || origin.password
    || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new Error("HEDGELING_CONSOLE_URL must be an HTTPS origin, or loopback HTTP for local troubleshooting");
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      authorization: authorizationHeader(),
      "content-type": "application/json",
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const hint = response.status === 404
      ? " Provision the project first; API imports only update existing projects."
      : response.status === 401
        ? " Check that the bearer credential is active and has not expired."
        : response.status === 402
          ? " The project's organization needs an active subscription with state_imports."
          : response.status === 403
            ? " Check the service account's project scope, imports.run permission, and organization feature settings."
            : "";
    throw new Error(`${options.method || "GET"} ${pathname} failed (HTTP ${response.status}): ${body.error || response.statusText}.${hint}`);
  }
  return body;
}

function firstContext(entry) {
  return entry.contexts?.[0] || {};
}

function contextVariants(entry) {
  return (entry.contexts || []).flatMap((context) => {
    const locations = context.locations?.length ? context.locations : [{}];
    return locations.map((location) => ({
      shape: context.shape || null,
      purpose: context.purpose || null,
      visualContext: context.visualContext || null,
      file: location.file || null,
      codeContext: [location.file, location.line, location.kind].filter(Boolean).join(":") || null,
      uiContext: context.purpose || null,
      appStateContext: null,
      raw: { context, location },
    }));
  });
}

function catalogToState({ catalog, config, filename }) {
  const entries = {};
  for (const entry of catalog.entries || []) {
    if (!entry.key || !entry.source) continue;
    const context = firstContext(entry);
    entries[entry.key] = {
      sourceText: entry.source,
      shape: context.shape || null,
      purpose: context.purpose || null,
      visualContext: context.visualContext || null,
      limit: null,
      contextVariants: contextVariants(entry),
      analysis: {},
      translations: {},
    };
  }
  return {
    version: 1,
    locales: config.locales || [],
    files: {
      [filename]: {
        updatedAt: new Date().toISOString(),
        entries,
        sourceIndex: {},
      },
    },
  };
}

await loadEnv(path.resolve(".env"));
await loadEnv(path.resolve("../../.env"));

for (const name of ["HEDGELING_SOURCE_JSON", "HEDGELING_CONFIG_PATH", "HEDGELING_PROJECT_SLUG"]) {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required; use an explicit source catalog, locale config, and existing project`);
}
const sourceJsonPath = path.resolve(process.env.HEDGELING_SOURCE_JSON);
const configPath = path.resolve(process.env.HEDGELING_CONFIG_PATH);
const filename = process.env.HEDGELING_FILENAME || "public/i18n/source.html";
const projectSlug = process.env.HEDGELING_PROJECT_SLUG;
const projectName = process.env.HEDGELING_PROJECT_NAME || projectSlug;
const pruneMissing = process.env.HEDGELING_IMPORT_PRUNE_MISSING === "true";

const [catalog, config] = await Promise.all([
  fs.readFile(sourceJsonPath, "utf8").then(JSON.parse),
  fs.readFile(configPath, "utf8").then(JSON.parse),
]);

// Refuse catalogs written by a NEWER toolchain; files without
// schemaVersion are legacy version 1 and always accepted.
const SUPPORTED_CATALOG_SCHEMA_VERSION = 1;
if (typeof catalog?.schemaVersion === "number" && catalog.schemaVersion > SUPPORTED_CATALOG_SCHEMA_VERSION) {
  throw new Error(
    `catalog schemaVersion ${catalog.schemaVersion} is newer than this importer supports (max ${SUPPORTED_CATALOG_SCHEMA_VERSION}) — update the web-console`,
  );
}

const state = catalogToState({ catalog, config, filename });
const outputPath = process.env.HEDGELING_STATE_OUTPUT;
if (outputPath) {
  // Source-only bootstrap must never replace the repo's translated state.
  await fs.writeFile(path.resolve(outputPath), `${JSON.stringify(state, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(`Prepared ${Object.keys(state.files[filename].entries).length} source strings for ${projectSlug}`);
} else {
  const result = await apiRequest("/api/import-state", {
    method: "POST",
    body: JSON.stringify({
      projectSlug,
      projectName,
      state,
      overwriteHuman: false,
      pruneMissing,
    }),
  });

  console.log(`Imported ${Object.keys(state.files[filename].entries).length} source strings into ${projectName} (${projectSlug})`);
  if (pruneMissing) console.log("Pruned source strings missing from the current catalog");
  console.log(JSON.stringify(result.counts || result));
}
