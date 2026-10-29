// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { fail } from './errors.js';
import { isAiOnly,jobCoverage } from './job-scope.js';

export const TRANSLATION_JOB_LIMITS = Object.freeze({ defaultPairs: 100, maximumPairs: 200, promptBytes: 65536, outputTokens: 2048, attempts: 2 });
const active = ['queued', 'running'];
const projectSql = `select p.id,p.slug,p.name,p.source_locale as "sourceLocale",p.business_unit_id as "businessUnitId",b.organization_id as "organizationId"
  from projects p join business_units b on b.id=p.business_unit_id join localization_jobs j on j.project_id=p.id where j.id=$1 and p.data_purged_at is null`;
const target = (p, id, action) => ({ view: 'workspace', organizationId: p.organizationId, projectSlug: p.slug, action, resource: { type: 'job', id } });
const content = rows => rows.map(r => ({ id: r.id, source_hash: r.source_hash, source_text: r.source_text }));

// Authorization, provider preparation, usage enforcement and revision saves are
// host dependencies. This module never holds credentials or invokes a model.
export function createTranslationJobs({ database, transaction, authorize, inspect, execute, fingerprint }) {
  async function load(input, auth, context, db, write = false, lock = false) {
    const p = (await db.query(projectSql + (lock ? ' for update of p' : ''), [input.jobId])).rows[0];
    if (!p) throw fail(404, 'Localization job not found.', 'job_not_found');
    const job = (await db.query('select * from localization_jobs where id=$1' + (lock ? ' for update' : ''), [input.jobId])).rows[0];
    if (Object.hasOwn(context, 'organizationId') && context.organizationId !== p.organizationId) throw fail(403, 'Choose this job’s workspace first.', 'agent_scope_mismatch');
    await authorize(auth, p, job.target_locales, write);
    return { p, job };
  }
  async function read(input, auth, context = {}, db = database) {
    const { p, job } = await load(input, auth, context, db);
    const counts = (await db.query('select status,count(*)::int as count from localization_job_items where job_id=$1 group by status', [job.id])).rows;
    const errors = (await db.query(`select locale,error_code as code,error_message as message from localization_job_items
      where job_id=$1 and error_code is not null order by ordinal limit 5`, [job.id])).rows;
    return { job: { id: job.id, name: job.name, status: job.status, projectSlug: p.slug,
      targetLocales: job.target_locales, steps: job.steps, documentId: job.source_document_id || null, progress: Object.fromEntries(counts.map(r => [r.status, r.count])),
      workflow: isAiOnly(job) ? 'AI-only translations' : job.steps.map(step=>({machine_translation:'AI Translation',human_translation:'Human translation',review:'Review',qa:'Quality check'})[step]||step).join(' → '), coverage: await jobCoverage(db,job),
      batch: job.execution?.summary || null, startedAt: job.started_at, finishedAt: job.finished_at, errors },
    uiTarget: target(p, job.id, 'localization_job.status') };
  }
  async function prepare(name, input, auth, context = {}, db = database, lock = false) {
    const { p, job } = await load(input, auth, context, db, true, lock);
    const uiTarget = target(p, job.id, name);
    if (name === 'localization_job.cancel') {
      if (!active.includes(job.status)) throw fail(409, 'This job is not running.', 'job_not_running');
      return { organizationId: p.organizationId, p, job, uiTarget, preview: { action: name,
        fields: { name: job.name, targetLocales: job.target_locales }, resources: { project: p, jobId: job.id },
        cost: 'An in-flight request may still be billed by the provider.', sideEffects: ['Stop further provider calls and draft saves for this job.', 'Keep already saved drafts for review.'] } };
    }
    if (job.status !== 'draft') throw fail(409, 'This job has already started. Check its progress; create a new draft for another batch.', 'job_already_started');
    if (job.steps[0] !== 'machine_translation' || job.steps.includes('human_translation')) throw fail(400, 'Choose AI translation as the first step. Human translation jobs cannot run automatically.', 'job_steps_unsupported');
    if (job.source_locale !== p.sourceLocale) throw fail(409, 'The source language changed. Create a new job draft.', 'job_source_changed');
    const other = (await db.query("select id from localization_jobs where project_id=$1 and status in ('queued','running') limit 1", [p.id])).rows[0];
    if (other) throw fail(409, 'Another translation job is running in this project. Wait for it or stop it first.', 'job_already_running');
    const sources = (await db.query('select id,source_hash,source_text from source_strings where project_id=$1' +
      (job.source_document_id ? ' and id=any($2::uuid[])' : '') + ' order by id',
      job.source_document_id ? [p.id, job.source_snapshot.map(s => s.id)] : [p.id])).rows;
    if (!sources.length) throw fail(400, 'Import source strings before starting translation.', 'job_source_empty');
    if (fingerprint(content(sources)) !== fingerprint(content(job.source_snapshot))) throw fail(409, 'Source content changed since this job draft. Create a new draft with the current catalog.', 'job_source_changed');
    const existing = (await db.query('select t.source_string_id,t.locale from translations t join source_strings s on s.id=t.source_string_id where s.project_id=$1 and t.locale=any($2::text[])', [p.id, job.target_locales])).rows;
    const selected = new Set(sources.map(s => s.id));
    const selectedExisting = existing.filter(r => selected.has(r.source_string_id));
    const saved = new Set(selectedExisting.map(r => `${r.source_string_id}:${r.locale}`));
    const maximum = input.maxTranslations ?? (job.source_document_id ? TRANSLATION_JOB_LIMITS.maximumPairs : TRANSLATION_JOB_LIMITS.defaultPairs);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > TRANSLATION_JOB_LIMITS.maximumPairs) throw fail(400, 'Choose between 1 and 200 translations per batch.', 'job_batch_limit');
    const missing = sources.flatMap(s => job.target_locales.filter(locale => !saved.has(`${s.id}:${locale}`)).map(locale => ({ sourceId: s.id, locale })));
    if (!missing.length) throw fail(409, 'Every source/language pair already has a translation. Existing translations are preserved; use Review to revise one.', 'job_nothing_missing');
    const items = [];
    for (const pair of missing.slice(0, maximum)) {
      const plan = await inspect({ ...pair, p, auth, db, aiOnly:isAiOnly(job) });
      if (plan.promptBytes > TRANSLATION_JOB_LIMITS.promptBytes) throw fail(400, 'A translation prompt is too large. Reduce its context or Library guidance before starting.', 'job_prompt_limit');
      items.push({ ...pair, fingerprint: plan.fingerprint, creditCeiling: plan.creditCeiling, promptBytes: plan.promptBytes, provider: plan.provider, model: plan.model, mode: plan.mode });
    }
    const provider = items[0];
    if (items.some(item => item.provider !== provider.provider || item.model !== provider.model || item.mode !== provider.mode)) throw fail(409, 'Provider settings changed. Request a fresh preview.', 'job_provider_changed');
    const summary = { pairs: items.length, sourceCount: new Set(items.map(i => i.sourceId)).size, remainingPairs: missing.length - items.length,
      preservedPairs: selectedExisting.length, provider: provider.provider, model: provider.model, mode: provider.mode,
      creditCeiling: items.reduce((n, i) => n + i.creditCeiling, 0), maximumRequests: items.length * TRANSLATION_JOB_LIMITS.attempts,
      maximumOutputTokens: items.length * TRANSLATION_JOB_LIMITS.attempts * TRANSLATION_JOB_LIMITS.outputTokens,
      maximumInputBytes: items.reduce((n, i) => n + i.promptBytes + 1024, 0) * TRANSLATION_JOB_LIMITS.attempts };
    const credit = summary.mode === 'managed' ? `Up to ${summary.creditCeiling} Hedgeling AI credits. Your plan and usage budgets still apply.`
      : `Your organization’s ${summary.provider === 'meta' ? 'Meta' : 'Gemini'} key: no Hedgeling translation credits. Provider charges apply; this is a request/token limit, not a dollar quote.`;
    return { organizationId: p.organizationId, p, job, items, summary, uiTarget, preview: { action: name,
      fields: { name: job.name, sourceLocale: job.source_locale, targetLocales: job.target_locales, steps: job.steps },
      resources: { project: p, jobId: job.id, sourceCount: summary.sourceCount, batch: summary, contentVersion: fingerprint(items) },
      cost: `${credit} At most ${summary.maximumRequests} generation requests and ${summary.maximumOutputTokens} output tokens, including one validation retry per translation.`,
      sideEffects: [`Translate ${summary.pairs} missing source/language pairs using the active instructions, personas and glossary.`,
        `Keep existing translations unchanged (${summary.preservedPairs}). ${summary.remainingPairs} additional missing pairs remain outside this batch.`,
        isAiOnly(job) ? 'Save AI-only translations. There is no review, verification or QA workflow step. Basic generation integrity checks still apply. These translations are not marked human-verified.' : 'Save generated drafts with placeholder, glossary and length checks. Human review, approval and publication remain separate.',
        isAiOnly(job) ? 'Complete the job when all source/language pairs are present. A bounded batch with missing pairs remains partially translated. Opening a PR is a separate confirmation.' : 'Human review and publication require separate actions.',
        'Continue in the background if you close or pause chat. Use Stop job to cancel remaining work.',
        'If inputs or access change, or a request fails, stop and keep any drafts already saved.'] } };
  }
  async function apply(name, prepared, proposal, auth, db) {
    const { p, job } = prepared;
    if (name === 'localization_job.cancel') {
      await db.query("update localization_jobs set status='canceled',finished_at=now() where id=$1", [job.id]);
      await db.query("update localization_job_items set status='canceled',finished_at=now() where job_id=$1 and status='queued'", [job.id]);
    } else {
      const actor = { principalType: 'user', user: { id: auth.user.id, platformStaff: false }, executionType: 'agent', platformAdmin: false,
        identityConnectionId: auth.identityConnectionId || null, agentRunId: proposal.run_id || null };
      await db.query("update localization_jobs set status='queued',started_at=now(),execution=$2 where id=$1", [job.id, { summary: prepared.summary, actor, proposalId: proposal.id }]);
      for (const [ordinal, item] of prepared.items.entries()) await db.query(`insert into localization_job_items(job_id,source_string_id,locale,ordinal,expected_fingerprint,credit_ceiling) values($1,$2,$3,$4,$5,$6)`, [job.id, item.sourceId, item.locale, ordinal, item.fingerprint, item.creditCeiling]);
    }
    return { job: { id: job.id, name: job.name, status: name === 'localization_job.cancel' ? 'canceled' : 'queued', batch: prepared.summary || null }, projectSlug: p.slug, uiTarget: target(p, job.id, name) };
  }
  async function settle(db, jobId) {
    await db.query(`update localization_jobs j set status=case when exists(select 1 from localization_job_items i where i.job_id=j.id and i.status in ('failed','uncertain')) then 'needs_attention'
      when j.steps=array['machine_translation']::text[] then case when (select count(*) from translations t where t.source_string_id in (select (s->>'id')::uuid from jsonb_array_elements(j.source_snapshot) s) and t.locale=any(j.target_locales) and length(trim(t.text))>0)=jsonb_array_length(j.source_snapshot)*cardinality(j.target_locales) then 'completed' else 'partially_translated' end else 'awaiting_review' end,finished_at=now()
      where j.id=$1 and j.status in ('queued','running') and not exists(select 1 from localization_job_items i where i.job_id=j.id and i.status in ('queued','running'))`, [jobId]);
  }
  async function tick() {
    const claim = await transaction(async db => {
      // A lost process may have submitted an expensive request. Never replay it.
      const expired = (await db.query(`update localization_job_items set status='uncertain',error_code='job_request_uncertain',error_message='Processing was interrupted. Check saved drafts before starting a new batch.',finished_at=now()
        where status='running' and lease_expires_at<now() returning job_id`)).rows;
      for (const { job_id: jobId } of expired) {
        await db.query("update localization_job_items set status='canceled',finished_at=now() where job_id=$1 and status='queued'", [jobId]);
        await settle(db, jobId);
      }
      const job = (await db.query(`select j.* from localization_jobs j where j.status in ('queued','running')
        and exists(select 1 from localization_job_items i where i.job_id=j.id and i.status='queued')
        and not exists(select 1 from localization_job_items i where i.job_id=j.id and i.status='running')
        order by j.started_at,j.id limit 1 for update of j skip locked`)).rows[0];
      if (!job) return null;
      const item = (await db.query("select * from localization_job_items where job_id=$1 and status='queued' order by ordinal limit 1 for update", [job.id])).rows[0];
      const token = randomUUID();
      await db.query("update localization_job_items set status='running',lease_token=$2,lease_expires_at=now()+interval '10 minutes' where id=$1", [item.id, token]);
      await db.query("update localization_jobs set status='running' where id=$1", [job.id]);
      return { job, item, token };
    });
    if (!claim) return false;
    const { job, item, token } = claim;
    const auth = job.execution.actor;
    const guard = async (db, lock = false) => {
      const { p, job: current } = await load({ jobId: job.id }, auth, {}, db, true, lock);
      const currentItem = (await db.query('select status,lease_token from localization_job_items where id=$1' + (lock ? ' for update' : ''), [item.id])).rows[0];
      if (!active.includes(current.status) || currentItem?.status !== 'running' || currentItem.lease_token !== token) throw fail(409, 'This job stopped before the result could be saved.', 'job_stopped');
      if (lock) await db.query('select id from source_strings where id=$1 for update', [item.source_string_id]);
      const plan = await inspect({ sourceId: item.source_string_id, locale: item.locale, p, auth, db, aiOnly:isAiOnly(job) });
      if (plan.fingerprint !== item.expected_fingerprint || plan.creditCeiling > Number(item.credit_ceiling)) throw fail(409, 'Source content, translations, guidance or provider settings changed. Start a fresh batch.', 'job_inputs_changed');
      return { p, plan };
    };
    try {
      const { p, plan } = await guard(database);
      await execute({ p, auth, aiOnly:isAiOnly(job), sourceId: item.source_string_id, locale: item.locale, plan, creditCeiling: Number(item.credit_ceiling),
        jobId: job.id, itemId: item.id, beforeCall: () => guard(database), beforeSave: db => guard(db, true),
        afterSave: async db => {
          await db.query("update localization_job_items set status='succeeded',finished_at=now() where id=$1 and lease_token=$2 and status='running'", [item.id, token]);
          await settle(db, job.id);
        } });
    } catch (error) {
      await transaction(async db => {
        await db.query('select id from localization_jobs where id=$1 for update', [job.id]);
        const code = ['job_stopped','job_inputs_changed','byok_key_missing','job_access_denied','job_entitlement_required'].includes(error.code) ? error.code : 'job_translation_failed';
        const message = code === 'job_translation_failed' ? 'Translation could not finish. Check provider access, usage limits and source constraints before starting a new batch.' : error.message;
        await db.query("update localization_job_items set status=$3,error_code=$4,error_message=$5,finished_at=now() where id=$1 and lease_token=$2 and status='running'", [item.id, token, code === 'job_stopped' ? 'canceled' : 'failed', code, message]);
        await db.query("update localization_job_items set status='canceled',finished_at=now() where job_id=$1 and status='queued'", [job.id]);
        await settle(db, job.id);
      });
    }
    return true;
  }
  function startWorker() {
    let busy = false;
    const timer = setInterval(() => { if (busy) return; busy = true; void tick().catch(() => console.error('Translation job worker could not finish its check.')).finally(() => { busy = false; }); }, 1000);
    timer.unref(); return () => clearInterval(timer);
  }
  return { read, prepare, apply, replay: (input, auth, context, db) => load(input, auth, context, db), tick, startWorker };
}
