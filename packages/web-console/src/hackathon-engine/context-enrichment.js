// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { fail } from './errors.js';
import { contextResultPage } from './context-results.js';
import { CONTEXT_LIMITS, CONTEXT_VERSION, contextEvidence, enrichmentPrompt, enrichmentBatches, parseEnrichment, withLengthSuggestion } from './context-analysis.js';
const projectSql = `select p.id,p.slug,p.name,p.source_locale as "sourceLocale",p.business_unit_id as "businessUnitId",b.organization_id as "organizationId"
  from projects p join business_units b on b.id=p.business_unit_id where p.data_purged_at is null and `;
const target = p => ({ view: 'workspace', organizationId: p.organizationId, projectSlug: p.slug, action: 'context.enrich', resource: { type: 'project', id: p.id } });
const batchesFor = r => r.provider_plan.batches || [{ stringIds: r.snapshot.map(s => s.id), maximumInputBytes: r.provider_plan.maximumInputBytes }];
const completedBatches = r => { const done = new Set(r.results.map(s => s.id)); return batchesFor(r).filter(b => b.stringIds.every(id => done.has(id))).length; };
const safeRun = r => ({ id: r.id, status: r.status, strings: r.snapshot.length, completedStrings: r.results.length,
  requests: batchesFor(r).length, completedRequests: completedBatches(r), createdAt: r.created_at, finishedAt: r.finished_at,
  provider: r.provider_plan.provider, model: r.provider_plan.model, acceptedStrings: r.accepted_ids.length,
  awaitingAcceptance: r.results.length - r.accepted_ids.length, error: r.error_code, failure: r.error_detail || null });
// Older pending analyses gain the same reviewable fallback without another
// paid request. Accepted results remain exactly as the person approved them.
const reviewResults = r => r.results.map(result => r.accepted_ids.includes(result.id) ? result
  : withLengthSuggestion(result, r.snapshot.find(s => s.id === result.id)?.evidence));

