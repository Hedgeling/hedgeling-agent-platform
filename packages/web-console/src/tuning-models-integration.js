import crypto from 'node:crypto';
import { query, withTransaction } from './db.js';
import { projectPermissions } from './authorization.js';
import { effectiveOrganizationAccess } from './entitlements.js';
import { translationProvider } from './organization-ai.js';
import { geminiModelForPlan } from './ai-credits.js';
import { metaTranslationConfiguration } from './hackathon-engine/meta-translation.js';
import { createTuningModels } from './hackathon-engine/tuning-models.js';
import { sourceEngine, repositories } from './repositories-integration.js';
import { reserveUsage, recordUsageEvent, geminiTokenMeasurements, usageActor } from './usage.js';
import { fail } from './action-errors.js';

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
}
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
let providerCall;
export function registerTuningProvider(call) { providerCall = call; }

async function permission(auth, p) {
  const active = (await query("select 1 from users where id=$1 and status='active'", [auth.user?.id])).rowCount;
  if (auth.principalType !== 'user' || !active) throw fail(403, 'LLM tuning requires an active named user.', 'tuning_access_denied');
  const delegated = { ...auth, executionType: 'agent', platformAdmin: false, user: { ...auth.user, platformStaff: false } };
  const permissions = await projectPermissions(delegated, p);
  if (!['strings.view', 'imports.run'].every(value => permissions.includes(value))) throw fail(403, 'You need source-view and import access to run extraction tuning.', 'tuning_access_denied');
  for (const entitlement of ['state_imports', 'ai_revision', 'ai_byok']) {
    if (!(await effectiveOrganizationAccess(p.organizationId, entitlement)).allowed) throw fail(402, 'LLM tuning needs source-import and organization AI-key access on an active platform plan.', 'tuning_plan_required');
  }
}
async function inspect(auth, p) {
  await permission(auth, p);
  const selected = await translationProvider(p.organizationId);
  if (selected.mode !== 'byok') throw fail(409, 'Select your organization’s Meta or Gemini key in AI providers & keys for LLM tuning. Managed tuning is not available yet.', 'tuning_byok_required');
  const access = await effectiveOrganizationAccess(p.organizationId, 'ai_revision');
  const model = selected.provider === 'meta' ? metaTranslationConfiguration().model : geminiModelForPlan(access.limits);
  const version = (await query(`select s.revision,c.updated_at as "credentialUpdatedAt" from organization_ai_settings s
    join organization_ai_credentials c on c.organization_id=s.organization_id and c.provider=s.translation_provider where s.organization_id=$1`, [p.organizationId])).rows[0];
  return { organizationId: p.organizationId, mode: 'byok', provider: selected.provider, model, version: fingerprint(version) };
}
export const tuningModels = createTuningModels({ database: { query }, transaction: withTransaction, fingerprint,
  engine: sourceEngine, inspect,
  authorize: async (auth, run) => {
    const p = (await query(`select p.id,p.slug,p.source_locale as "sourceLocale",p.business_unit_id as "businessUnitId",b.organization_id as "organizationId"
      from projects p join business_units b on b.id=p.business_unit_id where p.id=$1 and p.data_purged_at is null`, [run.project_id])).rows[0];
    if (!p) throw fail(403, 'Project unavailable.', 'tuning_access_denied');
    const connection = (await query(`select connection_id as "connectionId",repository_id::text as "repositoryId",repository_owner as owner,
      repository_name as repository,allowed_roots as "allowedRoots",default_ref as "defaultRef",source_mode as "sourceMode" from extraction_connections where project_id=$1 and connection_id=$2 and active=true`, [p.id, run.binding.connectionId])).rows[0];
    if (connection && connection.sourceMode !== 'github-fetch') delete connection.sourceMode;
    if (!connection || fingerprint(connection) !== fingerprint(run.binding) || Intl.getCanonicalLocales(p.sourceLocale.replaceAll('_','-'))[0] !== run.request.sourceLocale) throw fail(409, 'Source connection or locale changed.', 'tuning_connection_changed');
    await permission(auth, p);
    if (connection.sourceMode === 'github-fetch') await repositories.connected(connection, auth);
    return p;
  },
  generate: async ({ run, call, project: p }) => {
    if (!providerCall) throw fail(503, 'Tuning provider is not configured.', 'tuning_provider_unconfigured');
    const selected = await translationProvider(p.organizationId);
    const access = await effectiveOrganizationAccess(p.organizationId, 'ai_revision');
    if (selected.mode !== 'byok' || selected.provider !== run.provider_plan.provider || fingerprint({ ...await inspect(run.actor,p), limits:run.provider_plan.limits }) !== fingerprint(run.provider_plan)) throw fail(409, 'Provider settings changed.', 'tuning_provider_changed');
    const identity = { idempotencyKey: `llm_tuning:${call.id}`, idempotencyFingerprint: fingerprint(call), requestId: null };
    const scope = { organizationId: p.organizationId, businessUnitId: p.businessUnitId, projectId: p.id, actor: usageActor(run.actor), operation: 'llm_extraction_tuning', ...identity };
    const inputBound = Buffer.byteLength(call.system + call.user) + 1024;
    const estimated = { ai_generation_actions: 1, llm_input_tokens: inputBound, llm_output_tokens: call.maxOutputTokens, llm_total_tokens: inputBound + call.maxOutputTokens };
    const reservation = await reserveUsage({ ...scope, measurements: estimated,
      relevantMetrics: ['ai_generation_actions','llm_input_tokens','llm_output_tokens','llm_total_tokens'], planLimits: access.limits });
    if (reservation.duplicate) throw fail(409, 'This model request was already admitted; it will not be dispatched again.', 'tuning_request_uncertain');
    const record = async (outcome, result) => {
      const measured = Number.isSafeInteger(result?.raw?.usageMetadata?.totalTokenCount);
      await recordUsageEvent({ ...scope, reservationId: reservation.id, attemptNumber: reservation.attemptNumber, outcome,
        provider: selected.provider, model: run.provider_plan.model, providerRequestId: result?.raw?.responseId || null,
        measurements: measured ? { ai_generation_actions: 1, ...geminiTokenMeasurements(result.raw.usageMetadata) } : estimated,
        measurementAccuracy: measured ? 'exact' : 'estimated',
        metadata: { extractionId: run.extraction_id, modelRequestId: call.id, billingCategory: 'organization_provider', aiCredits: 0, usageEstimated: !measured } });
    };
    let result;
    try {
      result = await providerCall({ system: call.system, user: call.user, provider: selected.provider, model: run.provider_plan.model,
        apiKey: selected.key, maxOutputTokens: call.maxOutputTokens });
    } catch (e) { await record('failed', null); throw e; }
    await record('succeeded', result);
    return { text: result.text, usage: { totalTokens: result.raw?.usageMetadata?.totalTokenCount ?? estimated.llm_total_tokens,
      estimated: !Number.isSafeInteger(result.raw?.usageMetadata?.totalTokenCount) } };
  },
});
