import actionsRouter from "./actions.js";
import { engineStatus } from "./hackathon-engine/engine-status.js";
import { localSignIn, requireLocalRequest } from "./local-auth.js";
import express from "express";
import agentRouter from "./agent-runtime.js";
import organizationAiRouter, { translationProvider, expireAiProposals } from "./organization-ai.js";
import billingConsoleRouter from "./billing-console.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, withTransaction } from "./db.js";
import {
  authenticationConfiguration,
  requireAuthentication,
  requirePlatformAdmin,
  requirePlatformOperationsAccess,
  validateAuthenticationConfiguration,
} from "./auth.js";
import accessAdminRouter from "./access-admin.js";
import {
  identityAdminRouter,
  identityPublicRouter,
} from "./enterprise-identity.js";
import {
  governanceRouter,
  platformGovernanceRouter,
} from "./governance.js";
import {
  scimAdminRouter,
  scimPublicRouter,
} from "./scim.js";
import serviceAccountsRouter from "./service-accounts.js";
import vendorAdminRouter from "./vendor-admin.js";
import { adminRouter as workAdminRouter, personalRouter as personalWorkRouter } from "./work-admin.js";
import { authRateLimit } from "./auth-rate-limit.js";
import {
  logRequestError,
  publicError,
  requestCorrelation,
  requestOutcomeTelemetry,
  requireSameOriginMutation,
  securityHeaders,
  validateHttpSecurityConfiguration,
} from "./http-security.js";
import { requireProjectEntitlement } from "./entitlements.js";
import { migrateDatabase } from "./migrations.js";
import {
  listAccessibleProjects,
  projectPermissions,
  requireProjectPermission,
} from "./authorization.js";
import {
  confirmSignUp,
  confirmPasswordReset,
  refreshSession,
  resendSignupCode,
  requestPasswordReset,
  respondToChallenge,
  signIn,
  signOut,
  signUp,
} from "./cognito-login.js";
import selfServiceRouter, { publicPlanCatalog } from "./self-service.js";
import entitlementLeasesRouter, {
  validateEntitlementLeaseConfiguration,
} from "./entitlement-leases.js";
import npmSeatsRouter from "./npm-seats.js";
import commercialSettingsRouter from "./commercial-settings.js";
import { stripeWebhook, validateStripeConfiguration } from "./stripe-billing.js";
import {
  facilitatedPaymentsWebhook,
  organizationPaymentsRouter,
  platformPaymentsRouter,
  validateFacilitatedPaymentsConfiguration,
} from "./facilitated-payments.js";
import {
  organizationMoneyRouter,
  platformMoneyRouter,
} from "./facilitated-money.js";
import { pruneMissingProjectSources } from "./import-pruning.js";
import {
  buildEnumGrid,
  bulkVerifyTranslations,
  deriveStateDynamicFields,
  facetCondition,
  isDataSourceFacet,
  normalizeSourceFacet,
  upsertDynamicSourceFields,
} from "./review-triage.js";
import {
  SYNC_CONTRACT_VERSION,
  pullSyncRows,
  readSyncStatus,
  recordSyncPullStatus,
  recordSyncPushStatus,
  resolveSyncPushProjectSlug,
  validateSyncPushPayload,
} from "./repo-sync.js";
import {
  geminiTokenMeasurements,
  measureText,
  mergeMeasurements,
  recordUsageEvent,
  releaseUsageReservation,
  reserveUsage,
  usageActor,
  usageIdentity,
} from "./usage.js";
import {
  calculateAiCredits,
  effectiveAiCreditPlanLimits,
  estimateAiCreditReservation,
  geminiBillableTokenUsage,
  geminiModelForPlan,
  loadActiveAiCreditRate,
} from "./ai-credits.js";
import { recordOrganizationResourceHighWater } from "./commercial-resources.js";
import { validateTrialPackageDownloadConfiguration } from "./trial-package-downloads.js";
import {
  dataLifecycleRouter,
  platformDataLifecycleRouter,
  validateDataLifecycleConfiguration,
} from "./data-lifecycle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 8080);
const trustedProxyHops = Number(process.env.HEDGELING_TRUST_PROXY_HOPS || 0);
if (trustedProxyHops > 0) app.set("trust proxy", trustedProxyHops);
app.disable("x-powered-by");
if (process.env.HEDGELING_AUTH_MODE === "local") app.use(requireLocalRequest);
app.use(requestCorrelation);
app.use(requestOutcomeTelemetry);
app.use(securityHeaders);
app.use(requireSameOriginMutation);

app.post(
  "/api/billing/stripe/webhook",
  express.raw({ type: "application/json", limit: "2mb" }),
  asyncRoute(stripeWebhook),
);
app.post(
  "/api/vendor-payments/stripe/webhook",
  express.raw({ type: "application/json", limit: "2mb" }),
  asyncRoute(facilitatedPaymentsWebhook),
);
app.use(express.json({
  limit: "75mb",
  type: ["application/json", "application/scim+json"],
}));

const authenticationIdentity = (req) => req.body?.username;
const loginVolumeLimit = authRateLimit({ key: "login-volume", limit: 100, headers: false });
const loginFailureLimit = authRateLimit({
  key: "login-failures",
  limit: 10,
  countFailuresOnly: true,
  identity: authenticationIdentity,
});
const challengeVolumeLimit = authRateLimit({ key: "challenge-volume", limit: 100, headers: false });
const challengeFailureLimit = authRateLimit({
  key: "challenge-failures",
  limit: 15,
  countFailuresOnly: true,
  identity: authenticationIdentity,
});
const signupVolumeLimit = authRateLimit({
  key: "signup-volume",
  limit: 30,
  headers: false,
});
const signupIdentityLimit = authRateLimit({
  key: "signup",
  limit: 8,
  identity: (req) => req.body?.email,
});
const signupConfirmationVolumeLimit = authRateLimit({
  key: "signup-confirm-volume",
  limit: 100,
  headers: false,
});
const signupConfirmationIdentityLimit = authRateLimit({
  key: "signup-confirm",
  limit: 12,
  identity: (req) => req.body?.email,
});
const signupResendVolumeLimit = authRateLimit({
  key: "signup-resend-volume",
  limit: 20,
  headers: false,
});
const signupResendIdentityLimit = authRateLimit({
  key: "signup-resend",
  limit: 4,
  identity: (req) => req.body?.email,
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

function sendIdempotencyResult(res, reservation, operationLabel) {
  if (reservation.replay?.responseBody != null && reservation.replay.responseStatus) {
    res.set("Idempotency-Replayed", "true");
    return res
      .status(reservation.replay.responseStatus)
      .json(reservation.replay.responseBody);
  }
  if (reservation.replay) {
    return res.status(409).json({
      error: `The original successful ${operationLabel} cannot be replayed because it predates stored idempotency responses`,
      code: "idempotency_replayed",
      usageEventId: reservation.replay.eventId,
      outcome: reservation.replay.outcome,
    });
  }
  return res.status(409).json({
    error: `This idempotent ${operationLabel} is still being processed`,
    code: "idempotency_in_progress",
    reservationId: reservation.id,
    attemptNumber: reservation.attemptNumber,
  });
}

// P-06 bug fix: since P-02, non-Gemini machine translations carry
// source "mt" (plus provider/model/confidence fields) and carry-overs use
// "mt-carryover" — both used to be flattened to "gemini", which mislabeled
// them in the UI and dropped the provenance the review queue depends on.
// Only unknown/legacy values fall back to "gemini" now.
function normalizeTranslationSource(source) {
  if (source === "human" || source === "stub" || source === "mt" || source === "mt-carryover") return source;
  if (source === "manual-fix") return "human";
  return "gemini";
}

function importedSourceFields(entry) {
  return {
    sourceText: entry.sourceText,
    shape: entry.shape || null,
    purpose: entry.purpose || null,
    visualContext: entry.visualContext || null,
    limitChars: entry.limit || null,
  };
}

function importedSourceChanged(existing, fields) {
  return !existing
    || existing.sourceText !== fields.sourceText
    || existing.shape !== fields.shape
    || existing.purpose !== fields.purpose
    || existing.visualContext !== fields.visualContext
    || existing.limitChars !== fields.limitChars;
}

async function measureChangedImportSources(projectId, state) {
  const entries = Object.values(state.files || {}).flatMap((file) => (
    Object.entries(file?.entries || {})
      .filter(([, entry]) => Boolean(entry?.sourceText))
      .map(([sourceHash, entry]) => ({ sourceHash, entry }))
  ));
  if (!entries.length) {
    return { source_words_processed: 0, source_characters_processed: 0 };
  }
  const existingResult = await query(
    `select source_hash as "sourceHash", source_text as "sourceText",
            shape, purpose, visual_context as "visualContext",
            limit_chars as "limitChars"
     from source_strings
     where project_id = $1 and source_hash = any($2::text[])`,
    [projectId, [...new Set(entries.map(({ sourceHash }) => sourceHash))]],
  );
  const existingByHash = new Map(
    existingResult.rows.map((row) => [row.sourceHash, row]),
  );
  return entries.reduce(
    (totals, { sourceHash, entry }) => {
      const fields = importedSourceFields(entry);
      if (!importedSourceChanged(existingByHash.get(sourceHash), fields)) return totals;
      const measurement = measureText(fields.sourceText, state.sourceLocale);
      totals.source_words_processed += measurement.words;
      totals.source_characters_processed += measurement.characters;
      existingByHash.set(sourceHash, fields);
      return totals;
    },
    { source_words_processed: 0, source_characters_processed: 0 },
  );
}

function geminiApiKey() {
  return process.env.HEDGELING_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || "";
}

function efficientGeminiModelName() {
  return geminiModelForPlan({ modelTier: "efficient" });
}

const cachedGeminiModels = new Map();
let geminiClientOverride = null;

export function setGeminiTestClient(client) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Gemini test client is only available in NODE_ENV=test");
  }
  geminiClientOverride = client;
}

