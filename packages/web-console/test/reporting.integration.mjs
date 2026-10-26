import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServiceCredential } from "../src/service-accounts.js";
import { localConsole, eventually } from "../test-support/local-console.mjs";

test("pagination and organization reports cover more than 100 records without leaking project or locale access", { skip: process.env.HEDGELING_REQUIRE_AGENT_TEST_DATABASE !== "true" }, async (t) => {
  const app = await localConsole(process.env.TEST_DATABASE_URL); t.after(app.close);
  const { database, request } = app;
  const invoke = async (name, input) => {
    const response = await request(`/api/actions/${name}`, input);
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.result;
  };
  const userId = (await request("/api/me")).body.auth.user.id;
  const original = (await database.query(`select p.id,p.slug,p.business_unit_id as unit,b.organization_id as org from projects p join business_units b on b.id=p.business_unit_id where p.slug='hedgeling-local'`)).rows[0];
  await database.query(`insert into business_units(organization_id,slug,name) select $1,'unit-'||n,'Unit '||n from generate_series(1,125) n`, [original.org]);
  await database.query(`insert into projects(business_unit_id,slug,name,source_locale) select $1,'project-'||n,'Project '||n,'en' from generate_series(1,125) n`, [original.unit]);
  await database.query(`insert into localization_jobs(project_id,name,source_locale,target_locales,steps,source_snapshot,created_at)
    select $1,'Job '||n,'en',case when n%2=0 then array['fr','de'] else array['fr'] end,array['review'],'[{"source_text":"Hello"}]'::jsonb,
    '2026-01-01T00:00:00.123456Z'::timestamptz from generate_series(1,137) n`, [original.id]);
  // One job in every other project makes account totals differ from any one page/project.
  await database.query(`insert into localization_jobs(project_id,name,source_locale,target_locales,steps)
    select id,'Launch','en',array['fr'],array['review'] from projects where slug like 'project-%'`);
  const collect = async (name, input, key) => {
    const rows = []; let cursor;
    do { const page = await invoke(name, { ...input, ...(cursor ? { cursor } : {}) }); rows.push(...page[key]); cursor = page.page.nextCursor; assert.equal(page.page.hasMore, Boolean(cursor)); } while (cursor);
    assert.equal(new Set(rows.map((row) => row.id || row.slug || row.key)).size, rows.length);
    return rows;
  };
  assert.equal((await collect("projects.list", { organizationId: original.org, limit: 31 }, "projects")).length, 126);
  assert.equal((await invoke("projects.list", { organizationId: original.org, search: "project-125" })).projects.length, 1);
  const workspace = await invoke("workspace.get", { organizationId: original.org, limit: 100 });
  assert.equal(workspace.projects.length, 100); assert.equal(workspace.businessUnits.length, 100);
  const remaining = await invoke("workspace.get", { organizationId: original.org, limit: 100, projectCursor: workspace.pages.projects.nextCursor, businessUnitCursor: workspace.pages.businessUnits.nextCursor });
  assert.equal(remaining.projects.length, 26); assert.equal(remaining.businessUnits.length, 26);
  assert.equal((await collect("localization_jobs.list", { projectSlug: original.slug, limit: 23 }, "jobs")).length, 137);
  const first = await invoke("localization_jobs.list", { projectSlug: original.slug, limit: 25 });
  assert.equal(first.page.total, 137);
  assert.equal((await request("/api/actions/localization_jobs.list", { projectSlug: original.slug, limit: 25, targetLocale: "de", cursor: first.page.nextCursor })).status, 400);
  const allJobs = await collect("localization_jobs.list", { organizationId: original.org, limit: 100 }, "jobs");
  assert.equal(allJobs.length, 262);
  const overview = await invoke("reports.workspace.summary", { organizationId: original.org });
  assert.deepEqual(overview.metrics, { projects: 126, businessUnits: 126, jobs: 262, projectsWithJobs: 126, jobSourceStrings: 137 });
  assert.equal(overview.coverage.complete, true);
  const summary = await invoke("reports.jobs.summary", { organizationId: original.org, groupBy: "project", limit: 100 });
  assert.equal(summary.totals.jobs, 262); assert.equal(summary.groups.length, 100); assert.equal(summary.page.total, 126); assert.equal(summary.page.hasMore, true);
  assert.equal((await collect("reports.jobs.summary", { organizationId: original.org, groupBy: "project", limit: 50 }, "groups")).length, 126);
  const locales = await invoke("reports.jobs.summary", { organizationId: original.org, groupBy: "target_locale" });
  assert.equal(locales.totals.jobs, 262); assert.deepEqual(Object.fromEntries(locales.groups.map((g) => [g.key, g.jobs])), { de: 68, fr: 262 });
  const filtered = await invoke("reports.jobs.summary", { organizationId: original.org, targetLocale: "de", createdBefore: "2026-01-02T00:00:00Z" });
  assert.equal(filtered.totals.jobs, 68);
  assert.equal((await invoke("reports.jobs.summary", { organizationId: original.org, search: "nothing matches" })).totals.jobs, 0);
  assert.equal((await request("/api/actions/reports.jobs.summary", { organizationId: original.org, createdFrom: "2026-02-31T00:00:00Z" })).status, 400);
  // The organization formerly at position 101 must remain discoverable and usable.
  const orgs = (await database.query(`insert into organizations(slug,name) select 'org-'||n,'Organization '||n from generate_series(1,105) n returning id`)).rows;
  await database.query(`insert into organization_memberships(organization_id,user_id,status) select unnest($1::uuid[]),$2,'active'`, [orgs.map((o) => o.id), userId]);
  await database.query(`insert into role_assignments(principal_type,principal_id,role_id,scope_type,scope_id,inherit_to_children)
    select 'user',$1,r.id,'organization',o,true from roles r cross join unnest($2::uuid[]) o where r.key='organization_owner' and r.organization_id is null`, [userId, orgs.map((o) => o.id)]);
  const listed = await collect("organizations.list", { limit: 40 }, "organizations"); assert.equal(listed.length, 106);
  const lastOrg = listed.at(-1).id;
  assert.equal((await request("/api/agent/runs", { organizationId: lastOrg, controllerId: crypto.randomUUID() })).status, 201);
  const deniedOrg = (await database.query("insert into organizations(slug,name) values('private','Private') returning id")).rows[0].id;
  assert.equal((await request("/api/actions/reports.jobs.summary", { organizationId: deniedOrg })).status, 403);
  assert.equal((await request("/api/actions/localization_jobs.list", { organizationId: deniedOrg, projectSlug: original.slug })).status, 403);
  // Real in-process MCP sends the organization report, rather than enumerating projects.
  const controllerId = crypto.randomUUID();
  const run = (await request("/api/agent/runs", { organizationId: original.org, controllerId })).body.run;
  await request(`/api/agent/runs/${run.id}/messages`, { controllerId, text: "Give me an account overview" });
  await eventually(() => request(`/api/agent/runs/${run.id}`), (r) => r.body.run?.status === "awaiting_input", 20000);
  const history = (await database.query("select model_history from agent_runs where id=$1", [run.id])).rows[0].model_history;
  const report = history.flatMap((h) => h.parts).find((p) => p.functionResponse?.name === "console_report_workspace").functionResponse.response;
  assert.equal(report.metrics.jobs, 262);
  // Restrict this person to French jobs in just one project. The first 100 raw
  // records contain mixed locales; paging/counting must happen after access.
  await database.query("update role_assignments set revoked_at=now() where principal_id=$1 and scope_id=$2", [userId, original.org]);
  const role = (await database.query("insert into roles(key,name,organization_id) values('report_reader','Report reader',$1) returning id", [original.org])).rows[0].id;
  await database.query("insert into role_permissions(role_id,permission_id) select $1,id from permissions where key in ('strings.view','jobs.view')", [role]);
  await database.query(`insert into role_assignments(principal_type,principal_id,role_id,scope_type,scope_id,conditions) values('user',$1,$2,'project',$3,'{"locales":["fr"]}')`, [userId, role, original.id]);
  const service = (await database.query("insert into service_accounts(organization_id,name) values($1,'Reporting integration') returning id", [original.org])).rows[0].id;
  const credential = createServiceCredential();
  await database.query("insert into service_account_credentials(service_account_id,token_prefix,token_digest) values($1,$2,$3)", [service, credential.prefix, credential.digest]);
  await database.query(`insert into role_assignments(principal_type,principal_id,role_id,scope_type,scope_id,conditions) values('service_account',$1,$2,'project',$3,'{"locales":["fr"]}')`, [service, role, original.id]);
  const bearer = { authorization: `Bearer ${credential.token}`, cookie: "" };
  const machineReport = await request("/api/actions/reports.jobs.summary", { organizationId: original.org }, bearer);
  assert.equal(machineReport.status, 200, JSON.stringify(machineReport.body)); assert.equal(machineReport.body.result.totals.jobs, 69);
  assert.equal((await request("/api/actions/reports.jobs.summary", { organizationId: deniedOrg }, bearer)).status, 403);
  assert.equal((await request("/api/actions/localization_jobs.list", { projectSlug: original.slug, limit: 25, cursor: first.page.nextCursor }, bearer)).status, 400);
  const limited = await invoke("reports.jobs.summary", { organizationId: original.org, groupBy: "target_locale" });
  assert.equal(limited.totals.jobs, 69); assert.deepEqual(limited.groups.map((g) => g.key), ["fr"]);
  assert.equal((await collect("localization_jobs.list", { organizationId: original.org, limit: 17 }, "jobs")).length, 69);
  assert.equal((await invoke("localization_jobs.list", { organizationId: original.org, targetLocale: "de" })).page.total, 0);
  assert.equal((await invoke("reports.workspace.summary", { organizationId: original.org })).metrics.projects, 1);
  // Existing cursors confer no access; every continuation reapplies current grants.
  const continued = await invoke("localization_jobs.list", { projectSlug: original.slug, limit: 25, cursor: first.page.nextCursor });
  assert.equal(continued.page.total, 69); assert.ok(continued.jobs.every((j) => j.targetLocales.length === 1));
  // Job access remains independent of catalog access for custom reporting roles.
  await database.query("delete from role_permissions where role_id=$1 and permission_id=(select id from permissions where key='strings.view')", [role]);
  assert.equal((await invoke("localization_jobs.list", { projectSlug: original.slug })).page.total, 69);
  assert.equal((await invoke("reports.jobs.summary", { organizationId: original.org })).totals.jobs, 69);
  const jobsOnlyService = await request("/api/actions/reports.jobs.summary", { organizationId: original.org }, bearer);
  assert.equal(jobsOnlyService.status, 200, JSON.stringify(jobsOnlyService.body)); assert.equal(jobsOnlyService.body.result.totals.jobs, 69);
  assert.equal((await request("/api/actions/localization_jobs.list", { organizationId: deniedOrg }, bearer)).status, 403);
  await database.query("update organization_memberships set status='suspended' where user_id=$1 and organization_id=$2", [userId, original.org]);
  assert.equal((await request("/api/actions/reports.workspace.summary", { organizationId: original.org })).status, 403);
  assert.equal((await request("/api/actions/localization_jobs.list", { projectSlug: original.slug, limit: 25, cursor: first.page.nextCursor })).status, 403);
});
