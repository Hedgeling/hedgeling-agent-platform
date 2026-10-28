import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { eventually } from '../test-support/local-console.mjs';
import { setupTranslationJobs as setup } from '../test-support/translation-jobs.mjs';

const manualController = crypto.randomUUID();
const options = { skip: process.env.HEDGELING_REQUIRE_AGENT_TEST_DATABASE !== 'true' };

test('bounded translation starts only on confirmation; replay cannot spend twice; Meta saves review drafts with Library provenance', options, async t => {
  const a = await setup(t), { database, request, meta } = a;
  const job = await a.draft();
  const proposal = await a.preview('localization_job.start', { jobId: job.id, maxTranslations: 2 });
  assert.equal(proposal.preview.resources.batch.pairs, 2);
  assert.equal(proposal.preview.resources.batch.remainingPairs, 1);
  assert.equal(proposal.preview.resources.batch.creditCeiling, 0);
  assert.match(proposal.preview.cost, /not a dollar quote/);
  assert.equal(meta.calls.length, 0);
  assert.equal((await database.query('select count(*)::int n from localization_job_items')).rows[0].n, 0);
  assert.equal((await request(`/api/agent/proposals/${proposal.id}/confirm`, { fingerprint: proposal.fingerprint, controllerId: manualController }, { authorization: `Bearer ${a.token}` })).status, 403);
  const both = await Promise.all([a.confirm(proposal), a.confirm(proposal)]);
  assert.equal(both.filter(r => r.replayed).length, 1);
  const final = await a.done(job.id);
  assert.equal(final.status, 'awaiting_review', JSON.stringify(final)); assert.equal(final.progress.succeeded, 2);
  assert.equal(meta.calls.length, 2);
  assert(meta.calls.every(c => c.body.max_output_tokens === 2048 && c.body.input.includes('concise library guidance') && c.body.input.includes('Formal and warm')));
  const translations = (await database.query('select text,human_status,provider from translations t join source_strings s on s.id=t.source_string_id where s.project_id=$1', [a.project.id])).rows;
  assert.equal(translations.length, 2); assert(translations.every(r => r.text === 'Bonjour {name}' && r.human_status === 'pending' && r.provider === 'meta'));
  const revisions = (await database.query("select prompt_snapshot from translation_revisions where prompt_snapshot->>'localizationJobId'=$1", [job.id])).rows;
  assert.equal(revisions.length, 2); assert.equal(revisions[0].prompt_snapshot.libraryVersions.persona.length, 1);
  const usage = (await database.query("select metadata from usage_events where metadata->>'localizationJobId'=$1", [job.id])).rows;
  assert.equal(usage.length, 2); assert(usage.every(r => r.metadata.aiCredits.quantity === 0));
  assert.equal((await request('/api/actions/localization_job.start', { jobId: job.id })).status, 409);
  // A new bounded batch skips saved drafts; the real MCP path discovers and proposes its start.
  const next = await a.draft('Remaining French');
  const controllerId = crypto.randomUUID();
  const run = (await request('/api/agent/runs', { controllerId, organizationId: a.org })).body.run;
  await request(`/api/agent/runs/${run.id}/messages`, { controllerId, text: 'Start translation job "Remaining French"' });
  const waiting = await eventually(() => request(`/api/agent/runs/${run.id}`), r => r.body.run?.status === 'awaiting_confirmation');
  const start = waiting.body.proposals.find(p => p.preview.action === 'localization_job.start');
  assert.equal(start.preview.resources.batch.pairs, 1); assert.equal(start.preview.resources.batch.preservedPairs, 2);
  assert.equal(meta.calls.length, 2);
  assert.equal((await request(`/api/agent/proposals/${start.id}/confirm`, { fingerprint: start.fingerprint, controllerId })).status, 200);
  assert.equal((await a.done(next.id)).status, 'awaiting_review'); assert.equal(meta.calls.length, 3);
  const all = (await request('/api/actions/reports.jobs.summary', { organizationId: a.org, status: 'awaiting_review' })).body.result;
  assert.equal(all.totals.jobs, 2);
});

test('changed guidance, provider and source invalidate start previews; unrelated tenants cannot inspect jobs', options, async t => {
  const a = await setup(t, 1), job = await a.draft();
  const preview = await a.preview('localization_job.start', { jobId: job.id });
  await a.database.query("update prompts set body='Use short language',updated_at=now() where project_id=$1", [a.project.id]);
  assert.equal((await a.request(`/api/agent/proposals/${preview.id}/confirm`, { fingerprint: preview.fingerprint, controllerId: manualController })).status, 409);
  const fresh = await a.preview('localization_job.start', { jobId: job.id });
  await a.database.query('update organization_ai_settings set revision=revision+1 where organization_id=$1', [a.org]);
  assert.equal((await a.request(`/api/agent/proposals/${fresh.id}/confirm`, { fingerprint: fresh.fingerprint, controllerId: manualController })).status, 409);
  await a.database.query("update source_strings set source_text='Welcome {name}' where project_id=$1", [a.project.id]);
  assert.equal((await a.request('/api/actions/localization_job.start', { jobId: job.id })).body.code, 'job_source_changed');
  const foreign = (await a.database.query("insert into organizations(name,slug) values('Foreign','foreign-jobs') returning id")).rows[0].id;
  await a.database.query('update business_units set organization_id=$2 where id=(select business_unit_id from projects where id=$1)', [a.project.id, foreign]);
  assert.equal((await a.request('/api/actions/localization_job.status', { jobId: job.id })).status, 403);
  assert.equal(a.meta.calls.length, 0);
});

