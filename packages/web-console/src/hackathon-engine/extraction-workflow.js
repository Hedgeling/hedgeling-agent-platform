// SPDX-License-Identifier: Apache-2.0
import { AgentError } from './errors.js';
import { tuningSettings, tuningConfigPath, TUNING_FIELDS } from './tuning-config.js';
import { catalogState, catalogSummary, sourcePaths } from './extraction-catalog.js';

const deny = (status, message, code) => { throw new AgentError(status, message, code); };
const projectSql = `select p.id,p.slug,p.name,p.source_locale as "sourceLocale",p.business_unit_id as "businessUnitId",b.organization_id as "organizationId"
  from projects p join business_units b on b.id=p.business_unit_id where p.slug=$1 and p.data_purged_at is null`;
const bindingSql = `select connection_id as "connectionId",repository_id::text as "repositoryId",repository_owner as owner,
  repository_name as repository,allowed_roots as "allowedRoots",default_ref as "defaultRef"
  from extraction_connections where project_id=$1 and active=true`;
const sourceSql = `select id,source_hash,source_text,shape,purpose,visual_context,limit_chars,updated_at
  from source_strings where project_id=$1 order by id`;

// The host supplies its current authorization, entitlement, import/metering and
// transaction facilities. Neither model arguments nor service tokens grant access.
export function createExtractionWorkflow({ database, authorize, checkAccess, engine, fingerprint, importState, models }) {
  async function project(input, auth, context, db, lock = false) {
    const p = (await db.query(projectSql + (lock ? ' for update of p' : ''), [input.projectSlug])).rows[0];
    if (!p) deny(404, 'Project not found.', 'project_not_found');
    await authorize(auth, p);
    if (Object.hasOwn(context, 'organizationId') && context.organizationId !== p.organizationId) deny(403, 'Choose this project’s organization before continuing.', 'agent_scope_mismatch');
    return p;
  }
  async function binding(p, id, db) {
    const row = (await db.query(bindingSql + ' and connection_id=$2', [p.id, id])).rows[0];
    if (!row) deny(403, 'This repository is not connected to the selected project.', 'connection_denied');
    sourcePaths(row.allowedRoots, row.allowedRoots);
    return row;
  }
  async function linked(input, auth, context, db, lock = false) {
    const p = await project(input, auth, context, db, lock);
    const row = (await db.query('select * from extraction_requests where id=$1 and project_id=$2' + (lock ? ' for update' : ''), [input.extractionId, p.id])).rows[0];
    if (!row) deny(404, 'Extraction not found in this project.', 'extraction_not_found');
    const connected = await binding(p, row.binding.connectionId, db);
    if (fingerprint(connected) !== fingerprint(row.binding)) deny(409, 'Repository access changed. Start a new extraction from the current connection.', 'connection_changed');
    return { p, row, connected };
  }
  async function job(row) {
    if (new Date(row.expires_at).getTime() <= Date.now()) deny(410, 'This extraction has expired. Preview a new extraction to continue.', 'extraction_expired');
    const response = await engine().job(row.id);
    const value = response.job;
    if (!value || value.id !== row.id || value.operation !== row.request.operation || value.connectionId !== row.binding.connectionId
      || value.ref !== row.request.ref || (/^[a-f0-9]{40}$/.test(row.request.ref) && value.commitSha && value.commitSha !== row.request.ref) || value.sourceLocale !== row.request.sourceLocale
      || fingerprint(value.scanRoots) !== fingerprint(row.request.scanRoots) || fingerprint(value.settings || {}) !== fingerprint(row.request.settings || {})
      || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(value.status)) deny(502, 'The extraction service returned an unexpected job.', 'engine_job_invalid');
    return value;
  }
  async function artifact(row, value) {
    if (value.status !== 'succeeded') deny(409, 'Wait for extraction to finish before reviewing its catalog.', 'extraction_not_ready');
    if (!/^[a-f0-9]{40}$/.test(value.commitSha || '')) deny(502, 'The extraction commit is missing.', 'engine_job_invalid');
    const result = await engine().artifact(row.id);
    return catalogState(result, { commitSha: value.commitSha, repositoryId: Number(row.binding.repositoryId), sourceLocale: row.request.sourceLocale });
  }
  async function settings(p, connected, db) {
    const saved = (await db.query('select settings,binding_hash,source_commit,tuning_request_id,scan_roots,updated_at from extraction_settings where project_id=$1 and connection_id=$2', [p.id, connected.connectionId])).rows[0] || null;
    if (saved && saved.binding_hash !== fingerprint(connected)) deny(409, 'Repository access changed. Review the project’s saved extraction settings with an operator.', 'settings_connection_changed');
    return saved;
  }
  async function configuration(input, connected) {
    if (!tuningConfigPath(input.configPath)) deny(400, 'Use a .hedgeling/extract.config.json path.', 'invalid_config_path');
    const parent = input.configPath.slice(0, -'.hedgeling/extract.config.json'.length).replace(/\/$/, '');
    if (parent && !connected.allowedRoots.some(root => parent === root || parent.startsWith(root + '/'))) deny(403, 'The config path must be at repository root or within an allowed source root.', 'config_path_denied');
    const value = await engine().configuration(connected.connectionId, input.ref, input.configPath);
    if (value.repositoryId !== Number(connected.repositoryId) || !/^[a-f0-9]{40}$/.test(value.commitSha || '') || value.path !== input.configPath || typeof value.found !== 'boolean') deny(502, 'Unexpected repository configuration response.', 'config_response_invalid');
    let safe;
    try { safe = tuningSettings(value.settings).settings; } catch { deny(502, 'Invalid repository extraction settings.', 'config_response_invalid'); }
    return { commitSha: value.commitSha, path: value.path, found: value.found, settings: safe,
      ignoredFields: Array.isArray(value.ignoredFields) ? value.ignoredFields.filter(v => typeof v === 'string').slice(0, 30).map(v => v.slice(0, 80)) : [] };
  }
  async function tuning(row, live) {
    if (!['tune', 'tune-llm'].includes(row.request.operation) || live.status !== 'succeeded') deny(409, 'Wait for the tuning preview to finish.', 'tuning_not_ready');
    const artifact = await engine().artifact(row.id);
    const report = artifact.tuning;
    if (artifact.provenance?.commitSha !== live.commitSha || artifact.provenance?.repositoryId !== Number(row.binding.repositoryId) || artifact.provenance?.operation !== row.request.operation || !report || report.mode !== (row.request.operation === 'tune-llm' ? 'llm' : 'deterministic') || !Number.isSafeInteger(report.llmCalls) || report.llmCalls < 0 || report.llmCalls > (row.request.operation === 'tune-llm' ? 4 : 0) || report.wrote !== false) deny(502, 'Unexpected tuning artifact.', 'tuning_artifact_invalid');
    if (report.mode === 'llm' && (!Number.isSafeInteger(report.classifiedCount) || report.classifiedCount < 0 || report.classifiedCount > 80 || report.maximumItems !== 80 || report.coverage !== 'bounded')) deny(502, 'Invalid model tuning coverage.', 'tuning_artifact_invalid');
    let value;
    try { value = tuningSettings(report.settings).settings; } catch { deny(502, 'Invalid tuned settings.', 'tuning_artifact_invalid'); }
    if (!Array.isArray(report.acceptedEdits) || report.acceptedEdits.length > 100) deny(502, 'Tuning report exceeds the supported limit.', 'tuning_artifact_invalid');
    const expected = structuredClone(row.request.settings || {});
    for (const edit of report.acceptedEdits) {
      if (!edit || !TUNING_FIELDS.includes(edit.field) || typeof edit.value !== 'string') deny(502, 'Invalid tuning edit.', 'tuning_artifact_invalid');
      expected[edit.field] = [...new Set([...(expected[edit.field] || []), edit.value])];
    }
    if (fingerprint(expected) !== fingerprint(value)) deny(502, 'Tuned configuration does not match its accepted edits.', 'tuning_artifact_invalid');
    const counts = c => c && Number.isSafeInteger(c.strings) && c.strings >= 0 && c.diagnostics && Number.isSafeInteger(c.diagnostics.total) && c.diagnostics.total >= 0;
    if (!counts(report.before) || !counts(report.after)) deny(502, 'Missing tuning counts.', 'tuning_artifact_invalid');
    return { settings: value, acceptedEdits: report.acceptedEdits, before: { strings: report.before.strings, diagnostics: report.before.diagnostics.total }, after: { strings: report.after.strings, diagnostics: report.after.diagnostics.total }, mode: report.mode, llmCalls: report.llmCalls, ...(report.mode === 'llm' ? { classifiedCount: report.classifiedCount, maximumItems: 80, coverage: 'bounded' } : {}) };
  }
  const uiTarget = (p, action) => ({ view: 'workspace', organizationId: p.organizationId, projectSlug: p.slug, action, resource: { type: 'project', id: p.id } });
  async function read(name, input, auth, context = {}) {
    const p = await project(input, auth, context, database);
    if (name === 'extraction.config' || name === 'extraction.settings') {
      const connected = await binding(p, input.connectionId, database), saved = await settings(p, connected, database);
      if (name === 'extraction.settings') return { projectSlug: p.slug, saved: saved ? { settings: saved.settings, sourceCommit: saved.source_commit, updatedAt: saved.updated_at } : null,
        download: saved ? { filename: 'extract.config.json', content: JSON.stringify({ sourceLocale: p.sourceLocale, scanRoots: saved.scan_roots, ...saved.settings }, null, 2) + '\n' } : null };
      const repository = await configuration(input, connected);
      return { projectSlug: p.slug, repository, effectiveSettings: saved?.settings || repository.settings, source: saved ? 'project' : repository.found ? 'repository' : 'defaults' };
    }
    if (name === 'extraction.connections') return { projectSlug: p.slug, connections: (await database.query(bindingSql + ' order by connection_id', [p.id])).rows };
    if (name === 'extraction.jobs') {
      const limit = input.limit ?? 25, offset = input.offset ?? 0;
      const records = await database.query(`select r.id,r.created_at as "createdAt",r.expires_at as "expiresAt",r.imported_at as "importedAt",r.request->>'ref' as ref
        from extraction_requests r join extraction_connections c on c.project_id=r.project_id and c.connection_id=r.binding->>'connectionId' and c.active
        where r.project_id=$1 order by r.created_at desc,r.id limit $2 offset $3`, [p.id, limit + 1, offset]);
      return { projectSlug: p.slug, extractions: records.rows.slice(0, limit), nextOffset: records.rows.length > limit ? offset + limit : null };
    }
    const { row } = await linked(input, auth, context, database);
    const live = await job(row);
    const result = { extraction: { id: row.id, projectSlug: p.slug, operation: row.request.operation, status: live.status, phase: live.phase, commitSha: live.commitSha,
      ref: row.request.ref, scanRoots: row.request.scanRoots, importedAt: row.imported_at, expiresAt: row.expires_at,
      message: ['failed', 'cancelled'].includes(live.status) ? 'Extraction did not complete. Review the source selection and connection before starting a new request.' : null } };
    if (row.request.operation === 'tune-llm') result.modelUsage = await models.summary(row.id);
    if (live.status === 'succeeded' && ['tune', 'tune-llm'].includes(row.request.operation)) result.tuning = await tuning(row, live);
    else if (live.status === 'succeeded') {
      const state = await artifact(row, live);
      const entries = Object.values(state.files['extracted-source'].entries);
      result.catalog = { total: entries.length, sample: entries.slice(0, 5).map(e => e.sourceText.slice(0, 300)), sampleLimit: 5, completeSample: entries.length <= 5 };
    }
    return result;
  }
  async function prepare(name, input, auth, context = {}, db = database, lock = false) {
    const p = await project(input, auth, context, db, lock);
    const access = await checkAccess(auth, p);
    let resources, fields, state, row;
    if (name === 'extraction.start' || name === 'extraction.tune') {
      const connected = await binding(p, input.connectionId, db);
      const scanRoots = sourcePaths(input.scanRoots, connected.allowedRoots);
      if (!p.sourceLocale) deny(400, 'Set a source language for this project first.', 'source_locale_required');
      const capabilities = await engine().capabilities();
      if (!capabilities.sourceConfigured || !capabilities.operations?.includes('extract')) deny(503, 'Repository extraction is not configured yet.', 'engine_unconfigured');
      const saved = await settings(p, connected, db);
      const config = name === 'extraction.tune' ? await configuration(input, connected) : null;
      const llm = Boolean(config && input.mode === 'llm');
      if (llm && !models) deny(503, 'LLM tuning is not configured.', 'tuning_unavailable');
      const modelPlan = llm ? await models.preview(auth, p) : null;
      if (llm && fingerprint(capabilities.modelLimits) !== fingerprint(modelPlan.limits)) deny(503, 'The engine tuning limits need updating.', 'tuning_unavailable');
      if (config && !capabilities.operations.includes(llm ? 'tune-llm' : 'tune')) deny(503, 'This engine does not support tuning yet.', 'tuning_unavailable');
      const request = { connectionId: connected.connectionId, operation: config ? (llm ? 'tune-llm' : 'tune') : 'extract', ref: config ? config.commitSha : input.ref, scanRoots,
        sourceLocale: Intl.getCanonicalLocales(p.sourceLocale.replaceAll('_', '-'))[0] };
      if (saved || config) request.settings = saved?.settings || config.settings;
      resources = { project: p, connection: connected, ...(modelPlan ? { modelPlan } : {}), savedSettingsVersion: saved ? fingerprint(saved) : null, ...(config ? { configuration: config, settingsSource: saved ? 'project' : config.found ? 'repository' : 'defaults' } : {}) };
      fields = { projectSlug: p.slug, repository: connected.owner + '/' + connected.repository, ref: request.ref, scanRoots, sourceLocale: request.sourceLocale, ...(modelPlan ? { tuningMode: 'llm', provider: modelPlan.provider, model: modelPlan.model, limits: modelPlan.limits } : {}), ...(request.settings ? { settings: request.settings } : {}) };
      return { organizationId: p.organizationId, resource: { type: 'project', id: p.id }, connection: connected, request,
        preview: { action: name, fields, resources, cost: llm ? 'Uses your organization’s selected provider key. Up to 4 model requests including retries, each with at most 64 KiB of prompt text and 8,192 output tokens. Provider charges and platform usage limits apply; no managed AI credits are spent.' : 'No translation model calls or translation-credit spending. Private service job limits apply.',
          sideEffects: [...(config ? [llm ? 'Classify at most 80 candidate texts in one tuning round. Candidate text and nearby source snippets go to the selected model provider. Coverage is bounded; this does not enrich the catalog or calculate character limits.' : 'Run the built-in deterministic tuner for at most two rounds, with no LLM calls. Review its report before saving settings.', 'Tuning proposes settings only; the repository and project configuration remain unchanged.'] : []), 'Send only the selected source paths to the private hosted extraction service.',
            'A branch or tag is pinned to its commit when processing starts; its head may change before then.',
            'Create an extraction record and a catalog retained for up to seven days. Import requires a separate confirmation.',
            'Maximum 1,000 files, 1 MiB per file, 20 MiB total source, and five minutes of processing. No repository configuration code runs.'] } };
    }
    ({ row } = await linked(input, auth, context, db, lock));
    if (name === 'extraction.tuning.apply') {
      const live = await job(row), report = await tuning(row, live);
      if (!p.sourceLocale || Intl.getCanonicalLocales(p.sourceLocale.replaceAll('_', '-'))[0] !== row.request.sourceLocale) deny(409, 'The project source language changed. Run tuning again.', 'source_locale_changed');
      const connected = await binding(p, row.binding.connectionId, db), saved = await settings(p, connected, db);
      if (row.request.settingsVersion !== undefined && row.request.settingsVersion !== (saved ? fingerprint(saved) : null)) deny(409, 'Project settings changed after tuning. Run a new tuning preview.', 'settings_changed');
      if (saved && fingerprint(saved.settings) === fingerprint(report.settings)) deny(409, 'These settings are already saved. Start a new extraction to use them.', 'settings_unchanged');
      if (!/^[a-f0-9]{40}$/.test(live.commitSha || '')) deny(502, 'Missing pinned tuning revision.', 'tuning_artifact_invalid');
      const request = { connectionId: connected.connectionId, operation: 'extract', ref: live.commitSha, scanRoots: row.request.scanRoots, sourceLocale: row.request.sourceLocale, settings: report.settings };
      return { organizationId: p.organizationId, resource: { type: 'project', id: p.id }, row, connection: connected, request,
        preview: { action: name, fields: { projectSlug: p.slug, commitSha: live.commitSha, scanRoots: request.scanRoots, settings: report.settings },
          resources: { project: p, connection: connected, tuning: report, savedSettingsVersion: saved ? fingerprint(saved) : null },
          changes: [{ field: 'extractionSettings', label: 'Extraction settings', before: saved?.settings || row.request.settings || {}, after: report.settings }],
          cost: 'No LLM calls or translation-credit spending. One private extraction job counts toward service limits.',
          sideEffects: ['Save these settings for this project and repository connection.', 'Re-extract the same pinned source with these settings.', 'Keep the GitHub repository, existing source catalog and translations unchanged. Import requires separate approval.'] } };
    }
    if (row.request.operation !== 'extract') deny(409, 'Save the tuning settings and re-extract before importing.', 'tuning_not_importable');
    if (row.imported_at) deny(409, 'This extraction was already imported.', 'extraction_already_imported');
    const live = await job(row);
    state = await artifact(row, live);
    const existing = (await db.query(sourceSql, [p.id])).rows;
    const counts = catalogSummary(state, existing);
    if (!counts.total) deny(400, 'There are no source strings to import.', 'catalog_empty');
    resources = { project: p, sourceCount: counts.total, catalog: counts, commitSha: live.commitSha,
      artifactHash: fingerprint(state), sourceVersion: fingerprint(existing), limits: access.limits || {} };
    fields = { projectSlug: p.slug, repository: row.binding.owner + '/' + row.binding.repository, commitSha: live.commitSha, sourceLocale: row.request.sourceLocale };
    return { organizationId: p.organizationId, resource: { type: 'project', id: p.id }, state, row, access,
      preview: { action: name, fields, resources,
        cost: 'Import counts toward your managed-string and source-processing limits. No translation credits are used.',
        sideEffects: [`Import ${counts.added} new and update ${counts.updated} source strings; ${counts.unchanged} keep the same source fields.`,
          'Refresh extracted context metadata. Keep existing translations and source strings missing from this catalog.',
          'No translations, repository writes or publication will start.'] } };
  }
  async function apply(action, prepared, proposal, auth, db) {
    const p = prepared.preview.resources.project;
    if (['extraction.start', 'extraction.tune', 'extraction.tuning.apply'].includes(action)) {
      // Admission is fast; processing is asynchronous in the private service.
      // A lost response/local rollback is retried with this exact proposal key.
      const created = await engine().create(prepared.request, 'proposal-' + proposal.id);
      const value = created.job;
      if (!value || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id || '') || !Number.isFinite(Date.parse(value.expiresAt))
        || value.connectionId !== prepared.connection.connectionId || value.ref !== prepared.request.ref
        || value.operation !== prepared.request.operation || value.sourceLocale !== prepared.request.sourceLocale
        || fingerprint(value.scanRoots) !== fingerprint(prepared.request.scanRoots) || fingerprint(value.settings || {}) !== fingerprint(prepared.request.settings || {})) deny(502, 'The service returned an unexpected extraction receipt. Retry this same confirmation.', 'engine_job_invalid');
      await db.query(`insert into extraction_requests(id,project_id,proposal_id,created_by_user_id,binding,request,expires_at)
        values($1,$2,$3,$4,$5,$6,$7)`, [value.id, p.id, proposal.id, auth.user.id, prepared.connection, { ...prepared.request, ...(action === 'extraction.tune' ? { settingsVersion: prepared.preview.resources.savedSettingsVersion } : {}) }, value.expiresAt]);
      if (prepared.request.operation === 'tune-llm') await models.queue(value.id, prepared.preview.resources.modelPlan, auth, db);
      if (action === 'extraction.tuning.apply') await db.query(`insert into extraction_settings(project_id,connection_id,settings,binding_hash,source_commit,tuning_request_id,scan_roots) values($1,$2,$3,$4,$5,$6,$7) on conflict(project_id,connection_id) do update set settings=excluded.settings,binding_hash=excluded.binding_hash,source_commit=excluded.source_commit,tuning_request_id=excluded.tuning_request_id,scan_roots=excluded.scan_roots,updated_at=now()`, [p.id, prepared.connection.connectionId, prepared.request.settings, fingerprint(prepared.connection), prepared.request.ref, prepared.row.id, prepared.request.scanRoots]);
      return { ...(action === 'extraction.tuning.apply' ? { settingsSaved: true } : {}), extraction: { id: value.id, projectSlug: p.slug, status: value.status, operation: prepared.request.operation, name: action === 'extraction.tune' ? 'Extraction tuning preview' : 'Source extraction', expiresAt: value.expiresAt },
        projectSlug: p.slug, uiTarget: uiTarget(p, action) };
    }
    const counts = await importState({ prepared, proposal, auth, database: db });
    const result = { import: { extractionId: prepared.row.id, counts }, projectSlug: p.slug, uiTarget: uiTarget(p, action) };
    await db.query('update extraction_requests set imported_at=now(),import_result=$2 where id=$1', [prepared.row.id, result]);
    return result;
  }
  async function replay(input, auth, context, db) {
    if (input.extractionId) await linked(input, auth, context, db);
    else await binding(await project(input, auth, context, db), input.connectionId, db);
  }
  return { read, prepare, apply, replay };
}
