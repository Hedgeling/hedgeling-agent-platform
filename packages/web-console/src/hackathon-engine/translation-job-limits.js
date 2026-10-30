// SPDX-License-Identifier: Apache-2.0
// Shared by the server, API/MCP contract and browser controls. A pair is one
// source string in one target locale, not one model request containing the job.
export const TRANSLATION_JOB_LIMITS = Object.freeze({
  defaultPairs: 10000,
  maximumPairs: 10000,
  promptBytes: 65536,
  outputTokens: 2048,
  attempts: 2,
});

export function defaultTranslationBatchSize(sourceCount, localeCount) {
  const pairs = sourceCount * localeCount;
  return Number.isSafeInteger(pairs) && pairs > 0
    ? Math.min(pairs, TRANSLATION_JOB_LIMITS.maximumPairs)
    : TRANSLATION_JOB_LIMITS.defaultPairs;
}
