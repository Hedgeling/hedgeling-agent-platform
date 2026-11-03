import { jobReview } from './job-workflows-integration.js';
import { nextLocalizationStep } from './hackathon-engine/localization-flow-state.js';
import { LOCALIZATION_WORKFLOWS } from '@hedgeling/api-contract';
import { query } from './db.js';
import { projectPermissions } from './authorization.js';
import { contextEnrichment } from './context-integration.js';
import { jobCoverage } from './hackathon-engine/job-scope.js';
import { fail } from './action-errors.js';

const target = p => ({ view: 'workspace', organizationId: p.organizationId, projectSlug: p.slug,
  action: 'localization_flow.get', resource: { type: 'project', id: p.id } });
const defaults = { contextChoice: null, workflowPreset: null, jobId: null, revision: 0 };

async function load(input, auth, scope = {}, db = { query }, manage = false, lock = false) {
  if (auth?.principalType !== 'user' || !(await db.query("select 1 from users where id=$1 and status='active'", [auth.user?.id])).rowCount) throw fail(403, 'An active named user is required.', 'flow_access_denied');
  const p = (await db.query(`select p.id,p.slug,p.name,p.source_locale as "sourceLocale",p.business_unit_id as "businessUnitId",b.organization_id as "organizationId"
    from projects p join business_units b on b.id=p.business_unit_id where p.slug=$1 and p.data_purged_at is null${lock ? ' for update of p' : ''}`, [input.projectSlug])).rows[0];
  if (!p) throw fail(404, 'Project not found.');
  if (Object.hasOwn(scope, 'organizationId') && scope.organizationId !== p.organizationId) throw fail(403, 'Choose this project’s workspace first.', 'agent_scope_mismatch');
  const actor = { ...auth, executionType: 'agent', platformAdmin: false, user: { ...auth.user, platformStaff: false } };
  const permissions = await projectPermissions(actor, p);
  if (!['strings.view', 'jobs.view', 'translations.view', ...(manage ? ['projects.manage'] : [])].every(key => permissions.includes(key)))
    throw fail(403, 'Project-wide source, job and translation access is required. Saving a workflow also requires project management.', 'flow_access_denied');
  const choices = (await db.query(`select context_choice as "contextChoice",workflow_preset as "workflowPreset",job_id as "jobId",revision
    from localization_flows where project_id=$1`, [p.id])).rows[0] || { ...defaults };
  return { p, choices, canManage: permissions.includes('projects.manage') };
}
async function read(input, auth, scope = {}) {
  const { p, choices, canManage } = await load(input, auth, scope);
  const { counts: context, freshnessComplete } = await contextEnrichment.read('context.summary', input, auth, scope);
  const contextRun = (await query(`select id,status,error_code as error,jsonb_array_length(snapshot) as strings,jsonb_array_length(results) as "completedStrings",jsonb_array_length(results)-cardinality(accepted_ids) as "awaitingAcceptance"
    from context_enrichment_runs where project_id=$1 order by created_at desc,id desc limit 1`, [p.id])).rows[0] || null;
  let job = null, quality = null, lastPullRequest = null;
  if (choices.jobId) {
    const row = (await query('select * from localization_jobs where id=$1 and project_id=$2', [choices.jobId, p.id])).rows[0];
    if (row) {
      const current = (await query(`select count(*)::int as total,count(*) filter(where snap.value->>'source_hash'=s.source_hash and snap.value->>'source_text'=s.source_text)::int as matching
        from source_strings s left join jsonb_array_elements($2::jsonb) snap(value) on snap.value->>'id'=s.id::text where s.project_id=$1`, [p.id, JSON.stringify(row.source_snapshot)])).rows[0];
      job = { id: row.id, name: row.name, status: row.status, steps: row.steps, targetLocales: row.target_locales, workflow_preset: row.workflow_preset,
        stale: row.source_locale !== p.sourceLocale || current.total !== row.source_snapshot.length || current.matching !== current.total || row.workflow_preset !== choices.workflowPreset,
        coverage: await jobCoverage({ query }, row) };
      quality = await jobReview.summary({ jobId: row.id }, auth, scope);
      lastPullRequest = (await query('select receipt from job_pull_requests where job_id=$1 order by created_at desc,id desc limit 1', [row.id])).rows[0]?.receipt || null;
    }
  }
  const targetLocales = (await query('select locale from locales where project_id=$1 and enabled=true order by locale', [p.id])).rows.map(row => row.locale).filter(locale => locale !== p.sourceLocale);
  const state = { choices, context, contextRun, job, quality };
  return { flow: { projectSlug: p.slug, projectName: p.name, canManage, targetLocales, ...state, freshnessComplete,
    next: nextLocalizationStep(state), lastPullRequest }, uiTarget: target(p) };
}
async function prepare(name, input, auth, scope, db, lock = false) {
  const { p, choices } = await load(input, auth, scope, db, true, lock);
  if (input.revision !== choices.revision) throw fail(409, 'The saved workflow changed. Refresh before preparing a new preview.', 'flow_stale');
  const next = { ...choices, ...Object.fromEntries(['contextChoice', 'workflowPreset', 'jobId'].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])) };
  if (next.workflowPreset !== choices.workflowPreset && !Object.hasOwn(input, 'jobId')) next.jobId = null;
  if (next.jobId) {
    const job = (await db.query('select workflow_preset from localization_jobs where id=$1 and project_id=$2', [next.jobId, p.id])).rows[0];
    if (!job || job.workflow_preset !== next.workflowPreset) throw fail(400, 'Select a job in this project with the same workflow preset.', 'flow_job_invalid');
  }
  return { organizationId: p.organizationId, p, next, uiTarget: target(p), preview: { action: name,
    fields: { project: p.name, contextChoice: next.contextChoice, workflow: LOCALIZATION_WORKFLOWS[next.workflowPreset]?.label || 'Not chosen', jobId: next.jobId },
    resources: { revision: choices.revision, previous: choices }, cost: 'No model requests or paid work.',
    sideEffects: ['Save these choices for this project across chats and refreshes.', 'Each enrichment, translation, approval and PR still needs its own preview and confirmation. Existing jobs are unchanged.'] } };
}
async function apply(name, { p, next }, proposal, auth, db) {
  const row = (await db.query(`insert into localization_flows(project_id,context_choice,workflow_preset,job_id,updated_by_user_id)
    values($1,$2,$3,$4,$5) on conflict(project_id) do update set context_choice=excluded.context_choice,workflow_preset=excluded.workflow_preset,
    job_id=excluded.job_id,revision=localization_flows.revision+1,updated_by_user_id=excluded.updated_by_user_id,updated_at=now() returning revision`,
  [p.id, next.contextChoice, next.workflowPreset, next.jobId, auth.user.id])).rows[0];
  return { workflow: { projectSlug: p.slug, ...next, revision: row.revision }, uiTarget: target(p) };
}
export const localizationFlow = { read, prepare, apply, replay: (input, auth, scope, db) => load(input, auth, scope, db, true) };
