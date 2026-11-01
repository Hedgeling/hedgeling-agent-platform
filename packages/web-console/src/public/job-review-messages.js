// SPDX-License-Identifier: Apache-2.0
export function qualityFailureMessage(run) {
  const failure=run.failure;
  const reasons={missing_response:'The model returned no text.',response_too_large:'The model reply exceeded the size limit.',
    invalid_json:'The model reply was not valid JSON.',invalid_shape:'The model reply did not have the required result structure.',
    invalid_item:'A result had unexpected fields.',unknown_item:'A result did not match a selected translation.',duplicate_item:'The model returned the same translation more than once.',
    invalid_verdict:'A result had an unsupported verdict.',invalid_issues:'A result had missing or invalid issue explanations.',
    verdict_issues_mismatch:'A verdict did not agree with its issue explanations.'};
  const detail=failure?.reason==='item_count_mismatch'?`The model returned ${failure.receivedItems} results; ${failure.expectedItems} were required.`:reasons[failure?.reason];
  return `The check stopped (${run.error}).${detail?` ${failure.batch?`Batch ${failure.batch}: `:''}${detail}`:''} No translations were automatically verified. `+
    (run.checked>0?`${run.checked} findings from completed batches were saved. Review them before requesting another check.`:'No findings were saved. A new check makes new provider requests.');
}
