// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { fail } from './errors.js';
import { tuningConfigPath } from './tuning-config.js';
export const SOURCE_LIMITS = Object.freeze({ files: 100, bytes: 5 * 1024 * 1024, fileBytes: 1024 * 1024, treeEntries: 100000, page: 100, excerptBytes: 16384 });
const SHA = /^[a-f0-9]{40}$/;
const extensions = /\.(?:[cm]?[jt]sx?|vue|svelte|html?|json|mdx?|astro|cs|xaml)$/i;
export function repositoryUrl(value) {
  let u; try { u = new URL(value); } catch { throw fail(400, 'Enter a GitHub repository URL, such as https://github.com/owner/repo.', 'repository_url_invalid'); }
  const match = /^\/([a-z\d-]{1,100})\/([\w.-]{1,100})\/?$/i.exec(u.pathname);
  if (u.protocol !== 'https:' || u.host !== 'github.com' || u.username || u.password || u.search || u.hash || !match) throw fail(400, 'Use an HTTPS github.com repository URL without a branch, credentials or query parameters.', 'repository_url_invalid');
  const repository = match[2].replace(/\.git$/, '');
  if (['.','..',''].includes(repository)) throw fail(400, 'Invalid repository name.');
  return { owner: match[1], repository, url: `https://github.com/${match[1]}/${repository}` };
}
export const safeSourcePath = path => typeof path === 'string' && path.length <= 512 && !/[\\\x00-\x1f\x7f:*?\[\]{}]/.test(path)
  && path.split('/').every(p => p && !p.startsWith('.') && !/^(?:node_modules|vendor|dist|build|coverage|credentials|secrets?)(?:\.|$)/i.test(p));