export function createContextEnrichment({ database, transaction, authorize, inspectProvider, generate, fingerprint }) {
  async function project(input, auth, scope, db, write = false, lock = false) {
    const p = (await db.query(projectSql + (input.projectSlug ? 'p.slug=$1' : 'p.id=(select project_id from context_enrichment_runs where id=$1)') +
      (lock ? ' for update of p' : ''), [input.projectSlug || input.runId])).rows[0];
    if (!p) throw fail(404, 'Project or enrichment run not found.', 'context_not_found');
    if (Object.hasOwn(scope, 'organizationId') && scope.organizationId !== p.organizationId) throw fail(403, 'Choose this project’s workspace first.', 'agent_scope_mismatch');
    await authorize(auth, p, write);
    return p;
  }
  async function sources(p, db, { ids, cursor, limit = ids?.length || 21 } = {}) {
    const rows = (await db.query(`select s.*,e.evidence_fingerprint,e.data as accepted,e.updated_at as accepted_at from source_strings s
      left join source_context_enrichments e on e.source_string_id=s.id where s.project_id=$1
      and ($2::uuid[] is null or s.id=any($2::uuid[])) and ($3::uuid is null or s.id>$3) order by s.id limit $4`, [p.id, ids || null, cursor || null, limit])).rows;
    const contexts = rows.length ? (await db.query('select * from context_variants where source_string_id=any($1::uuid[])', [rows.map(s => s.id)])).rows : [];
    return rows.map(s => {
      const evidence = contextEvidence(s, contexts.filter(c => c.source_string_id === s.id));
      const version = fingerprint({ sourceLocale: p.sourceLocale, evidence });
      return { id: s.id, source: s.source_text, evidence, version, accepted: s.accepted || null, acceptedAt: s.accepted_at,
        current: Boolean(s.accepted && s.evidence_fingerprint === version), acceptedVersion: fingerprint(s.accepted || null) };
    });
  }
  async function run(id, db, lock = false) {
    const r = (await db.query('select * from context_enrichment_runs where id=$1' + (lock ? ' for update' : ''), [id])).rows[0];
    if (!r) throw fail(404, 'Enrichment run not found.', 'context_not_found');
    return r;
  }
  async function read(name, input, auth, scope = {}) {
    const p = await project(input, auth, scope, database);
    const uiTarget = target(p);
    if (name === 'context.summary') return transaction(async db => {
      await db.query('set transaction isolation level repeatable read, read only');
      const currentProject = await project(input, auth, scope, db);
      const counts = (await db.query(`select count(*)::int as total, count(e.source_string_id)::int as accepted
        from source_strings s left join source_context_enrichments e on e.source_string_id=s.id where s.project_id=$1`, [p.id])).rows[0];
      // Freshness uses exactly the same evidence fingerprint as generation and
      // translation. Never equate an existing row with current guidance.
      const complete = counts.accepted <= CONTEXT_LIMITS.scanStrings;
      let current = 0, cursor = null;
      if (complete) do {
        const rows = (await db.query(`select s.id from source_strings s join source_context_enrichments e on e.source_string_id=s.id
          where s.project_id=$1 and ($2::uuid is null or s.id>$2) order by s.id limit 100`,[p.id,cursor])).rows;
        if (!rows.length) break;
        current += (await sources(currentProject,db,{ids:rows.map(s=>s.id)})).filter(s=>s.current).length;
        cursor = rows.length===100 ? rows.at(-1).id : null;
      } while (cursor);
      return { counts: { totalStrings:counts.total,withAcceptedContext:counts.accepted,withoutAcceptedContext:counts.total-counts.accepted,
        currentContext:complete?current:null,staleContext:complete?counts.accepted-current:null,needsContext:complete?counts.total-current:null },
        freshnessComplete:complete,...(!complete?{notice:'Freshness was not scanned because accepted context exceeds the 10,000-string summary limit. Accepted/missing totals are exact; current/stale counts are unavailable.'}:{}),uiTarget };
    });
    if (name === 'context.inspect') {
      if (Boolean(input.query) === Boolean(input.stringIds) || input.query && input.query.trim().length < 2
        || input.stringIds && (!input.stringIds.length || input.stringIds.length > 5)) throw fail(400,'Specify up to five string IDs or a literal search of at least two characters.','context_selection_invalid');
      const matches = (await database.query(`select id from source_strings where project_id=$1
        and ($2::uuid[] is null or id=any($2::uuid[])) and ($3::text is null or strpos(lower(source_text),lower($3))>0)
        order by id limit 6`,[p.id,input.stringIds||null,input.query?.trim()||null])).rows;
      if (input.stringIds && matches.length!==input.stringIds.length) throw fail(404,'Some selected strings are unavailable in this project.','context_not_found');
      const selected = matches.length ? await sources(p,database,{ids:matches.slice(0,5).map(s=>s.id)}) : [];
      let analysis = null;
      if (input.runId) {
        analysis = await run(input.runId,database);
        if (analysis.project_id!==p.id) throw fail(404,'Enrichment run not found in this project.','context_not_found');
      }
      const saved = analysis ? reviewResults(analysis) : [];
      const page = contextResultPage(selected.map(s=>({id:s.id,source:s.source,current:s.current,accepted:s.accepted,
        hardLimit:s.evidence.hardLimit,contextCount:s.evidence.contexts.length,
        ...(analysis?{suggestion:saved.find(r=>r.id===s.id)||null,suggestionAccepted:analysis.accepted_ids.includes(s.id),
          suggestionCurrent:Boolean(saved.some(r=>r.id===s.id)&&analysis.source_locale===p.sourceLocale&&analysis.snapshot.find(r=>r.id===s.id)?.version===s.version)}:{})})));
      return { strings:page.results,hasMoreMatches:matches.length>5||page.page.nextOffset!==null,
        ...(matches.length>5||page.page.nextOffset!==null?{notice:'Only a narrow selection is shown. Refine the literal text or select specific IDs for other strings.'}:{}),uiTarget };
    }
    if (name === 'context.strings') {
      const rows = await sources(p, database, { cursor: input.cursor });
      return { strings: rows.slice(0, 20).map(s => ({ id: s.id, source: s.source, current: s.current, accepted: s.accepted,
        hardLimit: s.evidence.hardLimit, contextCount: s.evidence.contexts.length,
        codeAvailable: s.evidence.contexts.some(c => c.snippet?.text || (c.code && c.code !== c.file && !/^.+:\d+$/.test(c.code))) })),
      page: { nextCursor: rows.length > 20 ? rows[19].id : null }, uiTarget };
    }
    if (name === 'context.runs') {
      if (input.cursor && !(await database.query('select 1 from context_enrichment_runs where id=$1 and project_id=$2', [input.cursor,p.id])).rowCount) throw fail(400, 'Invalid enrichment cursor.');
      const rows = (await database.query(`select * from context_enrichment_runs where project_id=$1
        and ($2::uuid is null or (created_at,id)<(select created_at,id from context_enrichment_runs where id=$2)) order by created_at desc,id desc limit 21`, [p.id,input.cursor || null])).rows;
      return { runs: rows.slice(0,20).map(safeRun), page: { nextCursor: rows.length > 20 ? rows[19].id : null }, uiTarget };
    }
    const r = await run(input.runId, database);
    if (name === 'context.status') return { run:safeRun(r),uiTarget };
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > r.results.length) throw fail(400, 'Invalid context result offset.', 'context_page_invalid');
    const page = contextResultPage(reviewResults(r).map(result => ({ ...result, source: r.snapshot.find(s => s.id === result.id)?.source })), offset);
    return { run: { ...safeRun(r), acceptedIds:r.accepted_ids, results: page.results }, page: page.page, uiTarget };
  }
  async function prepare(name, input, auth, scope = {}, db = database, lock = false) {
    const p = await project(input, auth, scope, db, true, lock), uiTarget = target(p);
    if (name === 'context.cancel') {
      const r = await run(input.runId, db, lock);
      if (!['queued','running'].includes(r.status)) throw fail(409, 'This context run has already stopped.', 'context_not_running');
      return { p, r, organizationId: p.organizationId, uiTarget, preview: { action: name,
        fields: { runId: r.id }, resources: { project: p, runId: r.id }, cost: 'No new model requests. An in-flight request may still be billed.',
        sideEffects: ['Stop the remaining context batches and preserve completed suggestions for review.'] } };
    }
    if (!p.sourceLocale) throw fail(400, 'Set the project’s source language first.', 'context_source_locale_required');
    if (name === 'context.apply') {
      const r = await run(input.runId, db, lock);
      if (!['awaiting_review','applied','failed','uncertain'].includes(r.status) || !r.results.length) throw fail(409, 'Wait for completed suggestions before accepting context.', 'context_not_ready');
      const ids = input.stringIds || r.results.map(s => s.id).filter(id => !r.accepted_ids.includes(id));
      if (!ids.length || ids.some(id => r.accepted_ids.includes(id) || !r.results.some(s => s.id === id))) throw fail(409, 'Select results that have not already been accepted.', 'context_selection_invalid');
      const selected = await sources(p, db, { ids });
      if (selected.length !== ids.length || p.sourceLocale !== r.source_locale || selected.some(s => {
        const old = r.snapshot.find(o => o.id === s.id); return !old || old.version !== s.version || old.acceptedVersion !== s.acceptedVersion;
      })) throw fail(409, 'Source code, content, or accepted guidance changed. Generate a fresh analysis for these strings.', 'context_stale');
      const results = reviewResults(r).filter(s => ids.includes(s.id));
      return { p, r, selected, results, organizationId: p.organizationId, uiTarget, preview: { action: name,
        fields: { strings: results.map(r => ({ source: selected.find(s => s.id === r.id).source, ...r })) },
        resources: { project: p, runId: r.id, version: fingerprint(selected) }, cost: 'No model calls.',
        sideEffects: ['Save these descriptions and advisory length suggestions for future translations.', 'Preserve existing translations and enforced character limits. Suggestions do not prove visual fit.'] } };
    }
    if ((await db.query("select 1 from context_enrichment_runs where project_id=$1 and status in ('queued','running')", [p.id])).rowCount) throw fail(409, 'Context analysis is already running for this project.', 'context_already_running');
    if (input.allMissing && input.stringIds) throw fail(400, 'Choose all missing context or an explicit selection, not both.', 'context_selection_invalid');
    let selected;
    if (input.stringIds) {
      if (!input.stringIds.length || input.stringIds.length > CONTEXT_LIMITS.runStrings) throw fail(400, 'Select between 1 and 1,000 strings.', 'context_selection_limit');
      selected = await sources(p, db, { ids: input.stringIds });
      if (selected.length !== input.stringIds.length) throw fail(404, 'Some selected strings are unavailable in this project.', 'context_not_found');
    } else {
      // Bounded pages avoid loading an entire large project into memory.
      selected = []; let cursor = null, scanned = 0;
      const wanted = input.allMissing ? CONTEXT_LIMITS.runStrings + 1 : CONTEXT_LIMITS.strings;
      do {
        const page = await sources(p, db, { cursor, limit: 100 }); scanned += page.length;
        selected.push(...page.filter(s => !s.current));
        cursor = page.length === 100 ? page.at(-1).id : null;
      } while (cursor && selected.length < wanted && scanned < CONTEXT_LIMITS.scanStrings);
      if (input.allMissing && (selected.length > CONTEXT_LIMITS.runStrings || cursor)) throw fail(400, 'All missing context exceeds this run’s scan or 1,000-string limit. Select up to 1,000 strings explicitly.', 'context_selection_limit');
      if (!input.allMissing) selected = selected.slice(0, CONTEXT_LIMITS.strings);
      if (!selected.length && cursor) throw fail(409, 'Browse strings and select another batch explicitly; the scanned strings already have current context.', 'context_selection_required');
    }
    if (!selected.length) throw fail(409, 'No strings need context. Import a catalog or select strings to analyze again.', 'context_nothing_missing');
    const batches = enrichmentBatches(selected, p.sourceLocale), provider = await inspectProvider(auth,p);
    const plan = { ...provider, promptVersion: CONTEXT_VERSION, batches, maximumRequests: batches.length,
      maximumOutputTokens: CONTEXT_LIMITS.outputTokens, maximumInputBytes: Math.max(...batches.map(b => b.maximumInputBytes)),
      maximumTotalInputBytes: batches.reduce((n,b) => n + b.maximumInputBytes, 0), maximumTotalOutputTokens: batches.length * CONTEXT_LIMITS.outputTokens };
    return { p, selected, plan, organizationId: p.organizationId, uiTarget, preview: { action: name,
      fields: { sourceLocale: p.sourceLocale, selection: input.allMissing ? 'All missing context' : 'Selected batch',
        stringCount: selected.length, requests: batches.length, strings: selected.map(s => ({ id: s.id, source: s.source, existingContext: s.accepted?.description || null })) },
      resources: { project: p, provider: plan, contentVersion: fingerprint(selected),
        stringsWithCode: selected.filter(s => s.evidence.contexts.some(c => c.snippet?.text || (c.code && c.code !== c.file && !/^.+:\d+$/.test(c.code)))).length },
      cost: `${batches.length} request${batches.length === 1 ? '' : 's'} using your organization’s ${provider.provider} key: at most ${plan.maximumTotalInputBytes} input bytes and ${plan.maximumTotalOutputTokens} output tokens in total (${plan.maximumOutputTokens} output tokens per request). Provider charges and usage budgets apply; no Hedgeling translation credits. This is a bound, not a dollar quote.`,
      sideEffects: ['Send the selected source strings and up to four stored context variants each, including available nearby code, to the selected provider.',
        'Generate descriptions and advisory length targets for review. Without a model suggestion or enforced limit, use source length +30% rounded up (at least 5 extra characters), labeled as a formula estimate. Missing code is reported as limited evidence.',
        'Accepting suggestions requires a separate confirmation. No translations or enforced limits change.',
        'Run the previewed batches sequentially, saving each completed batch. Stop on the first failure; interrupted requests are never automatically retried. Chat pause does not stop enrichment; use Stop remaining batches.'] } };
  }
  async function apply(name, prepared, proposal, auth, db) {
    const { p } = prepared;
    if (name === 'context.cancel') {
      await db.query("update context_enrichment_runs set status='failed',error_code='context_cancelled',finished_at=now() where id=$1 and status in ('queued','running')", [prepared.r.id]);
      return { contextRun: safeRun(await run(prepared.r.id, db)), projectSlug: p.slug, uiTarget: target(p) };
    }
    if (name === 'context.enrich') {
      const actor = { principalType: 'user', user: { id: auth.user.id, platformStaff: false }, executionType: 'agent', platformAdmin: false, identityConnectionId: auth.identityConnectionId || null };
      const r = (await db.query(`insert into context_enrichment_runs(project_id,created_by_user_id,proposal_id,status,actor,source_locale,snapshot,provider_plan)
        values($1,$2,$3,'queued',$4,$5,$6,$7) returning *`, [p.id,auth.user.id,proposal.id,actor,p.sourceLocale,JSON.stringify(prepared.selected),prepared.plan])).rows[0];
      return { contextRun: safeRun(r), projectSlug: p.slug, uiTarget: target(p) };
    }
    const { r, results, selected } = prepared;
    // Match translation's project -> source lock ordering; imports serialize on
    // the same project lock acquired during prepare(..., lock=true).
    await db.query('select id from source_strings where id=any($1::uuid[]) order by id for update', [results.map(s => s.id)]);
    for (const result of results) await db.query(`insert into source_context_enrichments(source_string_id,run_id,evidence_fingerprint,data,model,provider,prompt_version,accepted_by_user_id)
      values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(source_string_id) do update set run_id=excluded.run_id,evidence_fingerprint=excluded.evidence_fingerprint,
      data=excluded.data,model=excluded.model,provider=excluded.provider,prompt_version=excluded.prompt_version,accepted_by_user_id=excluded.accepted_by_user_id,updated_at=now()`,
    [result.id,r.id,selected.find(s => s.id === result.id).version,result,r.provider_plan.model,r.provider_plan.provider,r.provider_plan.promptVersion,auth.user.id]);
    const accepted = [...new Set([...r.accepted_ids,...results.map(s => s.id)])];
    // Persist the exact approved results, including fallbacks added to older
    // pending analyses, so the run history matches saved translator guidance.
    const savedResults = r.results.map(old => results.find(s => s.id === old.id) || old);
    const status = ['failed','uncertain'].includes(r.status) ? r.status : accepted.length === r.results.length ? 'applied' : 'awaiting_review';
    await db.query('update context_enrichment_runs set accepted_ids=$2,status=$3,results=$4 where id=$1', [r.id,accepted,status,JSON.stringify(savedResults)]);
    return { accepted: results.length, projectSlug: p.slug, uiTarget: target(p) };
  }
  async function tick() {
    const claim = await transaction(async db => {
      await db.query("update context_enrichment_runs set status='uncertain',error_code='context_request_uncertain',finished_at=now() where status='running' and lease_expires_at<now()");
      const r = (await db.query("select * from context_enrichment_runs where status='queued' order by created_at,id limit 1 for update skip locked")).rows[0];
      if (!r) return null;
      const token = randomUUID();
      await db.query("update context_enrichment_runs set status='running',lease_token=$2,lease_expires_at=now()+interval '5 minutes' where id=$1", [r.id,token]);
      return { r, token };
    });
    if (!claim) return false;
    const { r, token } = claim;
    const batches = batchesFor(r), requestIndex = completedBatches(r), batch = batches[requestIndex];
    const batchItems = batch ? r.snapshot.filter(s => batch.stringIds.includes(s.id)) : [];
    async function guard(db, lock = false) {
      const p = await project({ runId: r.id },r.actor,{},db,true,lock);
      const current = await run(r.id,db,lock);
      if (current.status !== 'running' || current.lease_token !== token || new Date(current.lease_expires_at) <= new Date()) throw fail(409, 'Analysis lease expired.', 'context_request_uncertain');
      const rows = await sources(p,db,{ ids: r.snapshot.map(s => s.id) });
      if (rows.length !== r.snapshot.length || p.sourceLocale !== r.source_locale || rows.some(s => {
        const old = r.snapshot.find(o => o.id === s.id); return old.version !== s.version || old.acceptedVersion !== s.acceptedVersion;
      })) throw fail(409, 'Context inputs changed.', 'context_stale');
      const provider = await inspectProvider(r.actor,p);
      if (Object.keys(provider).some(k => fingerprint(provider[k]) !== fingerprint(r.provider_plan[k]))) throw fail(409, 'Provider settings changed.', 'context_provider_changed');
      return p;
    }
    try {
      const p = await guard(database);
      if (r.provider_plan.promptVersion !== CONTEXT_VERSION) throw fail(409, 'The context request format changed. Preview a fresh run before spending.', 'context_prompt_changed');
      if (!batch || batchItems.length !== batch.stringIds.length) throw fail(409, 'The saved request plan is invalid.', 'context_request_uncertain');
      const response = await generate({ p, auth: r.actor, run: r, requestIndex, batch,
        prompt: enrichmentPrompt(batchItems,r.source_locale), beforeCall: () => guard(database) });
      const results = [...r.results, ...parseEnrichment(response.text,batchItems)];
      const status = requestIndex + 1 === batches.length ? 'awaiting_review' : 'queued';
      await transaction(async db => { await guard(db,true); await db.query(`update context_enrichment_runs set results=$2,status=$3,
        lease_token=null,lease_expires_at=null,finished_at=case when $3='awaiting_review' then now() else null end where id=$1`, [r.id,JSON.stringify(results),status]); });
    } catch(error) {
      const code = ['context_stale','context_provider_changed','context_prompt_changed','context_access_denied','context_request_uncertain','context_result_invalid','context_plan_required'].includes(error.code) ? error.code : 'context_generation_failed';
      const detail = error.contextDiagnostic ? { ...error.contextDiagnostic, batch: requestIndex + 1 } : null;
      await database.query("update context_enrichment_runs set status='failed',error_code=$3,error_detail=$4,finished_at=now() where id=$1 and lease_token=$2 and status='running'", [r.id,token,code,detail]);
    }
    return true;
  }
  function startWorker() {
    let busy = false;
    const timer = setInterval(() => { if (busy) return; busy = true; void tick().catch(() => console.error('Context worker could not finish its check.')).finally(() => { busy = false; }); },1000);
    timer.unref(); return () => clearInterval(timer);
  }
  async function acceptedContext(source, contexts, sourceLocale, db = database) {
    const saved = (await db.query('select * from source_context_enrichments where source_string_id=$1', [source.id])).rows[0];
    if (!saved || saved.evidence_fingerprint !== fingerprint({ sourceLocale, evidence: contextEvidence(source,contexts) })) return null;
    return { ...saved.data, provider: saved.provider, model: saved.model, promptVersion: saved.prompt_version };
  }
  return { read, prepare, apply, tick, startWorker, acceptedContext, replay: (input,auth,scope,db) => project(input,auth,scope,db) };
}
