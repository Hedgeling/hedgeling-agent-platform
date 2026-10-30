// SPDX-License-Identifier: Apache-2.0
import {randomUUID} from 'node:crypto';
import {fail} from './errors.js';
import {loadJob,jobTarget,currentJobSources,jobTranslations,jobCoverage,selectedLocales,isAiOnly} from './job-scope.js';
import {REVIEW_LIMITS,reviewBatches,reviewPrompt,parseReview} from './job-review-analysis.js';
export function createJobReview({database,transaction,authorize,inspectProvider,generate,fingerprint}) {
  const load=(input,auth,scope,db,permission='read',lock=false)=>loadJob(db,input.jobId,auth,scope,authorize,permission,lock);
  async function run(input,db,lock=false){const r=(await db.query(`select * from job_quality_runs where job_id=$1${input.runId?' and id=$2':''} order by created_at desc,id desc limit 1${lock?' for update':''}`,input.runId?[input.jobId,input.runId]:[input.jobId])).rows[0];if(!r&&input.runId)throw fail(404,'Quality run not found.','review_not_found');return r;}
  async function guidance(db,p,locales){return {
    prompts:(await db.query('select key,body from prompts where project_id=$1 and active=true order by key',[p.id])).rows,
    personas:(await db.query('select locale,body from personas where project_id=$1 and active=true and locale=any($2::text[]) order by locale,id',[p.id,locales])).rows,
    glossary:(await db.query('select term,locale,translation,description,do_not_translate from glossary_terms where project_id=$1 and active=true and (locale is null or locale=any($2::text[])) order by id',[p.id,locales])).rows,
  };}
  async function selection(db,p,job,options){const rows=await jobTranslations(db,job,options);
    const contexts=(await db.query('select source_string_id,data,evidence_fingerprint from source_context_enrichments where source_string_id=any($1::uuid[]) order by source_string_id',[rows.map(r=>r.sourceId)])).rows;
    return rows.map(r=>({...r,enrichedContext:contexts.find(c=>c.source_string_id===r.sourceId)||null}));}
  async function guard(db,p,job,r,lock=false,ids=null){await currentJobSources(db,p,job,lock);
    const locales=r.provider_plan.locales;
    if(fingerprint(await guidance(db,p,locales))!==fingerprint(r.guidance))throw fail(409,'Library guidance changed. Run a fresh quality check.','review_inputs_changed');
    const wanted=ids||r.snapshot.map(s=>s.id),current=await selection(db,p,job,{locales,ids:wanted,limit:1001,lock});
    const before=new Map(r.snapshot.map(s=>[s.id,s]));
    if(current.length!==wanted.length||current.some(s=>fingerprint(s)!==fingerprint(before.get(s.id))))throw fail(409,'Translations or context changed since the quality check. Run a fresh check for this selection.','review_inputs_changed');
    return current;
  }
  async function read(name,input,auth,scope={},db=database){const {p,job}=await load(input,auth,scope,db),r=await run(input,db),uiTarget=jobTarget(p,job.id,name);
    if(!r)return {qualityRun:null,uiTarget};
    const offset=input.offset||0,counts={pass:0,needs_changes:0,uncertain:0};for(const item of r.results)counts[item.verdict]++;
    const results=r.results.slice(offset,offset+REVIEW_LIMITS.resultPage).map(result=>{const s=r.snapshot.find(s=>s.id===result.id);return {...result,locale:s.locale,source:s.sourceText.slice(0,2000),translation:s.text.slice(0,2000),accepted:r.accepted_ids.includes(s.id),previousStatus:s.humanStatus};});
    return {qualityRun:{id:r.id,jobId:job.id,status:r.status,selection:r.selection,targetLocales:r.provider_plan.locales,total:r.snapshot.length,checked:r.results.length,counts,accepted:r.accepted_ids.length,provider:r.provider_plan.provider,model:r.provider_plan.model,error:r.error_code,results},page:{nextOffset:offset+results.length<r.results.length?offset+results.length:null},uiTarget};
  }
  async function prepare(name,input,auth,scope={},db=database,lock=false){const {p,job}=await load(input,auth,scope,db,'review',lock),uiTarget=jobTarget(p,job.id,name);
    const base={organizationId:p.organizationId,p,job,uiTarget};
    if(name==='localization_job.review_cancel'){const r=await run(input,db,lock);if(!['queued','running'].includes(r.status))throw fail(409,'This check is not running.','review_not_running');return {...base,r,preview:{action:name,fields:{name:job.name,runId:r.id},resources:{},cost:'An in-flight provider request may still be charged.',sideEffects:['Stop remaining quality checks. Keep completed findings. No translations are verified.']}};}
    if(name==='localization_job.verify'){
      const r=await run(input,db,lock);if(!['ready','applied'].includes(r.status))throw fail(409,'Wait for a complete quality check.','review_not_ready');
      const eligible=r.results.filter(s=>s.verdict==='pass'&&!r.accepted_ids.includes(s.id)&&!['verified','rejected'].includes(r.snapshot.find(t=>t.id===s.id).humanStatus)).map(s=>s.id);
      const ids=input.translationIds||eligible;
      if(!ids.length||ids.some(id=>!eligible.includes(id)))throw fail(409,'Select passing, unaccepted translations. Human-rejected entries require individual review.','review_selection_invalid');
      const items=await guard(db,p,job,r,lock,ids);
      return {...base,r,items,preview:{action:name,fields:{name:job.name,translations:items.length,runId:r.id},resources:{contentVersion:fingerprint(items),sample:items.slice(0,10).map(i=>({locale:i.locale,source:i.sourceText,translation:i.text}))},cost:'No model calls.',sideEffects:[`Mark ${items.length} passing translations verified after your confirmation. Preserve their text.`,`Leave flagged, uncertain, human-rejected and unselected translations unchanged. This records your approval of an AI assessment, not a human linguistic review.`]}};
    }
    if(['queued','running'].includes(job.status))throw fail(409,'Wait for translation to finish before checking it.','review_job_running');
    if((await db.query("select 1 from job_quality_runs where job_id=$1 and status in ('queued','running')",[job.id])).rowCount)throw fail(409,'A quality check is already running for this job.','review_already_running');
    await currentJobSources(db,p,job,lock);const locales=selectedLocales(job,input.targetLocales),selected=input.selection||'in_review';
    const items=await selection(db,p,job,{locales,selection:selected,limit:1001,lock}),assets=await guidance(db,p,locales);
    const batches=reviewBatches(items,job.source_locale,assets),provider=await inspectProvider(auth,p);
    const plan={...provider,locales,batches:batches.map(b=>b.map(i=>i.id)),maximumRequests:batches.length,maximumOutputTokens:batches.length*REVIEW_LIMITS.outputTokens,maximumInputBytes:batches.reduce((n,b)=>{const prompt=reviewPrompt(b,job.source_locale,assets);return n+Buffer.byteLength(prompt.system+prompt.user);},0)};
    const coverage=await jobCoverage(db,job,locales);
    return {...base,items,assets,plan,selected,preview:{action:name,fields:{name:job.name,selection:selected,targetLocales:locales,translations:items.length},resources:{coverage,provider:{provider:plan.provider,model:plan.model,mode:plan.mode},contentVersion:fingerprint({items,assets,plan})},cost:`Your organization’s ${plan.provider} key. At most ${plan.maximumRequests} requests, ${plan.maximumInputBytes} input bytes and ${plan.maximumOutputTokens} output tokens. Provider charges apply; this is not a dollar quote. No automatic paid retries.`,sideEffects:[`Analyze ${items.length} existing translations for meaning, language, terminology, tone, placeholders and hard limits. ${coverage.missing} missing translations are not checked.`,`Save AI findings only. Do not change translation text or verification status. Passing results need a separate confirmation to become verified.`,...(isAiOnly(job)?['This is an explicitly requested extra check; the job remains labeled AI-only translations.']:[])]}};
  }
  async function apply(name,prepared,proposal,auth,db){const {p,job}=prepared;
    let runId=prepared.r?.id;
    if(name==='localization_job.review_cancel')await db.query("update job_quality_runs set status='cancelled',finished_at=now() where id=$1",[runId]);
    else if(name==='localization_job.verify'){
      const ids=prepared.items.map(i=>i.id);
      await db.query("update translations set human_status='verified',review_note=null,updated_at=now() where id=any($1::uuid[])",[ids]);
      await db.query("update job_quality_runs set accepted_ids=accepted_ids||$2::uuid[],status='applied' where id=$1",[runId,ids]);
      const coverage=await jobCoverage(db,job);
      if(!isAiOnly(job)&&coverage.total>0&&coverage.verified===coverage.total)await db.query("update localization_jobs set status='completed',finished_at=now() where id=$1 and status not in ('queued','running','canceled')",[job.id]);
    }else{
      const actor={principalType:'user',user:{id:auth.user.id,platformStaff:false},executionType:'agent',platformAdmin:false};
      runId=(await db.query(`insert into job_quality_runs(job_id,project_id,proposal_id,created_by_user_id,actor,source_locale,selection,status,snapshot,guidance,provider_plan)
        values($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10) returning id`,[job.id,p.id,proposal.id,auth.user.id,actor,job.source_locale,prepared.selected,JSON.stringify(prepared.items),prepared.assets,prepared.plan])).rows[0].id;
    }
    return {qualityRun:{id:runId,jobId:job.id,status:name==='localization_job.verify'?'applied':name==='localization_job.review_cancel'?'cancelled':'queued',verified:prepared.items&&name==='localization_job.verify'?prepared.items.length:0},uiTarget:jobTarget(p,job.id,name)};
  }
  async function tick(){const claimed=await transaction(async db=>{
    await db.query("update job_quality_runs set status='uncertain',error_code='review_request_uncertain',finished_at=now() where status='running' and lease_expires_at<now()");
    const r=(await db.query("select * from job_quality_runs where status='queued' order by created_at,id limit 1 for update skip locked")).rows[0];if(!r)return null;
    const token=randomUUID();await db.query("update job_quality_runs set status='running',lease_token=$2,lease_expires_at=now()+interval '5 minutes' where id=$1",[r.id,token]);return {r,token};
  });if(!claimed)return false;const {r,token}=claimed,auth=r.actor;
    const check=async(db,lock=false)=>{const {p,job}=await load({jobId:r.job_id},auth,{},db,'review',lock),latest=await run({jobId:r.job_id,runId:r.id},db,lock);
      if(latest.status!=='running'||latest.lease_token!==token)throw fail(409,'Quality check stopped.','review_stopped');
      await guard(db,p,job,r,lock);const provider=await inspectProvider(auth,p);
      if(['provider','model','mode','version'].some(k=>provider[k]!==r.provider_plan[k]))throw fail(409,'Provider configuration changed.','review_provider_changed');return {p,job};};
    try{const {p}=await check(database),ids=r.provider_plan.batches[r.next_batch],items=r.snapshot.filter(s=>ids.includes(s.id)),prompt=reviewPrompt(items,r.source_locale,r.guidance);
      const output=await generate({p,auth,run:r,prompt,beforeCall:()=>check(database)}),results=parseReview(output.text,items);
      await transaction(async db=>{await check(db,true);const done=r.next_batch+1===r.provider_plan.batches.length;
        await db.query(`update job_quality_runs set results=results||$2::jsonb,next_batch=next_batch+1,status=$3,finished_at=case when $3='ready' then now() else null end where id=$1`,[r.id,JSON.stringify(results),done?'ready':'queued']);});
    }catch(e){await database.query("update job_quality_runs set status='failed',error_code=$3,finished_at=now() where id=$1 and lease_token=$2 and status='running'",[r.id,token,['review_inputs_changed','review_provider_changed','review_result_invalid','review_access_denied','review_request_uncertain'].includes(e.code)?e.code:'review_failed']);}
    return true;
  }
  function startWorker(){let busy=false;const timer=setInterval(()=>{if(busy)return;busy=true;void tick().catch(()=>console.error('Quality worker could not finish its check.')).finally(()=>{busy=false;});},1000);timer.unref();return ()=>clearInterval(timer);}
  return {read,prepare,apply,tick,startWorker,replay:(input,auth,scope,db)=>load(input,auth,scope,db,'review')};
}
