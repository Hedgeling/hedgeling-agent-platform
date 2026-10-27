import crypto from 'node:crypto';
import { query } from './db.js';
import { projectPermissions } from './authorization.js';
import { effectiveOrganizationAccess } from './entitlements.js';
import { createExtractionWorkflow } from './hackathon-engine/extraction-workflow.js';
import { engineOperations } from './hackathon-engine/engine-operations.js';
import { fail } from './action-errors.js';

let importHandler;
export function registerExtractionImport(handler) { importHandler = handler; }
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
}
export const extractionWorkflow = createExtractionWorkflow({
  database: { query },
  fingerprint: value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'),
  engine: () => engineOperations({ url: process.env.HEDGELING_ENGINE_URL, token: process.env.HEDGELING_ENGINE_TOKEN }),
  authorize: async (auth, project) => {
    const permissions = await projectPermissions(auth, project);
    if (!['strings.view', 'imports.run'].every(p => permissions.includes(p))) throw fail(403, 'You need source-view and import access to use this project’s extraction connection.', 'extraction_access_denied');
  },
  checkAccess: async (_auth, project) => {
    const access = await effectiveOrganizationAccess(project.organizationId, 'state_imports');
    if (!access.allowed) throw fail(access.featureEnabled ? 402 : 403, 'This workspace does not currently include source import access.', 'extraction_entitlement_required');
    return access;
  },
  importState: options => {
    if (!importHandler) throw fail(503, 'Source import is not configured.');
    return importHandler(options);
  },
});
