import crypto from 'node:crypto';
import express from 'express';
import { query, withTransaction } from './db.js';
import { projectPermissions } from './authorization.js';
import { effectiveOrganizationAccess } from './entitlements.js';
import { authRateLimit } from './auth-rate-limit.js';
import { fail } from './action-errors.js';
import { createDocuments } from './hackathon-engine/documents.js';
import { processDocument } from './hackathon-engine/document-processing.js';
let importer;
export const registerDocumentImport = handler => { importer = handler; };
const canonical = v => v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const documents = createDocuments({ database: { query }, transaction: withTransaction,
  fingerprint: v => crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex'),
  authorize: async (auth, project, required, locales) => {
    if (auth.principalType !== 'user' || !(await query("select 1 from users where id=$1 and status='active'", [auth.user?.id])).rowCount) throw fail(403, 'An active user is required.', 'document_access_denied');
    for (const locale of locales) {
      const permissions = await projectPermissions(auth, project, { locale });
      if (!required.every(p => permissions.includes(p))) throw fail(403, 'You do not have access to this document action.', 'document_access_denied');
    }
    if (required.includes('exports.run')) {
      const access = await effectiveOrganizationAccess(project.organizationId, 'verified_exports');
      if (!access.allowed) throw fail(403, 'This workspace does not include translation exports.', 'document_export_denied');
    }
  },
  checkAccess: async (_auth, project) => {
    const access = await effectiveOrganizationAccess(project.organizationId, 'state_imports');
    if (!access.allowed) throw fail(403, 'This workspace does not include source imports.', 'document_import_denied');
    return access;
  },
  importState: options => { if (!importer) throw fail(503, 'Document import is not configured.'); return importer(options); },
});
export const documentsRouter = express.Router();
const route = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
let parsing = 0;
documentsRouter.post('/upload', authRateLimit({ key: 'document-upload', limit: 30, identity: req => req.auth?.user?.id }),
  (req, _res, next) => documents.uploadProject(String(req.query.project || ''), req.auth).then(() => next(), next),
  express.raw({ type: 'application/octet-stream', limit: '5mb' }), route(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw fail(400, 'Send a document as application/octet-stream.');
    if (parsing >= 2) throw fail(429, 'Two documents are being processed. Try again shortly.');
    let filename;
    try { filename = decodeURIComponent(req.get('X-Document-Name') || ''); } catch { throw fail(400, 'Invalid document filename.'); }
    parsing++;
    let parsed;
    try { parsed = await processDocument({ filename, bytes: req.body }); } finally { parsing--; }
    const result = await documents.upload(String(req.query.project || ''), parsed, req.auth);
    res.status(result.duplicate ? 200 : 201).json(result);
  }));
documentsRouter.get('/jobs/:id/download', route(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw fail(400, 'Invalid job ID.');
  const input = { jobId: req.params.id, locale: String(req.query.locale || ''), format: String(req.query.format || ''), status: String(req.query.status || '') };
  const result = await documents.download(input, req.auth);
  if (req.query.version && req.query.version !== result.version) throw fail(409, 'Translations changed. Prepare a fresh download.');
  res.set('Cache-Control', 'no-store').set('Content-Type', result.type)
    .set('Content-Disposition', `attachment; filename="document.${input.format}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`)
    .send(result.content);
}));
