// SPDX-License-Identifier: Apache-2.0
import { fail } from './errors.js';
export const isAiOnly = job => job.steps.length === 1 && job.steps[0] === 'machine_translation';
export const jobTarget = (p,id,action) => ({view:'workspace',organizationId:p.organizationId,projectSlug:p.slug,action,resource:{type:'job',id}});
export async function loadJob(db,jobId,auth,scope,authorize,permission='read',lock=false) {
  const p=(await db.query(`select p.id,p.slug,p.name,p.source_locale as "sourceLocale",p.business_unit_id as "businessUnitId",b.organization_id as "organizationId"
    from projects p join business_units b on b.id=p.business_unit_id join localization_jobs j on j.project_id=p.id where j.id=$1 and p.data_purged_at is null${lock?' for update of p':''}`,[jobId])).rows[0];
  if(!p)throw fail(404,'Localization job not found.','job_not_found');
  if(Object.hasOwn(scope,'organizationId')&&scope.organizationId!==p.organizationId)throw fail(403,'Choose this job’s workspace first.','agent_scope_mismatch');
  const job=(await db.query('select * from localization_jobs where id=$1'+(lock?' for update':''),[jobId])).rows[0];
  await authorize(auth,p,job.target_locales,permission);
  return {p,job};
}
export function selectedLocales(job,locales) {
  const result=locales||job.target_locales;
  if(!result.length||new Set(result).size!==result.length||result.some(l=>!job.target_locales.includes(l)))throw fail(400,'Choose languages included in this job.','job_locale_invalid');
  return [...result].sort();
}
export async function currentJobSources(db,p,job,lock=false) {
  const rows=(await db.query('select id,source_hash,source_text,limit_chars,purpose,visual_context from source_strings where project_id=$1 and id=any($2::uuid[]) order by id'+(lock?' for update':''),[p.id,job.source_snapshot.map(s=>s.id)])).rows;
  const saved=new Map(job.source_snapshot.map(s=>[s.id,s]));
  if(job.source_locale!==p.sourceLocale||rows.length!==saved.size||rows.some(s=>saved.get(s.id)?.source_hash!==s.source_hash||saved.get(s.id)?.source_text!==s.source_text))throw fail(409,'Source content changed since this job. Create a fresh job from the current catalog.','job_source_changed');
  return rows;
}
export async function jobCoverage(db,job,locales=job.target_locales) {
  const r=(await db.query(`select count(*)::int as saved,count(*) filter(where human_status='verified')::int as verified,
    count(*) filter(where human_status='rejected')::int as rejected,count(*) filter(where coalesce(human_status,'pending') in ('pending','needs-review'))::int as "inReview"
    from translations where source_string_id=any($1::uuid[]) and locale=any($2::text[]) and length(trim(text))>0`,[job.source_snapshot.map(s=>s.id),locales])).rows[0];
  const total=job.source_snapshot.length*locales.length;
  return {...r,total,missing:total-r.saved};
}
export async function jobTranslations(db,job,{locales=job.target_locales,selection='all',ids=null,limit=1001,lock=false}={}) {
  return (await db.query(`select t.id,t.source_string_id as "sourceId",t.locale,t.text,t.source,t.provider,t.model,t.human_status as "humanStatus",t.review_note as "reviewNote",t.updated_at as "updatedAt",
    s.source_hash as "sourceHash",s.source_text as "sourceText",s.limit_chars as "limitChars",s.purpose,s.visual_context as "visualContext"
    from translations t join source_strings s on s.id=t.source_string_id where s.project_id=$1 and s.id=any($2::uuid[]) and t.locale=any($3::text[])
    and ($4='all' or coalesce(t.human_status,'pending') in ('pending','needs-review')) and ($5::uuid[] is null or t.id=any($5::uuid[]))
    order by t.id limit $6${lock?' for update of t':''}`,[job.project_id,job.source_snapshot.map(s=>s.id),locales,selection,ids,limit])).rows;
}
