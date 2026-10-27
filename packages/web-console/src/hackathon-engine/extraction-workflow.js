// SPDX-License-Identifier: Apache-2.0
import { AgentError } from './errors.js';
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
export function createExtractionWorkflow({ database, authorize, checkAccess, engine, fingerprint, importState }) {
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
    if (!value || value.id !== row.id || value.operation !== 'extract' || value.connectionId !== row.binding.connectionId
      || value.ref !== row.request.ref || value.sourceLocale !== row.request.sourceLocale
      || fingerprint(value.scanRoots) !== fingerprint(row.request.scanRoots)
      || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(value.status)) deny(502, 'The extraction service returned an unexpected job.', 'engine_job_invalid');
    return value;
  }
  async function artifact(row, value) {
    if (value.status !== 'succeeded') deny(409, 'Wait for extraction to finish before reviewing its catalog.', 'extraction_not_ready');
    if (!/^[a-f0-9]{40}$/.test(value.commitSha || '')) deny(502, 'The extraction commit is missing.', 'engine_job_invalid');
    const result = await engine().artifact(row.id);
    return catalogState(result, { commitSha: value.commitSha, repositoryId: Number(row.binding.repositoryId), sourceLocale: row.request.sourceLocale });
  }
  const uiTarget = (p, action) => ({ view: 'workspace', organizationId: p.organizationId, projectSlug: p.slug, action, resource: { type: 'project', id: p.id } });
  async function read(name, input, auth, context = {}) {
    const p = await project(input, auth, context, database);
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
    const result = { extraction: { id: row.id, projectSlug: p.slug, status: live.status, phase: live.phase, commitSha: live.commitSha,
      ref: row.request.ref, scanRoots: row.request.scanRoots, importedAt: row.imported_at, expiresAt: row.expires_at,
      message: ['failed', 'cancelled'].includes(live.status) ? 'Extraction did not complete. Review the source selection and connection before starting a new request.' : null } };
    if (live.status === 'succeeded') {
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
    if (name === 'extraction.start') {
      const connected = await binding(p, input.connectionId, db);
      const scanRoots = sourcePaths(input.scanRoots, connected.allowedRoots);
      if (!p.sourceLocale) deny(400, 'Set a source language for this project first.', 'source_locale_required');
      const capabilities = await engine().capabilities();
      if (!capabilities.sourceConfigured || !capabilities.operations?.includes('extract')) deny(503, 'Repository extraction is not configured yet.', 'engine_unconfigured');
      const request = { connectionId: connected.connectionId, operation: 'extract', ref: input.ref, scanRoots,
        sourceLocale: Intl.getCanonicalLocales(p.sourceLocale.replaceAll('_', '-'))[0] };
      resources = { project: p, connection: connected };
      fields = { projectSlug: p.slug, repository: connected.owner + '/' + connected.repository, ref: request.ref, scanRoots, sourceLocale: request.sourceLocale };
      return { organizationId: p.organizationId, resource: { type: 'project', id: p.id }, connection: connected, request,
        preview: { action: name, fields, resources, cost: 'No translation model calls or translation-credit spending. Private service job limits apply.',
          sideEffects: ['Send only the selected source paths to the private hosted extraction service.',
            'A branch or tag is pinned to its commit when processing starts; its head may change before then.',
            'Create an extraction record and a catalog retained for up to seven days. Import requires a separate confirmation.',
            'Maximum 1,000 files, 1 MiB per file, 20 MiB total source, and five minutes of processing. No repository configuration code runs.'] } };
    }
    ({ row } = await linked(input, auth, context, db, lock));
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
    if (action === 'extraction.start') {
      // Admission is fast; processing is asynchronous in the private service.
      // A lost response/local rollback is retried with this exact proposal key.
      const created = await engine().create(prepared.request, 'proposal-' + proposal.id);
      const value = created.job;
      if (!value || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id || '') || !Number.isFinite(Date.parse(value.expiresAt))
        || value.connectionId !== prepared.connection.connectionId || value.ref !== prepared.request.ref
        || value.operation !== 'extract' || value.sourceLocale !== prepared.request.sourceLocale
        || fingerprint(value.scanRoots) !== fingerprint(prepared.request.scanRoots)) deny(502, 'The service returned an unexpected extraction receipt. Retry this same confirmation.', 'engine_job_invalid');
      await db.query(`insert into extraction_requests(id,project_id,proposal_id,created_by_user_id,binding,request,expires_at)
        values($1,$2,$3,$4,$5,$6,$7)`, [value.id, p.id, proposal.id, auth.user.id, prepared.connection, prepared.request, value.expiresAt]);
      return { extraction: { id: value.id, projectSlug: p.slug, status: value.status, name: 'Source extraction', expiresAt: value.expiresAt },
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
