// SPDX-License-Identifier: Apache-2.0
import { documentExports } from './documents.js';
const node = (tag, text = '', className = '') => { const value = document.createElement(tag); value.textContent = text; value.className = className; return value; };
const names = { draft: 'Draft', queued: 'Queued', running: 'Translating', awaiting_review: 'Drafts ready for review', needs_attention: 'Needs attention', canceled: 'Stopped', completed:'Complete', partially_translated:'Partially translated' };

// Progress uses authenticated reads, never additional model turns.
export function translationJobProgress({ jobId, request, onStop = null, onSettled = null }) {
  const card = node('section', '', 'translation-job-progress'); card.dataset.translationJobId = jobId;
  card.setAttribute('aria-label', 'Translation job progress');
  const title = node('h4', 'Translation job'), status = node('p', 'Checking progress…'), detail = node('p'), error = node('p', '', 'agent-error');
  status.setAttribute('role', 'status'); error.setAttribute('role', 'alert');
  const refresh = node('button', 'Refresh progress'); refresh.type = 'button';
  const review = node('a', 'Open translations to review'); review.hidden = true;
  const stop = node('button', 'Stop job'); stop.type = 'button'; stop.hidden = !onStop;
  card.append(title, status, detail, review, refresh, stop, error);
  let timer, busy = false, exportsAdded = false, settled = false;
  const load = async () => {
    if (busy) return; busy = true; clearTimeout(timer); refresh.disabled = true; error.textContent = '';
    try {
      const { result } = await request('/api/actions/localization_job.status', { jobId });
      const job = result.job, count = job.progress.succeeded || 0;
      if (job.documentId && !exportsAdded) { card.append(documentExports({ job, request })); exportsAdded = true; }
      title.textContent = job.name;
      status.textContent = `${names[job.status] || job.status}${job.batch ? ` · ${count} of ${job.batch.pairs} drafts saved` : ''}`;
      detail.textContent = `${job.workflow}. ${job.coverage ? `${job.coverage.saved} of ${job.coverage.total} translations present · ${job.coverage.missing} missing · ${job.coverage.verified} verified. ` : ''}` + (job.steps.length===1&&job.steps[0]==='machine_translation' ? 'AI-only output has no review, verification or QA step. Opening a PR is separate.' : 'Review, verification and opening a PR are separate actions.');
      if (job.errors.length) error.textContent = job.errors.map(e => `${e.locale}: ${e.message}`).join(' ');
      review.href = `/?project=${encodeURIComponent(job.projectSlug)}#review`; review.hidden = !count;
      review.onclick = async event => { if (window.HedgelingConsole?.openProject) { event.preventDefault(); try { await window.HedgelingConsole.openProject(job.projectSlug, { manual: true }); } catch(e) { error.textContent = e.message; } } };
      stop.hidden = !onStop || !['queued', 'running'].includes(job.status);
      if (['queued', 'running'].includes(job.status)) timer = setTimeout(() => { if (card.isConnected) void load(); }, 2500);
      else if(onSettled&&!settled){settled=true;await onSettled();}
    } catch (e) { error.textContent = e.message; }
    finally { busy = false; refresh.disabled = false; }
  };
  refresh.addEventListener('click', load);
  stop.addEventListener('click', async () => { stop.disabled = true; try { await onStop(jobId); } catch(e) { error.textContent = e.message; } finally { stop.disabled = false; } });
  card.addEventListener('translation-job-refresh', load);
  void load(); return card;
}

