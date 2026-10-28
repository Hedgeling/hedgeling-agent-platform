import crypto from 'node:crypto';
import { query } from './db.js';
import { projectPermissions } from './authorization.js';
import { createLibrary } from './hackathon-engine/library.js';
import { cursorBinding, readCursor, nextCursor } from './pagination.js';
import { fail } from './action-errors.js';
const canonical = v => v instanceof Date ? v.toJSON() : Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k,canonical(v[k])])) : v;
export const library = createLibrary({
  database:{query},fingerprint:value=>crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'),
  permissions:async(auth,project)=>{
    const rows=(await query('select locale from locales where project_id=$1 order by locale',[project.id])).rows;
    // Include legacy asset locales for permission-scoped reads/history. New writes
    // still require an enabled target, checked by the shared Library service.
    const assetLocales=(await query('select locale from personas where project_id=$1 union select locale from glossary_terms where project_id=$1 and locale is not null',[project.id])).rows;
    const locales=[null,...new Set([...rows,...assetLocales].map(r=>r.locale))];
    const grants=new Map(await Promise.all(locales.map(async locale=>[locale,new Set(await projectPermissions(auth,project,{locale}))])));
    const asset=(kind,locale)=>{
      const prefix={prompt:'prompts',persona:'personas',glossary:'glossary'}[kind];
      const has=suffix=>grants.get(locale)?.has(prefix+'.'+suffix)||grants.get(null)?.has(prefix+'.'+suffix);
      const canApply=Boolean(has('manage')||has('approve')),canPropose=Boolean(canApply||has('propose'));
      return {canRead:Boolean(canPropose||has('view')),canPropose,canApply};
    };
    return {asset,scopes:kind=>locales.filter(l=>kind!=='prompt'||l===null).map(locale=>({locale,...asset(kind,locale)})).filter(s=>s.canRead),canReadSources:[...grants.values()].some(s=>s.has('strings.view'))};
  },
  paging:(input,auth,action)=>{
    const limit=input.limit??25,binding=cursorBinding(auth,action,input),previous=readCursor(input.cursor,binding);
    if(previous&&typeof previous.after!=='string')throw fail(400,'Invalid Library page cursor.','invalid_cursor');
    return {limit,after:previous?.after||'',finish:rows=>{const items=rows.slice(0,limit),hasMore=rows.length>limit;return {items,page:{limit,returned:items.length,hasMore,nextCursor:hasMore?nextCursor(binding,items.at(-1).id,previous):null}};}};
  },
});