test('confirmed stop during inference preserves saved content and stops subsequent calls, even if the plan expires', options, async t => {
  const a = await setup(t, 3), job = await a.draft();
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(release);
  a.meta.control.beforeResponse = () => gate;
  await a.confirm(await a.preview('localization_job.start', { jobId: job.id }));
  await eventually(async () => a.meta.calls.length, n => n === 1);
  await a.database.query("update subscriptions set state='unpaid'");
  await a.confirm(await a.preview('localization_job.cancel', { jobId: job.id }));
  release();
  await eventually(() => a.status(job.id), j => !j.progress.running);
  const final = await a.status(job.id);
  assert.equal(final.status, 'canceled'); assert.equal(final.progress.canceled, 3); assert.equal(a.meta.calls.length, 1);
  assert.equal((await a.database.query('select count(*)::int n from translations t join source_strings s on s.id=t.source_string_id where s.project_id=$1', [a.project.id])).rows[0].n, 0);
});

test('provider failures preserve earlier drafts and stop the rest; interrupted requests are never automatically replayed', options, async t => {
  const a = await setup(t, 3), job = await a.draft();
  a.meta.control.beforeResponse = () => { if (a.meta.calls.length === 2) a.meta.control.fail = true; };
  await a.confirm(await a.preview('localization_job.start', { jobId: job.id }));
  const final = await a.done(job.id);
  assert.equal(final.status, 'needs_attention'); assert.equal(final.progress.succeeded, 1); assert.equal(final.progress.failed, 1); assert.equal(final.progress.canceled, 1);
  assert.equal(a.meta.calls.length, 2); assert(!JSON.stringify(final).includes('private upstream detail'));
  const next = await a.draft('Interrupted batch');
  const p = await a.preview('localization_job.start', { jobId: next.id });
  // Hold the worker out while emulating a process that died after claiming its request.
  await a.confirm(p);
  await a.database.query("update localization_job_items set status='running',lease_token=gen_random_uuid(),lease_expires_at=now()-interval '1 minute' where job_id=$1 and ordinal=0", [next.id]);
  const interrupted = await a.done(next.id);
  assert.equal(interrupted.status, 'needs_attention'); assert.equal(interrupted.progress.uncertain, 1); assert.equal(a.meta.calls.length, 2);
});

test('concurrent edits during inference cannot overwrite a person’s translation or continue a changed batch', options, async t => {
  const a = await setup(t, 2), job = await a.draft();
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(release);
  a.meta.control.beforeResponse = () => gate;
  await a.confirm(await a.preview('localization_job.start', { jobId: job.id }));
  await eventually(async () => a.meta.calls.length, n => n === 1);
  const item = (await a.database.query("select source_string_id from localization_job_items where job_id=$1 and status='running'", [job.id])).rows[0];
  await a.database.query("insert into translations(source_string_id,locale,text,mt_status,human_status,source) values($1,'fr','Human work','ready','verified','human')", [item.source_string_id]);
  release();
  const final = await a.done(job.id); assert.equal(final.status, 'needs_attention'); assert.equal(a.meta.calls.length, 1);
  assert.equal((await a.database.query('select text from translations where source_string_id=$1', [item.source_string_id])).rows[0].text, 'Human work');
});

test('revoked permissions stop a confirmed job before saving or making another provider call', options, async t => {
  const a = await setup(t, 2), job = await a.draft();
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(release);
  a.meta.control.beforeResponse = () => gate;
  await a.confirm(await a.preview('localization_job.start', { jobId: job.id }));
  await eventually(async () => a.meta.calls.length, n => n === 1);
  const user = (await a.request('/api/me')).body.auth.user.id;
  await a.database.query('update role_assignments set revoked_at=now() where principal_id=$1 and scope_id=$2', [user, a.org]);
  release();
  await eventually(async () => (await a.database.query('select status from localization_jobs where id=$1', [job.id])).rows[0].status, s => s === 'needs_attention');
  assert.equal((await a.request('/api/actions/localization_job.status', { jobId: job.id })).status, 403);
  assert.equal(a.meta.calls.length, 1);
  assert.equal((await a.database.query('select count(*)::int n from translations t join source_strings s on s.id=t.source_string_id where s.project_id=$1', [a.project.id])).rows[0].n, 0);
});

test('managed-credit preview is finite and an existing hard budget blocks dispatch without falling back to BYOK', options, async t => {
  const a = await setup(t, 1, { HEDGELING_GEMINI_API_KEY: 'synthetic-unusable-key-for-budget-test' });
  await a.database.query("update organization_ai_settings set translation_mode='managed',revision=revision+1 where organization_id=$1", [a.org]);
  await a.database.query("insert into usage_budgets(organization_id,scope_type,metric_key,limit_quantity,enforcement) values($1,'organization','ai_credits',1,'block')", [a.org]);
  const job = await a.draft(), proposal = await a.preview('localization_job.start', { jobId: job.id });
  const batch = proposal.preview.resources.batch;
  assert.equal(batch.provider, 'gemini'); assert.equal(batch.mode, 'managed'); assert(Number.isSafeInteger(batch.creditCeiling) && batch.creditCeiling > 1);
  assert.match(proposal.preview.cost, /Hedgeling AI credits/);
  await a.confirm(proposal);
  const final = await a.done(job.id); assert.equal(final.status, 'needs_attention'); assert.equal(a.meta.calls.length, 0);
  assert.equal((await a.database.query('select count(*)::int n from usage_events')).rows[0].n, 0);
  assert.equal((await a.database.query("select count(*)::int n from usage_budget_alerts where threshold='blocked'")).rows[0].n, 1);
});
