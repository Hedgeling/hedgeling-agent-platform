// SPDX-License-Identifier: Apache-2.0
import { workflowProgress } from './workflow-progress.js';
import {qualityFailureMessage} from './job-review-messages.js';
import { documentExports } from './documents.js';
import { TRANSLATION_JOB_LIMITS, defaultTranslationBatchSize } from './translation-job-limits.js';
const node = (tag, text = '', className = '') => { const value = document.createElement(tag); value.textContent = text; value.className = className; return value; };
const names = { draft: 'Draft', queued: 'Queued', running: 'Translating', awaiting_review: 'Drafts ready for review', needs_attention: 'Needs attention', canceled: 'Stopped', completed:'Complete', partially_translated:'Partially translated' };

// Progress uses authenticated reads, never additional model turns.
export function translationJobProgress({ jobId, request, onStop = null, onSettled = null }) {
  const card = node('section', '', 'translation-job-progress'); card.dataset.translationJobId = jobId;
  card.setAttribute('aria-label', 'Translation job progress');
  const title = node('h4', 'Translation job'), status = node('p', 'Checking progress…', 'translation-job-state'), detail = node('p'), error = node('p', '', 'agent-error');
  const countLabel = node('p', '', 'translation-job-count'), meter = node('progress', '', 'translation-job-meter');
  meter.setAttribute('aria-label', 'Drafts saved'); meter.hidden = true;
  const activity = node('p', '', 'translation-job-activity'), updated = node('p', '', 'translation-job-updated');
  const notices = node('details', '', 'translation-job-notices'), noticeSummary = node('summary'), noticeBody = node('div');
  notices.append(noticeSummary, noticeBody); notices.hidden = true;
  const announcement = node('p', '', 'translation-job-announcement'); announcement.setAttribute('role', 'status');
  error.setAttribute('role', 'alert');
  const refresh = node('button', 'Refresh progress'); refresh.type = 'button';
  const review = node('a', 'Open translations to review'); review.hidden = true;
  const stop = node('button', 'Stop job'); stop.type = 'button'; stop.hidden = !onStop;
  card.append(title, status, countLabel, meter, activity, updated, notices, detail, review, refresh, stop, error, announcement);
  let timer, busy = false, exportsAdded = false, settled = false, lastActive = false, failures = 0, lastAnnouncement = 0, lastState = '';
  const format = value => Number(value).toLocaleString();
  const schedule = delay => { timer = setTimeout(() => { if (card.isConnected) void load(); }, delay); };
  const load = async () => {
    if (busy) return; busy = true; clearTimeout(timer); refresh.disabled = true; error.textContent = '';
    try {
      const { result } = await request('/api/actions/localization_job.status', { jobId });
      const job = result.job, count = job.progress.succeeded || 0;
      failures = 0; lastActive = ['queued', 'running'].includes(job.status);
      const skipped = job.progress.failed || 0, uncertain = job.progress.uncertain || 0, queued = job.progress.queued || 0, running = job.progress.running || 0;
      if (job.documentId && !exportsAdded) { card.append(documentExports({ job, request })); exportsAdded = true; }
      title.textContent = job.name;
      status.textContent = names[job.status] || job.status;
      card.dataset.jobState = job.status;
      countLabel.hidden = meter.hidden = !job.batch;
      if (job.batch) {
        const total = job.batch.pairs, percent = total ? Math.floor(count / total * 100) : 0;
        countLabel.textContent = `${format(count)} of ${format(total)} drafts saved · ${percent}% saved`;
        meter.max = Math.max(1, total); meter.value = count;
        meter.setAttribute('aria-valuetext', `${format(count)} of ${format(total)} drafts saved${skipped ? `; ${format(skipped)} skipped` : ''}`);
      }
      activity.textContent = lastActive
        ? `${running ? `${format(running)} translating now` : 'Waiting for the next translation'} · ${format(queued)} queued${skipped ? ` · ${format(skipped)} skipped` : ''}. ${skipped ? 'The job is still running. No restart needed.' : 'You can keep working while this runs.'}`
        : job.status === 'needs_attention'
          ? `This pass has ended. ${format(skipped)} failed${uncertain ? ` · ${format(uncertain)} interrupted` : ''}. Saved drafts are preserved. Review the issues below, then create and confirm a new job for the remaining missing translations.`
          : job.status === 'canceled' ? 'The job has stopped. Saved drafts are preserved.' : 'This translation pass has finished.';
      updated.textContent = `Updated ${new Date().toLocaleTimeString()}${lastActive ? ' · Live updates every few seconds' : ''}`;
      notices.hidden = !job.errors.length;
      noticeSummary.textContent = lastActive
        ? `${format(skipped || job.errors.length)} ${skipped === 1 ? 'translation skipped' : 'translations skipped'} — job still running`
        : 'Review translation issues';
      noticeBody.replaceChildren(...job.errors.map(e => node('p', `${e.locale}: ${e.message}`)));
      if (job.errors.length && skipped + uncertain > job.errors.length) noticeBody.append(node('p', `Showing the first ${job.errors.length} issues.`));
      const state = `${job.status}:${skipped}:${uncertain}`;
      if (state !== lastState || Date.now() - lastAnnouncement >= 30000) {
        announcement.textContent = `${status.textContent}. ${countLabel.textContent}${skipped ? `. ${format(skipped)} skipped.` : ''}`;
        lastState = state; lastAnnouncement = Date.now();
      }
      detail.textContent = `${job.workflow}. ${job.coverage ? `${job.coverage.saved} of ${job.coverage.total} translations present · ${job.coverage.missing} missing · ${job.coverage.verified} verified. ` : ''}` + (job.steps.length===1&&job.steps[0]==='machine_translation' ? 'AI-only output has no review, verification or QA step. Opening a PR is separate.' : 'Review, verification and opening a PR are separate actions.');
      review.href = `/?project=${encodeURIComponent(job.projectSlug)}#review`; review.hidden = !count;
      review.onclick = async event => { if (window.HedgelingConsole?.openProject) { event.preventDefault(); try { await window.HedgelingConsole.openProject(job.projectSlug, { manual: true }); } catch(e) { error.textContent = e.message; } } };
      stop.hidden = !onStop || !lastActive;
      if (lastActive) schedule(2500);
      else if(onSettled&&!settled){settled=true;await onSettled();}
    } catch (e) {
      failures += 1;
      const retry = lastActive && failures <= 3;
      status.textContent = 'Progress temporarily unavailable';
      card.dataset.jobState = 'unknown';
      noticeSummary.textContent = 'Translation issues from the last update';
      updated.textContent = 'Live updates interrupted — showing the last received counts.';
      activity.textContent = 'The job may still be running. Check its latest progress before starting another job.';
      error.textContent = `Could not refresh progress. ${retry ? 'Retrying automatically.' : 'Use Refresh progress to try again.'} ${e.message}`;
      if (retry) schedule(5000);
    }
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
    const maximum = node('input'); maximum.type = 'number'; maximum.min = '1'; maximum.max = String(TRANSLATION_JOB_LIMITS.maximumPairs); maximum.value = String(defaultTranslationBatchSize(job.sourceCount, job.targetLocales.length)); maximum.required = true; maximum.style.width = '7rem';
    label.append(maximum);
    const start = node('button', 'Preview translation start'); start.type = 'button';
    start.addEventListener('click', async () => { if (!maximum.reportValidity()) return; start.disabled = true;
      try { await preview('localization_job.start', { jobId: job.id, maxTranslations: Number(maximum.value) }); } catch(e) { error.textContent = e.message; }
      finally { start.disabled = false; } });
    root.append(label, start);
    root.append(node('p', 'One source string in one target language counts as one translation. The default covers the full job up to 10,000 translations with one start approval; existing translations are preserved.'));
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
  const progress=workflowProgress('Translations checked');
  let currentId=runId,nextOffset=null,timer,busy=false;
  const load=async(append=false)=>{if(busy)return;busy=true;clearTimeout(timer);error.textContent='';refresh.disabled=true;
    try{const {result}=await request('/api/actions/localization_job.review_status',{jobId,...(currentId?{runId:currentId}:{}),offset:append?nextOffset:0});const r=result.qualityRun;
      if(!append)results.replaceChildren();if(!r){status.textContent='No AI quality check yet. Checks produce findings; verification needs your separate confirmation.';return;}
      progress.update({state:r.status,title: ['queued','running'].includes(r.status)?'Checking translation quality':['ready','applied'].includes(r.status)?'Quality findings ready':'Quality check stopped',completed:r.checked,total:r.total,unit:'translations checked',detail:`${r.counts.pass} passing · ${r.counts.needs_changes} need changes · ${r.counts.uncertain} uncertain. ${r.accepted} verified after confirmation.`});
      currentId=r.id;status.textContent=`${r.status} · ${r.checked}/${r.total} checked · ${r.counts.pass} pass · ${r.counts.needs_changes} need changes · ${r.counts.uncertain} uncertain · ${r.accepted} verified from this check. ${r.targetLocales.join(', ')}.`;
      if(r.error)error.textContent=qualityFailureMessage(r);
      for(const finding of r.results){const item=node('details','','job-quality-finding');item.append(node('summary',`${finding.locale} · ${finding.verdict.replaceAll('_',' ')}${finding.accepted?' · verified':''} · ${finding.source}`));item.append(node('p',`Translation: ${finding.translation}`));for(const issue of finding.issues)item.append(node('p',issue));results.append(item);}
      nextOffset=result.page.nextOffset;more.hidden=nextOffset===null;verify.hidden=!onPreview||!['ready','applied'].includes(r.status)||r.counts.pass<=r.accepted;cancel.hidden=!onPreview||!['queued','running'].includes(r.status);
      if(['queued','running'].includes(r.status))timer=setTimeout(()=>{if(panel.isConnected&&panel.open)void load();},2500);
    }catch(e){progress.update({state:'unavailable',title:'Quality progress unavailable',detail:'Refresh findings to check the latest status.'});error.textContent=e.message;}finally{busy=false;refresh.disabled=false;}
  };
  const propose=async(button,action,input)=>{button.disabled=true;try{await onPreview(action,{jobId,...input});}catch(e){error.textContent=e.message;}finally{button.disabled=false;}};
  if(onPreview){const form=node('form'),selection=node('select');selection.setAttribute('aria-label','Translations to check');for(const [value,label]of [['in_review','In review (pending + needs-review)'],['all','All existing translations']]){const option=node('option',label);option.value=value;selection.append(option);}
    const locales=node('input');locales.placeholder='All job languages, or fr-CA, ru-RU';locales.setAttribute('aria-label','Target languages to check');
    const start=node('button','Preview AI quality check');start.type='submit';form.append(selection,locales,start);
    form.addEventListener('submit',event=>{event.preventDefault();const targetLocales=locales.value.split(',').map(s=>s.trim()).filter(Boolean);void propose(start,'localization_job.review',{selection:selection.value,...(targetLocales.length?{targetLocales}:{})});});body.append(form,node('p','Uses your organization’s selected Meta or Gemini key. Up to 1,000 translations per check; narrow the languages for larger jobs. AI-only jobs do not need this optional check.'));
  }
  verify.onclick=()=>propose(verify,'localization_job.verify',{runId:currentId});cancel.onclick=()=>propose(cancel,'localization_job.review_cancel',{runId:currentId});refresh.onclick=()=>{currentId=runId;void load();};more.onclick=()=>load(true);
  body.append(progress.root,status,results,refresh,more,verify,cancel,error);panel.append(body);panel.addEventListener('toggle',()=>{if(panel.open)void load();else clearTimeout(timer);});return panel;
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
