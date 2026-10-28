import crypto from 'node:crypto';
import { query, withTransaction } from './db.js';
import { projectPermissions } from './authorization.js';
import { createTranslationJobs } from './hackathon-engine/translation-jobs.js';
import { fail } from './action-errors.js';

let revision;
export function registerJobTranslation(adapter) { revision = adapter; }
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
export const translationJobs = createTranslationJobs({ database: { query }, transaction: withTransaction,
  fingerprint: value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'),
  authorize: async (auth, project, locales, write) => {
    const user = (await query("select id from users where id=$1 and status='active'", [auth.user?.id])).rows[0];
    if (auth.principalType !== 'user' || !user) throw fail(403, 'An active named user is required.', 'job_access_denied');
    // Execution always uses delegated user permissions, including manual starts.
    const actor = { ...auth, executionType: 'agent', platformAdmin: false, user: { ...auth.user, platformStaff: false } };
    for (const locale of locales) {
      const permissions = await projectPermissions(actor, project, { locale });
      const required = write ? ['jobs.view', 'jobs.update', 'strings.view', 'translations.edit'] : ['jobs.view'];
      if (!required.every(p => permissions.includes(p))) throw fail(403, 'You need job, source and translation access to each enabled target language.', 'job_access_denied');
    }
  },
  inspect: options => {
    if (!revision) throw fail(503, 'Translation processing is not configured.');
    return revision.inspect(options);
  },
  execute: options => revision.execute(options),
});
