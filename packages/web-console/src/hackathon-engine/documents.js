// SPDX-License-Identifier: Apache-2.0
import { fail } from './errors.js';
const hash = (id, index) => `document:${id}:${index}`;
const metadata = d => ({ id: d.id, filename: d.filename, format: d.format, bytes: d.bytes, sourceLocale: d.source_locale,
  sections: d.segments.length, warnings: d.warnings, imported: Boolean(d.imported_at), createdAt: d.created_at, expiresAt: d.imported_at ? null : d.expires_at });
const projectSql = `select p.id,p.slug,p.name,p.source_locale as "sourceLocale",p.business_unit_id as "businessUnitId",b.organization_id as "organizationId"
  from projects p join business_units b on b.id=p.business_unit_id where p.data_purged_at is null and `;
const target = (p, action, job) => ({ view: 'workspace', organizationId: p.organizationId, projectSlug: p.slug, action,
  resource: { type: job ? 'job' : 'project', id: job || p.id } });
const csvCell = value => '"' + (/^\s*[=+@-]/.test(String(value)) ? "'" : '') + String(value).replaceAll('"', '""') + '"';

export function createDocuments({ database, transaction, authorize, checkAccess, fingerprint, importState }) {
  async function project(where, value, auth, context = {}, db = database, permissions = ['strings.view'], locales = [null]) {
    const p = (await db.query(projectSql + where, [value])).rows[0];
    if (!p) throw fail(404, 'Project not found.', 'document_not_found');
    if (Object.hasOwn(context, 'organizationId') && context.organizationId !== p.organizationId) throw fail(403, 'Choose this document’s workspace first.', 'agent_scope_mismatch');
    await authorize(auth, p, permissions, locales);
    return p;
  }
  async function load(id, auth, context = {}, db = database, permissions, locales) {
    const d = (await db.query('select * from uploaded_documents where id=$1', [id])).rows[0];
    if (!d) throw fail(404, 'Document not found.', 'document_not_found');
    const p = await project('p.id=$1', d.project_id, auth, context, db, permissions, locales);
    if (!d.imported_at && new Date(d.expires_at) <= new Date()) throw fail(410, 'This upload expired. Upload the document again.', 'document_expired');
    return { d, p };
  }
  async function uploadProject(projectSlug, auth, context = {}, db = database) {
    const p = await project('p.slug=$1', projectSlug, auth, context, db, ['strings.view', 'imports.run']);
    if (!p.sourceLocale) throw fail(400, 'Set the project’s source language before uploading.', 'document_source_locale');
    await checkAccess(auth, p); return p;
  }
  async function upload(projectSlug, parsed, auth, context = {}) {
    return transaction(async db => {
      const p = await uploadProject(projectSlug, auth, context, db);
      await db.query('select id from projects where id=$1 for update', [p.id]);
      await db.query('delete from uploaded_documents where imported_at is null and expires_at<now() and project_id=$1', [p.id]);
      const existing = (await db.query('select * from uploaded_documents where project_id=$1 and created_by_user_id=$2 and sha256=$3', [p.id, auth.user.id, parsed.sha256])).rows[0];
      if (existing) return { document: metadata(existing), projectSlug: p.slug, duplicate: true };
      const count = (await db.query("select count(*)::int as n from uploaded_documents where project_id=$1 and (imported_at is null or created_at>now()-interval '1 day')", [p.id])).rows[0].n;
      if (count >= 30) throw fail(429, 'This project has reached its 30-upload daily/pending limit.', 'document_upload_limit');
      const d = (await db.query(`insert into uploaded_documents(project_id,created_by_user_id,filename,format,sha256,bytes,source_locale,segments,warnings)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`, [p.id, auth.user.id, parsed.filename, parsed.format, parsed.sha256, parsed.bytes, p.sourceLocale,
        JSON.stringify(parsed.segments), JSON.stringify(parsed.warnings)])).rows[0];
      return { document: metadata(d), projectSlug: p.slug, uiTarget: target(p, 'documents.get') };
    });
  }
  async function read(name, input, auth, context = {}) {
    if (name === 'documents.list') {
      const p = await project('p.slug=$1', input.projectSlug, auth, context);
      const rows = (await database.query(`select * from uploaded_documents where project_id=$1 and (imported_at is not null or expires_at>now())
        and ($2::uuid is null or id>$2) order by id limit 21`, [p.id, input.cursor || null])).rows;
      return { documents: rows.slice(0, 20).map(metadata), page: { hasMore: rows.length > 20, nextCursor: rows.length > 20 ? rows[19].id : null } };
    }
    if (name === 'documents.export') {
      const result = await download(input, auth, context);
      return { files: [{ filename: result.filename, bytes: Buffer.byteLength(result.content), type: result.type,
        label: input.status === 'approved' ? 'Approved translations' : 'Drafts for review',
        href: `/api/documents/jobs/${input.jobId}/download?locale=${encodeURIComponent(input.locale)}&format=${input.format}&status=${input.status}&version=${result.version}` }] };
    }
    const { p, d } = await load(input.documentId, auth, context);
    const offset = input.offset || 0;
    return { document: metadata(d), projectSlug: p.slug, sections: d.segments.slice(offset, offset + 20),
      page: { nextOffset: offset + 20 < d.segments.length ? offset + 20 : null, total: d.segments.length }, uiTarget: target(p, 'documents.get') };
  }
  async function prepare(input, auth, context = {}, db = database, lock = false) {
    let { p, d } = await load(input.documentId, auth, context, db, ['strings.view', 'imports.run', 'jobs.create', 'jobs.view'], input.targetLocales);
    if (lock) {
      await db.query('select id from projects where id=$1 for update', [p.id]); await db.query('select id from uploaded_documents where id=$1 for update', [d.id]);
      ({ p, d } = await load(input.documentId, auth, context, db, ['strings.view', 'imports.run', 'jobs.create', 'jobs.view'], input.targetLocales));
    }
    if (d.source_locale !== p.sourceLocale) throw fail(409, 'The project’s source language changed. Upload into a project matching the document language.', 'document_source_changed');
    const locales = (await db.query('select locale from locales where project_id=$1 and enabled=true', [p.id])).rows.map(row => row.locale);
    if (input.targetLocales.some(locale => locale === p.sourceLocale || !locales.includes(locale))) throw fail(400, 'Choose target languages enabled in this project.', 'document_locale_invalid');
    const access = await checkAccess(auth, p);
    const entries = Object.fromEntries(d.segments.map(s => [hash(d.id, s.index), { sourceText: s.text,
      contextVariants: [{ shape: 'document', purpose: `Translate ${s.location} of the uploaded document.`, filePath: d.filename }] }]));
    const state = { schemaVersion: 2, sourceLocale: p.sourceLocale, locales: [], files: { [`documents/${d.id}`]: { entries } } };
    const hashes = Object.keys(entries);
    const current = (await db.query('select id,source_hash,source_text from source_strings where project_id=$1 and source_hash=any($2::text[]) order by id', [p.id, hashes])).rows;
    return { organizationId: p.organizationId, d, p, state, access, row: d, input, hashes, uiTarget: target(p, 'documents.job'),
      preview: { action: 'documents.job', fields: { name: input.name, filename: d.filename, sourceLocale: p.sourceLocale, targetLocales: input.targetLocales, steps: ['machine_translation', 'review'] },
        resources: { project: p, documentId: d.id, sourceCount: d.segments.length, artifactHash: fingerprint(state), sourceVersion: fingerprint(current), limits: access.limits || {} },
        cost: 'Import counts toward managed-string and source-processing limits. No translation model calls or translation charges until a separate start confirmation.',
        sideEffects: [`Import ${d.segments.length} document text sections and create a job containing only those sections.`,
          'Preserve unrelated project content and existing translations.', ...d.warnings,
          `${d.segments.length * input.targetLocales.length} source/language pairs in total; translation runs process at most 200 pairs per approved batch.`] } };
  }
  async function apply(prepared, proposal, auth, db) {
    await importState({ prepared, proposal, auth, database: db });
    const { p, d, input, hashes } = prepared;
    const snapshot = (await db.query('select id,source_hash,source_text,updated_at from source_strings where project_id=$1 and source_hash=any($2::text[]) order by id for share', [p.id, hashes])).rows;
    if (snapshot.length !== hashes.length) throw fail(409, 'The document import did not produce every section.', 'document_import_incomplete');
    const job = (await db.query(`insert into localization_jobs(project_id,name,source_locale,target_locales,steps,source_snapshot,created_by_user_id,proposal_id,source_document_id)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id,name,status`, [p.id, input.name, p.sourceLocale, input.targetLocales,
      ['machine_translation', 'review'], JSON.stringify(snapshot), auth.user.id, proposal.id, d.id])).rows[0];
    await db.query('update uploaded_documents set imported_at=coalesce(imported_at,now()) where id=$1', [d.id]);
    return { job: { ...job, documentId: d.id }, projectSlug: p.slug, document: metadata({ ...d, imported_at: true }), uiTarget: target(p, 'documents.job', job.id) };
  }
  async function download(input, auth, context = {}) {
    if (!['txt', 'csv'].includes(input.format) || !['approved', 'drafts'].includes(input.status)) throw fail(400, 'Choose TXT or CSV and approved translations or drafts.', 'document_export_invalid');
    const job = (await database.query('select * from localization_jobs where id=$1', [input.jobId])).rows[0];
    if (!job?.source_document_id) throw fail(404, 'Document job not found.', 'document_not_found');
    if (!job.target_locales.includes(input.locale)) throw fail(400, 'Choose a target language from this job.', 'document_locale_invalid');
    const { p, d } = await load(job.source_document_id, auth, context, database, ['jobs.view', 'strings.view', 'exports.run'], [input.locale]);
    if (job.project_id !== p.id) throw fail(409, 'The document job no longer matches its project.', 'document_source_changed');
    const rows = (await database.query(`select s.id,s.source_hash,s.source_text,t.text,t.human_status from source_strings s left join translations t
      on t.source_string_id=s.id and t.locale=$2 where s.project_id=$1 and s.id=any($3::uuid[])`, [p.id, input.locale, job.source_snapshot.map(s => s.id)])).rows;
    const byHash = new Map(rows.map(r => [r.source_hash, r]));
    const ordered = d.segments.map(s => ({ ...s, row: byHash.get(hash(d.id, s.index)) }));
    if (ordered.some(s => !s.row || s.row.source_text !== s.text)) throw fail(409, 'Source sections changed since upload. Resolve the changes before exporting.', 'document_source_changed');
    const missing = ordered.filter(s => !s.row.text || s.row.human_status === 'rejected' || (input.status === 'approved' && s.row.human_status !== 'verified')).length;
    if (missing) throw fail(409, `${missing} sections lack ${input.status === 'approved' ? 'approved' : 'usable'} translations in ${input.locale}. Finish translation/review before exporting. No source text will be substituted.`, 'document_export_incomplete');
    const csv = [['section', 'source', 'translation', 'status'], ...ordered.map(s => [s.location, s.text, s.row.text, s.row.human_status === 'verified' ? 'approved' : 'draft'])];
    const content = input.format === 'csv' ? '\uFEFF' + csv.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n' : ordered.map(s => s.row.text).join('\n\n') + '\n';
    const filename = `${d.filename.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]/gu, '-').slice(0, 90) || 'document'}.${input.locale}.${input.status}.${input.format}`;
    return { filename, content, type: input.format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8', version: fingerprint({ content, filename }) };
  }
  return { uploadProject, upload, read, prepare, apply, download,
    replay: async (input, auth, context, db) => { await load(input.documentId, auth, context, db, ['strings.view', 'jobs.view'], input.targetLocales); } };
}