function extractGeminiText(response) {
  return (response?.candidates ?? [])
    .flatMap((candidate) => candidate?.content?.parts ?? [])
    .map((part) => part?.text ?? "")
    .join("")
    .trim();
}

async function callGeminiText({
  system,
  user,
  model = efficientGeminiModelName(),
  maxOutputTokens = 2048,
  apiKey = null,
}) {
  if (geminiClientOverride) {
    return geminiClientOverride({ system, user, model, maxOutputTokens, apiKey });
  }
  const key = apiKey || geminiApiKey();
  if (!key) {
    const err = new Error("Gemini API key is not configured");
    err.status = 400;
    throw err;
  }

  const body = {
    contents: [{ role: "user", parts: [{ text: `${system}\n\n${user}` }] }],
    generationConfig: {
      maxOutputTokens,
    },
  };
  const candidates = [
    cachedGeminiModels.get(model),
    { apiVersion: "v1beta", model },
    { apiVersion: "v1", model },
  ].filter(Boolean);

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const result = await generateWithModel({ key, ...candidate, body });
      cachedGeminiModels.set(
        model,
        { apiVersion: candidate.apiVersion, model: result.model },
      );
      return result;
    } catch (err) {
      lastError = err;
      if (err.geminiStatus !== 404) throw err;
    }

  }

  throw lastError instanceof Error
    ? lastError
    : new Error("The configured Gemini model is not available");
}

async function fetchGeminiJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.HEDGELING_GEMINI_REQUEST_TIMEOUT_MS || 120000));
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: "error",
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    await response.body?.cancel();
    const err = new Error(`The Gemini service could not complete the request (${response.status}). Check provider access and try again.`);
    err.status = 502;
    err.geminiStatus = response.status;
    throw err;
  }

  return await response.json();
}

