// SPDX-License-Identifier: Apache-2.0
import {createHash} from 'node:crypto';
import {fail} from './errors.js';
import {safeSourcePath} from './github-source.js';
import {catalogState} from './extraction-catalog.js';
import {loadJob,jobTarget,currentJobSources,jobTranslations,jobCoverage,selectedLocales,isAiOnly} from './job-scope.js';
export const DELIVERY_LIMITS=Object.freeze({translations:10000,fileBytes:5*1024*1024,totalBytes:12*1024*1024,files:6});
const hash=value=>createHash('sha256').update(value).digest('hex');
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const badKey=k=>['__proto__','prototype','constructor'].includes(k);
function parse(text){let v;try{v=JSON.parse(text);}catch{throw fail(422,'A selected runtime file is not valid JSON.','delivery_format_invalid');}if(!object(v)||v.schemaVersion!==1)throw fail(422,'This delivery supports existing schemaVersion 1 Hedgeling runtime files.','delivery_format_invalid');return v;}
export function mergeRuntimeFile(text,kind,sources,translations){const value=parse(text);
  if(kind==='bundle'){
    for(const t of translations){if(badKey(t.locale)||badKey(t.sourceHash)||t.locale==='schemaVersion')throw fail(422,'Unsafe runtime key.','delivery_format_invalid');
      if(!Object.hasOwn(value,t.locale))value[t.locale]={};
      if(!object(value[t.locale]))throw fail(422,'A target language is not a translation map.','delivery_format_invalid');
      if(Object.hasOwn(value[t.locale],t.sourceHash)&&typeof value[t.locale][t.sourceHash]!=='string')throw fail(422,'A translation entry has an unsupported shape.','delivery_format_invalid');
      value[t.locale][t.sourceHash]=t.text;
    }
  }else{
    if(!object(value.bySource)||!Array.isArray(value.sources)||value.sources.some(s=>!object(s)||typeof s.source!=='string'||typeof s.key!=='string'||value.bySource[s.source]!==s.key))throw fail(422,'The existing source-key map is inconsistent.','delivery_format_invalid');
    for(const s of sources){if(badKey(s.source_text)||badKey(s.source_hash))throw fail(422,'Unsafe source map key.','delivery_format_invalid');
      if(Object.entries(value.bySource).some(([text,key])=>key===s.source_hash&&text!==s.source_text))throw fail(409,'A runtime key already belongs to another source string.','delivery_key_conflict');
      if(Object.hasOwn(value.bySource,s.source_text)&&value.bySource[s.source_text]!==s.source_hash)throw fail(409,'A source already maps to another runtime key. Resolve the mapping before creating a PR.','delivery_key_conflict');
      value.bySource[s.source_text]=s.source_hash;
      if(!value.sources.some(row=>row.source===s.source_text))value.sources.push({source:s.source_text,key:s.source_hash});
    }
  }
  return JSON.stringify(value,null,2)+'\n';
}
export async function publishTranslationPr(github,repo,prepared,proposalId){
  const base=`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repository)}`,branch=`hedgeling/translations-${prepared.job.id.slice(0,8)}-${proposalId}`,marker=`Hedgeling proposal ${proposalId}`;
  const call=(path,body)=>github.request(base+path,repo.token,body?{body}:{});
  const optional=async path=>{try{return await call(path);}catch(e){if(e.upstreamStatus===404)return null;throw e;}};
  const liveBase=await call('/branches/'+encodeURIComponent(prepared.baseBranch));
  if(liveBase.commit?.sha!==prepared.tree.commitSha)throw fail(409,'The base branch moved before delivery. Request a fresh preview.','delivery_base_changed');
  // Deterministic tree + branch + proposal marker allow recovery after a lost response.
  // Never update an existing ref, force-push, merge, or deploy.
  const tree=await call('/git/trees',{base_tree:prepared.tree.treeSha,tree:prepared.files.map(f=>({path:f.path,mode:f.mode,type:'blob',content:f.content}))});
  if(!/^[a-f0-9]{40}$/.test(tree?.sha))throw fail(502,'GitHub returned an invalid tree.','delivery_response_invalid');
  let ref=await optional('/git/ref/heads/'+encodeURIComponent(branch));
  if(!ref){const commit=await call('/git/commits',{message:`Add localization job translations\n\n${marker}`,tree:tree.sha,parents:[prepared.tree.commitSha]});
    if(!/^[a-f0-9]{40}$/.test(commit?.sha))throw fail(502,'GitHub returned an invalid commit.','delivery_response_invalid');
    ref=await call('/git/refs',{ref:'refs/heads/'+branch,sha:commit.sha});
  }
  const commit=await call('/git/commits/'+encodeURIComponent(ref.object?.sha||''));
  if(commit.tree?.sha!==tree.sha||commit.parents?.length!==1||commit.parents[0].sha!==prepared.tree.commitSha||!commit.message?.split('\n').includes(marker))throw fail(409,'The delivery branch already exists with different content. It was not overwritten.','delivery_branch_conflict');
  const pulls=await call('/pulls?'+new URLSearchParams({state:'all',head:`${repo.owner}:${branch}`,base:prepared.baseBranch,per_page:'100'}));
  if(!Array.isArray(pulls))throw fail(502,'Invalid GitHub pull request response.','delivery_response_invalid');
  let pr=pulls.find(p=>p.body?.includes(marker));
  if(!pr&&pulls.length)throw fail(409,'A different PR already uses this branch.','delivery_branch_conflict');
  if(!pr)pr=await call('/pulls',{title:`Translations: ${prepared.job.name}`.slice(0,200),head:branch,base:prepared.baseBranch,body:`${marker}\n\n${prepared.translations.length} translations for ${prepared.locales.join(', ')}.\n${isAiOnly(prepared.job)?'AI-only translations: AI output without human verification or a review/QA workflow.':'Translations verified through the platform approval workflow.'}\n\nOnly the approved runtime JSON files are changed; other strings and locales are preserved.\nSource extraction commit: ${prepared.tree.commitSha}.\n\nReview and merge this PR through your repository workflow. Deployment is separate.`});
  if(!Number.isSafeInteger(pr.number)||pr.number<1)throw fail(502,'Invalid PR number.','delivery_response_invalid');
  return {number:pr.number,url:`https://github.com/${repo.owner}/${repo.repository}/pull/${pr.number}`,branch,baseBranch:prepared.baseBranch,commitSha:commit.sha,status:pr.state,merged:Boolean(pr.merged_at)};
}
export function createJobDelivery({database,authorize,github,identity,engine,fingerprint}){
  const load=(i,a,s,d,permission='read',lock=false)=>loadJob(d,i.jobId,a,s,authorize,permission,lock);
  const connections=(db,p)=>db.query('select connection_id as "connectionId",repository_id::text as "repositoryId",repository_owner as owner,repository_name as repository,default_ref as "defaultRef",allowed_roots as "allowedRoots",source_mode as "sourceMode" from extraction_connections where project_id=$1 and active=true order by connection_id',[p.id]);
  async function repository(binding,auth,write){const token=await identity.token(auth);if(write&&!token)throw fail(403,'Connect your GitHub account before opening a PR. The App needs Contents and Pull requests read/write access to this repository.','delivery_github_required');
    const repo=await github.resolve(`https://github.com/${binding.owner}/${binding.repository}`,()=>token);
    if(repo.id!==Number(binding.repositoryId))throw fail(409,'Repository identity changed. Reconnect it.','repository_identity_changed');
    if(write&&(!repo.token||!repo.canPush))throw fail(403,'Your connected GitHub user needs push access, and the App needs Contents and Pull requests read/write permissions.','delivery_github_required');return repo;}
  async function read(name,input,auth,scope={},db=database){const {p,job}=await load(input,auth,scope,db),list=(await connections(db,p)).rows;
    const imports=(await db.query("select id,binding->>'connectionId' as \"connectionId\",request->>'ref' as ref,imported_at as \"importedAt\" from extraction_requests where project_id=$1 and imported_at is not null order by imported_at desc limit 100",[p.id])).rows;
    const receipts=(await db.query('select receipt from job_pull_requests where job_id=$1 order by created_at desc limit 20',[job.id])).rows.map(r=>r.receipt);
    let destination=null;if(input.connectionId){const binding=list.find(c=>c.connectionId===input.connectionId);if(!binding)throw fail(403,'Repository is not connected.','connection_denied');const repo=await repository(binding,auth,false),baseBranch=input.baseBranch||binding.defaultRef,tree=await github.tree(repo,baseBranch);
      destination={baseBranch,commitSha:tree.commitSha,bundlePaths:tree.files.filter(f=>f.path.split('/').at(-1)==='hedgeling-bundle.json').map(f=>f.path),sourceMapPaths:tree.files.filter(f=>f.path.split('/').at(-1)==='hedgeling-source-key-map.json').map(f=>f.path),githubWriteAccess:Boolean(repo.token&&repo.canPush)};
    }
    return {connections:list,imports,importsTruncated:imports.length===100,pullRequests:receipts,destination,uiTarget:jobTarget(p,job.id,name)};
  }
  async function prepare(name,input,auth,scope={},db=database,lock=false){const {p,job}=await load(input,auth,scope,db,'delivery',lock);
    if(job.source_document_id||['queued','running','draft','canceled'].includes(job.status))throw fail(409,'Finish a repository translation job before preparing its PR.','delivery_job_not_ready');
    const locales=selectedLocales(job,input.targetLocales),sources=await currentJobSources(db,p,job,lock),coverage=await jobCoverage(db,job,locales);
    if(coverage.missing||!coverage.total||coverage.rejected||!isAiOnly(job)&&coverage.verified!==coverage.total)throw fail(409,`This selection has ${coverage.missing} missing translations and ${coverage.total-coverage.verified} unverified translations. Complete coverage is required; review workflows also require verification. Human-rejected translations cannot be delivered.`, 'delivery_incomplete');
    if(coverage.total>DELIVERY_LIMITS.translations)throw fail(422,'Narrow delivery to at most 10,000 translations.','delivery_limit');
    const translations=await jobTranslations(db,job,{locales,limit:10001,lock});
    const binding=(await connections(db,p)).rows.find(c=>c.connectionId===input.connectionId);if(!binding)throw fail(403,'Repository is not connected to this project.','connection_denied');
    const repo=await repository(binding,auth,true),tree=await github.tree(repo,input.baseBranch);
    // A named branch is required; a SHA/tag cannot accidentally become the PR base.
    const branch=await github.request(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repository)}/branches/${encodeURIComponent(input.baseBranch)}`,repo.token);
    if(branch.commit?.sha!==tree.commitSha)throw fail(409,'The base branch changed. Request a fresh preview.','delivery_base_changed');
    const extraction=(await db.query('select * from extraction_requests where id=$1 and project_id=$2 and imported_at is not null',[input.extractionId,p.id])).rows[0];
    if(!extraction||extraction.binding.connectionId!==binding.connectionId||Number(extraction.binding.repositoryId)!==repo.id||extraction.request.operation!=='extract'||fingerprint(extraction.binding.allowedRoots)!==fingerprint(binding.allowedRoots))throw fail(409,'Choose an imported extraction from this project and the current repository scope.','delivery_source_unproven');
    const artifact=await engine().artifact(extraction.id);
    if(artifact?.provenance?.commitSha!==tree.commitSha)throw fail(409,'The base branch has changed since extraction. Extract and import its current source before delivery.','delivery_base_changed');
    const state=catalogState(artifact,{commitSha:tree.commitSha,repositoryId:repo.id,sourceLocale:job.source_locale}),entries=state.files['extracted-source'].entries;
    if(sources.some(s=>entries[s.source_hash]?.sourceText!==s.source_text))throw fail(409,'This job includes source strings not proven by the selected extraction. Use a matching current job.','delivery_source_unproven');
    const paths=[...input.bundlePaths,...input.sourceMapPaths];
    if(new Set(paths).size!==paths.length||paths.length>DELIVERY_LIMITS.files||paths.some(p=>!safeSourcePath(p)||!p.endsWith('.json')))throw fail(400,'Select distinct, ordinary runtime JSON files.','delivery_paths_invalid');
    const files=[];for(const path of paths){const entry=tree.files.find(f=>f.path===path);if(!entry)throw fail(409,'The runtime destination must already exist and be wired into the app.','delivery_runtime_missing');
      const original=await github.file(repo,entry,DELIVERY_LIMITS.fileBytes),content=mergeRuntimeFile(original,input.bundlePaths.includes(path)?'bundle':'map',sources,translations);
      if(Buffer.byteLength(content)>DELIVERY_LIMITS.fileBytes)throw fail(422,'A runtime file would exceed 5 MiB.','delivery_limit');
      if(original!==content)files.push({path,mode:entry.mode,oldSha:entry.sha,content,sha256:hash(content)});
    }
    if(!files.length)throw fail(409,'The selected runtime files already contain these translations.','delivery_unchanged');
    if(files.reduce((n,f)=>n+Buffer.byteLength(f.content),0)>DELIVERY_LIMITS.totalBytes)throw fail(422,'Delivery files exceed 12 MiB.','delivery_limit');
    return {organizationId:p.organizationId,p,job,repo,tree,files,locales,translations,baseBranch:input.baseBranch,preview:{action:name,fields:{name:job.name,repository:`${repo.owner}/${repo.repository}`,baseBranch:input.baseBranch,targetLocales:locales,translations:translations.length,workflow:isAiOnly(job)?'AI-only translations':'Verified translations'},resources:{baseCommit:tree.commitSha,extractionId:extraction.id,files:files.map(({path,oldSha,sha256,content})=>({path,oldSha,sha256,bytes:Buffer.byteLength(content)})),contentVersion:fingerprint({translations,sources,binding}),sample:translations.slice(0,10).map(t=>({locale:t.locale,key:t.sourceHash,text:t.text}))},cost:'No model calls. Your repository’s CI may run when the PR opens.',sideEffects:[`Create a new branch and one PR against ${input.baseBranch}. Change only the listed JSON files; preserve other strings and languages.`,isAiOnly(job)?'Deliver AI-only output without claiming human verification.':'Deliver verified translations.', 'Does not merge or deploy. The repository owner reviews and deploys through their normal workflow.','Requires your GitHub user authorization and App Contents/Pull requests write permissions.']}};
  }
  async function apply(name,prepared,proposal,auth,db){let receipt;try{receipt=await publishTranslationPr(github,prepared.repo,prepared,proposal.id);}catch(e){if(e.upstreamStatus===403||e.upstreamStatus===404)throw fail(403,'GitHub rejected this write. Check your push access, App Contents and Pull requests read/write permissions, and the repository installation. Any branch already created will be reused on retry.','delivery_github_required');throw e;}
    await db.query('insert into job_pull_requests(job_id,proposal_id,created_by_user_id,repository_id,receipt) values($1,$2,$3,$4,$5) on conflict(proposal_id) do nothing',[prepared.job.id,proposal.id,auth.user.id,prepared.repo.id,receipt]);
    return {pullRequest:receipt,uiTarget:jobTarget(prepared.p,prepared.job.id,name)};
  }
  return {read,prepare,apply,replay:(input,auth,scope,db)=>load(input,auth,scope,db,'delivery')};
}
