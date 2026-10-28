import { query } from "./db.js";
import { organizationPermissions, projectPermissions, listAccessibleProjects } from "./authorization.js";
import { fail } from "./action-errors.js";
import { pageRows, pageSize, cursorBinding, readCursor, nextCursor } from "./pagination.js";

export function enforceReadScope(organizationId, context) {
  if (Object.hasOwn(context, "organizationId") && context.organizationId !== organizationId) throw fail(403, "Start a conversation in the selected organization before using this action", "agent_scope_mismatch");
}
export async function accessibleOrganizations(auth, organizationId = null) {
  const projects = await listAccessibleProjects(auth);
  const ids = projects.map((p) => p.organizationId).filter(Boolean);
  const rows = (await query(`select distinct o.id,o.name,o.slug from organizations o
    left join organization_memberships m on m.organization_id=o.id and m.user_id=$1
    where o.status='active' and ($4::uuid is null or o.id=$4)
      and ((m.status='active' and (m.expires_at is null or m.expires_at>now())) or o.id=any($2::uuid[]) or o.id=$3)
    order by o.name,o.id`, [auth.user?.id || null, ids, auth.serviceAccount?.organizationId || null, organizationId])).rows;
  const visible = [];
  for (const row of rows) {
    const permissions = await organizationPermissions(auth, row.id);
    if (permissions.length || ids.includes(row.id)) visible.push({ ...row, permissions });
  }
  return visible;
}
export async function readOrganization(auth, organizationId, context = {}) {
  enforceReadScope(organizationId, context);
  const organization = (await accessibleOrganizations(auth, organizationId))[0];
  if (!organization) throw fail(403, "Organization is not accessible");
  return organization;
}
export async function workspaceRows(auth, organizationId, context = {}) {
  const organization = await readOrganization(auth, organizationId, context);
  const visible = (await listAccessibleProjects(auth)).filter((p) => p.organizationId === organizationId);
  const projects = (await query(`select p.id,p.name,p.slug,p.source_locale as "sourceLocale",p.business_unit_id as "businessUnitId",
    coalesce((select array_agg(locale order by locale) from locales where project_id=p.id and enabled=true),'{}') as "targetLocales"
    from projects p where p.slug=any($1::text[]) order by p.id`, [visible.map((p) => p.slug)])).rows;
  const businessUnits = (await query(`select id,name,slug from business_units where organization_id=$1 and status='active'
    and ($2::boolean or id=any($3::uuid[])) order by id`, [organizationId, organization.permissions.includes("organization.view"), projects.map((p) => p.businessUnitId)])).rows;
  return { organization, projects, businessUnits };
}
export async function readWorkspace(auth, input, context) {
  const data = await workspaceRows(auth, input.organizationId, context);
  const projects = pageRows(data.projects, { organizationId: input.organizationId, limit: input.limit, cursor: input.projectCursor }, auth, "workspace.projects");
  const units = pageRows(data.businessUnits, { organizationId: input.organizationId, limit: input.limit, cursor: input.businessUnitCursor }, auth, "workspace.business_units");
  for (const p of projects.items) {
    const permissions = await projectPermissions(auth, { ...p, organizationId: input.organizationId }, { allowUnknownLocale: true });
    p.canCreateJob = permissions.includes("jobs.create") && permissions.includes("strings.view");
    p.canViewJobs = permissions.includes("jobs.view");
    const unscoped = await projectPermissions(auth, { ...p, organizationId: input.organizationId });
    p.canEdit = unscoped.includes("projects.manage");
    p.canManageLocales = unscoped.includes("locales.manage");
    if (!p.canManageLocales) {
      const visibleLocales = [];
      for (const locale of p.targetLocales) if ((await projectPermissions(auth, { ...p, organizationId: input.organizationId }, { locale })).includes("locales.view")) visibleLocales.push(locale);
      p.targetLocales = visibleLocales;
    }
    p.canExtract = unscoped.includes('imports.run') && unscoped.includes('strings.view');
  }
  return { organization: data.organization, projects: projects.items, businessUnits: units.items, pages: { projects: projects.page, businessUnits: units.page } };
}
export async function listProjects(auth, input, context = {}, list = listAccessibleProjects) {
  if (input.organizationId) enforceReadScope(input.organizationId, context);
  let projects = await list(auth);
  const organizationId = Object.hasOwn(context, "organizationId") ? context.organizationId : input.organizationId;
  if (organizationId !== undefined) projects = projects.filter((p) => p.organizationId === organizationId);
  if (input.search) projects = projects.filter((p) => `${p.name || ""} ${p.slug}`.toLowerCase().includes(input.search.toLowerCase()));
  if (input.businessUnitId) {
    const slugs = new Set((await query("select slug from projects where business_unit_id=$1", [input.businessUnitId])).rows.map((p) => p.slug));
    projects = projects.filter((p) => slugs.has(p.slug));
  }
  const result = pageRows(projects, { ...input, organizationId }, auth, "projects.list", (p) => p.slug);
  return { projects: result.items, page: result.page };
}
function validateDates(input) {
  for (const name of ["createdFrom", "createdBefore"]) {
    if (input[name] && (!Number.isFinite(Date.parse(input[name])) || new Date(input[name]).toISOString().slice(0, 10) !== input[name].slice(0, 10))) throw fail(400, "Use a valid UTC timestamp for date filters", "action_input_invalid");
  }
  if (input.createdFrom && input.createdBefore && Date.parse(input.createdFrom) >= Date.parse(input.createdBefore)) throw fail(400, "createdFrom must be before createdBefore", "action_input_invalid");
}
// Build a permission relation BEFORE filtering, counting, grouping, or paging.
// Each locale in a multi-locale job must be visible, matching the detail API.
export async function jobQueryScope(auth, input, context = {}) {
  validateDates(input);
  let organizationId = input.organizationId;
  if (input.projectSlug) {
    const project = (await query(`select b.organization_id from projects p join business_units b on b.id=p.business_unit_id
      where p.slug=$1 and p.data_purged_at is null`, [input.projectSlug])).rows[0];
    if (!project) throw fail(404, "Project not found");
    if (organizationId && organizationId !== project.organization_id) throw fail(403, "Project is outside the requested organization");
    organizationId = project.organization_id;
  }
  enforceReadScope(organizationId, context);
  const candidates = (await query(`select p.id,p.slug,p.name,p.business_unit_id as "businessUnitId",b.organization_id as "organizationId"
    from projects p join business_units b on b.id=p.business_unit_id
    where b.organization_id=$1 and p.data_purged_at is null
      and ($2::text is null or p.slug=$2) and ($3::uuid is null or b.id=$3)`, [organizationId, input.projectSlug || null, input.businessUnitId || null])).rows;
  const access = [];
  for (const p of candidates) {
    const permissions = await projectPermissions(auth, p);
    if (permissions.includes("jobs.view")) { access.push({ projectId: p.id, locales: null }); continue; }
    if (!(await projectPermissions(auth, p, { allowUnknownLocale: true })).includes("jobs.view")) continue;
    const locales = (await query("select distinct unnest(target_locales) as locale from localization_jobs where project_id=$1", [p.id])).rows;
    const allowed = [];
    for (const { locale } of locales) if ((await projectPermissions(auth, p, { locale })).includes("jobs.view")) allowed.push(locale);
    access.push({ projectId: p.id, locales: allowed });
  }
  if (input.projectSlug && !access.length) throw fail(403, "You cannot view jobs in this project");
  // A jobs-only role need not also grant strings.view or organization.view.
  // Project authorization above establishes its organization scope. With no
  // job grants, require workspace visibility before returning an empty report.
  const organization = access.length ? { id: organizationId } : await readOrganization(auth, organizationId, context);
  const values = [JSON.stringify(access)];
  const clauses = [`exists (select 1 from jsonb_to_recordset($1::jsonb) as a("projectId" uuid,locales text[])
    where a."projectId"=j.project_id and (a.locales is null or j.target_locales <@ a.locales))`];
  const add = (value, clause) => { values.push(value); clauses.push(clause.replace("?", `$${values.length}`)); };
  if (input.status) add(input.status, "j.status=?");
  if (input.jobId) add(input.jobId, "j.id=?::uuid");
  if (input.targetLocale) add(input.targetLocale, "?=any(j.target_locales)");
  if (input.search) add(input.search, "strpos(lower(j.name),lower(?))>0");
  if (input.createdFrom) add(input.createdFrom, "j.created_at>=?::timestamptz");
  if (input.createdBefore) add(input.createdBefore, "j.created_at<?::timestamptz");
  return { organization, access, projects: candidates, values, where: clauses.join(" and "), from: "localization_jobs j join projects p on p.id=j.project_id join business_units b on b.id=p.business_unit_id",
    coverage: { scope: "authorized_matching_jobs", complete: true, projectsInScope: access.length, note: "Counts include only jobs you may view in every target locale. Hidden resources are not counted." } };
}
export async function readJobs(auth, input, context = {}) {
  const scope = await jobQueryScope(auth, input, context);
  const limit = pageSize(input), binding = cursorBinding(auth, "localization_jobs.list", { ...input, organizationId: scope.organization.id });
  const previous = readCursor(input.cursor, binding);
  if (previous && (!Array.isArray(previous.after) || previous.after.length !== 2 || !Number.isFinite(Date.parse(previous.after[0])) || !/^[0-9a-f-]{36}$/.test(previous.after[1]))) throw fail(400, "Invalid job cursor", "invalid_cursor");
  const values = [...scope.values, previous?.after[0] || null, previous?.after[1] || null, limit + 1];
  const index = scope.values.length;
  const result = (await query(`with matching as (
    select j.id,j.name,j.status,j.source_locale as "sourceLocale",j.target_locales as "targetLocales",j.steps,
      jsonb_array_length(j.source_snapshot) as "sourceCount",j.created_at as "createdAt",
      p.slug as "projectSlug",p.name as "projectName",b.id as "businessUnitId",b.name as "businessUnitName"
    from ${scope.from} where ${scope.where}
  ), selected as (select * from matching where ($${index + 1}::timestamptz is null or ("createdAt",id)<($${index + 1}::timestamptz,$${index + 2}::uuid))
    order by "createdAt" desc,id desc limit $${index + 3})
  select (select count(*)::int from matching) as total,
    coalesce((select jsonb_agg(to_jsonb(s) order by s."createdAt" desc,s.id desc) from selected s),'[]') as items`, values)).rows[0];
  const jobs = result.items.slice(0, limit), hasMore = result.items.length > limit;
  const editPermissions = new Map();
  for (const job of jobs) {
    const project = scope.projects.find((p) => p.slug === job.projectSlug);
    job.canEdit = job.status === "draft";
    job.canStart = job.status === 'draft' && job.steps[0] === 'machine_translation' && !job.steps.includes('human_translation');
    job.canStop = ['queued', 'running'].includes(job.status);
    for (const locale of job.targetLocales) {
      const delegated = { ...auth, executionType: 'agent', platformAdmin: false, user: { ...auth.user, platformStaff: false } };
      const permissions = await projectPermissions(delegated, project, { locale });
      const allowed = ['jobs.view', 'jobs.update', 'strings.view', 'translations.edit'].every(p => permissions.includes(p));
      job.canStart &&= allowed; job.canStop &&= allowed;
    }
    for (const locale of job.targetLocales.length ? job.targetLocales : [null]) {
      const key = JSON.stringify([project.id, locale]);
      if (!editPermissions.has(key)) editPermissions.set(key, (await projectPermissions(auth, project, { locale })).includes("jobs.update"));
      job.canEdit &&= editPermissions.get(key);
    }
  }
  return { jobs, page: { limit, returned: jobs.length, total: result.total, hasMore,
    nextCursor: hasMore ? nextCursor(binding, [jobs.at(-1).createdAt, jobs.at(-1).id], previous) : null } };
}
