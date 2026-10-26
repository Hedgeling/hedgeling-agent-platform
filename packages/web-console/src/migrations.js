import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withTransaction } from "./db.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const databaseDirectory = path.resolve(sourceDirectory, "..", "db");
const schemaPath = path.join(databaseDirectory, "schema.sql");
const migrationsDirectory = path.join(databaseDirectory, "migrations");
const baselineKey = "ordered-migrations-v1-baseline";
const migrationFilePattern = /^\d{8,14}_[a-z0-9][a-z0-9_-]*\.sql$/;

async function migrationFiles() {
  const entries = await fs.readdir(migrationsDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && migrationFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function checksum(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function allowBaseline() {
  return process.env.NODE_ENV !== "production"
    || process.env.HEDGELING_ALLOW_SCHEMA_BASELINE === "true";
}

export async function migrateDatabase() {
  const schema = await fs.readFile(schemaPath, "utf8");
  const files = await migrationFiles();
  return withTransaction(async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtext($1))",
      ["hedgeling:ordered-migrations-v1"],
    );
    const existing = await client.query(
      `select
         to_regclass('schema_migrations') is not null as "hasMigrations",
         to_regclass('organizations') is not null as "hasOrganizations"`,
    ).then((result) => result.rows[0]);

    if (!existing.hasMigrations) {
      if (existing.hasOrganizations && !allowBaseline()) {
        throw new Error(
          "Existing production database requires an explicit ordered-migration baseline; "
          + "run db:migrate in an approved maintenance window with "
          + "HEDGELING_ALLOW_SCHEMA_BASELINE=true",
        );
      }
      await client.query(schema);
    }

    let baseline = await client.query(
      "select metadata from schema_migrations where key = $1",
      [baselineKey],
    );
    if (!baseline.rows[0]) {
      if (!allowBaseline()) {
        throw new Error(
          "Production schema baseline is missing; run db:migrate in an approved "
          + "maintenance window with HEDGELING_ALLOW_SCHEMA_BASELINE=true",
        );
      }
      if (existing.hasMigrations) await client.query(schema);
      await client.query(
        `insert into schema_migrations(key, metadata)
         values($1, $2::jsonb)
         on conflict(key) do nothing`,
        [
          baselineKey,
          JSON.stringify({
            schemaSha256: checksum(schema),
            mechanism: "ordered-migrations-v1",
          }),
        ],
      );
      baseline = { rows: [{ metadata: { mechanism: "ordered-migrations-v1" } }] };
    }

    const applied = [];
    for (const file of files) {
      const sql = await fs.readFile(path.join(migrationsDirectory, file), "utf8");
      const migrationChecksum = checksum(sql);
      const key = `ordered:${file}`;
      const current = await client.query(
        "select metadata from schema_migrations where key = $1",
        [key],
      );
      if (current.rows[0]) {
        if (current.rows[0].metadata?.sha256 !== migrationChecksum) {
          throw new Error(`Applied migration ${file} has been modified`);
        }
        continue;
      }
      await client.query(sql);
      await client.query(
        `insert into schema_migrations(key, metadata)
         values($1, $2::jsonb)`,
        [
          key,
          JSON.stringify({ file, sha256: migrationChecksum }),
        ],
      );
      applied.push(file);
    }
    return {
      baseline: baselineKey,
      applied,
      available: files.length,
    };
  });
}
