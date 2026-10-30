import crypto from 'node:crypto';
import {query,withTransaction} from './db.js';
import {projectPermissions} from './authorization.js';
import {effectiveOrganizationAccess} from './entitlements.js';
import {translationProvider} from './organization-ai.js';
import {geminiModelForPlan} from './ai-credits.js';
import {reserveUsage,recordUsageEvent,geminiTokenMeasurements,usageActor} from './usage.js';
import {metaTranslationConfiguration} from './hackathon-engine/meta-translation.js';
import {createJobReview} from './hackathon-engine/job-review.js';
import {createJobDelivery} from './hackathon-engine/job-delivery.js';
import {github,githubConnection,sourceEngine} from './repositories-integration.js';
import {fail} from './action-errors.js';
const canonical=v=>v instanceof Date?v.toISOString():Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const fingerprint=v=>crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
let providerCall;
export const registerJobReviewProvider=call=>{providerCall=call;};
async function authorize(auth,p,locales,permission){
  if(auth.principalType!=='user'||!(await query("select 1 from users where id=$1 and status='active'",[auth.user?.id])).rowCount)throw fail(403,'An active named user is required.','review_access_denied');
  const actor={...auth,executionType:'agent',platformAdmin:false,user:{...auth.user,platformStaff:false}};
  const required=['jobs.view','strings.view','translations.view',...(permission==='review'?['jobs.update','translations.approve']:permission==='delivery'?['jobs.update','projects.manage','imports.run','translations.publish']:[])];
  for(const locale of locales){const permissions=await projectPermissions(actor,p,{locale});if(!required.every(k=>permissions.includes(k)))throw fail(403,permission==='delivery'?'You need project management, source import and translation publishing access to every job language.':'You need job and translation access; quality review and verification also require translation approval permission.','review_access_denied');}
}
async function inspectProvider(auth,p){
  for(const key of ['ai_revision','ai_byok'])if(!(await effectiveOrganizationAccess(p.organizationId,key)).allowed)throw fail(402,'Quality checks need organization AI-key access on an active platform plan.','review_plan_required');
  const selected=await translationProvider(p.organizationId);
  if(selected.mode!=='byok')throw fail(409,'Select your organization’s Meta or Gemini key in AI providers & keys for quality checks.','review_byok_required');
  const access=await effectiveOrganizationAccess(p.organizationId,'ai_revision'),model=selected.provider==='meta'?metaTranslationConfiguration().model:geminiModelForPlan(access.limits);
  const version=(await query(`select s.revision,c.updated_at from organization_ai_settings s join organization_ai_credentials c on c.organization_id=s.organization_id and c.provider=s.translation_provider where s.organization_id=$1`,[p.organizationId])).rows[0];
  return {provider:selected.provider,model,mode:'byok',version:fingerprint(version)};
}
export const jobReview=createJobReview({database:{query},transaction:withTransaction,authorize,inspectProvider,fingerprint,
  generate:async({p,auth,run,prompt,beforeCall})=>{
    if(!providerCall)throw fail(503,'Quality provider is not configured.','review_provider_unconfigured');
    await beforeCall();const selected=await translationProvider(p.organizationId),plan=await inspectProvider(auth,p);
    if(['version','provider','model'].some(k=>plan[k]!==run.provider_plan[k]))throw fail(409,'Provider settings changed.','review_provider_changed');
    const access=await effectiveOrganizationAccess(p.organizationId,'ai_revision');
    const scope={organizationId:p.organizationId,businessUnitId:p.businessUnitId,projectId:p.id,actor:usageActor(auth),operation:'job_quality_review',idempotencyKey:`quality:${run.id}:${run.next_batch}`,idempotencyFingerprint:fingerprint({prompt,plan}),requestId:null};
    const inputBytes=Buffer.byteLength(prompt.system+prompt.user),estimated={ai_generation_actions:1,llm_input_tokens:inputBytes,llm_output_tokens:prompt.maxOutputTokens,llm_total_tokens:inputBytes+prompt.maxOutputTokens};
    const reservation=await reserveUsage({...scope,measurements:estimated,relevantMetrics:Object.keys(estimated),planLimits:access.limits});
    if(reservation.duplicate)throw fail(409,'This quality request was already admitted and will not be sent again.','review_request_uncertain');
    const record=async(outcome,result)=>{const measured=Number.isSafeInteger(result?.raw?.usageMetadata?.totalTokenCount);await recordUsageEvent({...scope,reservationId:reservation.id,attemptNumber:reservation.attemptNumber,outcome,provider:plan.provider,model:plan.model,providerRequestId:result?.raw?.responseId||null,measurements:measured?{ai_generation_actions:1,...geminiTokenMeasurements(result.raw.usageMetadata)}:estimated,measurementAccuracy:measured?'exact':'estimated',metadata:{qualityRunId:run.id,batch:run.next_batch,billingCategory:'organization_provider',aiCredits:0,usageEstimated:!measured}});};
    let result;try{await beforeCall();result=await providerCall({...prompt,provider:plan.provider,model:plan.model,apiKey:selected.key});}catch(e){await record('failed',null);throw e;}
    await record('succeeded',result);return {text:result.text};
  },
});
export const jobDelivery=createJobDelivery({database:{query},authorize,github,identity:githubConnection,engine:sourceEngine,fingerprint});
