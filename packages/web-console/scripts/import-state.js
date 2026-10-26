import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

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

function awsSecretValue(secretId) {
  const args = [
    "secretsmanager",
    "get-secret-value",
    "--region",
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
    "--secret-id",
    secretId,
    "--query",
    "SecretString",
    "--output",
    "text",
  ];
  return execFileSync("aws", args, { encoding: "utf8" }).trim();
}

await loadEnv(path.resolve(".env"));
await loadEnv(path.resolve("../../.env"));

if (!process.env.DATABASE_URL) {
  const project = process.env.PROJECT || "hedgeling";
  const secretId = process.env.HEDGELING_DATABASE_URL_SECRET_ID || `${project}/DATABASE_URL`;
  process.env.DATABASE_URL = awsSecretValue(secretId);
}

process.env.DATABASE_SSL ??= "true";

const { withTransaction, pool } = await import("../src/db.js");
const { pruneMissingProjectSources } = await import("../src/import-pruning.js");
const { deriveStateDynamicFields, upsertDynamicSourceFields } = await import("../src/review-triage.js");

const workspaceRoot = process.env.HEDGELING_WORKSPACE_ROOT || process.cwd();
const statePath = process.env.HEDGELING_STATE_PATH || path.join(workspaceRoot, ".hedgeling", "hedgeling_package.json");
const projectSlug = process.env.HEDGELING_PROJECT_SLUG || "scroll-goblin";
const projectName = process.env.HEDGELING_PROJECT_NAME || "Scroll Goblin";
const overwriteHuman = process.env.HEDGELING_IMPORT_OVERWRITE_HUMAN === "true";
const pruneMissing = process.env.HEDGELING_IMPORT_PRUNE_MISSING === "true";

const state = JSON.parse(await fs.readFile(statePath, "utf8"));
// Spec 18 guard (mirrors @hedgeling/i18n core/schema.ts, which web-console does
// not depend on): refuse state files written by a NEWER toolchain; files
// without schemaVersion are legacy version 1 and always accepted.
// Spec 19 + P-02/P-06: state v2 is purely additive (optional per-locale
// `carriedFrom`, "needs-review"/"rejected" humanStatus, "mt"/"mt-carryover"
// sources, provider/model/confidence/reviewNote) — this importer persists the
// v2 fields and maps only unknown sources to "gemini", so v2 is fully
// supported.
const SUPPORTED_STATE_SCHEMA_VERSION = 2;
if (typeof state?.schemaVersion === "number" && state.schemaVersion > SUPPORTED_STATE_SCHEMA_VERSION) {
  throw new Error(
    `state schemaVersion ${state.schemaVersion} is newer than this importer supports (max ${SUPPORTED_STATE_SCHEMA_VERSION}) — update the web-console`,
  );
}
const counts = { translations: 0, translationRevisions: 0, preservedHumanTranslations: 0, preservedRejectedTranslations: 0, prunedSourceStrings: 0 };

// P-06 bug fix (kept in lockstep with src/server.js): 'mt' / 'mt-carryover'
// preserve P-02 non-Gemini provider provenance; only unknown/legacy values
// fall back to "gemini".
function normalizeTranslationSource(source) {
  if (source === "human" || source === "stub" || source === "mt" || source === "mt-carryover") return source;
  if (source === "manual-fix") return "human";
  return "gemini";
}