export function translationJobControls({ job, request, confirmation, controllerId, onChanged }) {
  const root = node('div', '', 'translation-job-controls');
  const slot = node('div'), error = node('p', '', 'agent-error'); error.setAttribute('role', 'alert');
  const preview = async (action, input) => {
    error.textContent = '';
    const { result } = await request(`/api/actions/${action}`, input);
    const proposal = result.proposal;
    const discard = async () => { await request(`/api/agent/proposals/${proposal.id}/reject`, {}); slot.replaceChildren(); };
    slot.replaceChildren(confirmation(proposal, { edit: discard, cancel: discard,
      confirm: async () => {
        await request(`/api/agent/proposals/${proposal.id}/confirm`, { controllerId, fingerprint: proposal.fingerprint });
        slot.replaceChildren(); await onChanged?.();
        const row=[...document.querySelectorAll('[data-resource-type="job"]')].find(n=>n.dataset.resourceId===job.id);
        const next=row?.querySelector(action==='localization_job.pull_request'?'.job-delivery':'.job-quality');
        if(next&&['localization_job.review','localization_job.verify','localization_job.review_cancel','localization_job.pull_request'].includes(action))next.open=true;
      } }));
    slot.querySelector('h3')?.focus();
  };
  if (job.canStart) {
    const label = node('label', 'Maximum translations in this batch ');
    const maximum = node('input'); maximum.type = 'number'; maximum.min = '1'; maximum.max = '200'; maximum.value = job.documentId ? '200' : '100'; maximum.required = true; maximum.style.width = '5rem';
    label.append(maximum);
    const start = node('button', 'Preview translation start'); start.type = 'button';
    start.addEventListener('click', async () => { if (!maximum.reportValidity()) return; start.disabled = true;
      try { await preview('localization_job.start', { jobId: job.id, maxTranslations: Number(maximum.value) }); } catch(e) { error.textContent = e.message; }
      finally { start.disabled = false; } });
    root.append(label, start);
  }
  if (job.status !== 'draft') root.append(translationJobProgress({ jobId: job.id, request,
    onSettled: ['queued','running'].includes(job.status) ? onChanged : null,
    onStop: job.canStop ? id => preview('localization_job.cancel', { jobId: id }) : null }));
  if(job.status!=='draft')root.append(jobQualityPanel({jobId:job.id,request,onPreview:job.canReview?preview:null}));
  if(job.canDeliver)root.append(jobDeliveryPanel({job,request,onPreview:preview}));
  root.append(slot, error); return root;
}

export function jobQualityPanel({jobId,request,onPreview=null,runId=null,open=false}) {
  const panel=node('details','','translation-job-progress job-quality');panel.open=open;panel.append(node('summary','AI quality check & verification'));
  const body=node('div'),status=node('p','Open to view quality findings.'),results=node('div'),error=node('p','','agent-error');error.setAttribute('role','alert');status.setAttribute('role','status');
  const refresh=node('button','Refresh findings'),more=node('button','More findings'),verify=node('button','Preview verification of passing translations'),cancel=node('button','Stop quality check');for(const b of [refresh,more,verify,cancel])b.type='button';more.hidden=verify.hidden=cancel.hidden=true;
  let currentId=runId,nextOffset=null,timer,busy=false;
  const load=async(append=false)=>{if(busy)return;busy=true;clearTimeout(timer);error.textContent='';refresh.disabled=true;
    try{const {result}=await request('/api/actions/localization_job.review_status',{jobId,...(currentId?{runId:currentId}:{}),offset:append?nextOffset:0});const r=result.qualityRun;
      if(!append)results.replaceChildren();if(!r){status.textContent='No AI quality check yet. Checks produce findings; verification needs your separate confirmation.';return;}
      currentId=r.id;status.textContent=`${r.status} · ${r.checked}/${r.total} checked · ${r.counts.pass} pass · ${r.counts.needs_changes} need changes · ${r.counts.uncertain} uncertain · ${r.accepted} verified from this check. ${r.targetLocales.join(', ')}.`;
      if(r.error)error.textContent=`The check stopped (${r.error}). No translations were automatically verified. Review the saved findings before requesting another check.`;
      for(const finding of r.results){const item=node('details','','job-quality-finding');item.append(node('summary',`${finding.locale} · ${finding.verdict.replaceAll('_',' ')}${finding.accepted?' · verified':''} · ${finding.source}`));item.append(node('p',`Translation: ${finding.translation}`));for(const issue of finding.issues)item.append(node('p',issue));results.append(item);}
      nextOffset=result.page.nextOffset;more.hidden=nextOffset===null;verify.hidden=!onPreview||!['ready','applied'].includes(r.status)||r.counts.pass<=r.accepted;cancel.hidden=!onPreview||!['queued','running'].includes(r.status);
      if(['queued','running'].includes(r.status))timer=setTimeout(()=>{if(panel.isConnected&&panel.open)void load();},2500);
    }catch(e){error.textContent=e.message;}finally{busy=false;refresh.disabled=false;}
  };
  const propose=async(button,action,input)=>{button.disabled=true;try{await onPreview(action,{jobId,...input});}catch(e){error.textContent=e.message;}finally{button.disabled=false;}};
  if(onPreview){const form=node('form'),selection=node('select');selection.setAttribute('aria-label','Translations to check');for(const [value,label]of [['in_review','In review (pending + needs-review)'],['all','All existing translations']]){const option=node('option',label);option.value=value;selection.append(option);}
    const locales=node('input');locales.placeholder='All job languages, or fr-CA, ru-RU';locales.setAttribute('aria-label','Target languages to check');
    const start=node('button','Preview AI quality check');start.type='submit';form.append(selection,locales,start);
    form.addEventListener('submit',event=>{event.preventDefault();const targetLocales=locales.value.split(',').map(s=>s.trim()).filter(Boolean);void propose(start,'localization_job.review',{selection:selection.value,...(targetLocales.length?{targetLocales}:{})});});body.append(form,node('p','Uses your organization’s selected Meta or Gemini key. Up to 1,000 translations per check; narrow the languages for larger jobs. AI-only jobs do not need this optional check.'));
  }
  verify.onclick=()=>propose(verify,'localization_job.verify',{runId:currentId});cancel.onclick=()=>propose(cancel,'localization_job.review_cancel',{runId:currentId});refresh.onclick=()=>{currentId=runId;void load();};more.onclick=()=>load(true);
  body.append(status,results,refresh,more,verify,cancel,error);panel.append(body);panel.addEventListener('toggle',()=>{if(panel.open)void load();else clearTimeout(timer);});return panel;
}

