// SPDX-License-Identifier: Apache-2.0
import { AgentError } from './errors.js';
export const TUNING_MODEL_LIMITS = Object.freeze({ items: 80, calls: 4, promptBytes: 65536, outputTokens: 8192, responseBytes: 131072 });
const fail = (code, message, status = 409) => { throw new AgentError(status, message, code); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function validateTuningModelRequest(value) {
  if (!value || Object.keys(value).some(k => !['id','system','user','maxOutputTokens'].includes(k)) || !uuid(value.id)
      || typeof value.system !== 'string' || typeof value.user !== 'string'
      || value.maxOutputTokens !== TUNING_MODEL_LIMITS.outputTokens
      || Buffer.byteLength(value.system + value.user) > TUNING_MODEL_LIMITS.promptBytes) fail('tuning_model_request_invalid', 'The engine model request exceeded the approved bounds.', 502);
  return value;
}

// Pull-only broker: no public model gateway and no provider credential crosses
// into the engine. The host supplies authorization, billing and provider access.
export function createTuningModels({ database, transaction, engine, inspect, authorize, generate, fingerprint }) {
  async function preview(auth, project) {
    const plan = await inspect(auth, project);
    return { ...plan, limits: TUNING_MODEL_LIMITS };
  }
  async function queue(id, plan, auth, db) {
    const actor = { principalType: 'user', executionType: 'agent', user: { id: auth.user.id, platformStaff: false }, platformAdmin: false,
      identityConnectionId: auth.identityConnectionId || null };
    await db.query('insert into extraction_model_runs(extraction_id,actor,provider_plan) values($1,$2,$3)', [id, actor, plan]);
  }
  async function summary(id) {
    const run = (await database.query('select provider_plan,status,error_code from extraction_model_runs where extraction_id=$1', [id])).rows[0];
    if (!run) return null;
    const calls = (await database.query('select status,usage from extraction_model_calls where extraction_id=$1', [id])).rows;
    return { provider: run.provider_plan.provider, model: run.provider_plan.model, status: run.status, errorCode: run.error_code,
      calls: calls.length, completedCalls: calls.filter(c => c.status === 'succeeded').length,
      totalTokens: calls.some(c => !c.usage) ? null : calls.reduce((n,c) => n + c.usage.totalTokens, 0),
      usageEstimated: calls.some(c => c.usage?.estimated), limits: run.provider_plan.limits };
  }
  async function guard(run) {
    const current = (await database.query('select status from extraction_model_runs where extraction_id=$1', [run.extraction_id])).rows[0];
    if (current?.status !== 'active' || new Date(run.expires_at).getTime() <= Date.now()) fail('tuning_inactive', 'This tuning run is no longer active.');
    const project = await authorize(run.actor, run);
    if (fingerprint(await preview(run.actor, project)) !== fingerprint(run.provider_plan)) fail('tuning_provider_changed', 'Provider settings or access changed. Preview a new LLM tuning run.');
    return project;
  }
  async function stop(run, code) {
    await database.query("update extraction_model_runs set status='failed',error_code=$2 where extraction_id=$1 and status='active'", [run.extraction_id, code]);
    // Cancellation is cleanup of the approved run, never a new processing job.
    await engine().cancel(run.extraction_id).catch(() => {});
  }
  async function tick() {
    // Provider responses are retained only for bounded delivery recovery.
    await database.query("update extraction_model_calls set response_text=null where response_text is not null and created_at < now() - interval '7 days'");
    const run = await transaction(async db => {
      const row = (await db.query(`select m.*,r.project_id,r.binding,r.request,r.expires_at from extraction_model_runs m
        join extraction_requests r on r.id=m.extraction_id where m.status='active'
        order by m.last_polled_at nulls first,m.created_at limit 1 for update of m skip locked`)).rows[0];
      if (row) await db.query('update extraction_model_runs set last_polled_at=now() where extraction_id=$1', [row.extraction_id]);
      return row;
    });
    if (!run) return false;
    if (Date.now() - new Date(run.created_at).getTime() > 10 * 60 * 1000) { await stop(run, 'tuning_interrupted'); return true; }
    let project;
    try { project = await guard(run); } catch (e) { await stop(run, e.code || 'tuning_access_changed'); return true; }
    const remote = (await engine().job(run.extraction_id)).job;
    if (!remote || remote.id !== run.extraction_id || remote.operation !== 'tune-llm' || remote.connectionId !== run.binding.connectionId
        || remote.ref !== run.request.ref || !['queued','running','succeeded','failed','cancelled'].includes(remote.status) || remote.sourceLocale !== run.request.sourceLocale
        || fingerprint(remote.scanRoots) !== fingerprint(run.request.scanRoots) || fingerprint(remote.settings || {}) !== fingerprint(run.request.settings || {})) {
      await stop(run, 'tuning_job_invalid'); return true;
    }
    if (['succeeded','failed','cancelled'].includes(remote.status)) {
      await database.query("update extraction_model_runs set status=$2 where extraction_id=$1 and status='active'", [run.extraction_id, remote.status === 'succeeded' ? 'completed' : 'failed']);
      return true;
    }
    const pending = await engine().modelRequests(run.extraction_id);
    if (!Array.isArray(pending.requests) || pending.requests.length > TUNING_MODEL_LIMITS.calls) { await stop(run, 'tuning_model_request_invalid'); return true; }
    for (const item of pending.requests) {
      let call;
      try { call = validateTuningModelRequest(item); } catch (e) { await stop(run, e.code); return true; }
      const claim = await transaction(async db => {
        const locked = (await db.query('select status from extraction_model_runs where extraction_id=$1 for update', [run.extraction_id])).rows[0];
        if (locked?.status !== 'active') fail('tuning_inactive', 'This tuning run is no longer active.');
        const current = (await db.query('select * from extraction_model_calls where id=$1', [call.id])).rows[0];
        if (current) {
          if (current.extraction_id !== run.extraction_id || current.input_hash !== fingerprint(call)) fail('tuning_model_request_changed', 'Model request changed.');
          return { row: current, fresh: false };
        }
        const count = (await db.query('select count(*)::int as n from extraction_model_calls where extraction_id=$1', [run.extraction_id])).rows[0].n;
        if (count >= run.provider_plan.limits.calls) fail('tuning_call_limit', 'The approved tuning request limit was reached.');
        const row = (await db.query("insert into extraction_model_calls(id,extraction_id,input_hash,status) values($1,$2,$3,'running') returning *", [call.id, run.extraction_id, fingerprint(call)])).rows[0];
        return { row, fresh: true };
      }).catch(async e => { await stop(run, e.code || 'tuning_claim_failed'); return null; });
      if (!claim) return true;
      let text = claim.row.response_text;
      if (!claim.fresh && claim.row.status === 'running') {
        if (Date.now() - new Date(claim.row.created_at).getTime() > 120000) await stop(run, 'tuning_request_uncertain');
        continue; // Never replay an inference with an unknown outcome.
      }
      if (claim.row.status === 'failed') { await stop(run, 'tuning_model_failed'); return true; }
      if (claim.fresh) {
        try {
          project = await guard(run);
          const result = await generate({ run, call, project });
          text = result.text;
          if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > TUNING_MODEL_LIMITS.responseBytes) fail('tuning_model_response_invalid', 'The model returned an invalid result.', 502);
          await database.query("update extraction_model_calls set status='succeeded',response_text=$2,usage=$3,finished_at=now() where id=$1", [call.id, text, result.usage]);
        } catch (e) {
          await database.query("update extraction_model_calls set status='failed',finished_at=now() where id=$1", [call.id]);
          await engine().modelResult(run.extraction_id, call.id, { failed: true }).catch(() => {});
          await stop(run, e.code || 'tuning_model_failed'); return true;
        }
      }
      try { await guard(run); } catch (e) { await stop(run, e.code || 'tuning_access_changed'); return true; }
      // A lost acknowledgement retries only delivery of saved text, not inference.
      await engine().modelResult(run.extraction_id, call.id, { text });
      return true;
    }
    return true;
  }
  let timer, busy = false;
  function startWorker() {
    if (timer) return;
    timer = setInterval(async () => {
      if (busy) return; busy = true;
      try { await tick(); } catch { /* A transient engine read/delivery can retry; inference claims cannot. */ }
      finally { busy = false; }
    }, 1000); timer.unref?.();
  }
  return { preview, queue, summary, tick, startWorker };
}
