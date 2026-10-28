import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { localConsole, eventually } from '../test-support/local-console.mjs';

test('Library API/MCP preserves approvals, versions, locale boundaries and reviewer authority', { skip: process.env.HEDGELING_REQUIRE_AGENT_TEST_DATABASE !== 'true' }, async t => {
  const app=await localConsole(process.env.TEST_DATABASE_URL);t.after(app.close);
  const {database,request}=app,controllerId=crypto.randomUUID();
  const p=(await database.query("select p.id,p.slug,p.business_unit_id as unit,b.organization_id as org from projects p join business_units b on b.id=p.business_unit_id where p.slug='hedgeling-local'")).rows[0];
  const userId=(await request('/api/me')).body.auth.user.id;
  await database.query("update projects set source_locale='en' where id=$1",[p.id]);
  await database.query('delete from locales where project_id=$1',[p.id]);
  await database.query("insert into locales(project_id,locale) values($1,'fr'),($1,'es-MX'),($1,'fr-CA')",[p.id]);
  const call=async(name,input)=>{const r=await request('/api/actions/'+name,{projectSlug:p.slug,...input});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.result;};
  const confirm=proposal=>request(`/api/agent/proposals/${proposal.id}/confirm`,{fingerprint:proposal.fingerprint,controllerId});
  const save=async(kind,input)=>{const proposal=(await call(`library.${kind}.save`,input)).proposal;const r=await confirm(proposal);assert.equal(r.status,200,JSON.stringify(r.body));return {proposal,result:r.body.result};};
  const get=async(kind,key)=>(await call('library.get',{kind,key})).asset;
  const instructions={key:'brand',label:'Brand voice',body:'Use friendly language. Preserve {name}.',active:true,expectedVersion:null};
  assert.equal((await call('library.list',{kind:'prompt'})).items.length,0);
  const preview=(await call('library.prompt.save',instructions)).proposal;
  assert.equal((await database.query('select count(*)::int n from prompts')).rows[0].n,0);
  const race=await Promise.all([confirm(preview),confirm(preview)]);for(const r of race)assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(race.filter(r=>r.body.replayed).length,1);
  assert.equal((await database.query('select count(*)::int n from library_revisions')).rows[0].n,1);
  const first=await get('prompt','brand');assert.equal(first.content.body,instructions.body);
  const a=(await call('library.prompt.save',{...instructions,body:'Use concise language.',expectedVersion:first.version})).proposal;
  const b=(await call('library.prompt.save',{...instructions,body:'Use playful language.',expectedVersion:first.version})).proposal;
  assert.equal((await confirm(a)).status,200);assert.equal((await confirm(b)).status,409);
  assert.equal((await request('/api/actions/library.prompt.save',{projectSlug:p.slug,...instructions})).status,409);
  assert.equal((await request('/api/actions/library.prompt.save',{projectSlug:p.slug,...instructions,canApply:true})).status,400);
  const history=await call('library.history',{kind:'prompt',key:'brand'});assert.equal(history.items.length,2);
  const restore=(await call('library.restore',{revisionId:race[0].body.result.library.revisionId,expectedVersion:(await get('prompt','brand')).version})).proposal;
  assert.equal((await confirm(restore)).status,200);assert.equal((await get('prompt','brand')).content.body,instructions.body);
  await database.query("insert into personas(project_id,locale,body) values($1,'fr','{\"developer_persona\":\"Legacy voice\",\"humor_sources\":[\"local context\"]}')",[p.id]);
  const persona=await get('persona','fr');
  const changedPersona=await save('persona',{locale:'fr',body:{audience:'New customers',tone:'Warm and direct'},active:true,expectedVersion:persona.version});
  assert.equal((await get('persona','fr')).content.body.developer_persona,'Legacy voice');
  const earlier=(await call('library.restore',{revisionId:changedPersona.result.library.revisionId,snapshot:'before',expectedVersion:(await get('persona','fr')).version})).proposal;
  assert.equal((await confirm(earlier)).status,200);
  assert.deepEqual((await get('persona','fr')).content.body,persona.content.body);
  assert.equal((await request('/api/actions/library.persona.save',{projectSlug:p.slug,locale:'de',body:{tone:'Friendly'},active:true,expectedVersion:null})).status,400);
  const term={term:'Workspace',locale:'fr',translation:'Espace de travail',description:'Area containing projects',doNotTranslate:false,active:true,expectedVersion:null};
  const termSaved=await save('glossary',term);
  const oldTerm=await get('glossary',termSaved.result.library.key);
  assert.equal((await request('/api/actions/library.glossary.save',{projectSlug:p.slug,...term})).status,409);
  assert.equal((await request('/api/actions/library.glossary.save',{projectSlug:p.slug,...term,term:'Brand',doNotTranslate:true})).status,400);
  await save('glossary',{term:'Hedgeling',locale:null,translation:'',description:'Product name',doNotTranslate:true,active:true,expectedVersion:null});
  await save('glossary',{...term,id:oldTerm.id,active:false,expectedVersion:oldTerm.version});
  assert.equal((await get('glossary',oldTerm.key)).active,false);
  assert.equal((await database.query('select count(*)::int n from translation_revisions')).rows[0].n,0);
  const firstPage=await call('library.list',{kind:'glossary',limit:1});assert.equal(firstPage.items.length,1);assert.equal(firstPage.page.hasMore,true);
  const secondPage=await call('library.list',{kind:'glossary',limit:1,cursor:firstPage.page.nextCursor});assert.equal(secondPage.page.hasMore,false);assert.notEqual(firstPage.items[0].id,secondPage.items[0].id);
  assert.equal((await request('/api/actions/library.list',{projectSlug:p.slug,kind:'glossary',search:'different',limit:1,cursor:firstPage.page.nextCursor})).status,400);
  await database.query("insert into source_strings(project_id,source_hash,source_text) values($1,'library-evidence','Manage your workspace')",[p.id]);
  assert.equal((await call('library.sources',{search:'workspace'})).items[0].text,'Manage your workspace');

  // The old direct-save endpoint cannot bypass confirmation on the agent console.
  const legacy=await fetch(app.origin+'/api/glossary?project='+p.slug,{method:'POST',headers:{origin:app.origin,cookie:app.cookie,'content-type':'application/json'},body:JSON.stringify(term)});assert.equal(legacy.status,409);
  const run=(await request('/api/agent/runs',{organizationId:p.org,controllerId})).body.run;
  await request(`/api/agent/runs/${run.id}/messages`,{controllerId,text:`Create translation instructions "chat-rules" for project "${p.slug}".`});
  const pending=await eventually(()=>request(`/api/agent/runs/${run.id}`),r=>r.body.run?.status==='awaiting_confirmation',20000);
  assert.equal(pending.body.proposals[0].preview.action,'library.prompt.save');assert.equal((await get('prompt','chat-rules')),null);
  assert.equal((await confirm(pending.body.proposals[0])).status,200);

  // Exercise the real in-process MCP transport with the quoted null observed
  // from Meta. It must create an approval card, never save automatically.
  const personaInput={projectSlug:p.slug,locale:'fr-CA',body:{tone:'Warm and direct',audience:'New customers'},active:true,expectedVersion:'null'};
  assert.equal((await request('/api/actions/library.persona.save',personaInput)).status,400,'HTTP API retains strict JSON typing');
  const personaRun=(await request('/api/agent/runs',{organizationId:p.org,controllerId})).body.run;
  assert.equal((await request(`/api/agent/runs/${personaRun.id}/messages`,{controllerId,text:`Create persona "fr-CA" for project "${p.slug}".`})).status,200);
  const personaPending=await eventually(()=>request(`/api/agent/runs/${personaRun.id}`),r=>r.body.run?.status==='awaiting_confirmation',20000);
  assert.equal(personaPending.body.proposals[0].preview.action,'library.persona.save');
  assert.equal(await get('persona','fr-CA'),null);
  assert.equal((await confirm(personaPending.body.proposals[0])).status,200);
  assert.deepEqual((await get('persona','fr-CA')).content.body,personaInput.body);
  // Repaired null still cannot overwrite an existing persona.
  assert.equal((await request('/api/actions/library.persona.save',{...personaInput,expectedVersion:null})).status,409);

  // Simulate changing human roles. Propose-only confirmations enqueue suggestions;
  // the same confirmed proposal cannot become an application after role promotion.
  const role=(await database.query("insert into roles(key,name,organization_id) values('library-test','Library tester',$1) returning id",[p.org])).rows[0].id;
  await database.query('update role_assignments set revoked_at=now() where principal_id=$1',[userId]);
  const assignment=(await database.query("insert into role_assignments(principal_type,principal_id,role_id,scope_type,scope_id,conditions) values('user',$1,$2,'project',$3,'{\"locales\":[\"fr\"]}') returning id",[userId,role,p.id])).rows[0].id;
  const grant=async permissions=>{await database.query('delete from role_permissions where role_id=$1',[role]);await database.query('insert into role_permissions(role_id,permission_id) select $1,id from permissions where key=any($2::text[])',[role,permissions]);};
  await grant(['glossary.propose','strings.view']);
  assert.equal((await request('/api/actions/library.list',{projectSlug:p.slug,kind:'prompt'})).status,403);
  const limited=await call('library.list',{kind:'glossary'});assert.deepEqual(limited.items.map(r=>r.locale),['fr']);
  assert.equal((await request('/api/actions/library.glossary.save',{projectSlug:p.slug,...term,term:'Hidden',locale:'es-MX'})).status,403);
  const suggestion=await save('glossary',{...term,term:'Checkout',translation:'Paiement'});assert.equal(suggestion.result.library.status,'submitted');
  assert.equal((await database.query("select count(*)::int n from glossary_terms where term='Checkout'")).rows[0].n,0);
  assert.equal((await request('/api/actions/library.review',{projectSlug:p.slug,suggestionId:suggestion.result.library.id,decision:'approve'})).status,403);
  await grant(['glossary.approve','strings.view']);
  const replay=await confirm(suggestion.proposal);assert.equal(replay.status,200);assert.equal(replay.body.result.library.status,'submitted');
  const review=(await call('library.review',{suggestionId:suggestion.result.library.id,decision:'approve'})).proposal;
  assert.equal((await confirm(review)).status,200);assert.equal((await database.query("select count(*)::int n from glossary_terms where term='Checkout'")).rows[0].n,1);
  assert.equal((await request('/api/actions/library.review',{projectSlug:p.slug,suggestionId:suggestion.result.library.id,decision:'approve'})).status,409);
  // A competing edit makes acceptance stale, while a reviewer can still reject.
  await grant(['glossary.propose']);
  const staleSuggestion=await save('glossary',{...term,id:oldTerm.id,translation:'Espace',expectedVersion:(await get('glossary',oldTerm.key)).version});
  await grant(['glossary.approve']);
  await save('glossary',{...term,id:oldTerm.id,translation:'Zone de travail',expectedVersion:(await get('glossary',oldTerm.key)).version});
  assert.equal((await request('/api/actions/library.review',{projectSlug:p.slug,suggestionId:staleSuggestion.result.library.id,decision:'approve'})).status,409);
  const rejection=(await call('library.review',{suggestionId:staleSuggestion.result.library.id,decision:'reject'})).proposal;
  assert.equal((await confirm(rejection)).status,200);
  assert.equal((await get('glossary',oldTerm.key)).content.translation,'Zone de travail');
  const approved=(await call('library.list',{kind:'glossary',search:'Checkout'})).items[0];
  const revoke=(await call('library.glossary.save',{...term,id:approved.id,term:'Checkout',translation:'Commander',expectedVersion:approved.version})).proposal;
  await database.query('update role_assignments set revoked_at=now() where id=$1',[assignment]);
  assert.equal((await confirm(revoke)).status,403);assert.equal((await confirm(review)).status,403);
  assert.equal((await request('/api/actions/library.list',{projectSlug:p.slug,kind:'glossary'})).status,403);
});
