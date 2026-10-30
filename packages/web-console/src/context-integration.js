import crypto from 'node:crypto';
import { query, withTransaction } from './db.js';
import { projectPermissions } from './authorization.js';
import { effectiveOrganizationAccess } from './entitlements.js';
import { translationProvider } from './organization-ai.js';
import { geminiModelForPlan } from './ai-credits.js';
import { metaTranslationConfiguration } from './hackathon-engine/meta-translation.js';
import { createContextEnrichment } from './hackathon-engine/context-enrichment.js';
import { reserveUsage, recordUsageEvent, geminiTokenMeasurements, usageActor } from './usage.js';
import { fail } from './action-errors.js';

const canonical = v => v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k,canonical(v[k])])) : v;
const fingerprint = v => crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
let providerCall;
export const registerContextProvider = call => { providerCall = call; };
async function authorize(auth,p,write) {
  if (auth.principalType !== 'user' || !(await query("select 1 from users where id=$1 and status='active'", [auth.user?.id])).rowCount) throw fail(403,'An active named user is required.','context_access_denied');
  const actor = { ...auth, executionType:'agent', platformAdmin:false, user:{ ...auth.user,platformStaff:false } };
  const permissions = await projectPermissions(actor,p);
  if (!(write ? ['strings.view','imports.run'] : ['strings.view']).every(k => permissions.includes(k))) throw fail(403,'You need source-view and import access to manage context.','context_access_denied');
}
async function inspectProvider(auth,p) {
  await authorize(auth,p,true);
  for (const key of ['ai_revision','ai_byok']) if (!(await effectiveOrganizationAccess(p.organizationId,key)).allowed) throw fail(402,'Context enrichment needs organization AI-key access on an active platform plan.','context_plan_required');
  const selected = await translationProvider(p.organizationId);
  if (selected.mode !== 'byok') throw fail(409,'Select your organization’s Meta or Gemini key in AI providers & keys. Managed context enrichment is not available yet.','context_byok_required');
  const access = await effectiveOrganizationAccess(p.organizationId,'ai_revision');
  const model = selected.provider === 'meta' ? metaTranslationConfiguration().model : geminiModelForPlan(access.limits);
  const version = (await query(`select s.revision,c.updated_at from organization_ai_settings s join organization_ai_credentials c
    on c.organization_id=s.organization_id and c.provider=s.translation_provider where s.organization_id=$1`,[p.organizationId])).rows[0];
  return { provider:selected.provider,model,mode:'byok',version:fingerprint(version) };
}
export const contextEnrichment = createContextEnrichment({ database:{ query },transaction:withTransaction,authorize,inspectProvider,fingerprint,
  generate: async ({ p,auth,run,prompt,beforeCall }) => {
    if (!providerCall) throw fail(503,'Context provider is not configured.','context_provider_unconfigured');
    await beforeCall();
    const selected = await translationProvider(p.organizationId);
    const plan = await inspectProvider(auth,p);
    if (plan.version !== run.provider_plan.version || plan.provider !== run.provider_plan.provider || plan.model !== run.provider_plan.model) throw fail(409,'Provider settings changed.','context_provider_changed');
    const access = await effectiveOrganizationAccess(p.organizationId,'ai_revision');
    const scope = { organizationId:p.organizationId,businessUnitId:p.businessUnitId,projectId:p.id,actor:usageActor(auth),operation:'context_enrichment',
      idempotencyKey:`context:${run.id}`,idempotencyFingerprint:fingerprint({ prompt,plan }),requestId:null };
    const estimated = { ai_generation_actions:1,llm_input_tokens:run.provider_plan.maximumInputBytes,
      llm_output_tokens:run.provider_plan.maximumOutputTokens,llm_total_tokens:run.provider_plan.maximumInputBytes+run.provider_plan.maximumOutputTokens };
    const reservation = await reserveUsage({ ...scope,measurements:estimated,relevantMetrics:Object.keys(estimated),planLimits:access.limits });
    if (reservation.duplicate) throw fail(409,'This request was already admitted; it will not be sent again.','context_request_uncertain');
    const record = async (outcome,result) => {
      const measured = Number.isSafeInteger(result?.raw?.usageMetadata?.totalTokenCount);
      await recordUsageEvent({ ...scope,reservationId:reservation.id,attemptNumber:reservation.attemptNumber,outcome,
        provider:plan.provider,model:plan.model,providerRequestId:result?.raw?.responseId || null,
        measurements:measured ? { ai_generation_actions:1,...geminiTokenMeasurements(result.raw.usageMetadata) } : estimated,
        measurementAccuracy:measured ? 'exact' : 'estimated',metadata:{ contextRunId:run.id,billingCategory:'organization_provider',aiCredits:0,usageEstimated:!measured } });
    };
    let result;
    try { await beforeCall(); result = await providerCall({ ...prompt,provider:plan.provider,model:plan.model,apiKey:selected.key }); }
    catch(error) { await record('failed',null); throw error; }
    await record('succeeded',result); return { text:result.text };
  },
});
