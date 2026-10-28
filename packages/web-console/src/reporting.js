import { query } from "./db.js";
import { fail } from "./action-errors.js";
import { workspaceRows, jobQueryScope } from "./workspace-read.js";
import { pageRows } from "./pagination.js";

const definitions = {
  "reports.workspace.summary": { id: "workspace.summary", version: 1, run: workspaceSummary },
  "reports.jobs.summary": { id: "jobs.summary", version: 1, run: jobsSummary },
};
export async function runReport(name, input, auth, context) {
  if (process.env.HEDGELING_AGENT_ENABLED !== "true") throw fail(404, "The assistant workspace API is not enabled");
  const definition = definitions[name];
  if (!definition) throw fail(404, "Unknown report");
  const startedAt = new Date().toISOString();
  const result = await definition.run(auth, input, context);
  return { report: { id: definition.id, version: definition.version, startedAt, generatedAt: new Date().toISOString(), freshness: "live", consistency: "read_committed" },
    scope: { organizationId: input.organizationId }, filters: Object.fromEntries(Object.entries(input).filter(([key]) => !["cursor", "limit", "organizationId"].includes(key))),
    ...result };
}
async function aggregateJobs(scope, groupBy = "status") {
  const dimension = {
    status: { key: "j.status", label: "j.status" },
    project: { key: "p.slug", label: "p.name" },
    business_unit: { key: "b.id::text", label: "b.name" },
    target_locale: { key: "target.locale", label: "target.locale", join: "cross join lateral (select distinct unnest(j.target_locales) as locale) target" },
  }[groupBy];
  // groupBy is an allowlisted expression, never user-provided SQL.
  const result = (await query(`with permitted as (
      select j.*,p.slug as project_slug,p.name as project_name,b.id as business_unit_id,b.name as business_unit_name
      from ${scope.from} where ${scope.where}
    ), grouped as (
      select ${dimension.key} as key,${dimension.label} as label,count(*)::int as jobs,
        sum(jsonb_array_length(j.source_snapshot))::bigint as "sourceStrings"
      from permitted j join projects p on p.id=j.project_id join business_units b on b.id=p.business_unit_id ${dimension.join || ""}
      group by ${dimension.key},${dimension.label}
    ) select (select count(*)::int from permitted) as jobs,
      (select count(distinct project_id)::int from permitted) as "projectsWithJobs",
      (select coalesce(sum(jsonb_array_length(source_snapshot)),0)::bigint from permitted) as "sourceStrings",
      coalesce((select jsonb_agg(to_jsonb(g) order by g.key) from grouped g),'[]') as groups`, scope.values)).rows[0];
  return { totals: { jobs: result.jobs, projectsWithJobs: result.projectsWithJobs, sourceStrings: Number(result.sourceStrings) },
    groups: result.groups.map((group) => ({ ...group, sourceStrings: Number(group.sourceStrings) })) };
}
async function workspaceSummary(auth, input, context) {
  const workspace = await workspaceRows(auth, input.organizationId, context);
  const scope = await jobQueryScope(auth, input, context);
  const jobs = await aggregateJobs(scope);
  return { coverage: { ...scope.coverage, projectScope: "projects_with_strings_view", businessUnitScope: "permitted_active_business_units" },
    metrics: { projects: workspace.projects.length, businessUnits: workspace.businessUnits.length, jobs: jobs.totals.jobs, projectsWithJobs: jobs.totals.projectsWithJobs, jobSourceStrings: jobs.totals.sourceStrings },
    jobsByStatus: jobs.groups,
    definitions: { jobSourceStrings: "Sum of source strings stored in job snapshots; repeated content across jobs counts more than once.", jobs: "Stored localization jobs by current state. Awaiting review means draft generation finished, not human approval or publication." } };
}
async function jobsSummary(auth, input, context) {
  const scope = await jobQueryScope(auth, input, context);
  const groupBy = input.groupBy || "status";
  const result = await aggregateJobs(scope, groupBy);
  const groups = pageRows(result.groups, { ...input, groupBy }, auth, "reports.jobs.summary", (row) => row.key);
  return { coverage: { ...scope.coverage, groupsComplete: !groups.page.hasMore && !input.cursor }, totals: result.totals, groupBy, groups: groups.items, page: groups.page,
    definitions: { sourceStrings: "Sum of job source-snapshot lengths, not unique content or completed translations.",
      grouping: groupBy === "target_locale" ? "A multilingual job appears in each of its target-locale groups. Group counts are not additive; totals count each job once." : "Each matching job belongs to one group." } };
}