function jobDeliveryPanel({job,request,onPreview}){
  const root=node('details','','translation-job-progress job-delivery');root.append(node('summary','Deliver translations in a GitHub PR'));
  const text=node('p','For repositories already loading Hedgeling runtime bundles. Complete coverage is required for the selected languages. AI-only output remains unreviewed. Opening a PR does not merge or deploy it.'),form=node('form'),error=node('p','','agent-error'),receipts=node('div');error.setAttribute('role','alert');
  const field=(title,input)=>{const label=node('label',title+' ');label.append(input);form.append(label);return input;};
  const connection=field('Repository',node('select')),branch=field('Base branch',node('input')),extraction=field('Imported extraction',node('select')),locales=field('Languages (blank = all)',node('input'));
  const bundles=field('Bundle paths (one per line)',node('textarea')),maps=field('Source-key map paths (one per line)',node('textarea'));branch.required=true;bundles.required=maps.required=true;bundles.rows=maps.rows=2;
  const inspect=node('button','Find runtime files'),submit=node('button','Preview translation PR');inspect.type='button';submit.type='submit';form.append(inspect,submit);let info=null,loaded=false;
  const populateImports=()=>{extraction.replaceChildren();for(const item of info.imports.filter(i=>i.connectionId===connection.value)){const option=node('option',`${item.ref.slice(0,12)} · ${new Date(item.importedAt).toLocaleString()}`);option.value=item.id;extraction.append(option);}extraction.required=true;};
  const discover=async()=>{error.textContent='';inspect.disabled=true;try{const {result}=await request('/api/actions/localization_job.delivery_options',{jobId:job.id,connectionId:connection.value,...(branch.value.trim()?{baseBranch:branch.value.trim()}:{})});branch.value=result.destination.baseBranch;bundles.value=result.destination.bundlePaths.join('\n');maps.value=result.destination.sourceMapPaths.join('\n');if(!result.destination.githubWriteAccess)error.textContent='Connect GitHub with repository push access. The App also needs Contents and Pull requests read/write permissions.';}catch(e){error.textContent=e.message;}finally{inspect.disabled=false;}};
  connection.onchange=()=>{branch.value=info.connections.find(c=>c.connectionId===connection.value)?.defaultRef||'';populateImports();void discover();};inspect.onclick=discover;
  root.addEventListener('toggle',async()=>{if(!root.open||loaded)return;try{const {result}=await request('/api/actions/localization_job.delivery_options',{jobId:job.id});info=result;connection.replaceChildren();for(const c of result.connections){const option=node('option',`${c.owner}/${c.repository}`);option.value=c.connectionId;connection.append(option);}for(const pr of result.pullRequests){const a=node('a',`PR #${pr.number} · ${pr.branch}`);a.href=pr.url;a.target='_blank';a.rel='noopener noreferrer';receipts.append(a);}loaded=true;if(!result.connections.length){error.textContent='Connect a repository to this project first.';return;}connection.onchange();}catch(e){error.textContent=e.message;}});
  form.onsubmit=async event=>{event.preventDefault();submit.disabled=true;error.textContent='';try{const targetLocales=locales.value.split(',').map(s=>s.trim()).filter(Boolean);await onPreview('localization_job.pull_request',{jobId:job.id,connectionId:connection.value,extractionId:extraction.value,baseBranch:branch.value.trim(),bundlePaths:bundles.value.split('\n').map(s=>s.trim()).filter(Boolean),sourceMapPaths:maps.value.split('\n').map(s=>s.trim()).filter(Boolean),...(targetLocales.length?{targetLocales}:{})});}catch(e){error.textContent=e.message;}finally{submit.disabled=false;}};
  root.append(text,receipts,form,error);return root;
}
