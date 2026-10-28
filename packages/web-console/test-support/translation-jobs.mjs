import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { localConsole, eventually } from './local-console.mjs';
import { metaProvider } from './meta-provider.mjs';
const manualController = crypto.randomUUID();
export async function setupTranslationJobs(t, count = 3, environment = {}) {
  const meta = await metaProvider(); t.after(meta.close);
  const app = await localConsole(process.env.TEST_DATABASE_URL, { ...meta.env,
    HEDGELING_AI_KEY_ID: 'test', HEDGELING_AI_KEYRING: JSON.stringify({ test: crypto.randomBytes(32).toString('base64') }), ...environment }); t.after(app.close);
  const { request, database } = app;
  const org = (await request('/api/agent/config')).body.organizations[0].id;
  const account = (await database.query('insert into billing_accounts(organization_id) values($1) returning id', [org])).rows[0].id;
  await database.query("insert into subscriptions(billing_account_id,plan_id,state,current_period_start,current_period_end) select $1,id,'active',now(),now()+interval '1 month' from product_plans where key='business-v1'", [account]);
  for (const payload of [{ action: 'connect', provider: 'meta', key: 'synthetic.translation.job.key-1234' }, { action: 'translation_mode', mode: 'byok', provider: 'meta' }]) {
    const base = `/api/access/organizations/${org}/ai-providers`;
    const proposal = (await request(`${base}/preview`, payload)).body.proposal;
    assert.equal((await request(`${base}/proposals/${proposal.id}/confirm`, {})).status, 200);
  }
  const project = (await database.query("insert into projects(name,slug,business_unit_id,source_locale) select 'Translation test','translation-test',business_unit_id,'en' from projects where slug='hedgeling-local' returning id,slug", [])).rows[0];
  await database.query("insert into locales(project_id,locale) values($1,'fr')", [project.id]);
  const sources = [];
  for (let n = 0; n < count; n++) sources.push((await database.query("insert into source_strings(project_id,source_hash,source_text) values($1,$2,'Hello {name}') returning id", [project.id, `test-${n}`])).rows[0].id);
  await database.query("insert into prompts(project_id,key,label,body,active) values($1,'voice','Voice','Use concise library guidance.',true)", [project.id]);
  await database.query("insert into personas(project_id,locale,body) values($1,'fr','{\"tone\":\"Formal and warm\"}')", [project.id]);
  await database.query("insert into glossary_terms(project_id,term,locale,translation,active) values($1,'Hello','fr','Bonjour',true)", [project.id]);
  const confirm = async proposal => {
    const result = await request(`/api/agent/proposals/${proposal.id}/confirm`, { fingerprint: proposal.fingerprint, controllerId: manualController });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  };
  const preview = async (action, input) => {
    const result = await request(`/api/actions/${action}`, input);
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.result.proposal;
  };
  const draft = async (name = 'French launch') => (await confirm(await preview('localization_job.create', { projectSlug: project.slug, name, targetLocales: ['fr'], steps: ['machine_translation', 'review'] }))).result.job;
  const status = async jobId => (await request('/api/actions/localization_job.status', { jobId })).body.result?.job;
  const done = jobId => eventually(() => status(jobId), j => j && ['awaiting_review', 'needs_attention', 'canceled'].includes(j.status), 15000);
  return { ...app, meta, org, project, sources, confirm, preview, draft, status, done };
}