await withTransaction(async (client) => {
  const project = await client.query(
    `insert into projects(slug, name) values($1, $2)
     on conflict(slug) do update set name = excluded.name, updated_at = now()
     returning id`,
    [projectSlug, projectName],
  );
  const projectId = project.rows[0].id;
  const importedSourceHashes = new Set();

  for (const locale of state.locales || []) {
    await client.query(
      `insert into locales(project_id, locale) values($1, $2)
       on conflict(project_id, locale) do update set enabled = true`,
      [projectId, locale],
    );
  }

  // dynamic-data spec 08 (lockstep with src/server.js): one triage derivation
  // per source hash across the whole document; non-dynamic wins when a hash
  // appears in both a real file and a dynamic group.
  const dynamicFieldsByHash = deriveStateDynamicFields(state.files);

  for (const file of Object.values(state.files || {})) {
    for (const [sourceHash, entry] of Object.entries(file.entries || {})) {
      importedSourceHashes.add(sourceHash);
      const source = await client.query(
        `insert into source_strings(project_id, source_hash, source_text, shape, purpose, visual_context, limit_chars)
         values($1, $2, $3, $4, $5, $6, $7)
         on conflict(project_id, source_hash) do update
         set source_text = excluded.source_text,
             shape = excluded.shape,
             purpose = excluded.purpose,
             visual_context = excluded.visual_context,
             limit_chars = excluded.limit_chars,
             updated_at = now()
         returning id`,
        [projectId, sourceHash, entry.sourceText, entry.shape, entry.purpose, entry.visualContext || null, entry.limit || null],
      );
      const sourceId = source.rows[0].id;

      // dynamic-data spec 08 (lockstep with src/server.js): derived from the
      // pseudo-file scheme — never client-supplied.
      await upsertDynamicSourceFields(
        (sql, params) => client.query(sql, params),
        { sourceId, fields: dynamicFieldsByHash.get(sourceHash) },
      );

      await client.query("delete from context_variants where source_string_id = $1", [sourceId]);
      for (const variant of entry.contextVariants || []) {
        await client.query(
          `insert into context_variants(source_string_id, shape, purpose, visual_context, file_path, code_context, ui_context, app_state_context, raw)
           values($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            sourceId,
            variant.shape || null,
            variant.purpose || null,
            variant.visualContext || null,
            variant.file || null,
            variant.codeContext || null,
            variant.uiContext || null,
            variant.appStateContext || null,
            JSON.stringify(variant),
          ],
        );
      }

      for (const [passName, pass] of Object.entries(entry.analysis || {})) {
        if (passName !== "pass1" && passName !== "pass2") continue;
        await client.query(
          `insert into analysis_passes(source_string_id, pass_name, status, prompt_version, data, warning)
           values($1, $2, $3, $4, $5, $6)
           on conflict(source_string_id, pass_name) do update
           set status = excluded.status,
               prompt_version = excluded.prompt_version,
               data = excluded.data,
               warning = excluded.warning,
               updated_at = now()`,
          [sourceId, passName, pass.status || "ready", pass.promptVersion || "unknown", JSON.stringify(pass.data || {}), pass.warning || null],
        );
      }

      for (const [locale, translation] of Object.entries(entry.translations || {})) {
        const normalizedSource = normalizeTranslationSource(translation.source);
        const nextHumanStatus = translation.humanStatus || "pending";
        const nextMtStatus = translation.mtStatus || "ready";
        const nextUpdatedAt = translation.updatedAt || new Date().toISOString();
        // P-06: provider metadata + reviewer note ride along for the queue.
        const nextProvider = typeof translation.provider === "string" ? translation.provider : null;
        const nextModel = typeof translation.model === "string" ? translation.model : null;
        const nextConfidence = typeof translation.confidence === "number" ? translation.confidence : null;
        const nextReviewNote = typeof translation.reviewNote === "string" ? translation.reviewNote : null;
        const existing = await client.query(
          `select id, text, mt_status, human_status, source
           from translations
           where source_string_id = $1 and locale = $2`,
          [sourceId, locale],
        );
        const previous = existing.rows[0] || null;
        const result = await client.query(
          `insert into translations(source_string_id, locale, text, mt_status, human_status, source, provider, model, confidence, review_note, updated_at)
           values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           on conflict(source_string_id, locale) do update
           set text = excluded.text,
               mt_status = excluded.mt_status,
               human_status = excluded.human_status,
               source = excluded.source,
               provider = excluded.provider,
               model = excluded.model,
               confidence = excluded.confidence,
               review_note = excluded.review_note,
               updated_at = excluded.updated_at
           where $12::boolean
              or (
                translations.human_status != 'verified'
                -- P-06: a console rejection of THIS text is a pending review
                -- decision the CLI hasn't pulled yet — an import of the same
                -- text with an undecided status must not erase it.
                and not (
                  translations.human_status = 'rejected'
                  and translations.text = excluded.text
                  and excluded.human_status in ('pending', 'needs-review')
                )
              )
           returning id`,
          [
            sourceId,
            locale,
            translation.text,
            nextMtStatus,
            nextHumanStatus,
            normalizedSource,
            nextProvider,
            nextModel,
            nextConfidence,
            nextReviewNote,
            nextUpdatedAt,
            overwriteHuman,
          ],
        );
        if (result.rowCount === 0) {
          if (previous?.human_status === "rejected") counts.preservedRejectedTranslations += 1;
          else counts.preservedHumanTranslations += 1;
        }
        else {
          counts.translations += 1;
          const changed =
            !previous ||
            previous.text !== translation.text ||
            previous.mt_status !== nextMtStatus ||
            previous.human_status !== nextHumanStatus ||
            previous.source !== normalizedSource;
          if (changed) {
            await client.query(
              `insert into translation_revisions(
                 translation_id,
                 source_string_id,
                 locale,
                 previous_text,
                 next_text,
                 revision_source,
                 instruction,
                 prompt_snapshot,
                 created_at
               )
               values($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                result.rows[0].id,
                sourceId,
                locale,
                previous?.text || null,
                translation.text,
                normalizedSource,
                "Imported from Hedgeling state",
                JSON.stringify({
                  importer: "web-console/scripts/import-state.js",
                  sourceHash,
                  mtStatus: nextMtStatus,
                  humanStatus: nextHumanStatus,
                  source: normalizedSource,
                  provider: nextProvider,
                  model: nextModel,
                  confidence: nextConfidence,
                  importedUpdatedAt: nextUpdatedAt,
                }),
                nextUpdatedAt,
              ],
            );
            counts.translationRevisions += 1;
          }
        }
      }
    }
  }

  if (pruneMissing) {
    counts.prunedSourceStrings = await pruneMissingProjectSources(client, {
      projectId,
      importedSourceHashes,
      emptyImportMessage:
        "HEDGELING_IMPORT_PRUNE_MISSING requires at least one source string",
    });
  }
});

await pool.end();
console.log(`Imported Hedgeling state from ${statePath}`);
console.log(JSON.stringify(counts));
