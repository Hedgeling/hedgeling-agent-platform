// SPDX-License-Identifier: Apache-2.0
const node = (tag,text = '',cls = '') => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
const button = text => { const n = node('button',text); n.type = 'button'; return n; };
const errorText = { context_cancelled:'Remaining batches were stopped. Completed suggestions are available for review.',context_stale:'The source or accepted guidance changed. Request a fresh analysis.',context_provider_changed:'The provider settings changed. Request a fresh analysis.',context_prompt_changed:'The analysis format changed. Review saved suggestions, then preview a fresh run.',context_request_uncertain:'Processing was interrupted. This request will not be retried automatically. Completed suggestions are preserved.' };
export function contextFailureMessage(run) {
  if (run.error !== 'context_result_invalid') return errorText[run.error] || 'Analysis could not finish. Check provider access and usage limits before requesting a new batch.';
  const f = run.failure;
  const reasons = { missing_response:'The model returned no text.', response_too_large:'The model reply exceeded the size limit.',
    invalid_json:'The model reply was not valid JSON.', invalid_shape:'The model reply did not have the required result structure.',
    invalid_item:'A suggestion did not have the required structure.', unknown_item:'A suggestion did not match a selected string.',
    duplicate_item:'The model returned the same string more than once.', invalid_description:'A suggestion had no usable description.',
    invalid_confidence:'A suggestion used an unsupported confidence value.', invalid_limit_reason:'A suggestion had no usable length explanation.',
    invalid_character_suggestion:'A suggestion had an invalid character count.', existing_hard_limit:'A suggestion tried to replace an existing character limit.' };
  const detail = f?.reason === 'item_count_mismatch' ? `The model returned ${f.receivedItems} suggestions; ${f.expectedItems} were required.`
    : ['description_too_long','limit_reason_too_long'].includes(f?.reason) ? `Suggestion ${f.itemIndex} exceeded its ${f.maximumCharacters}-character ${f.reason === 'description_too_long' ? 'description' : 'length explanation'} limit (${f.receivedCharacters} returned).`
    : reasons[f?.reason] || 'The previous run did not record a detailed validation reason.';
  const saved = run.completedStrings ?? run.results?.length ?? 0;
  return `${f?.batch ? `Batch ${f.batch} stopped. ` : 'A batch returned invalid suggestions. '}${detail} Remaining batches stopped. `+
    (saved ? `${saved} suggestions from completed batches are saved. Review and accept those you want before starting another run, so they are not generated again.` : 'No suggestions were saved. A new run makes new provider requests.');
}
export const characterSuggestionLabel = result => result.suggestedMaxCharacters == null ? 'No character count suggested.'
  : `Suggested length: ${result.suggestedMaxCharacters} Unicode characters · ${result.suggestionSource === 'formula' ? 'formula estimate' : 'LLM suggestion'} · not enforced`;
