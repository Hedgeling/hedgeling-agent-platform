import { organizationPermissions, projectPermissions } from "./authorization.js";
import { fail } from "./action-errors.js";
import { enforceReadScope } from "./workspace-read.js";

export const isWorkspaceUpdate = (name) => ["organization.update", "business_unit.update", "project.update", "localization_job.update"].includes(name);
const labels = { name: "Name", targetLocales: "Target languages", steps: "Workflow" };
const stale = () => fail(409, "This item changed since your preview. Review it again before saving.", "proposal_stale");

export async function prepareWorkspaceUpdate(action, input, auth, context, database, lock = false, replay = false) {
  let organizationId, resource, resourceType, resources;
  const suffix = lock ? " for update" : "";
  if (action.name === "organization.update") {
    organizationId = input.organizationId;
    enforceReadScope(organizationId, context);
    if (!(await organizationPermissions(auth, organizationId)).includes(action.permission)) throw fail(403, "You cannot edit this organization");
    resource = (await database.query(`select id,name,slug,xmin::text as version from organizations where id=$1 and status='active'${suffix}`, [organizationId])).rows[0];
    resourceType = "organization"; resources = { organization: resource };
  } else if (action.name === "business_unit.update") {
    resource = (await database.query(`select id,name,slug,organization_id as "organizationId",xmin::text as version from business_units where id=$1 and status='active'${suffix}`, [input.businessUnitId])).rows[0];
    if (!resource) throw fail(404, "Business unit not found");
    organizationId = resource.organizationId;
    enforceReadScope(organizationId, context);
    if (!(await organizationPermissions(auth, organizationId)).includes(action.permission)) throw fail(403, "You cannot edit this business unit");
    resourceType = "business_unit"; resources = { businessUnit: resource };
  } else {
    const project = (await database.query(`select p.id,p.name,p.slug,p.source_locale as "sourceLocale",p.business_unit_id as "businessUnitId",b.organization_id as "organizationId",p.xmin::text as version
      from projects p join business_units b on b.id=p.business_unit_id
      where p.data_purged_at is null and (${action.name === "project.update" ? "p.slug=$1" : "p.id=(select project_id from localization_jobs where id=$1)"})${lock ? " for update of p" : ""}`,
    [input.projectSlug || input.jobId])).rows[0];
    if (!project) throw fail(404, "Project or job not found");
    organizationId = project.organizationId;
    enforceReadScope(organizationId, context);
    if (action.name === "project.update") {
      if (!(await projectPermissions(auth, project)).includes(action.permission)) throw fail(403, "You cannot edit this project");
      resource = project; resourceType = "project"; resources = { project };
    } else {
      resource = (await database.query(`select id,name,status,source_locale as "sourceLocale",target_locales as "targetLocales",steps,
        jsonb_array_length(source_snapshot) as "sourceCount",xmin::text as version from localization_jobs where id=$1 and project_id=$2${suffix}`, [input.jobId, project.id])).rows[0];
      if (!resource) throw fail(404, "Job not found");
      const affectedLocales = [...new Set([...resource.targetLocales, ...(input.targetLocales || [])])];
      for (const locale of affectedLocales.length ? affectedLocales : [null]) {
        const permissions = await projectPermissions(auth, project, { locale });
        if (!permissions.includes("jobs.view") || !permissions.includes("jobs.update")) throw fail(403, "You cannot edit this job in every current and proposed target language");
      }
      if (!replay && resource.status !== "draft") throw fail(409, "Only job drafts can be edited here");
      if (!replay && input.targetLocales) {
        const enabled = (await database.query(`select locale from locales where project_id=$1 and enabled=true${lock ? " for share" : ""}`, [project.id])).rows.map((r) => r.locale);
        if (input.targetLocales.some((locale) => locale === resource.sourceLocale || !enabled.includes(locale))) throw fail(400, "Choose target languages enabled in this project");
      }
      resourceType = "job"; resources = { project, job: resource, sourceCount: resource.sourceCount };
    }
  }
  if (!resource) throw fail(404, "Organization not found");
  const changes = Object.keys(labels).filter((key) => Object.hasOwn(input, key) && JSON.stringify(input[key]) !== JSON.stringify(resource[key]))
    .map((field) => ({ field, label: labels[field], before: resource[field], after: input[field] }));
  if (!changes.length && !replay) { if (lock) throw stale(); throw fail(400, "Nothing has changed yet. Edit a field to prepare a preview.", "no_changes"); }
  return { organizationId, resource: { type: resourceType, id: resource.id }, preview: { action: action.name, fields: input, resources, changes,
    sideEffects: resourceType === "job" ? ["Update this draft's settings using its existing source snapshot", "Translation and review remain unstarted"] : ["Update the display name; existing links, content and access stay in place"],
    cost: "No paid work is started" } };
}

export async function applyWorkspaceUpdate(action, input, prepared, client) {
  const { resources } = prepared.preview;
  let updated, result;
  if (action.name === "organization.update") {
    updated = await client.query("update organizations set name=$2,updated_at=now() where id=$1 and xmin::text=$3 returning id,name,slug", [input.organizationId, input.name, resources.organization.version]);
    result = { organization: updated.rows[0] };
  } else if (action.name === "business_unit.update") {
    updated = await client.query("update business_units set name=$2,updated_at=now() where id=$1 and xmin::text=$3 returning id,name,slug", [input.businessUnitId, input.name, resources.businessUnit.version]);
    result = { businessUnit: updated.rows[0] };
  } else if (action.name === "project.update") {
    updated = await client.query("update projects set name=$2,updated_at=now() where id=$1 and xmin::text=$3 returning id,name,slug", [resources.project.id, input.name, resources.project.version]);
    result = { project: updated.rows[0] };
  } else {
    const job = resources.job;
    updated = await client.query(`update localization_jobs set name=$2,target_locales=$3,steps=$4 where id=$1 and status='draft' and xmin::text=$5
      returning id,name,status,target_locales as "targetLocales",steps`, [input.jobId, input.name ?? job.name, input.targetLocales ?? job.targetLocales, input.steps ?? job.steps, job.version]);
    result = { job: updated.rows[0], projectSlug: resources.project.slug };
  }
  if (!updated.rowCount) throw stale();
  return result;
}
