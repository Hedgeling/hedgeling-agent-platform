import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSOLE_ACTIONS, validateActionInput, LOCALIZATION_WORKFLOWS } from '@hedgeling/api-contract';
import { nextLocalizationStep } from '../src/hackathon-engine/localization-flow-state.js';
import { reviewSatisfied } from '../src/hackathon-engine/job-scope.js';
test('every shared schema compiles strictly and guided drafts require a defined workflow', () => {
  for (const action of CONSOLE_ACTIONS) assert.doesNotThrow(() => validateActionInput(action, {}), action.name);
  const action = CONSOLE_ACTIONS.find(a => a.name === 'localization_job.create');
  for (const workflowPreset of Object.keys(LOCALIZATION_WORKFLOWS)) assert.equal(validateActionInput(action, { projectSlug: 'test', name: 'Example', targetLocales: ['fr'], workflowPreset }), null);
  assert(validateActionInput(action, { projectSlug: 'test', name: 'Example', targetLocales: ['fr'] }));
});
test('missing context never silently becomes accepted, and failed enrichment remains actionable', () => {
  const state = { choices: { contextChoice: 'enrich' }, context: { totalStrings: 3, needsContext: 3 }, contextRun: { status: 'failed', awaitingAcceptance: 2, error: 'context_result_invalid' } };
  assert.equal(nextLocalizationStep(state).id, 'context_accept');
  state.contextRun.awaitingAcceptance = 0;
  assert.equal(nextLocalizationStep(state).id, 'context_enrich');
  state.choices.contextChoice = 'skip';
  assert.equal(nextLocalizationStep(state).id, 'workflow_choice');
  state.context.totalStrings = 0;
  assert.equal(nextLocalizationStep(state).id, 'extract');
});
test('review gates distinguish legacy approval, AI approval and human review', () => {
  const coverage = { total: 4, verified: 4, userApproved: 3, humanReviewed: 1 };
  assert.equal(reviewSatisfied({ steps: ['machine_translation'], workflow_preset: 'ai_only' }, coverage), true);
  assert.equal(reviewSatisfied({ steps: ['machine_translation', 'qa'], workflow_preset: 'ai_quality' }, coverage), true);
  assert.equal(reviewSatisfied({ steps: ['machine_translation', 'review'], workflow_preset: 'human_review' }, coverage), false);
  assert.equal(reviewSatisfied({ steps: ['machine_translation', 'qa'], workflow_preset: 'ai_quality' }, { ...coverage, userApproved: 0 }), false);
  assert.equal(reviewSatisfied({ steps: ['machine_translation', 'review'] }, coverage), true, 'Legacy workflows keep their original gate');
});
