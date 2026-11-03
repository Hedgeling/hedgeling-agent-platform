// Shared definitions for tools, server enforcement and browser choices.
export const LOCALIZATION_WORKFLOWS = Object.freeze({
  ai_only: { label: 'AI translation only', steps: ['machine_translation'], description: 'Fastest path. AI drafts are delivered unreviewed.' },
  ai_quality: { label: 'AI translation + quality check', steps: ['machine_translation', 'qa'], description: 'AI checks language and technical constraints. You approve passing results separately; findings do not rewrite translations.' },
  human_review: { label: 'AI translation + human review', steps: ['machine_translation', 'review'], description: 'A person reviews and approves translations in the console before delivery. More oversight, more time.' },
});
