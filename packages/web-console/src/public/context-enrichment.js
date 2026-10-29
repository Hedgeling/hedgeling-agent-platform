// SPDX-License-Identifier: Apache-2.0
const node = (tag,text = '',cls = '') => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
const button = text => { const n = node('button',text); n.type = 'button'; return n; };
const errorText = { context_stale:'The source or accepted guidance changed. Request a fresh analysis.',context_provider_changed:'The provider settings changed. Request a fresh analysis.',context_request_uncertain:'Processing was interrupted. This request will not be retried automatically.',context_result_invalid:'The model returned incomplete or invalid suggestions. No guidance was saved.' };
export const characterSuggestionLabel = result => result.suggestedMaxCharacters == null ? 'No character count suggested.'
  : `Suggested length: ${result.suggestedMaxCharacters} Unicode characters · ${result.suggestionSource === 'formula' ? 'formula estimate' : 'LLM suggestion'} · not enforced`;
function resultCard(result) {
  const card = node('article','','context-suggestion');
  card.append(node('h4',result.source || result.id),node('p',result.description),node('p',`${result.evidence === 'code' ? 'Code evidence' : 'Metadata only'} · ${result.confidence} confidence`,'context-evidence'));
  card.append(node('p',characterSuggestionLabel(result)),node('p',result.limitReason));
  return card;
}
export function contextProgress({ runId,request,onReview }) {
  const root = node('section','','context-progress'), status = node('p','Preparing context analysis…'), results = node('div'), error = node('p','','agent-error');
  root.dataset.contextRunId = runId; status.setAttribute('role','status'); error.setAttribute('role','alert'); root.append(status,results,error);
  async function refresh() {
    if (!root.isConnected) return;
    try {
      const { run } = (await request('/api/actions/context.status',{ runId })).result;
      status.textContent = `${({ queued:'Queued',running:'Writing context',awaiting_review:'Context ready to review',applied:'Context accepted',failed:'Analysis stopped',uncertain:'Result uncertain' })[run.status]} · ${run.strings} strings · ${run.provider} / ${run.model}`;
      results.replaceChildren();
      if (run.error) error.textContent = errorText[run.error] || 'Analysis could not finish. Check provider access and usage limits before requesting a new batch.';
      for (const item of run.results || []) {
        const detail = node('details'); detail.append(node('summary',item.source || item.id),resultCard(item)); results.append(detail);
      }
      if (run.status === 'awaiting_review' && onReview) { const review = button('Review and accept context'); review.onclick = () => Promise.resolve(onReview(run)).catch(e => { error.textContent = e.message; }); results.append(review); }
      if (['queued','running'].includes(run.status)) setTimeout(refresh,2000);
    } catch(e) { error.textContent = e.message; }
  }
  setTimeout(refresh,0); return root;
}
export function contextPanel({ project,request,confirmation,controllerId }) {
  const root = node('details','','context-panel'); root.dataset.projectSlug = project.slug; root.append(node('summary','Context · descriptions and length suggestions'));
  const explanation = node('p','Give translators the meaning behind each string. Review LLM descriptions and suggested lengths before using them. Formula estimates fill gaps when the model has no length suggestion: source +30%, rounded up, with at least 5 extra characters. These targets are not enforced. Explicit limits stay unchanged.');
  const load = button('Browse string context'), generate = button('Preview context enrichment'), next = button('More strings'), runsMore = button('More analyses'); next.hidden = runsMore.hidden = true;
  const listing = node('div'), history = node('div'), progress = node('div'), approval = node('div'), error = node('p','','agent-error'); error.setAttribute('role','alert');
  const chooseHelp = node('p','Select up to 20 strings, or leave the selection empty to analyze the next batch without current accepted context.');
  root.append(explanation,load,chooseHelp,listing,next,generate,approval,error,node('h4','Recent analyses'),history,runsMore,progress);
  let cursor = null, runCursor = null;
  async function propose(action,input,onSaved) {
    error.textContent = ''; generate.disabled = true;
    try {
      const p = (await request(`/api/actions/${action}`,input)).result.proposal;
      const discard = async () => { await request(`/api/agent/proposals/${p.id}/reject`,{}); approval.replaceChildren(); generate.disabled = false; };
      approval.replaceChildren(confirmation(p,{ edit:discard,cancel:discard,confirm:async () => {
        const saved = await request(`/api/agent/proposals/${p.id}/confirm`,{ controllerId,fingerprint:p.fingerprint });
        approval.replaceChildren(); generate.disabled = false; await onSaved(saved.result);
      } }));
    } catch(e) { error.textContent = e.message; generate.disabled = false; }
  }
  function review(run) {
    const selection = node('fieldset'); selection.append(node('legend','Choose context to accept'));
    for (const result of run.results.filter(s => !run.acceptedIds.includes(s.id))) {
      const label = node('label'), check = node('input'); check.type = 'checkbox'; check.value = result.id; check.checked = true; check.setAttribute('aria-label',`Accept context: ${result.source}`);
      label.append(check,resultCard(result)); selection.append(label);
    }
    const save = button('Preview accepting selected context');
    save.onclick = () => {
      const stringIds = [...selection.querySelectorAll('input:checked')].map(n => n.value);
      if (!stringIds.length) { error.textContent = 'Choose at least one suggestion.'; return; }
      void propose('context.apply',{ runId:run.id,stringIds },async () => { progress.replaceChildren(node('p','Context accepted for future translations.')); await browse(true); });
    };
    progress.replaceChildren(selection,save);
  }
  const show = runId => { progress.replaceChildren(contextProgress({ runId,request,onReview:review })); };
  async function runList(reset) {
    if (reset) { runCursor = null; history.replaceChildren(); }
    const r = (await request('/api/actions/context.runs',{ projectSlug:project.slug,...(runCursor ? { cursor:runCursor } : {}) })).result;
    for (const item of r.runs) { const b = button(`${item.status.replaceAll('_',' ')} · ${item.strings} strings · ${new Date(item.createdAt).toLocaleString()}`); b.onclick = () => show(item.id); history.append(b); }
    runCursor = r.page.nextCursor; runsMore.hidden = !runCursor;
  }
  async function browse(reset) {
    error.textContent = ''; load.disabled = next.disabled = true;
    try {
      if (reset) { cursor = null; listing.replaceChildren(); }
      const r = (await request('/api/actions/context.strings',{ projectSlug:project.slug,...(cursor ? { cursor } : {}) })).result;
      for (const s of r.strings) {
        const row = node('label','','context-source'), check = node('input'); check.type = 'checkbox'; check.value = s.id; check.setAttribute('aria-label',`Analyze: ${s.source}`);
        const content = node('span'); content.append(node('strong',s.source),node('span',`${s.codeAvailable ? 'Code excerpt available' : 'Metadata only'} · ${s.current ? 'Accepted context is current' : s.accepted ? 'Context needs refreshing' : 'No accepted context'}`,'context-evidence'));
        if (s.accepted) content.append(node('p',s.accepted.description),node('p',characterSuggestionLabel(s.accepted)));
        if (s.hardLimit != null) content.append(node('span',`Existing enforced limit: ${s.hardLimit}`));
        row.append(check,content); listing.append(row);
      }
      if (reset && !r.strings.length) listing.append(node('p','Import source strings or a document before enriching context.'));
      cursor = r.page.nextCursor; next.hidden = !cursor; if (reset) await runList(true);
    } catch(e) { error.textContent = e.message; } finally { load.disabled = next.disabled = false; }
  }
  generate.onclick = () => {
    const stringIds = [...listing.querySelectorAll('input:checked')].map(n => n.value);
    if (stringIds.length > 20) { error.textContent = 'Choose at most 20 strings per batch.'; return; }
    void propose('context.enrich',{ projectSlug:project.slug,...(stringIds.length ? { stringIds } : {}) },async r => { show(r.contextRun.id); await runList(true); });
  };
  load.onclick = () => browse(true); next.onclick = () => browse(false);
  runsMore.onclick = async () => { runsMore.disabled = true; try { await runList(false); } catch(e) { error.textContent = e.message; } finally { runsMore.disabled = false; } };
  return root;
}
