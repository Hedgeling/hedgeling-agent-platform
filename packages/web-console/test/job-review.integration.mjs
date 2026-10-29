import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {eventually} from '../test-support/local-console.mjs';
import {setupTranslationJobs as setup} from '../test-support/translation-jobs.mjs';
const options={skip:process.env.HEDGELING_REQUIRE_AGENT_TEST_DATABASE!=='true'};
async function translated(a,{count=a.sources.length,steps=['machine_translation','review']}={}){
  const job=(await a.confirm(await a.preview('localization_job.create',{projectSlug:a.project.slug,name:'Quality fixture',targetLocales:['fr'],steps}))).result.job;
  await a.database.query("update localization_jobs set status='awaiting_review' where id=$1",[job.id]);
  for(const id of a.sources.slice(0,count))await a.database.query("insert into translations(source_string_id,locale,text,mt_status,human_status,source) values($1,'fr','Bonjour {name}','ready','pending','mt')",[id]);
  a.meta.control.beforeResponse=({body})=>{const input=JSON.parse(body.input);a.meta.control.text=JSON.stringify({items:input.items.map(i=>({id:i.id,verdict:'pass',issues:[]}))});};
  return job;
}
const status=async(a,id)=>(await a.request('/api/actions/localization_job.review_status',{jobId:id})).body.result?.qualityRun;
const done=(a,id)=>eventually(()=>status(a,id),r=>r&&['ready','failed','uncertain','cancelled'].includes(r.status),20000);
test('AI quality checks require confirmation; findings and verification remain separate, with one-time approval',options,async t=>{
  const a=await setup(t,3),job=await translated(a);
  const rows=(await a.database.query('select id from translations order by id')).rows;
  await a.database.query("update translations set human_status='verified' where id=$1",[rows[2].id]);
  a.meta.control.beforeResponse=({body})=>{const input=JSON.parse(body.input);a.meta.control.text=JSON.stringify({items:input.items.map(i=>({id:i.id,verdict:i.id===rows[0].id?'needs_changes':'pass',issues:i.id===rows[0].id?['Incorrect tone.']:[]}))});};
  const p=await a.preview('localization_job.review',{jobId:job.id,selection:'in_review'});assert.equal(p.preview.fields.translations,2);assert.equal(a.meta.calls.length,0);
  const start=await a.confirm(p);assert.equal((await a.confirm(p)).replayed,true);
  const r=await done(a,job.id);assert.equal(r.status,'ready',JSON.stringify(r));assert.equal(r.counts.pass,1);assert.equal(r.counts.needs_changes,1);assert.equal(a.meta.calls.length,1);
  assert.equal((await a.database.query("select count(*)::int n from translations where human_status='verified'")).rows[0].n,1);
  const verify=await a.preview('localization_job.verify',{jobId:job.id,runId:start.result.qualityRun.id});assert.equal(verify.preview.fields.translations,1);
  const forbidden=await a.request(`/api/agent/proposals/${verify.id}/confirm`,{fingerprint:verify.fingerprint,controllerId:crypto.randomUUID()},{authorization:`Bearer ${a.token}`});assert.equal(forbidden.status,403);
  await a.confirm(verify);assert.equal((await a.confirm(verify)).replayed,true);assert.equal(a.meta.calls.length,1);
  assert.equal((await a.database.query("select count(*)::int n from translations where human_status='verified'")).rows[0].n,2);
  assert.equal((await a.database.query('select human_status from translations where id=$1',[rows[0].id])).rows[0].human_status,'pending');
  assert.equal((await a.request('/api/actions/localization_job.verify',{jobId:job.id,runId:r.id,translationIds:[rows[0].id]})).status,409);
  const usage=(await a.database.query("select metadata from usage_events where operation='job_quality_review'")).rows;assert.equal(usage.length,1);assert.equal(usage[0].metadata.aiCredits,0);
});
test('all selection is batched completely and findings paginate without inference',options,async t=>{
  const a=await setup(t,55),job=await translated(a);const p=await a.preview('localization_job.review',{jobId:job.id,selection:'all'});assert.equal(p.preview.fields.translations,55);
  await a.confirm(p);const r=await done(a,job.id);assert.equal(r.status,'ready',JSON.stringify(r));assert.equal(r.checked,55);assert.equal(a.meta.calls.length,3);assert.equal(r.results.length,50);
  const page=(await a.request('/api/actions/localization_job.review_status',{jobId:job.id,runId:r.id,offset:50})).body.result;assert.equal(page.qualityRun.results.length,5);assert.equal(page.page.nextOffset,null);assert.equal(a.meta.calls.length,3);
  await a.confirm(await a.preview('localization_job.verify',{jobId:job.id,runId:r.id}));assert.equal((await a.status(job.id)).status,'completed');
});
test('stale translations and revoked access prevent verification and save no false approvals',options,async t=>{
  const a=await setup(t,1),job=await translated(a);await a.confirm(await a.preview('localization_job.review',{jobId:job.id}));const r=await done(a,job.id);assert.equal(r.status,'ready',JSON.stringify(r));
  const verify=await a.preview('localization_job.verify',{jobId:job.id,runId:r.id});await a.database.query("update translations set text='Human edit {name}',updated_at=now()");
  const stale=await a.request(`/api/agent/proposals/${verify.id}/confirm`,{fingerprint:verify.fingerprint,controllerId:crypto.randomUUID()});assert.equal(stale.status,409);assert.equal(stale.body.code,'review_inputs_changed');
  const user=(await a.request('/api/me')).body.auth.user.id;await a.database.query('update role_assignments set revoked_at=now() where principal_id=$1 and scope_id=$2',[user,a.org]);
  assert.equal((await a.request('/api/actions/localization_job.review_status',{jobId:job.id})).status,403);
  assert.equal((await a.database.query("select count(*)::int n from translations where human_status='verified'")).rows[0].n,0);
});
test('cancel during AI inference stops remaining requests and never verifies',options,async t=>{
  const a=await setup(t,21),job=await translated(a);let release;const gate=new Promise(resolve=>{release=resolve;});t.after(release);
  const response=a.meta.control.beforeResponse;a.meta.control.beforeResponse=async options=>{response(options);await gate;};
  await a.confirm(await a.preview('localization_job.review',{jobId:job.id,selection:'all'}));await eventually(async()=>a.meta.calls.length,n=>n===1);
  const r=await status(a,job.id);await a.confirm(await a.preview('localization_job.review_cancel',{jobId:job.id,runId:r.id}));release();
  assert.equal((await done(a,job.id)).status,'cancelled');assert.equal(a.meta.calls.length,1);assert.equal((await a.database.query("select count(*)::int n from translations where human_status='verified'")).rows[0].n,0);
});
test('AI-only completes without review, while a bounded partial batch stays incomplete and unverified',options,async t=>{
  const a=await setup(t,2);
  const draft=async name=>(await a.confirm(await a.preview('localization_job.create',{projectSlug:a.project.slug,name,targetLocales:['fr'],steps:['machine_translation']}))).result.job;
  const job=await draft('AI only partial');await a.confirm(await a.preview('localization_job.start',{jobId:job.id,maxTranslations:1}));
  const partial=await eventually(()=>a.status(job.id),j=>j?.status==='partially_translated',15000);assert.equal(partial.workflow,'AI-only translations');assert.equal(partial.coverage.missing,1);assert.equal(partial.coverage.verified,0);
  const next=await draft('AI only complete');await a.confirm(await a.preview('localization_job.start',{jobId:next.id}));const complete=await eventually(()=>a.status(next.id),j=>j?.status==='completed',15000);
  assert.equal(complete.coverage.missing,0);assert.equal(complete.coverage.verified,0);assert.equal(a.meta.calls.length,2);
  assert.equal((await a.database.query('select count(*)::int n from job_quality_runs')).rows[0].n,0);
});

test('AI-only completion counts nonempty saved translations, not preserved empty rows',options,async t=>{
  const a=await setup(t,2);
  await a.database.query("insert into translations(source_string_id,locale,text,mt_status,human_status,source) values($1,'fr','','ready','pending','human')",[a.sources[0]]);
  const job=(await a.confirm(await a.preview('localization_job.create',{projectSlug:a.project.slug,name:'Preserve empty manual row',targetLocales:['fr'],steps:['machine_translation']}))).result.job;
  await a.confirm(await a.preview('localization_job.start',{jobId:job.id}));
  const final=await eventually(()=>a.status(job.id),j=>j?.status==='partially_translated',15000);
  assert.equal(final.coverage.missing,1);assert.equal(final.coverage.verified,0);assert.equal(a.meta.calls.length,1);
  assert.equal((await a.database.query('select text from translations where source_string_id=$1',[a.sources[0]])).rows[0].text,'');
});
