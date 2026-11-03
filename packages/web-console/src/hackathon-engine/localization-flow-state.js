import { reviewSatisfied } from './job-scope.js';
export function nextLocalizationStep({ choices, context, contextRun, job, quality }) {
  const step = (id, title, description, section) => ({ id, title, description, section });
  if (!context.totalStrings) return step('extract', 'Extract and import source strings', 'Start with a repository extraction and confirm its import.', '02');
  if (!choices.contextChoice && context.needsContext !== 0) return step('context_choice', 'Add context before translating?', 'Enrich missing context with AI, or continue with the context you already have.', '03');
  if (choices.contextChoice === 'enrich' && context.needsContext !== 0) {
    if (contextRun && ['queued', 'running'].includes(contextRun.status)) return step('context_running', 'Context enrichment is running', 'Completed suggestions will need your acceptance before they are used.', '03');
    if (contextRun?.awaitingAcceptance > 0) return step('context_accept', 'Review context suggestions', 'Accept useful suggestions before translation. Character-limit suggestions remain advisory.', '03');
    return step('context_enrich', 'Enrich missing context', contextRun?.error ? 'The previous run stopped. Review its findings before approving another paid request, or choose to continue with existing context.' : 'Preview the selected strings and request budget before starting.', '03');
  }
  if (!choices.workflowPreset) return step('workflow_choice', 'Choose your translation workflow', 'Pick the level of review you want before delivery.', '05');
  if (!job || job.stale) return step('create_job', 'Create a translation draft', job?.stale ? 'The source catalog changed. Create a fresh draft; existing translations are preserved.' : 'Choose the job name and target languages. Creating a draft starts no paid work.', '05');
  if (['queued', 'running'].includes(job.status)) return step('translating', 'Translation is running', 'Saved drafts are preserved. Progress updates do not make model requests.', '05');
  if (job.coverage.missing) return step(job.status === 'draft' ? 'translate' : 'translation_attention', job.status === 'draft' ? 'Start translation' : 'Review missing translations', `${job.coverage.saved} of ${job.coverage.total} translations are saved. ${job.status === 'draft' ? 'Review the provider and budget before confirming.' : 'Inspect the job’s issues before preparing a fresh draft for the remaining pairs.'}`, '05');
  if (job.coverage.rejected) return step('review_findings', 'Resolve rejected translations', 'Open the review console to revise rejected entries before delivery.', '05');
  if (choices.workflowPreset === 'human_review' && !reviewSatisfied(job, job.coverage)) return step('human_review', 'Review translations in the console', `${job.coverage.humanReviewed} of ${job.coverage.total} translations have recorded human review. AI findings cannot complete this step.`, '05');
  if (choices.workflowPreset === 'ai_quality' && !reviewSatisfied(job, job.coverage)) {
    if (quality && ['queued', 'running'].includes(quality.status)) return step('quality_running', 'AI quality check is running', `${quality.checked} of ${quality.total} selected translations checked. Findings do not change or approve text.`, '05');
    if (quality && ['ready', 'applied'].includes(quality.status) && quality.passingUnaccepted > 0) return step('quality_approve', 'Review findings and approve passing results', 'AI checked is not user approved. Inspect the findings, then confirm approval separately.', '05');
    return step('quality_check', 'Check translation quality', quality ? 'Review flagged or outdated results. Changes need a fresh check; no paid retry starts automatically.' : 'One AI check covers meaning, language, terminology, placeholders and hard limits. Preview its budget first.', '05');
  }
  return step('deliver', 'Prepare the translation PR', choices.workflowPreset === 'ai_only' ? 'All translations are present. The PR will describe them as unreviewed AI output.' : 'The selected review requirement is satisfied. Preview delivery; merging and deployment stay separate.', '05');
}
