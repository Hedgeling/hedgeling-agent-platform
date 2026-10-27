import crypto from 'node:crypto';
import { query } from './db.js';
import { projectPermissions } from './authorization.js';
import { effectiveOrganizationAccess } from './entitlements.js';
import { createProjectLocales } from './hackathon-engine/project-locales.js';
import { fail } from './action-errors.js';
export const projectLocales = createProjectLocales({
  database: { query },
  fingerprint: value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  authorize: async (auth, project, manage) => {
    const unscoped = await projectPermissions(auth, project);
    const canManage = unscoped.includes('locales.manage');
    const visible = await projectPermissions(auth, project, { allowUnknownLocale: true });
    if (manage ? !canManage : !canManage && !visible.includes('locales.view')) throw fail(403, manage ? 'You need project-wide language-management access to add languages.' : 'You cannot view languages in this project.', 'project_locale_access_denied');
    return { canManage, canView: async locale => (await projectPermissions(auth, project, { locale })).includes('locales.view') };
  },
  limits: async organizationId => {
    // Language configuration uses the existing catalog-write plan and resource
    // limit. It starts no import, model inference, or billable usage.
    const access = await effectiveOrganizationAccess(organizationId, 'state_imports', { featureKey: null });
    if (!access.allowed) throw fail(402, 'Your workspace plan does not currently allow language configuration. Review Billing & usage.', 'project_locale_entitlement_required');
    const value = access.limits?.resources?.targetLocales;
    if (value == null || value === 'unlimited') return null;
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) throw fail(503, 'The language limit is not configured correctly.', 'locale_limit_unconfigured');
    return count;
  },
});
