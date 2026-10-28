// SPDX-License-Identifier: Apache-2.0
import { PERSONA_FIELDS } from './library-actions.js';
import { AgentError } from './errors.js';
import { canonicalProjectLocale } from './project-locales.js';
export const LIBRARY_KINDS = Object.freeze({ prompt: 'prompts', persona: 'personas', glossary: 'glossary_terms' });
const fail = (status, message, code = 'library_invalid') => new AgentError(status, message, code);
const keyOf = (kind, row) => kind === 'prompt' ? row.key : kind === 'persona' ? row.locale : row.id;
export function librarySnapshot(kind, row) {
  if (!row) return null;
  const shared = { id: row.id, active: row.active !== false };
  if (kind === 'prompt') return { ...shared, key: row.key, label: row.label, body: row.body };
  if (kind === 'persona') return { ...shared, locale: row.locale, body: row.body };
  return { ...shared, term: row.term, locale: row.locale, translation: row.translation || '', description: row.description || '', doNotTranslate: row.do_not_translate ?? row.doNotTranslate ?? false };
}
const title = (kind, state) => kind === 'prompt' ? state.label : kind === 'persona' ? `${state.locale} voice` : state.term;
const clean = value => typeof value === 'string' ? value.trim() : value;
export function libraryChange(kind, input, current) {
  if (kind === 'prompt') return { ...(current?.id ? { id: current.id } : {}), key: clean(input.key), label: clean(input.label), body: clean(input.body), active: input.active };
  if (kind === 'persona') {
    const body = { ...current?.body, ...Object.fromEntries(Object.entries(input.body).map(([k,v]) => [k, clean(v)])) };
    if (!Object.values(body).some(v => typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.length : v && Object.keys(v).length)) throw fail(400, 'Add some audience, voice or regional guidance before saving a persona.');
    return { ...(current?.id ? { id: current.id } : {}), locale: input.locale, body, active: input.active };
  }
  const value = { ...(current?.id ? { id: current.id } : {}), term: clean(input.term), locale: input.locale, translation: clean(input.translation), description: clean(input.description), doNotTranslate: input.doNotTranslate, active: input.active };
  if (value.doNotTranslate && value.translation) throw fail(400, 'Choose either a preferred translation or “Do not translate”, not both.');
  if (!value.doNotTranslate && (!value.locale || !value.translation)) throw fail(400, 'A preferred translation needs a target language and translated term. Use “Do not translate” for protected names.');
  return value;
}
export function createLibrary({ database, permissions, fingerprint, paging }) {
  async function project(input, auth, context, db, lock = false) {
    const p = (await db.query(`select p.id,p.slug,p.name,p.source_locale as "sourceLocale",p.business_unit_id as "businessUnitId",b.organization_id as "organizationId"
      from projects p join business_units b on b.id=p.business_unit_id where p.slug=$1 and p.data_purged_at is null${lock ? ' for update of p' : ''}`, [input.projectSlug])).rows[0];
    if (!p) throw fail(404, 'Project not found.', 'project_not_found');
    if (Object.hasOwn(context, 'organizationId') && context.organizationId !== p.organizationId) throw fail(403, 'Choose this project’s organization before continuing.', 'agent_scope_mismatch');
    const access = await permissions(auth, p);
    return { p, access };
  }
  const localeOf = (kind, row) => kind === 'prompt' ? null : row?.locale || null;
  function allow(access, kind, locale, write = false, approve = false) {
    const rights = access.asset(kind, locale);
    if (approve ? !rights.canApply : write ? !rights.canPropose : !rights.canRead) throw fail(403, approve ? 'You need Library approval or management access for this language.' : write ? 'You cannot suggest changes to this Library asset.' : 'This Library asset is not accessible.', 'library_access_denied');
    return rights;
  }
  async function getRow(kind, key, p, db, lock = false) {
    const column = kind === 'prompt' ? 'key' : kind === 'persona' ? 'locale' : 'id::text';
    return (await db.query(`select * from ${LIBRARY_KINDS[kind]} where project_id=$1 and ${column}=$2${lock ? ' for update' : ''}`, [p.id, key])).rows[0] || null;
  }
  function version(kind, row) { return row ? fingerprint({ state: librarySnapshot(kind, row), updatedAt: row.updated_at }) : null; }
  async function normalizeLocale(locale, p, db) {
    if (locale == null) return null;
    const canonical = canonicalProjectLocale(locale);
    const rows = (await db.query('select locale from locales where project_id=$1 and enabled=true', [p.id])).rows;
    const matched = rows.filter(r => canonicalProjectLocale(r.locale) === canonical && canonicalProjectLocale(r.locale) !== canonicalProjectLocale(p.sourceLocale || 'und'));
    if (matched.length !== 1) throw fail(400, 'Choose an enabled target language from this project.', 'library_locale_invalid');
    return matched[0].locale;
  }
  function exposed(kind, row, access, full = true) {
    const state = librarySnapshot(kind, row), locale = localeOf(kind, state);
    const result = { kind, key: keyOf(kind, row), id: row.id, label: String(title(kind, state)).slice(0,200), locale, active: state.active, version: version(kind, row), updatedAt: row.updated_at, permissions: access.asset(kind, locale) };
    if(full&&Buffer.byteLength(JSON.stringify(state))>24000)throw fail(413,'This asset exceeds the 24 KB interactive Library limit.','library_size_limit');
    return full ? { ...result, content: state } : result;
  }
  function page(input, auth, action, context) { return paging({ ...input, conversationOrganizationId: context.organizationId }, auth, action); }
  async function read(action, input, auth, context = {}) {
    const { p, access } = await project(input, auth, context, database);
    const kind = input.kind;
    if (action === 'library.get') {
      const row = await getRow(kind, input.key, p, database);
      if (!row) { allow(access, kind, kind === 'persona' ? input.key : null); return { asset: null }; }
      allow(access, kind, localeOf(kind, row));
      return { asset: exposed(kind, row, access) };
    }
    const pager = page(input, auth, action, context);
    if (action === 'library.sources') {
      if (!access.canReadSources) throw fail(403, 'You cannot read this project’s source strings.', 'library_access_denied');
      const rows = (await database.query(`select id,left(source_text,500) as text,length(source_text)>500 as truncated from source_strings
        where project_id=$1 and id::text>$2 and ($3='' or strpos(lower(source_text),lower($3))>0) order by id limit $4`, [p.id,pager.after,input.search || '',pager.limit+1])).rows;
      return { ...pager.finish(rows), coverage: 'One page of matching source strings, up to 500 characters each. Suggestions are not approved terminology.' };
    }
    if (action === 'library.history') {
      const current = await getRow(kind, input.key, p, database); if (!current) throw fail(404, 'Library asset not found.');
      allow(access, kind, localeOf(kind, current));
      const rows = (await database.query(`select id,created_at as "createdAt",after_state->>'active' as active,after_state,locale,before_state is not null as "hasBefore" from library_revisions
        where project_id=$1 and kind=$2 and asset_key=$3 and id::text>$4 and ($6::boolean or locale=any($7::text[])) order by id limit $5`, [p.id,kind,input.key,pager.after,pager.limit+1,access.asset(kind,null).canRead,access.scopes(kind).map(s=>s.locale).filter(Boolean)])).rows;
      // A locale move must not expose older content from a language the reader cannot access.
      const result = pager.finish(rows.map(r => ({ id:r.id, createdAt:r.createdAt, active:r.active==='true', label:title(kind,r.after_state), hasBefore:r.hasBefore, canRestore:access.asset(kind,r.locale).canPropose && access.asset(kind,localeOf(kind,current)).canPropose })));
      return result;
    }
    const scopes = access.scopes(kind);
    if (!scopes.length) throw fail(403, 'This Library section is not accessible.', 'library_access_denied');
    const all = access.asset(kind, null).canRead;
    const values = [p.id, all, scopes.filter(s=>s.locale!==null).map(s=>s.locale), pager.after, pager.limit+1];
    if (action === 'library.reviews') {
      const rows = (await database.query(`select * from library_suggestions where project_id=$1 and kind=$6 and status='pending' and ($2 or locale=any($3::text[])) and id::text>$4 order by id limit $5`, [...values,kind])).rows;
      return pager.finish(rows.map(r => ({ id:r.id, kind:r.kind, key:r.asset_key, locale:r.locale, label:title(kind,r.after_state), createdAt:r.created_at, canReview:access.asset(kind,r.locale).canApply, mine:r.created_by_user_id===auth.user?.id })));
    }
    const scope = kind === 'prompt' ? '($2 or null::text=any($3::text[]))' : '($2 or locale=any($3::text[]))';
    const searchField = kind === 'prompt' ? "key || ' ' || label || ' ' || body" : kind === 'persona' ? "locale || ' ' || body::text" : "term || ' ' || coalesce(translation,'') || ' ' || coalesce(description,'')";
    const localeFilter = kind === 'prompt' ? '($7::text is null or null::text=$7)' : '($7::text is null or locale=$7)';
    const rows = (await database.query(`select * from ${LIBRARY_KINDS[kind]} where project_id=$1 and ${scope} and id::text>$4 and ($6='' or strpos(lower(${searchField}),lower($6))>0) and ${localeFilter} order by id limit $5`, [...values,input.search || '',input.locale || null])).rows;
    return { project:{id:p.id,slug:p.slug,name:p.name}, scopes, ...pager.finish(rows.map(r => exposed(kind,r,access,false))) };
  }
  async function prepare(action, input, auth, context = {}, db = database, lock = false) {
    const { p, access } = await project(input, auth, context, db, lock);
    let kind = action.split('.')[1], row, before, after, expected = input.expectedVersion, restoredFrom = null, suggestion = null;
    if (action === 'library.review') {
      suggestion = (await db.query(`select * from library_suggestions where id=$1 and project_id=$2${lock?' for update':''}`, [input.suggestionId,p.id])).rows[0];
      if (!suggestion || suggestion.status !== 'pending') throw fail(409, 'This Library suggestion is no longer pending.', 'proposal_stale');
      kind = suggestion.kind; after = suggestion.after_state; expected = suggestion.expected_version; restoredFrom = suggestion.restored_from_id;
      row = suggestion.asset_key.startsWith('new:') ? null : await getRow(kind,suggestion.asset_key,p,db,lock);
      allow(access,kind,suggestion.locale,true,true);
      if (suggestion.before_state) allow(access,kind,localeOf(kind,suggestion.before_state),true,true);
      if (row) allow(access,kind,localeOf(kind,row),true,true);
    } else if (action === 'library.restore') {
      const revision = (await db.query('select * from library_revisions where id=$1 and project_id=$2',[input.revisionId,p.id])).rows[0];
      if (!revision) throw fail(404,'Library revision not found.');
      kind = revision.kind; row = await getRow(kind,revision.asset_key,p,db,lock); if(!row)throw fail(404,'Library asset no longer exists.');
      after = input.snapshot === 'before' ? revision.before_state : revision.after_state; if (!after) throw fail(400,'This revision has no earlier saved content.'); restoredFrom = revision.id;
    } else {
      const normalized = { ...input };
      if(kind!=='prompt')normalized.locale=await normalizeLocale(input.locale,p,db);
      const key = kind==='prompt'?clean(input.key):kind==='persona'?normalized.locale:input.id;
      row = key ? await getRow(kind,key,p,db,lock) : null;
      if(input.id&&!row)throw fail(404,'Glossary term not found.');
      after = libraryChange(kind,normalized,librarySnapshot(kind,row));
    }
    before=librarySnapshot(kind,row);
    const rights=allow(access,kind,localeOf(kind,after),true,Boolean(suggestion));
    const oldRights=before?allow(access,kind,localeOf(kind,before),true,Boolean(suggestion)):rights;
    if(input.decision!=='reject') {
      if(version(kind,row)!==expected)throw fail(409,'This asset changed. Read it again and prepare a fresh preview.','proposal_stale');
      if(kind!=='prompt')await normalizeLocale(after.locale,p,db);
      if(kind==='glossary') {
        const duplicate=(await db.query("select id from glossary_terms where project_id=$1 and lower(term)=lower($2) and locale is not distinct from $3 and id::text<>$4 and active=true limit 1",[p.id,after.term,after.locale,row?.id||''])).rows[0];
        if(duplicate&&after.active)throw fail(409,'An active term already exists for this language. Find and edit that term instead.','library_duplicate');
      }
      if(before&&fingerprint(before)===fingerprint(after))throw fail(400,'Change a field before preparing a preview.','no_changes');
    }
    if(Buffer.byteLength(JSON.stringify(before))>24000||Buffer.byteLength(JSON.stringify(after))>24000)throw fail(400,'This Library asset exceeds the 24 KB editing limit.');
    const disposition = suggestion ? input.decision : rights.canApply&&oldRights.canApply ? 'apply' : 'submit';
    const key = row?keyOf(kind,row):kind==='prompt'?after.key:kind==='persona'?after.locale:'new:'+after.term.toLocaleLowerCase('en-US')+':'+(after.locale||'*');
    const changeLabels={key:'Key',label:'Label',body:kind==='persona'?'Locale voice':'Translation instructions',locale:'Language',term:'Term',translation:'Preferred translation',description:'Definition and usage',doNotTranslate:'Do not translate',active:'Active for future translations'};
    // JSONB storage can reorder object keys between preview and confirmation.
    // Keep the readable change list deterministic as part of the signed preview.
    const changes=Object.keys(after).sort().filter(k=>k!=='id'&&fingerprint(before?.[k]??(typeof after[k]==='string'?'':null))!==fingerprint(after[k])).flatMap(k=>kind==='persona'&&k==='body'
      ? Object.keys(after.body).sort().filter(field=>fingerprint(before?.body?.[field]??(typeof after.body[field]==='string'?'':null))!==fingerprint(after.body[field])).map(field=>({field:'body.'+field,label:PERSONA_FIELDS[field]||field,before:before?.body?.[field]??null,after:after.body[field]}))
      : [{field:k,label:changeLabels[k]||k,before:before?.[k]??null,after:after[k]}]);
    return {organizationId:p.organizationId,kind,key,before,after,expected,disposition,restoredFrom,suggestion,
      resource:{type:'project',id:p.id},uiTarget:{view:'library',projectSlug:p.slug,organizationId:p.organizationId,kind,action,resource:{type:'project',id:p.id}},
      preview:{action,fields:input,resources:{project:p,assetVersion:version(kind,row),suggestionId:suggestion?.id||null},library:{kind,label:title(kind,after),locale:localeOf(kind,after),disposition},changes,
        sideEffects:[disposition==='submit'?'Submit a suggestion for an authorized reviewer; active guidance stays unchanged.':disposition==='reject'?'Reject this suggestion; active guidance stays unchanged.':after.active?'Use this guidance for future AI translation revisions.':'Keep this guidance inactive; future revisions will not use it.','Existing translations are not regenerated.'],cost:'No translation or paid processing starts.'}};
  }
  async function apply(prepared, proposal, auth, db) {
    const {kind,after,before,disposition,restoredFrom,suggestion}=prepared,p=prepared.preview.resources.project;
    if(disposition==='submit') {
      const saved=(await db.query(`insert into library_suggestions(project_id,kind,asset_key,locale,expected_version,before_state,after_state,created_by_user_id,proposal_id,restored_from_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,[p.id,kind,prepared.key,localeOf(kind,after),prepared.expected,before,after,auth.user.id,proposal.id,restoredFrom])).rows[0];
      return {library:{...saved,kind,status:'submitted',label:title(kind,after)},uiTarget:prepared.uiTarget};
    }
    if(disposition==='reject') {
      await db.query("update library_suggestions set status='rejected',reviewed_by_user_id=$2,reviewed_at=now() where id=$1",[suggestion.id,auth.user.id]);
      return {library:{id:suggestion.id,kind,status:'rejected',label:title(kind,after)},uiTarget:prepared.uiTarget};
    }
    let saved;
    if(kind==='prompt')saved=(await db.query(`insert into prompts(project_id,key,label,body,active) values($1,$2,$3,$4,$5) on conflict(project_id,key) do update set label=excluded.label,body=excluded.body,active=excluded.active,updated_at=now() returning *`,[p.id,after.key,after.label,after.body,after.active])).rows[0];
    else if(kind==='persona')saved=(await db.query(`insert into personas(project_id,locale,body,active) values($1,$2,$3,$4) on conflict(project_id,locale) do update set body=excluded.body,active=excluded.active,updated_at=now() returning *`,[p.id,after.locale,after.body,after.active])).rows[0];
    else if(before)saved=(await db.query(`update glossary_terms set term=$2,locale=$3,translation=$4,description=$5,do_not_translate=$6,active=$7,updated_at=now() where id=$1 and project_id=$8 returning *`,[before.id,after.term,after.locale,after.translation||null,after.description||null,after.doNotTranslate,after.active,p.id])).rows[0];
    else saved=(await db.query(`insert into glossary_terms(project_id,term,locale,translation,description,do_not_translate,active) values($1,$2,$3,$4,$5,$6,$7) returning *`,[p.id,after.term,after.locale,after.translation||null,after.description||null,after.doNotTranslate,after.active])).rows[0];
    const history=(await db.query(`insert into library_revisions(project_id,kind,asset_key,locale,before_state,after_state,created_by_user_id,proposal_id,restored_from_id)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,[p.id,kind,keyOf(kind,saved),localeOf(kind,saved),before,librarySnapshot(kind,saved),auth.user.id,proposal.id,restoredFrom])).rows[0];
    if(suggestion)await db.query("update library_suggestions set status='approved',reviewed_by_user_id=$2,reviewed_at=now() where id=$1",[suggestion.id,auth.user.id]);
    return {library:{id:saved.id,key:keyOf(kind,saved),kind,status:'saved',label:title(kind,after),active:after.active,revisionId:history.id,version:version(kind,saved)},uiTarget:prepared.uiTarget};
  }
  async function replay(input, auth, context, db, result) {
    const {p,access}=await project(input,auth,context,db);
    if(result.library.status==='saved') {const row=await getRow(result.library.kind,result.library.key,p,db);if(!row)throw fail(404,'Library asset no longer exists.');allow(access,result.library.kind,localeOf(result.library.kind,row),true,true);}
    else {const suggestion=(await db.query('select * from library_suggestions where id=$1 and project_id=$2',[result.library.id,p.id])).rows[0];if(!suggestion)throw fail(404,'Suggestion not found.');allow(access,suggestion.kind,suggestion.locale,true,result.library.status==='rejected');}
  }
  return {read,prepare,apply,replay};
}