function resultCard(result) {
  const card = node('article','','context-suggestion');
  card.append(node('h4',result.source || result.id),node('p',result.description),node('p',`${result.evidence === 'code' ? 'Code evidence' : 'Metadata only'} · ${result.confidence} confidence`,'context-evidence'));
  card.append(node('p',characterSuggestionLabel(result)),node('p',result.limitReason));
  return card;
}
export function contextProgress({ runId,request,onReview,onStop }) {
  const root = node('section','','context-progress'), status = node('p','Preparing context analysis…'), results = node('div'), error = node('p','','agent-error');
  root.dataset.contextRunId = runId; status.setAttribute('role','status'); error.setAttribute('role','alert'); root.append(status,results,error);
  let busy = false, nextOffset = null;
  const more = button('More suggestions'); more.hidden = true; root.append(more);
  async function refresh(append = false) {
    if (!root.isConnected) return;
    if (busy) return; busy = true; more.disabled = true;
    try {
      const { run, page } = (await request('/api/actions/context.status',{ runId, offset: append ? nextOffset : 0 })).result;
      status.textContent = `${({ queued:'Queued',running:'Writing context',awaiting_review:'Context ready to review',applied:'Context accepted',failed:'Analysis stopped',uncertain:'Result uncertain' })[run.status]} · ${run.completedStrings ?? run.results.length} / ${run.strings} strings · ${run.completedRequests ?? 0} / ${run.requests ?? 1} requests completed · ${run.provider} / ${run.model}`;
      if (!append) results.replaceChildren();
      results.querySelectorAll('[data-context-control]').forEach(n => n.remove());
      error.textContent = run.error ? contextFailureMessage(run) : '';
      for (const item of run.results || []) {
        const detail = node('details'); detail.append(node('summary',item.source || item.id),resultCard(item)); results.append(detail);
      }
      nextOffset = page?.nextOffset ?? null; more.hidden = nextOffset === null;
      if (['awaiting_review','failed','uncertain'].includes(run.status) && (run.completedStrings ?? run.results.length) > run.acceptedIds.length && onReview) { const review = button('Review and accept context'); review.dataset.contextControl = ''; review.onclick = async () => { review.disabled = true; try { await onReview(run); } catch(e) { error.textContent = e.message; } finally { review.disabled = false; } }; results.append(review); }
      if (['queued','running'].includes(run.status) && onStop) { const stop = button('Stop remaining batches'); stop.dataset.contextControl = ''; stop.onclick = () => Promise.resolve(onStop(run)).catch(e => { error.textContent = e.message; }); results.append(stop); }
      if (['queued','running'].includes(run.status)) setTimeout(refresh,2000);
    } catch(e) { error.textContent = e.message; }
    finally { busy = false; more.disabled = false; }
  }
  more.onclick = () => refresh(true);
  setTimeout(refresh,0); return root;
}
export function contextPanel({ project,request,confirmation,controllerId }) {
  const root = node('details','','context-panel'); root.dataset.projectSlug = project.slug; root.append(node('summary','Context · descriptions and length suggestions'));
  const explanation = node('p','Give translators the meaning behind each string. Review LLM descriptions and suggested lengths before using them. Formula estimates fill gaps when the model has no length suggestion: source +30%, rounded up, with at least 5 extra characters. These targets are not enforced. Explicit limits stay unchanged.');
  const load = button('Browse string context'), generate = button('Preview context enrichment'), generateAll = button('Preview all missing context'), next = button('More strings'), runsMore = button('More analyses'); next.hidden = runsMore.hidden = true;
  const listing = node('div'), history = node('div'), progress = node('div'), approval = node('div'), error = node('p','','agent-error'); error.setAttribute('role','alert');
  const chooseHelp = node('p','Select up to 1,000 strings, leave the selection empty for the next 20, or preview all missing context. One approval covers the displayed request budget; requests run in batches of up to 20 strings.');
  root.append(explanation,load,chooseHelp,listing,next,generate,generateAll,approval,error,node('h4','Recent analyses'),history,runsMore,progress);
  let cursor = null, runCursor = null;
  async function propose(action,input,onSaved) {
    error.textContent = ''; generate.disabled = generateAll.disabled = true;
    try {
      const p = (await request(`/api/actions/${action}`,input)).result.proposal;
      const discard = async () => { await request(`/api/agent/proposals/${p.id}/reject`,{}); approval.replaceChildren(); generate.disabled = generateAll.disabled = false; };
      approval.replaceChildren(confirmation(p,{ edit:discard,cancel:discard,confirm:async () => {
        const saved = await request(`/api/agent/proposals/${p.id}/confirm`,{ controllerId,fingerprint:p.fingerprint });
        approval.replaceChildren(); generate.disabled = generateAll.disabled = false; await onSaved(saved.result);
      } }));
    } catch(e) { error.textContent = e.message; generate.disabled = generateAll.disabled = false; }
  }
  async function review(run) {
    // The browser can review every saved suggestion without putting them all
    // into the assistant's request. Nothing is accepted by these paged reads.
    const all = []; let offset = 0;
    do {
      const result = (await request('/api/actions/context.status',{runId:run.id,offset})).result;
      run = result.run; all.push(...run.results); offset = result.page?.nextOffset ?? null;
    } while (offset !== null);
    const selection = node('fieldset'); selection.append(node('legend','Choose context to accept'));
    for (const result of all.filter(s => !run.acceptedIds.includes(s.id))) {
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
  const show = runId => { progress.replaceChildren(contextProgress({ runId,request,onReview:review,
    onStop:run => propose('context.cancel',{runId:run.id},async () => { show(run.id); await runList(true); }) })); };
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
    if (stringIds.length > 1000) { error.textContent = 'Choose at most 1,000 strings per run.'; return; }
    void propose('context.enrich',{ projectSlug:project.slug,...(stringIds.length ? { stringIds } : {}) },async r => { show(r.contextRun.id); await runList(true); });
  };
  generateAll.onclick = () => propose('context.enrich',{ projectSlug:project.slug,allMissing:true },async r => { show(r.contextRun.id); await runList(true); });
  load.onclick = () => browse(true); next.onclick = () => browse(false);
  runsMore.onclick = async () => { runsMore.disabled = true; try { await runList(false); } catch(e) { error.textContent = e.message; } finally { runsMore.disabled = false; } };
  return root;
}
