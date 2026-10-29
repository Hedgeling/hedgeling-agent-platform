import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const databaseUrl = process.env.TEST_DATABASE_URL || process.argv[2];
if (!databaseUrl) throw new Error("TEST_DATABASE_URL must point to disposable loopback PostgreSQL");
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=2", fileURLToPath(new URL("../test/context-enrichment.integration.mjs", import.meta.url)), fileURLToPath(new URL("../test/translation-jobs.integration.mjs", import.meta.url)), fileURLToPath(new URL("../test/library.integration.mjs", import.meta.url)), fileURLToPath(new URL("../test/extraction-tuning.integration.mjs", import.meta.url)), fileURLToPath(new URL("../test/tuning-models.integration.mjs", import.meta.url)), fileURLToPath(new URL("../test/project-locales.integration.mjs", import.meta.url)), fileURLToPath(new URL("../test/extraction.integration.mjs", import.meta.url)), fileURLToPath(new URL("../test/agent-console.integration.mjs", import.meta.url)), fileURLToPath(new URL("../test/agent-access.integration.mjs", import.meta.url)), fileURLToPath(new URL("../test/reporting.integration.mjs", import.meta.url)), fileURLToPath(new URL("../test/workspace-management.integration.mjs", import.meta.url)), fileURLToPath(new URL("../test/commercial-console.integration.mjs", import.meta.url))], {
  env: { ...process.env, TEST_DATABASE_URL: databaseUrl, HEDGELING_REQUIRE_AGENT_TEST_DATABASE: "true" }, stdio: "inherit",
});
process.exitCode = result.status ?? 1;
