import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTranslationJobs } from '../test-support/translation-jobs.mjs';
import { eventually } from '../test-support/local-console.mjs';
const options = { skip:process.env.HEDGELING_REQUIRE_AGENT_TEST_DATABASE !== 'true' };
async function setup(t,count = 2) {
  const a = await setupTranslationJobs(t,count);
  for (const id of a.sources) await a.database.query(`insert into context_variants(source_string_id,file_path,code_context,raw)
    values($1,'src/welcome.tsx','<h1>Hello {name}</h1>',$2)`,[id,{codeEvidence:{text:'<h1>Hello {name}</h1>',startLine:1,endLine:1}}]);
  a.meta.control.beforeResponse = ({body}) => {
    if (body?.instructions?.startsWith('You write translator context')) a.meta.control.text = JSON.stringify({items:JSON.parse(body.input).items.map(s => ({id:s.id,description:'A personalized welcome heading. Preserve the name placeholder.',evidence:'code',confidence:'high',suggestedMaxCharacters:null,limitReason:'The heading has no measurable character budget.'}))});
    else a.meta.control.text = 'Bonjour {name}';
  };
  a.contextStatus = async runId => (await a.request('/api/actions/context.status',{runId})).body.result?.run;
  a.contextDone = runId => eventually(() => a.contextStatus(runId),r => r && !['queued','running'].includes(r.status),15000);
  a.enrich = async () => { const r = (await a.confirm(await a.preview('context.enrich',{projectSlug:a.project.slug}))).result.contextRun; return a.contextDone(r.id); };
  return a;
}
test('enrichment and acceptance require separate human approvals; accepted fresh context reaches translation and detail UI',options,async t => {
  const a = await setup(t), preview = await a.preview('context.enrich',{projectSlug:a.project.slug});
  assert.equal(preview.preview.resources.stringsWithCode,2); assert.equal(a.meta.calls.length,0);
  assert.equal(preview.preview.resources.provider.maximumRequests,1);
  assert.equal((await a.request(`/api/agent/proposals/${preview.id}/confirm`,{fingerprint:preview.fingerprint,controllerId:crypto.randomUUID()},{authorization:`Bearer ${a.token}`})).status,403);
  const [one,two] = await Promise.all([a.confirm(preview),a.confirm(preview)]); assert(one.replayed || two.replayed);
  const result = await a.contextDone(one.result.contextRun.id); assert.equal(result.status,'awaiting_review',JSON.stringify(result));
  assert.equal(a.meta.calls.length,1); assert.match(a.meta.calls[0].body.input,/<h1>/);
  assert.equal((await a.database.query('select count(*)::int n from source_context_enrichments')).rows[0].n,0);
  const approval = await a.preview('context.apply',{runId:result.id,stringIds:[a.sources[0]]});
  await a.confirm(approval); await a.confirm(approval);
  assert.equal(a.meta.calls.length,1); assert.equal((await a.contextStatus(result.id)).status,'awaiting_review');
  const detail = await a.request(`/api/strings/${a.sources[0]}`); assert.match(detail.body.acceptedContext.description,/personalized welcome/);
  const job = await a.draft(); await a.confirm(await a.preview('localization_job.start',{jobId:job.id}));
  assert.equal((await a.done(job.id)).status,'awaiting_review');
  const inputs = a.meta.calls.slice(1).map(c => JSON.parse(c.body.input.slice(c.body.input.indexOf('{'))));
  assert.equal(inputs.filter(i => i.acceptedContext?.description.includes('personalized welcome')).length,1);
  assert.equal((await a.database.query('select count(*)::int n from source_strings where limit_chars is not null')).rows[0].n,0);
  await a.database.query("update context_variants set code_context='<footer>Hello {name}</footer>' where source_string_id=$1",[a.sources[0]]);
  assert.equal((await a.request(`/api/strings/${a.sources[0]}`)).body.acceptedContext,null);
  const list = (await a.request('/api/actions/context.strings',{projectSlug:a.project.slug})).body.result;
  assert.equal(list.strings.find(s => s.id===a.sources[0]).current,false);
  const usage = (await a.database.query("select provider from usage_events where operation='context_enrichment'")).rows;
  assert.equal(usage.length,1); assert.equal(usage[0].provider,'meta');
  await a.database.query('delete from agent_proposals where id=$1',[preview.id]);
  assert.equal((await a.database.query('select count(*)::int n from source_context_enrichments')).rows[0].n,1);
  assert.equal((await a.database.query('select proposal_id from context_enrichment_runs where id=$1',[result.id])).rows[0].proposal_id,null);
});
test('stale source/provider previews are rejected before spending; stale results cannot be accepted',options,async t => {
  const a = await setup(t,1), p = await a.preview('context.enrich',{projectSlug:a.project.slug});
  await a.database.query("update context_variants set purpose='Different purpose' where source_string_id=$1",[a.sources[0]]);
  assert.equal((await a.request(`/api/agent/proposals/${p.id}/confirm`,{fingerprint:p.fingerprint,controllerId:crypto.randomUUID()})).status,409);
  const p2 = await a.preview('context.enrich',{projectSlug:a.project.slug});
  await a.database.query('update organization_ai_settings set revision=revision+1 where organization_id=$1',[a.org]);
  assert.equal((await a.request(`/api/agent/proposals/${p2.id}/confirm`,{fingerprint:p2.fingerprint,controllerId:crypto.randomUUID()})).status,409);
  assert.equal(a.meta.calls.length,0);
  const result = await a.enrich(); assert.equal(result.status,'awaiting_review',JSON.stringify(result));
  await a.database.query('update source_strings set limit_chars=30 where id=$1',[a.sources[0]]);
  assert.equal((await a.request('/api/actions/context.apply',{runId:result.id})).body.code,'context_stale');
});
test('provider failures and invalid output save no guidance; tenant boundaries protect reads and writes',options,async t => {
  const a = await setup(t,1); a.meta.control.beforeResponse = null; a.meta.control.text='not JSON';
  const result = await a.enrich(); assert.equal(result.error,'context_result_invalid'); assert.equal(a.meta.calls.length,1);
  await a.database.query("update context_enrichment_runs set status='running',lease_token=gen_random_uuid(),lease_expires_at=now()-interval '1 minute' where id=$1",[result.id]);
  assert.equal((await a.contextDone(result.id)).status,'uncertain'); assert.equal(a.meta.calls.length,1);
  assert.equal((await a.database.query('select count(*)::int n from source_context_enrichments')).rows[0].n,0);
  const foreign = (await a.database.query("insert into organizations(name,slug) values('Other','other-context') returning id")).rows[0].id;
  const unit = (await a.database.query("insert into business_units(name,slug,organization_id) values('Private','private',$1) returning id",[foreign])).rows[0].id;
  const otherProject = (await a.database.query("insert into projects(name,slug,business_unit_id,source_locale) values('Private','private-context',$1,'en') returning id",[unit])).rows[0].id;
  assert.equal((await a.request('/api/actions/context.enrich',{projectSlug:'private-context'})).status,403);
  await a.database.query('update context_enrichment_runs set project_id=$2 where id=$1',[result.id,otherProject]);
  assert.equal((await a.request('/api/actions/context.status',{runId:result.id})).status,403);
  assert.equal((await a.request('/api/actions/context.strings',{projectSlug:'private-context'})).status,403);
});
test('revocation during inference prevents saving results and does not dispatch again',options,async t => {
  const a = await setup(t,1), respond = a.meta.control.beforeResponse;
  a.meta.control.beforeResponse = async value => { await respond(value); await a.database.query("update subscriptions set state='unpaid'"); };
  const result = await a.enrich(); assert.equal(result.status,'failed'); assert.equal(result.error,'context_plan_required');
  assert.equal(result.results.length,0); assert.equal(a.meta.calls.length,1);
});