const within = (path, roots) => roots.some(root => path === root || path.startsWith(root + '/'));
export function recommendRoots(files, description = '') {
  const words = [...new Set(description.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !['the','only','want','scan','repo','strings','that','relate','with','from','this','game'].includes(w)))].slice(0,12);
  const ranked = files.map(f => ({ path:f.path, score: words.reduce((n,w) => n + Number(f.path.toLowerCase().includes(w)),0) })).filter(f => f.score).sort((a,b) => b.score-a.score || a.path.localeCompare(b.path));
  return ranked.slice(0,20).map(f => f.path);
}
export function githubSource({ fetchImpl = fetch } = {}) {
  async function request(path, token, { body, maximumBytes = 2 * 1024 * 1024, signal = AbortSignal.timeout(30000) } = {}) {
    let response;
    try { response = await fetchImpl('https://api.github.com' + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'hedgeling-console', ...(token ? {Authorization:`Bearer ${token}`} : {}) }, ...(body ? {body:JSON.stringify(body)} : {}) }); }
    catch { throw fail(502, 'GitHub could not be reached.', 'github_unavailable'); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429 || response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))) throw fail(429, 'GitHub’s request limit was reached. Try later or connect your GitHub account.', 'github_rate_limit');
      if ([401,403,404].includes(response.status)) throw Object.assign(fail(403, 'Repository or branch unavailable. Check the URL, connect GitHub, and grant the App access to this repository.', 'github_access_required'), { upstreamStatus: response.status });
      throw fail(502, 'GitHub could not complete this request.', 'github_unavailable');
    }
    let bytes=0; const parts=[];
    for await (const part of response.body) { bytes+=part.length; if(bytes>maximumBytes) throw fail(422,'GitHub response is too large.','github_response_limit'); parts.push(part); }
    try { return JSON.parse(Buffer.concat(parts).toString()); } catch { throw fail(502,'Invalid GitHub response.','github_response_invalid'); }
  }
  const base = repo => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repository)}`;
  async function resolve(url, getToken) {
    const name=repositoryUrl(url); let token=await getToken?.()||null, repo;
    try { repo=await request(base(name),token); }
    catch(e) { if(e.upstreamStatus!==401||!token)throw e; token=null; repo=await request(base(name)); }
    if (!Number.isSafeInteger(repo.id) || typeof repo.private !== 'boolean' || typeof repo.default_branch !== 'string') throw fail(502,'Invalid repository metadata.','github_response_invalid');
    if(repo.private && !token)throw fail(403,'Connect GitHub to read this private repository.','github_access_required');
    return { ...name, id:repo.id, visibility:repo.private?'private':'public', defaultRef:repo.default_branch, canPush:repo.permissions?.push===true, token };
  }
  async function tree(repo, ref) {
    if(typeof ref!=='string'||!ref||ref.length>200||/[\x00-\x20\x7f]/.test(ref))throw fail(400,'Choose a branch, tag or commit.','repository_ref_invalid');
    const commit=await request(`${base(repo)}/commits/${encodeURIComponent(ref)}`,repo.token);
    if(!SHA.test(commit.sha)||!SHA.test(commit.commit?.tree?.sha)||SHA.test(ref)&&ref!==commit.sha)throw fail(502,'Invalid GitHub revision.','github_response_invalid');
    const tree=await request(`${base(repo)}/git/trees/${commit.commit.tree.sha}?recursive=1`,repo.token,{maximumBytes:32*1024*1024});
    if(tree.truncated||!Array.isArray(tree.tree)||tree.tree.length>SOURCE_LIMITS.treeEntries)throw fail(422,'GitHub returned a truncated or oversized tree. Complete scope discovery is unavailable.','repository_tree_limit');
    const files=tree.tree.filter(f=>safeSourcePath(f.path)&&extensions.test(f.path)&&f.type==='blob'&&['100644','100755'].includes(f.mode));
    if(files.some(f=>!SHA.test(f.sha)||!Number.isSafeInteger(f.size)||f.size<0)||new Set(files.map(f=>f.path)).size!==files.length)throw fail(502,'Invalid source tree.','github_response_invalid');
    return {commitSha:commit.sha,treeSha:commit.commit.tree.sha, files:files.sort((a,b)=>a.path.localeCompare(b.path)), configurationEntries:tree.tree.filter(f=>tuningConfigPath(f.path))};
  }
  async function file(repo, entry, maximumBytes = SOURCE_LIMITS.fileBytes) {
    if(entry.size>maximumBytes)throw fail(422,'This file is too large for this operation.','repository_file_limit');
    const blob=await request(`${base(repo)}/git/blobs/${entry.sha}`,repo.token,{maximumBytes:maximumBytes*2+4096});
    if(blob.encoding!=='base64'||typeof blob.content!=='string')throw fail(502,'Invalid GitHub file.','github_response_invalid');
    const bytes=Buffer.from(blob.content,'base64');
    if(bytes.length!==entry.size||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==entry.sha)throw fail(502,'Source file integrity check failed.','source_integrity');
    let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw fail(422,'Source files must be UTF-8 text.','source_encoding');}
    if(content.includes('\0'))throw fail(422,'Binary files are not supported.','source_encoding');
    return content;
  }
  function select(tree, roots) {
    if(!Array.isArray(roots)||!roots.length||roots.length>20||!roots.every(safeSourcePath))throw fail(400,'Choose 1–20 literal repository-relative files or folders.','repository_roots_invalid');
    const files=tree.files.filter(f=>within(f.path,roots));const bytes=files.reduce((n,f)=>n+f.size,0);
    if(roots.some(r=>!files.some(f=>within(f.path,[r]))))throw fail(400,'Every selected path must contain supported source files.','repository_empty_root');
    if(files.length>SOURCE_LIMITS.files||bytes>SOURCE_LIMITS.bytes||files.some(f=>f.size>SOURCE_LIMITS.fileBytes))throw fail(422,'Narrow the scan to at most 100 files, 1 MiB each and 5 MiB total.','repository_source_limit');
    return {files,bytes};
  }
  async function snapshot(repo, ref, roots) {
    const t=await tree(repo,ref), selected=select(t,roots), files=[];let index=0;
    await Promise.all(Array.from({length:Math.min(6,selected.files.length)},async()=>{while(index<selected.files.length){const entry=selected.files[index++];files.push({path:entry.path,blobSha:entry.sha,content:await file(repo,entry)});}}));
    return {commitSha:t.commitSha,bytes:selected.bytes,files:files.sort((a,b)=>a.path.localeCompare(b.path))};
  }
  async function branches(repo,page=1){if(!Number.isSafeInteger(page)||page<1||page>10000)throw fail(400,'Invalid branch page.');const list=await request(`${base(repo)}/branches?per_page=50&page=${page}`,repo.token);if(!Array.isArray(list))throw fail(502,'Invalid branch list.');return{branches:list.map(b=>({name:b.name,commitSha:b.commit?.sha})),nextPage:list.length===50?page+1:null};}
  return {request,resolve,tree,file,select,snapshot,branches};
}