async function generateWithModel({ key, apiVersion, model, body }) {
  const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${encodeURIComponent(model)}:generateContent`;
  const raw = await fetchGeminiJson(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
  });

  const text = extractGeminiText(raw);
  if (!text) {
    const err = new Error("Gemini returned an empty revision");
    err.status = 502;
    throw err;
  }
  return { text, raw, model, apiVersion };
}

function cleanGeminiTranslation(text) {
  let trimmed = String(text || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isInvalidTranslationText(text) {
  const trimmed = String(text || "").trim();
  return !trimmed || /^\[[a-z]{2}(?:-[A-Z]{2})?\]\s*/.test(trimmed);
}

function extractPlaceholders(text) {
  return {
    tags: (String(text || "").match(/<\/?\d+>/g) ?? []).slice().sort(),
    values: (String(text || "").match(/\{[a-zA-Z0-9_]+\}/g) ?? []).slice().sort(),
  };
}

function placeholdersPreserved(source, translated) {
  const expected = extractPlaceholders(source);
  if (expected.tags.length === 0 && expected.values.length === 0) return true;
  const actual = extractPlaceholders(translated);
  return expected.tags.join("\u0000") === actual.tags.join("\u0000") &&
    expected.values.join("\u0000") === actual.values.join("\u0000");
}

// P-06: placeholder validation for review edits, matching the library's
// accept-loop semantics (state.ts placeholdersPreserved): every source
// {value} must be present — or satisfied by an ICU plural/select over the
// same variable (spec-12b plural expansion) — and inline tags must match
// exactly. Extra values in the translation are allowed. Returns null when
// valid, otherwise the specific validator message.
function reviewEditPlaceholderError(source, translated) {
  const expected = extractPlaceholders(source);
  if (expected.tags.length === 0 && expected.values.length === 0) return null;
  const actual = extractPlaceholders(translated);
  const actualValues = new Set(actual.values);
  const missing = expected.values.filter((value) => {
    if (actualValues.has(value)) return false;
    const name = value.slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`\\{${name}\\s*,\\s*(plural|select)\\s*,`, "i").test(String(translated || ""));
  });
  if (missing.length > 0) {
    return `placeholder_mismatch: the edit must preserve ${missing.join(", ")} exactly`;
  }
  if (expected.tags.join("\u0000") !== actual.tags.join("\u0000")) {
    return "placeholder_mismatch: every inline tag (<0>…</0>) from the source must be preserved exactly";
  }
  return null;
}

function containsGlossaryTerm(text, term) {
  if (!term) return false;
  if (/[^\p{L}\p{N}_]/u.test(term)) return String(text || "").includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = /^[A-Za-z0-9_]+$/.test(term) ? "A-Za-z0-9_" : "\\p{L}\\p{N}_";
  return new RegExp(`(^|[^${boundary}])${escaped}($|[^${boundary}])`, "iu").test(String(text || ""));
}

function glossaryViolation(sourceText, translatedText, locale, terms) {
  for (const term of terms) {
    if (term.locale && term.locale !== locale) continue;
    if (!containsGlossaryTerm(sourceText, String(term.term || ""))) continue;
    const required = term.doNotTranslate ? term.term : term.translation;
    if (required && !containsGlossaryTerm(translatedText, String(required))) {
      return `${term.term} -> ${required}`;
    }
  }
  return null;
}

function buildRevisionPrompt({
  source,
  locale,
  currentTranslation,
  instruction,
  contexts,
  analysis,
  prompts,
  persona,
  glossary,
}) {
  const system =
    "You are the final revision pass for Hedgeling, a localization pipeline for UI strings.\n" +
    "Revise exactly one translated UI string using the provided facts. Do not translate unrelated data.\n" +
    "Respect locale persona, style prompts, glossary, DNT rules, placeholders, layout constraints, and character limit.\n" +
    "Constraint priority rule: if the locale persona wants a longer joke but Pass 2 says the visual entropy budget is Very Tight or Tight, layout constraints win.\n" +
    "Preserve numbered markup tags like <0> and </0>, and placeholders like {name}, exactly.\n" +
    "Reject placeholder/stub formats such as [es-ES] Potion. Never output bracketed locale prefixes.\n" +
    "Output ONLY the final revised string. No notes, no markdown, no quotes.";

  const payload = {
    sourceString: source.sourceText,
    sourceHash: source.sourceHash,
    targetLocale: locale,
    currentTranslation: currentTranslation || "",
    revisionInstruction: instruction || "Improve the translation while preserving intent and constraints.",
    baseContext: {
      shape: source.shape,
      purpose: source.purpose,
      visualContext: source.visualContext,
      characterLimit: source.limitChars,
    },
    extractedContextVariants: contexts,
    semanticAnalysis: {
      pass1: analysis.pass1 || null,
      pass2: analysis.pass2 || null,
    },
    activeStylePrompts: prompts,
    localePersona: persona || null,
    glossaryTerms: glossary,
  };

  return {
    system,
    user: `Revise this translation using this JSON payload:\n${JSON.stringify(payload, null, 2)}`,
    promptSnapshot: payload,
  };
}

async function getProject(projectSlug = "scroll-goblin") {
  const result = await query("select * from projects where slug = $1", [projectSlug]);
  if (!result.rows[0]) throw Object.assign(new Error("Project not found"), { status: 404 });
  return result.rows[0];
}

export async function importHedgelingState({
  state,
  projectSlug = "scroll-goblin",
  projectName = "Scroll Goblin",
  overwriteHuman = false,
  pruneMissing = false,
  usageContext = null,
  resourceLimits = {},
  // v1.3.0 spec 10: the sync push route stamps its revisions "sync" so the
  // revision log distinguishes the sanctioned transport from ad-hoc imports.
  revisionSource = null,
}) {
  if (!state || typeof state !== "object" || !state.files || typeof state.files !== "object") {
    const err = new Error("state must be a Hedgeling hedgeling_package.json object");
    err.status = 400;
    throw err;
  }
  // Spec 18 guard (19R P3-4): mirrors scripts/import-state.js — refuse state
  // files written by a NEWER toolchain; files without schemaVersion are
  // legacy version 1 and always accepted. Keep in lockstep with the script.
  const SUPPORTED_STATE_SCHEMA_VERSION = 2;
  if (typeof state.schemaVersion === "number" && state.schemaVersion > SUPPORTED_STATE_SCHEMA_VERSION) {
    const err = new Error(
      `state schemaVersion ${state.schemaVersion} is newer than this importer supports (max ${SUPPORTED_STATE_SCHEMA_VERSION}) — update the web-console`,
    );
    err.status = 400;
    throw err;
  }

  const counts = {
    locales: 0,
    sourceStrings: 0,
    meteredSourceStrings: 0,
    contextVariants: 0,
    analysisPasses: 0,
    translations: 0,
    translationRevisions: 0,
    preservedHumanTranslations: 0,
    preservedRejectedTranslations: 0,
    prunedSourceStrings: 0,
  };
  const usageItems = [];
  const sourceLocale = typeof state.sourceLocale === "string" ? state.sourceLocale : null;
  const importedSourceHashesForLimit = new Set();
  const importedLocalesForLimit = new Set(
    (Array.isArray(state.locales) ? state.locales : [])
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim()),
  );
  for (const file of Object.values(state.files || {})) {
    for (const [sourceHash, entry] of Object.entries(file?.entries || {})) {
      if (!entry?.sourceText) continue;
      importedSourceHashesForLimit.add(sourceHash);
      for (const targetLocale of Object.keys(entry.translations || {})) {
        if (targetLocale.trim()) importedLocalesForLimit.add(targetLocale.trim());
      }
    }
  }
  if (sourceLocale) importedLocalesForLimit.delete(sourceLocale);

  await withTransaction(async (client) => {
    const project = await client.query(
      `insert into projects(slug, name) values($1, $2)
       on conflict(slug) do update set name = excluded.name, updated_at = now()
       returning id`,
      [projectSlug, projectName],
    );
    const projectId = project.rows[0].id;
    if (pruneMissing) {
      counts.prunedSourceStrings = await pruneMissingProjectSources(client, {
        projectId,
        importedSourceHashes: importedSourceHashesForLimit,
      });
    }
    const activeSourceStringLimit = Number(resourceLimits.activeSourceStrings);
    const targetLocaleLimit = Number(resourceLimits.targetLocales);
    if (
      usageContext?.organizationId
      && (
        Number.isSafeInteger(activeSourceStringLimit)
        || Number.isSafeInteger(targetLocaleLimit)
      )
    ) {
      await client.query(
        "select pg_advisory_xact_lock(hashtext($1))",
        [`resource-limit:${usageContext.organizationId}`],
      );
    }
    if (usageContext?.organizationId && Number.isSafeInteger(activeSourceStringLimit)) {
      const [organizationCount, existingImported] = await Promise.all([
        client.query(
          `select count(*)::integer as count
           from source_strings source
           join projects owned_project on owned_project.id = source.project_id
           join business_units unit on unit.id = owned_project.business_unit_id
           where unit.organization_id = $1
             and owned_project.data_purged_at is null`,
          [usageContext.organizationId],
        ),
        importedSourceHashesForLimit.size
          ? client.query(
            `select count(*)::integer as count
             from source_strings
             where project_id = $1 and source_hash = any($2::text[])`,
            [projectId, [...importedSourceHashesForLimit]],
          )
          : Promise.resolve({ rows: [{ count: 0 }] }),
      ]);
      const projected = Number(organizationCount.rows[0].count)
        + importedSourceHashesForLimit.size
        - Number(existingImported.rows[0].count);
      if (projected > activeSourceStringLimit) {
        throw Object.assign(
          new Error(
            `This import would exceed the plan limit of ${activeSourceStringLimit} active source strings`,
          ),
          { status: 402, code: "resource_limit_exceeded" },
        );
      }
    }
    if (usageContext?.organizationId && Number.isSafeInteger(targetLocaleLimit)) {
      const existingLocales = await client.query(
        `select distinct locale.locale
         from locales locale
         join projects owned_project on owned_project.id = locale.project_id
         join business_units unit on unit.id = owned_project.business_unit_id
         where unit.organization_id = $1 and locale.enabled = true`,
        [usageContext.organizationId],
      );
      const projectedLocales = new Set([
        ...existingLocales.rows.map((row) => row.locale.toLowerCase()),
        ...[...importedLocalesForLimit].map((value) => value.toLowerCase()),
      ]);
      if (projectedLocales.size > targetLocaleLimit) {
        throw Object.assign(
          new Error(
            `This import would exceed the plan limit of ${targetLocaleLimit} target locales`,
          ),
          { status: 402, code: "resource_limit_exceeded" },
        );
      }
    }

    for (const locale of state.locales || []) {
      if (typeof locale !== "string" || !locale.trim()) continue;
      await client.query(
        `insert into locales(project_id, locale) values($1, $2)
         on conflict(project_id, locale) do update set enabled = true`,
        [projectId, locale.trim()],
      );
      counts.locales += 1;
    }

    // dynamic-data spec 08: one triage derivation per source hash across the
    // whole document (non-dynamic wins when a hash appears in both a real
    // file and a dynamic group) — derived from the pseudo-file scheme, never
    // client-supplied.
    const dynamicFieldsByHash = deriveStateDynamicFields(state.files);

    for (const file of Object.values(state.files || {})) {
      for (const [sourceHash, entry] of Object.entries(file?.entries || {})) {
        if (!entry?.sourceText) continue;
        const sourceFields = importedSourceFields(entry);
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
           where (
             source_strings.source_text,
             source_strings.shape,
             source_strings.purpose,
             source_strings.visual_context,
             source_strings.limit_chars
           ) is distinct from (
             excluded.source_text,
             excluded.shape,
             excluded.purpose,
             excluded.visual_context,
             excluded.limit_chars
           )
           returning id`,
          [
            projectId,
            sourceHash,
            sourceFields.sourceText,
            sourceFields.shape,
            sourceFields.purpose,
            sourceFields.visualContext,
            sourceFields.limitChars,
          ],
        );
        counts.sourceStrings += 1;
        const sourceChanged = Boolean(source.rows[0]);
        const sourceId = source.rows[0]?.id || await client.query(
          `select id from source_strings
           where project_id = $1 and source_hash = $2`,
          [projectId, sourceHash],
        ).then((result) => result.rows[0].id);
        if (sourceChanged) {
          counts.meteredSourceStrings += 1;
          const sourceMeasurement = measureText(entry.sourceText, sourceLocale);
          usageItems.push({
            sourceStringId: sourceId,
            sourceLocale,
            sourceWords: sourceMeasurement.words,
            sourceCharacters: sourceMeasurement.characters,
            metadata: { sourceHash },
          });
        }

        // dynamic-data spec 08: upsert the derived triage columns SEPARATELY
        // from the metered text-field upsert — reach must refresh on every
        // push without a reach-only change looking like a source-text change
        // to billing.
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
          counts.contextVariants += 1;
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
            [
              sourceId,
              passName,
              pass.status || "ready",
              pass.promptVersion || "unknown",
              JSON.stringify(pass.data || {}),
              pass.warning || null,
            ],
          );
          counts.analysisPasses += 1;
        }

        for (const [locale, translation] of Object.entries(entry.translations || {})) {
          if (!translation?.text) continue;
          const normalizedSource = normalizeTranslationSource(translation.source);
          const nextHumanStatus = translation.humanStatus || "pending";
          const nextMtStatus = translation.mtStatus || "ready";
          const nextUpdatedAt = translation.updatedAt || new Date().toISOString();
          // P-06: P-02 provider metadata + reviewer note ride along so the
          // review queue can surface provenance and confidence.
          const nextProvider = typeof translation.provider === "string" ? translation.provider : null;
          const nextModel = typeof translation.model === "string" ? translation.model : null;
          const nextConfidence = typeof translation.confidence === "number" ? translation.confidence : null;
          const nextReviewNote = typeof translation.reviewNote === "string" ? translation.reviewNote : null;
          const existing = await client.query(
            `select id, text, mt_status, human_status, source,
                    provider, model, confidence, review_note
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
                  -- decision the CLI hasn't pulled yet. An import of the same
                  -- text with an undecided status must not erase it; once the
                  -- state carries a new text (regeneration) or its own review
                  -- decision, the import wins again.
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
              Boolean(overwriteHuman),
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
                  revisionSource || normalizedSource,
                  revisionSource === "sync" ? "Pushed from the repo via hedgeling sync" : "Imported from Hedgeling state",
                  JSON.stringify({
                    importer: revisionSource === "sync" ? "web-console sync push API" : "web-console import API",
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

    if (usageContext?.organizationId) {
      const activeStrings = await client.query(
        `select count(*)::integer as count
         from source_strings source
         join projects owned_project on owned_project.id = source.project_id
         join business_units unit on unit.id = owned_project.business_unit_id
         where unit.organization_id = $1
           and owned_project.data_purged_at is null`,
        [usageContext.organizationId],
      );
      await recordOrganizationResourceHighWater(client, {
        organizationId: usageContext.organizationId,
        resourceKey: "managed_strings",
        observedQuantity: activeStrings.rows[0].count,
        metadata: {
          method: "monthly_organization_high_water",
          source: "state_import",
          projectId,
        },
      });
    }

    if (usageContext) {
      const responseBody = {
        ok: true,
        counts,
        usageWarnings: usageContext.usageWarnings || [],
      };
      await recordUsageEvent({
        client,
        ...usageContext,
        operation: "state_import",
        outcome: "succeeded",
        responseStatus: 200,
        responseBody,
        measurements: {
          source_words_processed: usageItems.reduce(
            (total, item) => total + item.sourceWords,
            0,
          ),
          source_characters_processed: usageItems.reduce(
            (total, item) => total + item.sourceCharacters,
            0,
          ),
        },
        items: usageItems,
        metadata: {
          sourceLocale,
          importedFiles: Object.keys(state.files || {}).length,
          overwriteHuman,
          pruneMissing,
        },
      });
    }
  });

  return counts;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/ready", asyncRoute(async (_req, res) => {
  try {
    await query("select 1");
  } catch (cause) {
    throw Object.assign(
      new Error(`Database readiness check failed: ${cause?.message || "unknown error"}`),
      {
        status: 503,
        code: "service_not_ready",
        publicMessage: "Service is not ready",
      },
    );
  }
  res.json({ ok: true, database: "ready" });
}));

app.get("/api/auth/config", (_req, res) => {
  res.json(authenticationConfiguration());
});
app.get("/api/billing/plans", asyncRoute(publicPlanCatalog));

app.get("/login", (_req, res) => process.env.HEDGELING_AUTH_MODE === "local"
  ? res.redirect(302, "/local-login")
  : res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/signup", (_req, res) => res.sendFile(path.join(__dirname, "public", "signup.html")));
app.get("/login.css", (_req, res) => res.sendFile(path.join(__dirname, "public", "login.css")));
app.get("/login.js", (_req, res) => res.sendFile(path.join(__dirname, "public", "login.js")));
app.get("/signup.css", (_req, res) => res.sendFile(path.join(__dirname, "public", "signup.css")));
app.get("/signup.js", (_req, res) => res.sendFile(path.join(__dirname, "public", "signup.js")));
app.get("/theme.js", (_req, res) => res.sendFile(path.join(__dirname, "public", "theme.js")));
app.get("/hedgeling-logo.png", (_req, res) => res.sendFile(path.join(__dirname, "public", "hedgeling-logo.png")));
app.get("/design-system/theme.css", (_req, res) => res.sendFile(path.resolve(__dirname, "..", "..", "design-system", "theme.css")));
app.get("/design-system/brand.json", (_req, res) => res.sendFile(path.resolve(__dirname, "..", "..", "design-system", "brand.json")));
app.get(["/design-system/tokens.json", "/tokens.json"], (_req, res) => res.sendFile(path.resolve(__dirname, "..", "..", "design-system", "tokens.json")));
app.use("/design-system/assets", express.static(path.resolve(__dirname, "..", "..", "design-system", "assets"), { index: false, dotfiles: "deny" }));
app.post("/api/auth/login", loginVolumeLimit, loginFailureLimit, asyncRoute(signIn));
app.post(
  "/api/auth/signup",
  signupVolumeLimit,
  signupIdentityLimit,
  asyncRoute(signUp),
);
app.post(
  "/api/auth/signup/confirm",
  signupConfirmationVolumeLimit,
  signupConfirmationIdentityLimit,
  asyncRoute(confirmSignUp),
);
app.post(
  "/api/auth/signup/resend",
  signupResendVolumeLimit,
  signupResendIdentityLimit,
  asyncRoute(resendSignupCode),
);
app.post("/api/auth/challenge", challengeVolumeLimit, challengeFailureLimit, asyncRoute(respondToChallenge));
app.post("/api/auth/refresh", authRateLimit({ key: "refresh", limit: 60 }), asyncRoute(refreshSession));
app.post("/api/auth/password-reset/request", authRateLimit({ key: "password-reset-request", limit: 5 }), asyncRoute(requestPasswordReset));
app.post("/api/auth/password-reset/confirm", authRateLimit({ key: "password-reset-confirm", limit: 10 }), asyncRoute(confirmPasswordReset));
app.post("/api/auth/refresh/logout", asyncRoute(signOut));
app.use(
  "/api/auth",
  authRateLimit({ key: "enterprise-sso", limit: 300 }),
  identityPublicRouter,
);
app.use("/scim/v2", scimPublicRouter);

if (process.env.HEDGELING_AUTH_MODE === "local") {
  app.get("/local-login", (_req, res) => res.sendFile(path.join(__dirname, "public", "local-login.html")));
  app.get("/local-login.js", (_req, res) => res.sendFile(path.join(__dirname, "public", "local-login.js")));
  app.post("/api/auth/local", authRateLimit({ key: "local-login", limit: 10 }), asyncRoute(localSignIn));
}
app.use(requireAuthentication);
app.get(
  "/onboarding",
  (_req, res) => res.sendFile(path.join(__dirname, "public", "onboarding.html")),
);
app.get(
  "/operations",
  requirePlatformOperationsAccess,
  (_req, res) => res.sendFile(path.join(__dirname, "operator-ui", "operations.html")),
);
app.get(
  "/operations.css",
  requirePlatformOperationsAccess,
  (_req, res) => res.sendFile(path.join(__dirname, "operator-ui", "operations.css")),
);
app.get(
  "/operations.js",
  requirePlatformOperationsAccess,
  (_req, res) => res.sendFile(path.join(__dirname, "operator-ui", "operations.js")),
);
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/me", (req, res) => {
  res.json({ auth: req.auth });
});

app.get("/api/platform/engine-status", requirePlatformAdmin, asyncRoute(async (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(await engineStatus());
}));

app.use("/api/actions", actionsRouter);
app.use("/api/agent", authRateLimit({ key: "agent-console", limit: 300, identity: (req) => req.auth?.user?.id }), agentRouter);
app.use("/api/onboarding", selfServiceRouter);
app.use("/api", entitlementLeasesRouter);
app.use("/api/access", accessAdminRouter);
app.use("/api/access", billingConsoleRouter);
app.use("/api/access", organizationAiRouter);
app.use("/api/access", identityAdminRouter);
app.use("/api/access", scimAdminRouter);
app.use("/api/access", serviceAccountsRouter);
app.use("/api/access", npmSeatsRouter);
app.use("/api/access", commercialSettingsRouter);
app.use("/api/access", governanceRouter);
app.use("/api/access", vendorAdminRouter);
app.use("/api/access", workAdminRouter);
app.use("/api/access", dataLifecycleRouter);
app.use("/api/access", organizationPaymentsRouter);
app.use("/api/access", organizationMoneyRouter);
app.use("/api/work", personalWorkRouter);
app.use("/api/platform", platformGovernanceRouter);
app.use("/api/platform", platformPaymentsRouter);
app.use("/api/platform", platformMoneyRouter);
app.use("/api/platform", platformDataLifecycleRouter);

app.get("/api/projects", asyncRoute(async (req, res) => {
  res.json({ projects: await listAccessibleProjects(req.auth) });
}));

app.get("/api/projects/:slug/permissions", requireProjectPermission("strings.view", { ignoreLocale: true }), asyncRoute(async (req, res) => {
  res.json({
    permissions: await projectPermissions(req.auth, req.authorizedProject, {
      locale: String(req.query.locale || "").trim() || null,
    }),
  });
}));

app.get("/api/projects/default", requireProjectPermission("strings.view", { ignoreLocale: true }), asyncRoute(async (req, res) => {
  res.json(await getProject(String(req.query.project || "scroll-goblin")));
}));

app.get("/api/projects/:slug", requireProjectPermission("strings.view", { ignoreLocale: true }), asyncRoute(async (req, res) => {
  res.json(await getProject(req.params.slug));
}));

app.get("/api/locales", requireProjectPermission("locales.view", { ignoreLocale: true }), asyncRoute(async (req, res) => {
  const project = await getProject(String(req.query.project || "scroll-goblin"));
  const result = await query(
    "select locale, enabled from locales where project_id = $1 order by locale",
    [project.id],
  );
  // Phase 2 favors the canonical permission evaluator over duplicated SQL. This
  // is one query per configured locale and should become set-based at larger scale.
  const localesWithAccess = [];
  for (const locale of result.rows) {
    const permissions = await projectPermissions(req.auth, req.authorizedProject, { locale: locale.locale });
    if (permissions.includes("strings.view")) localesWithAccess.push(locale);
  }
  res.json({ locales: localesWithAccess });
}));

app.get(
  "/api/export-verified",
  requireProjectPermission("exports.run", { localeListQuery: "locales" }),
  requireProjectEntitlement("verified_exports"),
  asyncRoute(async (req, res) => {
  const projectSlug = String(req.query.project || "scroll-goblin");
  const locales = String(req.query.locales || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const hashes = String(req.query.hashes || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  // P-06: when the CLI asks for review decisions too (includeRejected=true),
  // rejected rows ride along with their reviewer note so `hedgeling pull` can
  // stamp the rejection into state and the next translate run regenerates
  // them. Old clients never send the flag and keep the verified-only contract.
  const includeRejected = String(req.query.includeRejected || "") === "true";
  // The export matches on STATUS, not provenance: approving a machine
  // translation keeps its source ('mt'/'gemini' — "verified mt" stays
  // distinguishable from a human rewrite), so filtering on source = 'human'
  // here would strand console approvals of MT — the row never exports, the
  // local record stays unverified, and `check --require-verified` keeps
  // failing. `t.source` rides along so `hedgeling pull` preserves provenance.
  const params = [projectSlug];
  const filters = [
    "p.slug = $1",
    includeRejected
      ? "(t.human_status = 'verified' or t.human_status = 'rejected')"
      : "t.human_status = 'verified'",
  ];
  if (locales.length > 0) {
    params.push(locales);
    filters.push(`t.locale = any($${params.length}::text[])`);
  }
  if (hashes.length > 0) {
    params.push(hashes);
    filters.push(`s.source_hash = any($${params.length}::text[])`);
  }

  const result = await query(
    `
      select
        s.source_hash as "sourceHash",
        s.source_text as "sourceText",
        t.locale,
        t.text,
        t.source,
        t.human_status as "humanStatus",
        t.review_note as "reviewNote",
        t.updated_at as "updatedAt"
      from translations t
      join source_strings s on s.id = t.source_string_id
      join projects p on p.id = s.project_id
      where ${filters.join(" and ")}
      order by t.locale, s.source_hash
    `,
    params,
  );
  res.json({ translations: result.rows });
  }),
);

app.get("/api/stats", requireProjectPermission("strings.view"), asyncRoute(async (req, res) => {
  const project = await getProject(String(req.query.project || "scroll-goblin"));
  const locale = String(req.query.locale || "");
  const result = await query(
    `
      select
        count(*)::int as "totalStrings",
        count(t.id)::int as "translatedStrings",
        count(*) filter (where t.id is null)::int as "missingStrings",
        count(*) filter (where coalesce(t.human_status, 'pending') = 'pending')::int as "pendingStrings",
        count(*) filter (where t.human_status = 'verified')::int as "verifiedStrings",
        count(*) filter (where t.human_status = 'needs-review')::int as "needsReviewStrings",
        count(*) filter (where t.human_status = 'rejected')::int as "rejectedStrings",
        count(*) filter (where ap1.status = 'degraded' or ap2.status = 'degraded')::int as "degradedStrings"
      from source_strings s
      left join translations t on t.source_string_id = s.id and ($2::text is null or t.locale = $2)
      left join analysis_passes ap1 on ap1.source_string_id = s.id and ap1.pass_name = 'pass1'
      left join analysis_passes ap2 on ap2.source_string_id = s.id and ap2.pass_name = 'pass2'
      where s.project_id = $1
    `,
    [project.id, locale || null],
  );
  res.json({ stats: result.rows[0] });
}));

app.post(
  "/api/import-state",
  requireProjectPermission("imports.run"),
  requireProjectEntitlement("state_imports"),
  asyncRoute(async (req, res) => {
  const state = req.body.state || req.body;
  const projectSlug = String(req.body.projectSlug || "scroll-goblin");
  const projectName = String(req.body.projectName || "Scroll Goblin");
  const overwriteHuman = req.body.overwriteHuman === true || process.env.HEDGELING_IMPORT_OVERWRITE_HUMAN === "true";
  const pruneMissing = req.body.pruneMissing === true || process.env.HEDGELING_IMPORT_PRUNE_MISSING === "true";
  const identity = usageIdentity(req, "state_import", {
    state,
    projectSlug,
    projectName,
    overwriteHuman,
    pruneMissing,
  });
  const importMeasurements = await measureChangedImportSources(
    req.authorizedProject.id,
    state,
  );
  const reservation = await reserveUsage({
    organizationId: req.authorizedProject.organizationId,
    businessUnitId: req.authorizedProject.businessUnitId,
    projectId: req.authorizedProject.id,
    operation: "state_import",
    ...identity,
    measurements: importMeasurements,
    relevantMetrics: Object.entries(importMeasurements)
      .filter(([, quantity]) => quantity > 0)
      .map(([metricKey]) => metricKey),
    planLimits: req.commercialAccess?.limits,
  });
  if (reservation.duplicate) {
    return sendIdempotencyResult(res, reservation, "import request");
  }
  let counts;
  try {
    counts = await importHedgelingState({
      state,
      projectSlug,
      projectName,
      overwriteHuman,
      pruneMissing,
      usageContext: {
        organizationId: req.authorizedProject.organizationId,
        businessUnitId: req.authorizedProject.businessUnitId,
        projectId: req.authorizedProject.id,
        actor: usageActor(req.auth),
        reservationId: reservation.id,
        attemptNumber: reservation.attemptNumber,
        usageWarnings: reservation.warnings,
        ...identity,
      },
      resourceLimits: req.commercialAccess?.limits?.resources || {},
    });
  } catch (error) {
    await releaseUsageReservation(reservation.id).catch(() => {});
    throw error;
  }
  res.json({ ok: true, counts, usageWarnings: reservation.warnings });
  }),
);

// ---- v1.3.0 spec 10: console ↔ repo state sync (bulk routes) ----------------------
// Contract documented in src/repo-sync.js beside the payload/query helpers.
// Push consumes the manage-tier import permission (imports.run — the console's
// "strings.manage" tier) + the state_imports entitlement, mirroring
// /api/import-state's metering so sync is never a billing bypass. Push ALWAYS
// prunes console rows for keys absent from the pushed state
// (pruneMissingProjectSources semantics, work-order conflicts → 409) and never
// overwrites console human truth (the field-ownership law — overwriteHuman is
// not accepted from the payload). Revisions are recorded with
// revision_source "sync".
app.post(
  "/api/sync/push",
  requireProjectPermission("imports.run"),
  requireProjectEntitlement("state_imports"),
  asyncRoute(async (req, res) => {
  const payload = validateSyncPushPayload(req.body);
  // No default project (unlike the seed-era routes above): a caller omitting
  // the slug gets a 400, and a body slug differing from the slug the caller
  // was AUTHORIZED for (the middleware prefers ?project=) is rejected too.
  const projectSlug = resolveSyncPushProjectSlug(payload, {
    queryProject: req.query.project,
    authorizedSlug: req.authorizedProject.slug,
  });
  const projectName = payload.projectName || projectSlug;
  const identity = usageIdentity(req, "state_import", {
    state: payload.state,
    projectSlug,
    projectName,
    overwriteHuman: false,
    pruneMissing: true,
  });
  const importMeasurements = await measureChangedImportSources(
    req.authorizedProject.id,
    payload.state,
  );
  const reservation = await reserveUsage({
    organizationId: req.authorizedProject.organizationId,
    businessUnitId: req.authorizedProject.businessUnitId,
    projectId: req.authorizedProject.id,
    operation: "state_import",
    ...identity,
    measurements: importMeasurements,
    relevantMetrics: Object.entries(importMeasurements)
      .filter(([, quantity]) => quantity > 0)
      .map(([metricKey]) => metricKey),
    planLimits: req.commercialAccess?.limits,
  });
  if (reservation.duplicate) {
    return sendIdempotencyResult(res, reservation, "sync push request");
  }
  let counts;
  try {
    counts = await importHedgelingState({
      state: payload.state,
      projectSlug,
      projectName,
      overwriteHuman: false,
      pruneMissing: true,
      revisionSource: "sync",
      usageContext: {
        organizationId: req.authorizedProject.organizationId,
        businessUnitId: req.authorizedProject.businessUnitId,
        projectId: req.authorizedProject.id,
        actor: usageActor(req.auth),
        reservationId: reservation.id,
        attemptNumber: reservation.attemptNumber,
        usageWarnings: reservation.warnings,
        ...identity,
      },
      resourceLimits: req.commercialAccess?.limits?.resources || {},
    });
  } catch (error) {
    await releaseUsageReservation(reservation.id).catch(() => {});
    throw error;
  }
  // Operational visibility + last-writer detection: record WHEN/WHAT/WHO
  // pushed, and compare the CLI's declared base (the hash its committed
  // cursor says it built on) against what this console last accepted. A
  // mismatch means another writer pushed in between (two repos, a fork with
  // a stale cursor) — surfaced as `staleBase`, a warning rather than a 409,
  // because the import already applied under the never-overwrite-human law
  // and older CLIs send no baseStateHash at all.
  const syncStatus = await recordSyncPushStatus(query, {
    projectId: req.authorizedProject.id,
    stateHash: payload.stateHash,
    baseStateHash: payload.baseStateHash,
    actor: usageActor(req.auth),
  });
  res.json({
    version: SYNC_CONTRACT_VERSION,
    ok: true,
    counts,
    projectId: req.authorizedProject.id,
    stateHash: payload.stateHash,
    ...(syncStatus.staleBase
      ? { staleBase: true, previousStateHash: syncStatus.previousStateHash }
      : {}),
    usageWarnings: reservation.warnings,
  });
  }),
);

// Pull: console human truth (review verdicts + human edits) incrementally
// after the `since` watermark — strings.view + review fields, per spec 10.
app.get(
  "/api/sync/pull",
  requireProjectPermission("strings.view", { localeListQuery: "locales" }),
  asyncRoute(async (req, res) => {
  // The authorization middleware already resolved ?project= — reuse it so the
  // queried project is BY CONSTRUCTION the one the caller was authorized for.
  const projectId = req.authorizedProject.id;
  const since = String(req.query.since || "").trim() || null;
  const locales = String(req.query.locales || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const { cursor, translations } = await pullSyncRows(query, {
    projectId,
    since,
    locales,
  });
  // Bookkeeping, not authorization: the caller's tier stays strings.view —
  // this write only records "a repo pulled" for the status endpoint, so a
  // dead token or forgotten workflow shows up as staleness, not drift.
  await recordSyncPullStatus(query, { projectId, actor: usageActor(req.auth) });
  res.json({ version: SYNC_CONTRACT_VERSION, projectId, cursor, translations });
  }),
);

// Status: operational visibility for the sync loop — last push/pull per
// project (timestamps, pushed stateHash, actor). Read-only (strings.view);
// the staleness judgment ("this repo has not pushed in N days") belongs to
// the caller, which knows its own cadence.
app.get(
  "/api/sync/status",
  requireProjectPermission("strings.view"),
  asyncRoute(async (req, res) => {
    const projectId = req.authorizedProject.id;
    const status = await readSyncStatus(query, { projectId });
    res.json({ version: SYNC_CONTRACT_VERSION, projectId, ...status });
  }),
);

app.get("/api/strings", requireProjectPermission("strings.view"), asyncRoute(async (req, res) => {
  const project = await getProject(String(req.query.project || "scroll-goblin"));
  const locale = String(req.query.locale || "");
  const search = String(req.query.search || "").trim();
  const status = String(req.query.status || "all");
  // dynamic-data spec 08: the source facet segregates dynamic rows from UI
  // strings. The DEFAULT is UI strings only — dynamic volume must never bury
  // the strings a human must review. A data-source facet sorts by reach
  // descending (the template shared by 400 listings gets eyes before the
  // one-off); enum-tier rows render in the grid view, not the queue.
  const facet = normalizeSourceFacet(req.query.facet);
  const params = [project.id, locale || null, search ? `%${search}%` : null, status];
  const facetFilter = facetCondition(facet, params.length + 1);
  params.push(...facetFilter.params);
  const orderSql = isDataSourceFacet(facet)
    ? "coalesce(s.reach, 0) desc, lower(s.source_text)"
    : `case when $4 in ('needs-review', 'rejected') then occ.count else 0 end desc,
        lower(s.source_text)`;
  const result = await query(
    `
      select
        s.id,
        s.source_hash as "sourceHash",
        s.source_text as "sourceText",
        s.shape,
        s.purpose,
        s.visual_context as "visualContext",
        s.limit_chars as "limitChars",
        s.is_dynamic as "isDynamic",
        s.data_source as "dataSource",
        s.reach,
        s.dynamic_enum as "dynamicEnum",
        s.mask_names as "maskNames",
        t.locale,
        t.text as "translationText",
        t.human_status as "humanStatus",
        t.source as "translationSource",
        t.provider as "translationProvider",
        t.model as "translationModel",
        t.confidence as "translationConfidence",
        t.review_note as "reviewNote",
        t.updated_at as "translationUpdatedAt",
        occ.count as "occurrences",
        coalesce(ap1.status, 'missing') as "pass1Status",
        coalesce(ap2.status, 'missing') as "pass2Status"
      from source_strings s
      left join translations t on t.source_string_id = s.id and ($2::text is null or t.locale = $2)
      left join analysis_passes ap1 on ap1.source_string_id = s.id and ap1.pass_name = 'pass1'
      left join analysis_passes ap2 on ap2.source_string_id = s.id and ap2.pass_name = 'pass2'
      left join lateral (
        select count(*)::int as count from context_variants cv where cv.source_string_id = s.id
      ) occ on true
      where s.project_id = $1
        and ($3::text is null or s.source_text ilike $3 or coalesce(t.text, '') ilike $3)
        and (
          $4 = 'all'
          or ($4 = 'missing' and t.id is null)
          or ($4 = 'human-pending' and coalesce(t.human_status, 'pending') = 'pending')
          or ($4 = 'verified' and t.human_status = 'verified')
          or ($4 = 'needs-review' and t.human_status = 'needs-review')
          or ($4 = 'rejected' and t.human_status = 'rejected')
          or ($4 = 'degraded' and (ap1.status = 'degraded' or ap2.status = 'degraded'))
          or ($4 = 'no-context' and not exists (select 1 from context_variants cv where cv.source_string_id = s.id))
        )
        ${facetFilter.clause}
      order by
        -- P-06: the review queue reads most-occurred first (review what users
        -- see most); spec 08 dynamic facets read highest-reach first; the
        -- other views keep the alphabetical order.
        ${orderSql}
      limit 500
    `,
    params,
  );
  // The facet options: every data source this project has rows for.
  const sources = await query(
    `select distinct data_source as "dataSource"
     from source_strings
     where project_id = $1 and is_dynamic = true and data_source is not null
     order by 1`,
    [project.id],
  );
  res.json({ strings: result.rows, dataSources: sources.rows.map((row) => row.dataSource) });
}));

// dynamic-data spec 08: enum fields get a table view, not a queue — one
// compact source×locale grid per field (the whole vocabulary on one screen).
app.get("/api/dynamic-enums", requireProjectPermission("strings.view"), asyncRoute(async (req, res) => {
  const project = await getProject(String(req.query.project || "scroll-goblin"));
  const source = String(req.query.source || "").trim();
  if (!source) return res.status(400).json({ error: "source is required (a dynamic data source name)" });
  const result = await query(
    `
      select
        s.id as "sourceId",
        s.source_hash as "sourceHash",
        s.source_text as "sourceText",
        s.enum_field as "enumField",
        s.reach,
        t.locale,
        t.text,
        t.human_status as "humanStatus"
      from source_strings s
      left join translations t on t.source_string_id = s.id
      where s.project_id = $1
        and s.is_dynamic = true
        and s.data_source = $2
        and s.dynamic_enum = true
      order by s.enum_field, lower(s.source_text), t.locale
    `,
    [project.id, source],
  );
  res.json({ source, fields: buildEnumGrid(result.rows) });
}));

// dynamic-data spec 08: bulk verify for the enum grid. Verification semantics
// are UNCHANGED (same humanStatus lifecycle as the single approve route) —
// this only lets one review sitting cover a whole vocabulary. Approve rights
// can be locale-scoped, so the middleware authorizes every locale in
// `?locales=` (falling back to all project locales) and each item must stay
// inside that authorized set.
app.post("/api/translations/bulk-approve", requireProjectPermission("translations.approve", { localeListQuery: "locales" }), asyncRoute(async (req, res) => {
  const project = await getProject(String(req.query.project || "scroll-goblin"));
  const authorizedLocales = new Set(req.authorizedLocales || []);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (req.authorizedLocales && items.some((item) => !authorizedLocales.has(item?.locale))) {
    return res.status(403).json({ error: "Every bulk-verify locale must be listed in ?locales= and authorized" });
  }
  const outcome = await withTransaction((client) =>
    bulkVerifyTranslations((sql, params) => client.query(sql, params), {
      projectId: project.id,
      items: req.body?.items,
    }));
  res.json(outcome);
}));

app.get("/api/strings/:id", requireProjectPermission("strings.view", { sourceParam: "id" }), asyncRoute(async (req, res) => {
  const source = await query(
    `select id, source_hash as "sourceHash", source_text as "sourceText", shape, purpose,
      visual_context as "visualContext", limit_chars as "limitChars",
      is_dynamic as "isDynamic", data_source as "dataSource", reach,
      dynamic_enum as "dynamicEnum", mask_names as "maskNames"
     from source_strings where id = $1`,
    [req.params.id],
  );
  if (!source.rows[0]) return res.status(404).json({ error: "Not found" });

  const [contexts, passes, translations, revisions] = await Promise.all([
    query("select * from context_variants where source_string_id = $1 order by created_at", [req.params.id]),
    query("select pass_name as \"passName\", status, prompt_version as \"promptVersion\", data, warning, updated_at as \"updatedAt\" from analysis_passes where source_string_id = $1", [req.params.id]),
    query("select locale, text, mt_status as \"mtStatus\", human_status as \"humanStatus\", source, provider, model, confidence, review_note as \"reviewNote\", updated_at as \"updatedAt\" from translations where source_string_id = $1 order by locale", [req.params.id]),
    query("select locale, previous_text as \"previousText\", next_text as \"nextText\", revision_source as \"revisionSource\", instruction, created_at as \"createdAt\" from translation_revisions where source_string_id = $1 order by created_at desc limit 50", [req.params.id]),
  ]);

  res.json({
    string: source.rows[0],
    contexts: contexts.rows,
    analysis: Object.fromEntries(passes.rows.map((row) => [row.passName, row])),
    translations: translations.rows,
    revisions: revisions.rows,
  });
}));

app.get("/api/prompts", requireProjectPermission("prompts.view"), asyncRoute(async (req, res) => {
  const project = await getProject(String(req.query.project || "scroll-goblin"));
  const result = await query("select key, label, body, active, updated_at as \"updatedAt\" from prompts where project_id = $1 order by key", [project.id]);
  res.json({ prompts: result.rows });
}));

app.put("/api/prompts/:key", requireProjectPermission("prompts.manage"), asyncRoute(async (req, res) => {
  const project = await getProject(String(req.query.project || "scroll-goblin"));
  const { label, body } = req.body;
  const result = await query(
    `insert into prompts(project_id, key, label, body)
     values($1, $2, $3, $4)
     on conflict(project_id, key) do update set label = excluded.label, body = excluded.body, updated_at = now()
     returning key, label, body, updated_at as "updatedAt"`,
    [project.id, req.params.key, label || req.params.key, body || ""],
  );
  res.json({ prompt: result.rows[0] });
}));

app.get("/api/personas", requireProjectPermission("personas.view"), asyncRoute(async (req, res) => {
  const project = await getProject(String(req.query.project || "scroll-goblin"));
  const result = await query(
    "select locale, body, active, updated_at as \"updatedAt\" from personas where project_id = $1 order by locale",
    [project.id],
  );
  res.json({ personas: result.rows });
}));

app.put("/api/personas/:locale", requireProjectPermission("personas.manage"), asyncRoute(async (req, res) => {
  const project = await getProject(String(req.query.project || "scroll-goblin"));
  const { body, active } = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "body must be a JSON object" });
  }
  const result = await query(
    `insert into personas(project_id, locale, body, active)
     values($1, $2, $3, $4)
     on conflict(project_id, locale) do update
     set body = excluded.body, active = excluded.active, updated_at = now()
     returning locale, body, active, updated_at as "updatedAt"`,
    [project.id, req.params.locale, JSON.stringify(body), active !== false],
  );
  res.json({ persona: result.rows[0] });
}));

app.get("/api/glossary", requireProjectPermission("glossary.view"), asyncRoute(async (req, res) => {
  const project = await getProject(String(req.query.project || "scroll-goblin"));
  const result = await query(
    "select id, term, locale, translation, description, do_not_translate as \"doNotTranslate\", updated_at as \"updatedAt\" from glossary_terms where project_id = $1 order by lower(term), locale nulls first",
    [project.id],
  );
  res.json({ terms: result.rows });
}));

app.post("/api/glossary", requireProjectPermission("glossary.manage"), asyncRoute(async (req, res) => {
  const project = await getProject(String(req.query.project || "scroll-goblin"));
  const { term, locale, translation, description, doNotTranslate } = req.body;
  if (typeof term !== "string" || !term.trim()) return res.status(400).json({ error: "term is required" });
  const result = await query(
    `insert into glossary_terms(project_id, term, locale, translation, description, do_not_translate)
     values($1, $2, $3, $4, $5, $6)
     returning id, term, locale, translation, description, do_not_translate as "doNotTranslate", updated_at as "updatedAt"`,
    [project.id, term.trim(), locale || null, translation || null, description || null, Boolean(doNotTranslate)],
  );
  res.json({ term: result.rows[0] });
}));

app.put("/api/glossary/:id", requireProjectPermission("glossary.manage"), asyncRoute(async (req, res) => {
  const project = await getProject(String(req.query.project || "scroll-goblin"));
  const { term, locale, translation, description, doNotTranslate } = req.body;
  if (typeof term !== "string" || !term.trim()) return res.status(400).json({ error: "term is required" });
  const result = await query(
    `update glossary_terms
     set term = $2,
         locale = $3,
         translation = $4,
         description = $5,
         do_not_translate = $6,
         updated_at = now()
     where id = $1 and project_id = $7
     returning id, term, locale, translation, description, do_not_translate as "doNotTranslate", updated_at as "updatedAt"`,
    [req.params.id, term.trim(), locale || null, translation || null, description || null, Boolean(doNotTranslate), project.id],
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
  res.json({ term: result.rows[0] });
}));

app.delete("/api/glossary/:id", requireProjectPermission("glossary.manage"), asyncRoute(async (req, res) => {
  const project = await getProject(String(req.query.project || "scroll-goblin"));
  const result = await query("delete from glossary_terms where id = $1 and project_id = $2 returning id", [req.params.id, project.id]);
  if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
}));

app.put("/api/translations/:sourceId/:locale", requireProjectPermission("translations.approve", { sourceParam: "sourceId" }), asyncRoute(async (req, res) => {
  const { text } = req.body;
  if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "text is required" });

  // P-06: console edits are human translations — validated with the SAME
  // guards as the translate pipeline, and rejected with the specific validator
  // message (never silently accepted).
  const sourceResult = await query(
    "select source_text as \"sourceText\" from source_strings where id = $1",
    [req.params.sourceId],
  );
  if (!sourceResult.rows[0]) return res.status(404).json({ error: "Source string not found" });
  if (isInvalidTranslationText(text.trim())) {
    return res.status(400).json({ error: "invalid_text: the edit is empty or looks like bracketed placeholder output" });
  }
  const placeholderError = reviewEditPlaceholderError(sourceResult.rows[0].sourceText, text.trim());
  if (placeholderError) {
    return res.status(400).json({ error: placeholderError });
  }

  const result = await withTransaction(async (client) => {
    const existing = await client.query(
      "select id, text from translations where source_string_id = $1 and locale = $2",
      [req.params.sourceId, req.params.locale],
    );
    const previous = existing.rows[0];
    const upserted = await client.query(
      `insert into translations(source_string_id, locale, text, mt_status, human_status, source)
       values($1, $2, $3, 'ready', 'verified', 'human')
       on conflict(source_string_id, locale) do update
       set text = excluded.text, human_status = 'verified', source = 'human',
           provider = null, model = null, confidence = null, review_note = null,
           updated_at = now()
       returning *`,
      [req.params.sourceId, req.params.locale, text.trim()],
    );
    await client.query(
      `insert into translation_revisions(translation_id, source_string_id, locale, previous_text, next_text, revision_source)
       values($1, $2, $3, $4, $5, 'human')`,
      [upserted.rows[0].id, req.params.sourceId, req.params.locale, previous?.text ?? null, text.trim()],
    );
    return upserted.rows[0];
  });

  res.json({ translation: result });
}));

// P-06: approve the CURRENT text as-is (bulk approve = repeated calls).
// Verification is per locale per entry; the text/source provenance is kept so
// "verified mt" remains distinguishable from a human rewrite.
app.post("/api/translations/:sourceId/:locale/approve", requireProjectPermission("translations.approve", { sourceParam: "sourceId" }), asyncRoute(async (req, res) => {
  const result = await query(
    `update translations
     set human_status = 'verified', review_note = null, updated_at = now()
     where source_string_id = $1 and locale = $2
     returning *`,
    [req.params.sourceId, req.params.locale],
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Translation not found" });
  res.json({ translation: result.rows[0] });
}));

// P-06: reject the current text with a required reviewer note. Rejected MT is
// re-generated by the next translate run with the note in the prompt context;
// rejected human entries wait in the queue for a person.
app.post("/api/translations/:sourceId/:locale/reject", requireProjectPermission("translations.approve", { sourceParam: "sourceId" }), asyncRoute(async (req, res) => {
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  if (!note) return res.status(400).json({ error: "note is required — the rejection note feeds the regeneration prompt" });
  const result = await query(
    `update translations
     set human_status = 'rejected', review_note = $3, updated_at = now()
     where source_string_id = $1 and locale = $2
     returning *`,
    [req.params.sourceId, req.params.locale, note],
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Translation not found" });
  res.json({ translation: result.rows[0] });
}));

app.post(
  "/api/translations/:sourceId/:locale/revise",
  requireProjectPermission("translations.edit", { sourceParam: "sourceId" }),
  requireProjectEntitlement("ai_revision"),
  asyncRoute(async (req, res) => {
  const instruction = typeof req.body?.instruction === "string" ? req.body.instruction.trim() : "";
  const sourceResult = await query(
    `select
       s.id,
       s.source_hash as "sourceHash",
       s.source_text as "sourceText",
       s.shape,
       s.purpose,
       s.visual_context as "visualContext",
       s.limit_chars as "limitChars",
       p.id as "projectId",
       p.slug as "projectSlug"
     from source_strings s
     join projects p on p.id = s.project_id
     where s.id = $1`,
    [req.params.sourceId],
  );
  const source = sourceResult.rows[0];
  if (!source) return res.status(404).json({ error: "Source string not found" });

  const [translationResult, contextResult, passResult, promptResult, personaResult, glossaryResult] = await Promise.all([
    query("select id, text from translations where source_string_id = $1 and locale = $2", [source.id, req.params.locale]),
    query(
      `select
         shape,
         purpose,
         visual_context as "visualContext",
         file_path as "filePath",
         code_context as "codeContext",
         ui_context as "uiContext",
         app_state_context as "appStateContext",
         raw
       from context_variants
       where source_string_id = $1
       order by created_at`,
      [source.id],
    ),
    query(
      `select pass_name as "passName", status, prompt_version as "promptVersion", data, warning
       from analysis_passes
       where source_string_id = $1`,
      [source.id],
    ),
    query(
      "select key, label, body from prompts where project_id = $1 and active = true order by key",
      [source.projectId],
    ),
    query(
      "select body from personas where project_id = $1 and locale = $2 and active = true",
      [source.projectId, req.params.locale],
    ),
    query(
      `select term, locale, translation, description, do_not_translate as "doNotTranslate"
       from glossary_terms
       where project_id = $1 and (locale is null or locale = $2)
       order by lower(term), locale nulls first`,
      [source.projectId, req.params.locale],
    ),
  ]);

  const existingTranslation = translationResult.rows[0];
  const passes = Object.fromEntries(passResult.rows.map((row) => [row.passName, row]));
  const prompt = buildRevisionPrompt({
    source,
    locale: req.params.locale,
    currentTranslation: existingTranslation?.text || "",
    instruction,
    contexts: contextResult.rows,
    analysis: passes,
    prompts: promptResult.rows,
    persona: personaResult.rows[0]?.body || null,
    glossary: glossaryResult.rows,
  });
  const usageRequest = usageIdentity(req, "ai_translation_revision", {
    sourceId: source.id,
    locale: req.params.locale,
    instruction,
  });
  const usageScope = {
    organizationId: req.authorizedProject.organizationId,
    businessUnitId: req.authorizedProject.businessUnitId,
    projectId: source.projectId,
    actor: usageActor(req.auth),
    ...usageRequest,
  };
  const sourceMeasurement = measureText(source.sourceText, null);
  const maximumOutputTokens = Number(
    process.env.HEDGELING_REVISION_MAX_OUTPUT_TOKENS || 2048,
  );
  if (
    !Number.isSafeInteger(maximumOutputTokens)
    || maximumOutputTokens < 1
    || maximumOutputTokens > 65536
  ) {
    throw Object.assign(
      new Error("HEDGELING_REVISION_MAX_OUTPUT_TOKENS must be an integer from 1 to 65536"),
      { status: 503, code: "ai_output_limit_invalid" },
    );
  }
  const configuredGeminiModel = geminiModelForPlan(
    req.commercialAccess?.limits,
  );
  const provider = await translationProvider(usageScope.organizationId);
  const managed = provider.mode === "managed";
  const creditRate = managed ? await loadActiveAiCreditRate({
    provider: "gemini",
    model: configuredGeminiModel,
    operation: "translation",
  }) : null;
  const creditReservation = managed ? estimateAiCreditReservation(creditRate, {
    systemPrompt: prompt.system,
    // A validation retry is internal COGS, but its successful final prompt can
    // contain a bounded correction note that must still fit inside the hold.
    userPrompt: `${prompt.user}${" ".repeat(1024)}`,
    maxOutputTokens: maximumOutputTokens,
  }) : { quantity: 0 };
  const creditLimits = await effectiveAiCreditPlanLimits(
    usageScope.organizationId,
    req.commercialAccess?.limits,
  );
  const reservation = await reserveUsage({
    organizationId: usageScope.organizationId,
    businessUnitId: usageScope.businessUnitId,
    projectId: usageScope.projectId,
    operation: "ai_translation_revision",
    ...usageRequest,
    measurements: {
      ai_generation_actions: 1,
      ai_credits: creditReservation.quantity,
      source_words_processed: sourceMeasurement.words,
      source_characters_processed: sourceMeasurement.characters,
    },
    relevantMetrics: [
      "source_words_processed",
      "source_characters_processed",
      "ai_generation_actions",
      "ai_credits",
      "ai_output_words",
      "ai_output_characters",
      "llm_input_tokens",
      "llm_output_tokens",
      "llm_cached_input_tokens",
      "llm_reasoning_tokens",
      "llm_total_tokens",
    ].filter((metric) => managed || metric !== "ai_credits"),
    planLimits: creditLimits.planLimits,
  });
  if (reservation.duplicate) {
    return sendIdempotencyResult(res, reservation, "AI revision request");
  }
  usageScope.reservationId = reservation.id;
  usageScope.attemptNumber = reservation.attemptNumber;

  let revised = "";
  let geminiResult = null;
  let validationError = "";
  const geminiAttempts = [];
  const recordRevisionUsage = async ({
    client,
    outcome,
    translationRevisionId = null,
    providerError = null,
    responseStatus = null,
    responseBody = null,
  }) => {
    const attemptTextMeasurements = geminiAttempts.map((attempt) => (
      measureText(attempt.text, req.params.locale)
    ));
    const outputMeasurement = measureText(revised, req.params.locale);
    const billedCredits = managed && outcome === "succeeded" && geminiResult
      ? calculateAiCredits(
        creditRate,
        geminiBillableTokenUsage(geminiResult.raw?.usageMetadata),
      )
      : { quantity: 0, components: {} };
    return recordUsageEvent({
      client,
      ...usageScope,
      operation: "ai_translation_revision",
      outcome,
      responseStatus,
      responseBody,
      provider: "gemini",
      model: geminiResult?.model || null,
      providerRequestId: geminiResult?.raw?.responseId || null,
      measurements: mergeMeasurements(
        {
          ai_generation_actions: outcome === "succeeded" ? 1 : 0,
          ai_credits: billedCredits.quantity,
          source_words_processed: sourceMeasurement.words,
          source_characters_processed: sourceMeasurement.characters,
          ai_output_words: attemptTextMeasurements.reduce(
            (total, measurement) => total + measurement.words,
            0,
          ),
          ai_output_characters: attemptTextMeasurements.reduce(
            (total, measurement) => total + measurement.characters,
            0,
          ),
        },
        ...geminiAttempts.map((attempt) => (
          geminiTokenMeasurements(attempt.raw?.usageMetadata)
        )),
      ),
      items: [{
        sourceStringId: source.id,
        translationRevisionId,
        sourceWords: sourceMeasurement.words,
        sourceCharacters: sourceMeasurement.characters,
        targetLocale: req.params.locale,
        outputWords: outputMeasurement.words,
        outputCharacters: outputMeasurement.characters,
      }],
      metadata: {
        billingCategory: managed ? "managed_translation" : "organization_provider",
        attempts: geminiAttempts.map((attempt, index) => ({
          attempt: index + 1,
          model: attempt.model,
          apiVersion: attempt.apiVersion,
          providerRequestId: attempt.raw?.responseId || null,
          finishReason: attempt.raw?.candidates?.[0]?.finishReason || null,
          usageMetadata: attempt.raw?.usageMetadata || {},
        })),
        validationError: validationError || null,
        aiCredits: {
          quantity: billedCredits.quantity,
          components: billedCredits.components,
          reservedQuantity: creditReservation.quantity,
          rateCardKey: creditRate?.rateCardKey || null,
          rateCardVersion: creditRate?.rateCardVersion || null,
          provider: "gemini",
          model: configuredGeminiModel,
          operation: "translation",
        },
        providerError: providerError
          ? {
            name: providerError.name || "Error",
            message: String(providerError.message || "Provider request failed").slice(0, 500),
          }
          : null,
      },
    });
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const retryNote = validationError
      ? `\n\nPrevious output was rejected because: ${validationError}. Produce a corrected final string only.`
      : "";
    try {
      geminiResult = await callGeminiText({
        system: prompt.system,
        user: `${prompt.user}${retryNote}`,
        model: configuredGeminiModel,
        maxOutputTokens: maximumOutputTokens,
        apiKey: provider.key,
      });
    } catch (error) {
      await recordRevisionUsage({
        outcome: geminiAttempts.length ? "partial" : "failed",
        providerError: error,
      });
      throw error;
    }
    revised = cleanGeminiTranslation(geminiResult.text);
    geminiAttempts.push(geminiResult);
    validationError = "";
    if (isInvalidTranslationText(revised)) validationError = "invalid or bracketed placeholder output";
    else if (!placeholdersPreserved(source.sourceText, revised)) validationError = "required placeholders were not preserved";
    else if (source.limitChars && revised.length > source.limitChars) {
      validationError = `character limit exceeded: ${revised.length}/${source.limitChars}`;
    }
    else {
      const glossaryMismatch = glossaryViolation(source.sourceText, revised, req.params.locale, glossaryResult.rows);
      if (glossaryMismatch) validationError = `glossary mismatch: ${glossaryMismatch}`;
    }
    if (!validationError) break;
  }

  if (validationError) {
    await recordRevisionUsage({ outcome: "failed" });
    return res.status(502).json({ error: `Gemini revision rejected: ${validationError}` });
  }

  let responseBody;
  try {
    responseBody = await withTransaction(async (client) => {
      const upserted = await client.query(
      `insert into translations(source_string_id, locale, text, mt_status, human_status, source)
       values($1, $2, $3, 'ready', 'pending', 'gemini')
       on conflict(source_string_id, locale) do update
       set text = excluded.text,
           mt_status = 'ready',
           human_status = 'pending',
           source = 'gemini',
           updated_at = now()
       returning id, locale, text, mt_status as "mtStatus", human_status as "humanStatus", source, updated_at as "updatedAt"`,
      [source.id, req.params.locale, revised],
    );
      const revision = await client.query(
      `insert into translation_revisions(translation_id, source_string_id, locale, previous_text, next_text, revision_source, instruction, prompt_snapshot)
       values($1, $2, $3, $4, $5, 'gemini', $6, $7)
       returning id`,
      [
        upserted.rows[0].id,
        source.id,
        req.params.locale,
        existingTranslation?.text ?? null,
        revised,
        instruction || null,
        JSON.stringify({
          ...prompt.promptSnapshot,
          model: geminiResult.model,
          apiVersion: geminiResult.apiVersion,
          finishReason: geminiResult.raw?.candidates?.[0]?.finishReason || null,
          usageMetadata: geminiResult.raw?.usageMetadata || {},
        }),
      ],
    );
      const successfulResponse = {
        message: "Gemini revision complete. Review and save manually to mark it verified.",
        translation: upserted.rows[0],
        usageWarnings: reservation.warnings,
        billingCategory: managed ? "managed_translation" : "organization_provider",
        aiCredits: managed ? calculateAiCredits(
          creditRate,
          geminiBillableTokenUsage(geminiResult.raw?.usageMetadata),
        ).quantity : 0,
      };
      await recordRevisionUsage({
        client,
        outcome: "succeeded",
        translationRevisionId: revision.rows[0].id,
        responseStatus: 200,
        responseBody: successfulResponse,
      });
      return successfulResponse;
    });
  } catch (error) {
    await releaseUsageReservation(reservation.id).catch(() => {});
    throw error;
  }

  res.json(responseBody);
  }),
);

app.use((err, req, res, _next) => {
  logRequestError(err, req.correlationId);
  const response = publicError(err);
  res.status(response.status).json(response.body);
});

async function runStartupMigration() {
  return migrateDatabase();
}

const isEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  validateAuthenticationConfiguration();
  validateHttpSecurityConfiguration();
  validateStripeConfiguration();
  validateFacilitatedPaymentsConfiguration();
  validateEntitlementLeaseConfiguration();
  validateTrialPackageDownloadConfiguration();
  validateDataLifecycleConfiguration();
  await runStartupMigration();
  // Bound retention of abandoned encrypted key previews even without traffic.
  await expireAiProposals();
  setInterval(() => { void expireAiProposals().catch(() => console.error("Expired AI-key preview cleanup failed")); }, 60000).unref();
  app.listen(port, process.env.HEDGELING_AUTH_MODE === "local" ? "127.0.0.1" : "0.0.0.0", () => {
    console.log(`Hedgeling web console listening on :${port}`);
  });
}

export { app, runStartupMigration };
