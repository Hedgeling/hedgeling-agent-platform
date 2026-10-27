// SPDX-License-Identifier: Apache-2.0
import { AgentError } from './errors.js';
const fail = (status, message, code) => new AgentError(status, message, code);
export function canonicalProjectLocale(value) {
  try {
    const locale = Intl.getCanonicalLocales(value.trim().replaceAll('_', '-'))[0];
    if (!locale) throw new Error();
    return locale;
  } catch { throw fail(400, 'Use a valid language code, such as fr, fr-CA or pt-BR.', 'invalid_locale'); }
}
export function localeAddition(sourceLocale, rows, requested) {
  const source = sourceLocale ? canonicalProjectLocale(sourceLocale) : null;
  const targets = [...new Set(requested.map(canonicalProjectLocale))].sort();
  if (targets.includes(source)) throw fail(400, 'The source language cannot also be a target language.', 'source_locale_conflict');
  const enabled = rows.filter(r => r.enabled && canonicalProjectLocale(r.locale) !== source);
  const before = enabled.map(r => r.locale).sort();
  const additions = targets.filter(locale => !enabled.some(r => canonicalProjectLocale(r.locale) === locale));
  // Re-enable the existing key so its translations remain attached. Never rename
  // legacy keys or silently create a second canonical-equivalent locale.
  const writes = additions.map(locale => rows.find(r => canonicalProjectLocale(r.locale) === locale)?.locale || locale);
  return { before, after: [...before, ...writes].sort(), additions, writes };
}
export function createProjectLocales({ database, authorize, limits, fingerprint }) {
  async function project(input, auth, context, db, manage, lock = false) {
    const p = (await db.query(`select p.id,p.name,p.slug,p.source_locale as "sourceLocale",p.business_unit_id as "businessUnitId",b.organization_id as "organizationId",p.xmin::text as version
      from projects p join business_units b on b.id=p.business_unit_id where p.slug=$1 and p.data_purged_at is null${lock ? ' for update of p' : ''}`, [input.projectSlug])).rows[0];
    if (!p) throw fail(404, 'Project not found.', 'project_not_found');
    const access = await authorize(auth, p, manage);
    if (Object.hasOwn(context, 'organizationId') && context.organizationId !== p.organizationId) throw fail(403, 'Choose this project’s organization before continuing.', 'agent_scope_mismatch');
    return { p, access };
  }
  const rows = async (p, db) => (await db.query('select locale,enabled from locales where project_id=$1 order by locale', [p.id])).rows;
  async function read(input, auth, context = {}) {
    const { p, access } = await project(input, auth, context, database, false);
    const visible = [];
    for (const row of await rows(p, database)) if (access.canManage || await access.canView(row.locale)) visible.push(row);
    return { project: { id: p.id, name: p.name, slug: p.slug }, sourceLocale: p.sourceLocale,
      targetLocales: visible.filter(r => r.enabled && r.locale !== p.sourceLocale).map(r => r.locale),
      disabledLocales: visible.filter(r => !r.enabled).map(r => r.locale), canManage: access.canManage };
  }
  async function prepare(input, auth, context = {}, db = database, lock = false) {
    const { p } = await project(input, auth, context, db, true, lock);
    // Same organization lock as catalog import. It serializes additions across
    // projects so concurrent confirmations cannot exceed the account-wide cap.
    if (lock) await db.query('select pg_advisory_xact_lock(hashtext($1))', ['resource-limit:' + p.organizationId]);
    const configured = await rows(p, db);
    const change = localeAddition(p.sourceLocale, configured, input.targetLocales);
    if (!change.additions.length) throw fail(lock ? 409 : 400, 'Those target languages are already enabled. Refresh the languages before preparing another change.', lock ? 'proposal_stale' : 'no_changes');
    if (new Set(change.after.map(canonicalProjectLocale)).size > 30) throw fail(400, 'This workflow supports up to 30 enabled target languages per project.', 'project_locale_limit');
    const limit = await limits(p.organizationId);
    const all = (await db.query(`select l.locale from locales l join projects p on p.id=l.project_id join business_units b on b.id=p.business_unit_id
      where b.organization_id=$1 and p.data_purged_at is null and l.enabled=true`, [p.organizationId])).rows;
    const total = new Set([...all.map(r => canonicalProjectLocale(r.locale)), ...change.additions]).size;
    if (limit != null && total > limit) throw fail(402, `Your plan supports ${limit} distinct target languages across this organization. Review your plan before adding more.`, 'resource_limit_exceeded');
    return { organizationId: p.organizationId, resource: { type: 'project', id: p.id }, writes: change.writes,
      preview: { action: 'project.locales.add', fields: input,
        resources: { project: p, localeVersion: fingerprint(configured), targetLocaleLimit: limit },
        changes: [{ field: 'targetLocales', label: 'Target languages', before: change.before, after: change.after }],
        sideEffects: [`Enable ${change.writes.join(', ')} for this project.`, 'Keep existing target languages and translations. Existing jobs keep their current language selections.'],
        cost: 'No translation or paid work starts. Choose a translation action separately after saving.' } };
  }
  async function apply(prepared, db) {
    const p = prepared.preview.resources.project;
    for (const locale of prepared.writes) await db.query('insert into locales(project_id,locale) values($1,$2) on conflict(project_id,locale) do update set enabled=true', [p.id, locale]);
    await db.query('update projects set updated_at=now() where id=$1', [p.id]);
    return { project: { id: p.id, name: p.name, slug: p.slug, sourceLocale: p.sourceLocale, targetLocales: prepared.preview.changes[0].after }, addedLocales: prepared.writes };
  }
  async function replay(input, auth, context, db) { await project(input, auth, context, db, true); }
  return { read, prepare, apply, replay };
}
