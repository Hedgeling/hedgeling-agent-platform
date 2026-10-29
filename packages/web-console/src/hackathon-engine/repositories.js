// SPDX-License-Identifier: Apache-2.0
import { fail } from './errors.js';
import { SOURCE_LIMITS, recommendRoots, safeSourcePath } from './github-source.js';
import { tuningSettings, tuningConfigPath } from './tuning-config.js';
export function createRepositories({database,github,identity,authorize,fingerprint,engine}) {
  async function project(input,auth,scope={},db=database,write=false,lock=false){
    const p=(await db.query(`select p.id,p.slug,p.name,p.source_locale as "sourceLocale",p.business_unit_id as "businessUnitId",b.organization_id as "organizationId"
      from projects p join business_units b on b.id=p.business_unit_id where p.slug=$1 and p.data_purged_at is null${lock?' for update of p':''}`,[input.projectSlug])).rows[0];
    if(!p)throw fail(404,'Project not found.','repository_project_not_found');
    if(Object.hasOwn(scope,'organizationId')&&scope.organizationId!==p.organizationId)throw fail(403,'Choose this project’s workspace first.','agent_scope_mismatch');
    await authorize(auth,p,write);return p;
  }
  const resolve=(url,auth)=>github.resolve(url,()=>identity.token(auth));
  const safe=repo=>({id:repo.id,url:repo.url,owner:repo.owner,repository:repo.repository,visibility:repo.visibility,defaultRef:repo.defaultRef});
  const target=p=>({view:'workspace',organizationId:p.organizationId,projectSlug:p.slug,action:'repositories.connect',resource:{type:'project',id:p.id}});
  async function read(name,input,auth,scope={}){
    const p=await project(input,auth,scope),repo=await resolve(input.url,auth),uiTarget=target(p);
    if(name==='repositories.branches')return{repository:safe(repo),...await github.branches(repo,input.page),uiTarget};
    const tree=await github.tree(repo,input.ref||repo.defaultRef);
    if(name==='repositories.file'){
      if(!safeSourcePath(input.path))throw fail(400,'Choose an ordinary supported source file.');
      const entry=tree.files.find(f=>f.path===input.path);if(!entry)throw fail(404,'Source file not found.');
      return{repository:safe(repo),commitSha:tree.commitSha,path:entry.path,content:await github.file(repo,entry,SOURCE_LIMITS.excerptBytes),untrusted:true,uiTarget};
    }
    const offset=input.offset||0,files=tree.files.slice(offset,offset+SOURCE_LIMITS.page);
    return{repository:safe(repo),ref:input.ref||repo.defaultRef,commitSha:tree.commitSha,files:files.map(f=>({path:f.path,bytes:f.size})),
      page:{total:tree.files.length,nextOffset:offset+files.length<tree.files.length?offset+files.length:null},
      suggestedRoots:recommendRoots(tree.files,input.description),recommendationBasis:'Path names only. Check shared files; this is not a semantic guarantee.',limits:SOURCE_LIMITS,uiTarget};
  }
  async function prepare(_name,input,auth,scope={},db=database,lock=false){
    const p=await project(input,auth,scope,db,true,lock),repo=await resolve(input.url,auth),tree=await github.tree(repo,input.ref);
    github.select(tree,input.scanRoots);
    const connectionId='repo-'+repo.id,old=(await db.query('select repository_owner,repository_name,allowed_roots,default_ref,source_mode,active from extraction_connections where project_id=$1 and connection_id=$2',[p.id,connectionId])).rows[0]||null;
    if(old&&old.source_mode!=='github-fetch')throw fail(409,'An operator-managed connection already uses this identifier.','repository_connection_conflict');
    const roots=[...new Set(input.scanRoots)].sort(),after={repository:repo.owner+'/'+repo.repository,ref:input.ref,scanRoots:roots};
    return{p,repo,connectionId,roots,organizationId:p.organizationId,uiTarget:target(p),preview:{action:'repositories.connect',fields:after,
      resources:{project:p,repositoryId:repo.id,visibility:repo.visibility,previous:old,version:fingerprint(old)},cost:'No extraction or model request.',
      sideEffects:[old?`Replace this connection’s previous paths (${old.allowed_roots.join(', ')}) and default branch (${old.default_ref}).`:'Connect this repository to the project.',
        'Authorized project members can request scans within these paths. Each person needs their own GitHub access for a private repository.',
        'Extraction and catalog import require separate confirmations. Imported source becomes available to authorized project members.',
        'The selected files are sent through the console backend to the private extraction service only after extraction confirmation.']}};
  }
  async function apply(_name,prepared,_proposal,auth,db){const {p,repo,connectionId,roots}=prepared;await authorize(auth,p,true);await db.query(`insert into extraction_connections(project_id,connection_id,repository_id,repository_owner,repository_name,allowed_roots,default_ref,source_mode,visibility)
    values($1,$2,$3,$4,$5,$6,$7,'github-fetch',$8) on conflict(project_id,connection_id) do update set repository_id=excluded.repository_id,repository_owner=excluded.repository_owner,repository_name=excluded.repository_name,allowed_roots=excluded.allowed_roots,default_ref=excluded.default_ref,source_mode=excluded.source_mode,visibility=excluded.visibility,active=true`,[p.id,connectionId,repo.id,repo.owner,repo.repository,roots,prepared.preview.fields.ref,repo.visibility]);return{projectSlug:p.slug,connectionId,repository:repo.owner+'/'+repo.repository,uiTarget:target(p)};}
  async function connected(binding,auth){const repo=await resolve(`https://github.com/${binding.owner}/${binding.repository}`,auth);if(repo.id!==Number(binding.repositoryId))throw fail(409,'Repository identity changed. Connect it again.','repository_identity_changed');return repo;}
  async function plan(binding,ref,roots,auth){const repo=await connected(binding,auth),tree=await github.tree(repo,ref),selected=github.select(tree,roots);return{commitSha:tree.commitSha,files:selected.files.length,bytes:selected.bytes,visibility:repo.visibility};}
  async function submit(binding,request,key,auth){const repo=await connected(binding,auth),snapshot=await github.snapshot(repo,request.ref,request.scanRoots);return engine().snapshot({request,repository:{id:repo.id,owner:repo.owner,name:repo.repository},snapshot},key);}
  async function configuration(binding,ref,path,auth){
    if(!tuningConfigPath(path))throw fail(400,'Choose a .hedgeling/extract.config.json path.');
    const repo=await connected(binding,auth),base=`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repository)}`;
    const tree=await github.tree(repo,ref);
    // GitHub contents lookup for this fixed JSON-config shape only; never execute it.
    let value;try{value=await github.request(`${base}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${tree.commitSha}`,repo.token,{maximumBytes:65536});}catch(e){if(e.upstreamStatus===404)return{repositoryId:repo.id,commitSha:tree.commitSha,path,found:false,settings:{},ignoredFields:[]};throw e;}
    const entry=tree.configurationEntries.find(f=>f.path===path);
    if(!entry||entry.type!=='blob'||!['100644','100755'].includes(entry.mode)||value.type!=='file'||!Number.isSafeInteger(value.size)||value.size>32768||value.size!==entry.size||value.sha!==entry.sha||!/^[a-f0-9]{40}$/.test(value.sha))throw fail(422,'Configuration must be an ordinary JSON file up to 32 KiB, not a symlink.');
    const content=await github.file(repo,{size:value.size,sha:value.sha},32768);
    let parsed;try{parsed=JSON.parse(content);}catch{throw fail(422,'Configuration is not valid JSON.');}
    return{repositoryId:repo.id,commitSha:tree.commitSha,path,found:true,...tuningSettings(parsed,{strict:false})};
  }
  return{read,prepare,apply,connected,plan,submit,configuration,replay:(input,auth,scope,db)=>project(input,auth,scope,db,true)};
}
