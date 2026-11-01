// SPDX-License-Identifier: Apache-2.0
// Keep saved analyses intact. Only the read/model view is bounded.
export const CONTEXT_RESULT_LIMITS = Object.freeze({ items: 20, bytes: 65536, sourceCharacters: 1000 });
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function sourceLabel(item) {
  if (typeof item.source !== 'string' || [...item.source].length <= CONTEXT_RESULT_LIMITS.sourceCharacters) return item;
  return { ...item, source: [...item.source].slice(0, CONTEXT_RESULT_LIMITS.sourceCharacters).join('') + '…', sourceTruncated: true };
}
export function contextResultPage(results, offset = 0) {
  const selected = []; let size = 2;
  for (const item of results.slice(offset, offset + CONTEXT_RESULT_LIMITS.items)) {
    const row = sourceLabel(item), length = bytes(row) + 1;
    if (selected.length && size + length > CONTEXT_RESULT_LIMITS.bytes) break;
    selected.push(row); size += length;
  }
  const end = offset + selected.length;
  return { results: selected, page: { offset, total: results.length, nextOffset: end < results.length ? end : null } };
}

// The signed-in console retains the complete proposal and fingerprint. The
// assistant needs counts, budgets and references, not a second bulk review UI.
export function contextChatResult(name, result) {
  if (!result || typeof result !== 'object') return result;
  if (name === 'console_get_context_run' && result.run) {
    const {page,...rest}=result;
    return { ...rest,run:contextRunSummary(result.run) };
  }
  if (name === 'console_list_context_runs' && Array.isArray(result.runs)) return { ...result,runs:result.runs.map(contextRunSummary) };
  if (name === 'console_list_string_context' && Array.isArray(result.strings)) {
    return { page:result.page,uiTarget:result.uiTarget,returnedStrings:result.strings.length,
      details:'Historical browse content omitted. Use context.summary for project totals; use context.inspect only for explicitly requested strings.' };
  }
  const proposal = result.proposal, preview = proposal?.preview;
  if (!['console_propose_context_enrichment','console_propose_context_apply'].includes(name)
    || !['context.enrich','context.apply'].includes(preview?.action) || !Array.isArray(preview.fields?.strings)) return result;
  const { strings, ...fields } = preview.fields;
  const resources = { ...preview.resources };
  if (resources.provider?.batches) {
    const { batches, ...provider } = resources.provider;
    resources.provider = { ...provider, batchCount: batches.length };
  }
  return { ...result, proposal: { ...proposal, preview: { ...preview, resources,
    fields: { ...fields, stringCount: fields.stringCount ?? strings.length },
    details: 'Full string details are in the console approval card. This chat summary is not a replacement for reviewing that card.' } } };
}
function contextRunSummary(run) {
  const {results,acceptedIds,page,...summary}=run;
  const completedStrings=run.completedStrings??results?.length??0,acceptedStrings=run.acceptedStrings??acceptedIds?.length??0;
  return {...summary,completedStrings,acceptedStrings,awaitingAcceptance:run.awaitingAcceptance??completedStrings-acceptedStrings};
}
export function contextChatHistory(history) {
  return history.map(content => ({ ...content, parts: content.parts.map(part => part.functionResponse
    ? { ...part, functionResponse: { ...part.functionResponse, response: contextChatResult(part.functionResponse.name, part.functionResponse.response) } }
    : part) }));
}
