import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { localConsole, eventually } from "../test-support/local-console.mjs";
import { createServiceCredential } from "../src/service-accounts.js";

test("workspace edits require current authority and exact previews, preserve identity and source, and work through MCP", { skip: process.env.HEDGELING_REQUIRE_AGENT_TEST_DATABASE !== "true" }, async (t) => {
  const app = await localConsole(process.env.TEST_DATABASE_URL); t.after(app.close);
  const { request, database } = app;
  const controllerId = crypto.randomUUID();
  const call = async (name, input) => { const r = await request(`/api/actions/${name}`, input); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.result; };
  const confirm = (proposal) => request(`/api/agent/proposals/${proposal.id}/confirm`, { controllerId, fingerprint: proposal.fingerprint });
  const save = async (proposal) => { const r = await confirm(proposal); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const p = (await database.query(`select p.id,p.slug,p.name,p.source_locale,b.id as unit,b.organization_id as org from projects p join business_units b on b.id=p.business_unit_id where p.slug='hedgeling-local'`)).rows[0];
  const userId = (await request("/api/me")).body.auth.user.id;
  await database.query("insert into locales(project_id,locale) values($1,'fr'),($1,'de') on conflict(project_id,locale) do update set enabled=true", [p.id]);
  const snapshot = [{ id: crypto.randomUUID(), source_text: "Hello", source_hash: "fixture-source" }];
  const job = (await database.query(`insert into localization_jobs(project_id,name,source_locale,target_locales,steps,source_snapshot)
    values($1,'Launch','en',array['fr'],array['review'],$2) returning id`, [p.id, JSON.stringify(snapshot)])).rows[0];
  const org = (await database.query("select id,name,slug from organizations where id=$1", [p.org])).rows[0];
  const proposed = (await call("organization.update", { organizationId: p.org, name: "Updated workspace" })).proposal;
  assert.deepEqual(proposed.preview.changes, [{ field: "name", label: "Name", before: org.name, after: "Updated workspace" }]);
  assert.equal((await database.query("select name from organizations where id=$1", [p.org])).rows[0].name, org.name);
  assert.equal((await request(`/api/agent/proposals/${proposed.id}/confirm`, { controllerId, fingerprint: "wrong" })).status, 409);
  assert.equal((await save(proposed)).result.organization.slug, org.slug);
  assert.equal((await save(proposed)).replayed, true);
  assert.equal((await database.query("select count(*)::int as n from audit_events where action='organization.update.confirmed'")).rows[0].n, 1);
  const business = (await call("business_unit.update", { businessUnitId: p.unit, name: "Growth" })).proposal;
  await save(business);
  assert.equal((await database.query("select business_unit_id from projects where id=$1", [p.id])).rows[0].business_unit_id, p.unit);
  const a = (await call("project.update", { projectSlug: p.slug, name: "Website" })).proposal;
  const b = (await call("project.update", { projectSlug: p.slug, name: "Conflicting name" })).proposal;
  const renamed = await save(a); assert.equal(renamed.result.project.slug, p.slug);
  assert.equal((await confirm(b)).status, 409);
  assert.equal((await request("/api/actions/project.update", { projectSlug: p.slug, name: "Website" })).status, 400);
  assert.equal((await database.query("select source_locale from projects where id=$1", [p.id])).rows[0].source_locale, p.source_locale);
  const draft = (await call("localization_job.update", { jobId: job.id, name: "Autumn launch", targetLocales: ["de", "fr"], steps: ["machine_translation", "review", "qa"] })).proposal;
  assert.equal(draft.preview.changes.length, 3);
  const saved = await save(draft); assert.equal(saved.result.job.id, job.id);
  assert.deepEqual((await database.query("select source_snapshot from localization_jobs where id=$1", [job.id])).rows[0].source_snapshot, snapshot);
  assert.equal((await save(draft)).replayed, true);
  for (const patch of [{ jobId: job.id }, { jobId: job.id, name: " " }, { jobId: job.id, targetLocales: ["es"] }, { jobId: job.id, steps: [] }, { jobId: job.id, name: "New", sourceLocale: "ru" }]) {
    assert.equal((await request("/api/actions/localization_job.update", patch)).status, 400);
  }
  const before = (await database.query("select before_state from audit_events where action='localization_job.update.confirmed'")).rows[0].before_state;
  assert.equal(before.name, "Launch"); assert.deepEqual(before.targetLocales, ["fr"]);
  const expired = (await call("localization_job.update", { jobId: job.id, name: "Expired edit" })).proposal;
  await database.query("update agent_proposals set expires_at=now()-interval '1 minute' where id=$1", [expired.id]);
  assert.equal((await confirm(expired)).status, 409);
  const rejected = (await call("project.update", { projectSlug: p.slug, name: "Discarded edit" })).proposal;
  assert.equal((await request(`/api/agent/proposals/${rejected.id}/reject`, {})).status, 200);
  assert.equal((await confirm(rejected)).status, 409);
  const privateOrg = (await database.query("insert into organizations(name,slug) values('Private','private-edit') returning id")).rows[0].id;
  assert.equal((await request("/api/actions/organization.update", { organizationId: privateOrg, name: "Blocked" })).status, 403);

  // An actual fixture turn discovers the project through MCP, then proposes an edit.
  const run = (await request("/api/agent/runs", { organizationId: p.org, controllerId })).body.run;
  await request(`/api/agent/runs/${run.id}/messages`, { controllerId, text: 'Rename project "Website" to "Marketing website"' });
  const pending = await eventually(() => request(`/api/agent/runs/${run.id}`), (r) => r.body.run?.status === "awaiting_confirmation", 20000);
  assert.equal(pending.body.proposals.length, 1);
  assert.equal(pending.body.proposals[0].preview.action, "project.update");
  assert.equal((await database.query("select name from projects where id=$1", [p.id])).rows[0].name, "Website");
  await save(pending.body.proposals[0]);
  await request(`/api/agent/runs/${run.id}/continue`, { controllerId });
  const finished = await eventually(() => request(`/api/agent/runs/${run.id}`), (r) => r.body.run?.status === "awaiting_input", 20000);
  assert.ok(finished.body.events.some((e) => e.data.text?.includes("Saved your confirmed changes")));
  assert.equal((await database.query("select count(*)::int as n from localization_jobs")).rows[0].n, 1);
  // Repeating names must elicit a choice rather than choosing an arbitrary record.
  await database.query("insert into projects(business_unit_id,slug,name) values($1,'duplicate-1','Duplicate'),($1,'duplicate-2','Duplicate')", [p.unit]);
  const choiceRun = (await request("/api/agent/runs", { organizationId: p.org, controllerId })).body.run;
  assert.equal((await request(`/api/agent/runs/${choiceRun.id}/messages`, { controllerId, text: 'Rename project "Duplicate" to "Renamed"' })).status, 200);
  const ambiguous = await eventually(() => request(`/api/agent/runs/${choiceRun.id}`), (r) => r.body.run?.status === "awaiting_input", 20000);
  assert.ok(ambiguous.body.events.some((e) => e.data.text?.includes("Several items")));
  assert.equal(ambiguous.body.proposals.length, 0);

  const service = (await database.query("insert into service_accounts(organization_id,name) values($1,'Edit boundary test') returning id", [p.org])).rows[0].id;
  const credential = createServiceCredential();
  await database.query("insert into service_account_credentials(service_account_id,token_prefix,token_digest) values($1,$2,$3)", [service, credential.prefix, credential.digest]);
  assert.equal((await request("/api/actions/project.update", { projectSlug: p.slug, name: "Machine write" }, { cookie: "", authorization: `Bearer ${credential.token}` })).status, 403);
  // A French-only editor cannot reveal or remove the German part of a job.
  await database.query("update role_assignments set revoked_at=now() where principal_id=$1 and scope_id=$2", [userId, p.org]);
  const role = (await database.query("insert into roles(key,name,organization_id) values('draft_editor','Draft editor',$1) returning id", [p.org])).rows[0].id;
  await database.query("insert into role_permissions(role_id,permission_id) select $1,id from permissions where key in ('strings.view','jobs.view','jobs.update')", [role]);
  await database.query(`insert into role_assignments(principal_type,principal_id,role_id,scope_type,scope_id,conditions)
    values('user',$1,$2,'project',$3,'{"locales":["fr"]}')`, [userId, role, p.id]);
  assert.equal((await request("/api/actions/localization_job.update", { jobId: job.id, targetLocales: ["fr"] })).status, 403);
  assert.equal((await request("/api/actions/project.update", { projectSlug: p.slug, name: "Denied rename" })).status, 403);
  await database.query("update localization_jobs set target_locales=array['fr'] where id=$1", [job.id]);
  assert.equal((await call("localization_jobs.list", { projectSlug: p.slug })).jobs[0].canEdit, true);
  const restricted = (await call("localization_job.update", { jobId: job.id, name: "French launch" })).proposal;
  await save(restricted);
  const revoked = (await call("localization_job.update", { jobId: job.id, name: "Revoked edit" })).proposal;
  await database.query("delete from role_permissions where role_id=$1 and permission_id=(select id from permissions where key='jobs.update')", [role]);
  assert.equal((await confirm(revoked)).status, 403);
  assert.equal((await call("localization_jobs.list", { projectSlug: p.slug })).jobs[0].canEdit, false);
  assert.equal((await database.query("select name from localization_jobs where id=$1", [job.id])).rows[0].name, "French launch");
});
