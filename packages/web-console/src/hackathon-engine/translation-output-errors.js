// SPDX-License-Identifier: Apache-2.0
// Only completed model output rejected by these checks is an item-level failure.
// Provider, authorization, budget, persistence and input-version errors stop work.
export const TRANSLATION_OUTPUT_ERRORS = Object.freeze({
  job_output_invalid: 'The generated text failed the output check after two attempts. This translation was not saved.',
  job_placeholders_invalid: 'The generated text did not preserve required placeholders after two attempts. This translation was not saved.',
  job_length_invalid: 'The generated text exceeded the hard character limit after two attempts. This translation was not saved.',
  job_glossary_invalid: 'The generated text did not preserve a required glossary term after two attempts. This translation was not saved.',
});
