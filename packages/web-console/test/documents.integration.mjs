import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTranslationJobs as setup } from '../test-support/translation-jobs.mjs';
import { eventually } from '../test-support/local-console.mjs';
const options = { skip: process.env.HEDGELING_REQUIRE_AGENT_TEST_DATABASE !== 'true' };
const controllerId = crypto.randomUUID();
async function upload(a, filename = 'welcome.md', text = 'Hello {name}\n\nWelcome {name}') {
  const r = await fetch(`${a.origin}/api/documents/upload?project=${a.project.slug}`, { method: 'POST',
    headers: { origin: a.origin, cookie: a.cookie, 'content-type': 'application/octet-stream', 'x-document-name': encodeURIComponent(filename) }, body: text });
  return { status: r.status, body: await r.json() };
}
const action = (a, name, input) => a.request(`/api/actions/${name}`, input);
const draft = async (a, id) => (await a.confirm(await a.preview('documents.job', { documentId: id, name: 'Document French', targetLocales: ['fr'] }))).result.job;

test('document upload → preview → confirmed scoped job → translations → downloadable drafts; no unrelated work', options, async t => {
  const a = await setup(t, 3), uploaded = await upload(a);
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const id = uploaded.body.document.id;
  assert.equal((await upload(a)).body.document.id, id);
  assert.equal((await a.database.query('select count(*)::int n from source_strings where project_id=$1', [a.project.id])).rows[0].n, 3);
  assert.equal(a.meta.calls.length, 0);
  const details = (await action(a, 'documents.get', { documentId: id })).body.result;
  assert.equal(details.sections.length, 2); assert.match(details.document.warnings.join(' '), /no OCR|not guaranteed/);
  const proposal = await a.preview('documents.job', { documentId: id, name: 'Document French', targetLocales: ['fr'] });
  assert.equal(proposal.preview.resources.sourceCount, 2);
  const both = await Promise.all([a.confirm(proposal), a.confirm(proposal)]);
  assert.equal(both.filter(r => r.replayed).length, 1);
  const job = both[0].result.job;
  assert.equal((await a.database.query('select count(*)::int n from localization_jobs')).rows[0].n, 1);
  // Adding unrelated content must neither invalidate this job nor enter it.
  await a.database.query("insert into source_strings(project_id,source_hash,source_text) values($1,'unrelated-new','Never translate me')", [a.project.id]);
  const start = await a.preview('localization_job.start', { jobId: job.id });
  assert.equal(start.preview.resources.batch.pairs, 2); assert.equal(a.meta.calls.length, 0);
  await a.confirm(start); assert.equal((await a.done(job.id)).status, 'awaiting_review');
  assert.equal(a.meta.calls.length, 2);
  assert.equal((await a.database.query('select count(*)::int n from translations where source_string_id=any($1::uuid[])', [a.sources])).rows[0].n, 0);
  const input = { jobId: job.id, locale: 'fr', format: 'csv', status: 'approved' };
  assert.equal((await action(a, 'documents.export', input)).body.code, 'document_export_incomplete');
  const exported = (await action(a, 'documents.export', { ...input, status: 'drafts' })).body.result.files[0];
  const response = await fetch(a.origin + exported.href, { headers: { cookie: a.cookie } });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/);
  const csv = await response.text(); assert.match(csv, /Bonjour/); assert.match(csv, /draft/); assert.doesNotMatch(csv, /Never translate me/);
  const anon = await fetch(a.origin + exported.href, { redirect: 'manual' }); assert.notEqual(anon.status, 200);
  await a.database.query("update translations set human_status='verified' where source_string_id in (select id from source_strings where project_id=$1 and source_hash like 'document:%')", [a.project.id]);
  assert.equal((await fetch(a.origin + exported.href, { headers: { cookie: a.cookie } })).status, 409);
  assert.equal((await action(a, 'documents.export', input)).status, 200);
});

test('document scope, revocation, malformed input, and stale source previews fail safely', options, async t => {
  const a = await setup(t, 0), uploaded = await upload(a), id = uploaded.body.document.id;
  assert.equal((await upload(a, 'script.js')).status, 400);
  assert.equal((await upload(a, 'many.md', 'Text\n\n'.repeat(201))).status, 400);
  assert.equal((await action(a, 'documents.job', { documentId: id, name: 'Wrong locale', targetLocales: ['ru'] })).status, 400);
  const p = await a.preview('documents.job', { documentId: id, name: 'Stale', targetLocales: ['fr'] });
  await a.database.query("update projects set source_locale='de' where id=$1", [a.project.id]);
  assert.equal((await a.request(`/api/agent/proposals/${p.id}/confirm`, { controllerId, fingerprint: p.fingerprint })).status, 409);
  assert.equal((await a.database.query('select count(*)::int n from localization_jobs')).rows[0].n, 0);
  await a.database.query("update projects set source_locale='en' where id=$1", [a.project.id]);
  const job = await draft(a, id);
  await a.database.query("update source_strings set source_text='Changed' where project_id=$1", [a.project.id]);
  assert.equal((await action(a, 'localization_job.start', { jobId: job.id })).body.code, 'job_source_changed');
  assert.equal(a.meta.calls.length, 0);
  await a.database.query('update role_assignments set revoked_at=now() where principal_id=(select created_by_user_id from uploaded_documents where id=$1)', [id]);
  await a.database.query("update organization_memberships set status='suspended'");
  assert.equal((await action(a, 'documents.get', { documentId: id })).status, 403);
  assert.equal((await action(a, 'documents.export', { jobId: job.id, locale: 'fr', format: 'txt', status: 'drafts' })).status, 403);
});

test('MCP exposes the same document tools; pagination and CSV formula protection remain server-side', options, async t => {
  const a = await setup(t, 0), uploaded = await upload(a, 'formula.md', '=SUM(A1:A2)\n\nHello {name}'), id = uploaded.body.document.id;
  const list = await action(a, 'documents.list', { projectSlug: a.project.slug }); assert.equal(list.body.result.documents[0].id, id);
  const job = await draft(a, id);
  await a.database.query(`insert into translations(source_string_id,locale,text,source,human_status)
    select id,'fr','+DANGEROUS()','mt','pending' from source_strings where project_id=$1`, [a.project.id]);
  const result = await action(a, 'documents.export', { jobId: job.id, locale: 'fr', format: 'csv', status: 'drafts' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const csv = await (await fetch(a.origin + result.body.result.files[0].href, { headers: { cookie: a.cookie } })).text();
  assert.match(csv, /'=SUM/); assert.match(csv, /'\+DANGEROUS/);
  // Exercise the actual in-process MCP adapter via a synthetic chat provider.
  const run = (await a.request('/api/agent/runs', { organizationId: a.org, controllerId })).body.run;
  await a.request(`/api/agent/runs/${run.id}/messages`, { controllerId, text: `Export draft CSV for document job ${job.id}` });
  const ready = await eventually(() => a.request(`/api/agent/runs/${run.id}`), r => r.body.run?.status === 'awaiting_input');
  assert(ready.body.events.some(event => event.kind === 'files' && event.data.files[0].filename.endsWith('.csv')));
});
