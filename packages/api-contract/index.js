// Protocol-neutral operation descriptions shared by the API and MCP adapter.
// These describe behavior, not authorization grants. The server reauthorizes
// each invocation using its authenticated principal and resolved resource.
import Ajv from "ajv";
import { LIBRARY_ACTIONS } from './library-actions.js';
export { normalizeLibraryToolInput } from './library-actions.js';
import { PROJECT_LOCALE_ACTIONS } from './project-locales-actions.js';
import { EXTRACTION_ACTIONS } from './extraction-actions.js';
export const ACTION_CONTRACT_VERSION = 1;
const text = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" };
const id = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" };
const schema = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const action = (name, toolName, description, permission, inputSchema, readOnly = true) => ({ name, toolName, description, permission, scope: "agent_domain", readOnly, inputSchema });
const paging = { limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string", minLength: 1, maxLength: 4096 } };
const search = { type: "string", minLength: 1, maxLength: 200 };
const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?Z$" };
const jobFilters = { search, status: { type: "string", enum: ["draft"] }, targetLocale: text, createdFrom: date, createdBefore: date, businessUnitId: id };
const jobChanges = { name: text, targetLocales: { type: "array", items: text, minItems: 1, maxItems: 30, uniqueItems: true }, steps: { type: "array", items: { type: "string", enum: ["machine_translation", "human_translation", "review", "qa"] }, minItems: 1, maxItems: 4, uniqueItems: true } };
export const REPORT_ACTIONS = [
  { ...action("reports.workspace.summary", "console_report_workspace", "Get a complete permission-scoped organization overview: project and business-unit counts plus localization-job totals. Prefer this to enumerating projects for counts. Metrics describe stored job drafts and states, not translation progress.", "organization.view", schema({ organizationId: id })), scope: "reporting" },
  { ...action("reports.jobs.summary", "console_report_jobs", "Aggregate ALL matching permitted localization jobs in one organization, grouped by status, project, business unit or target locale. Totals cover every matching job, independent of group pagination. Follow page.nextCursor for remaining groups. Locale groups overlap for multilingual jobs.", "jobs.view", schema({ organizationId: id, projectSlug: text, ...jobFilters, groupBy: { type: "string", enum: ["status", "project", "business_unit", "target_locale"] }, ...paging }, ["organizationId"])), scope: "reporting" },
];
export const WORKSPACE_ACTIONS = [
  ...LIBRARY_ACTIONS,
  ...EXTRACTION_ACTIONS,
  ...PROJECT_LOCALE_ACTIONS,
  action("organizations.list", "console_list_organizations", "List permitted organizations in pages. Follow page.nextCursor until hasMore is false; never treat one page as the full account list.", "organization.view", schema({ search, ...paging }, [])),
  action("workspace.get", "console_get_workspace", "Read an organization and pages of permitted projects and business units. Continue each collection using pages.projects.nextCursor as projectCursor and pages.businessUnits.nextCursor as businessUnitCursor. For totals use console_report_workspace.", "organization.view", schema({ organizationId: id, limit: paging.limit, projectCursor: paging.cursor, businessUnitCursor: paging.cursor }, ["organizationId"])),
  action("organization.create", "console_propose_organization", "Preview creating an empty customer organization and its initial owner. Requires human confirmation; creates no subscription, BU, project or credential.", "", schema({ name: text }), false),
  action("business_unit.create", "console_propose_business_unit", "Preview creating one business unit. Requires human confirmation.", "business_units.create", schema({ organizationId: id, name: text }), false),
  action("project.create", "console_propose_project", "Preview creating one project and its locales in a business unit. Requires human confirmation.", "projects.create", schema({ businessUnitId: id, name: text, sourceLocale: text, targetLocales: { type: "array", items: text, minItems: 1, maxItems: 30, uniqueItems: true } }), false),
  action("localization_job.create", "console_propose_localization_job", "Preview a localization job draft using the current source catalog. No translation work is started. Requires human confirmation.", "jobs.create", schema({ projectSlug: text, name: text, targetLocales: { type: "array", items: text, minItems: 1, maxItems: 30, uniqueItems: true }, steps: { type: "array", items: { type: "string", enum: ["machine_translation", "human_translation", "review", "qa"] }, minItems: 1, maxItems: 4, uniqueItems: true } }), false),
  action("localization_jobs.list", "console_list_localization_jobs", "Search permitted localization jobs in one project or across an organization. Supply organizationId or projectSlug. Follow page.nextCursor for additional jobs; use console_report_jobs for complete totals.", "jobs.view", { ...schema({ organizationId: id, projectSlug: text, jobId: id, ...jobFilters, ...paging }, []), anyOf: [{ properties: { organizationId: id }, required: ["organizationId"] }, { properties: { projectSlug: text }, required: ["projectSlug"] }] }),
  action("organization.update", "console_propose_organization_update", "Preview renaming an existing organization using its discovered ID. Preserves its slug, billing, membership and access. Requires human confirmation.", "organization.update", schema({ organizationId: id, name: text }), false),
  action("business_unit.update", "console_propose_business_unit_update", "Preview renaming an existing business unit using its discovered ID. Preserves its slug, projects and access. Requires human confirmation.", "business_units.manage", schema({ businessUnitId: id, name: text }), false),
  action("project.update", "console_propose_project_update", "Preview renaming an existing project using its discovered slug. Preserves its slug, locales, source content and integrations. Requires human confirmation.", "projects.manage", schema({ projectSlug: text, name: text }), false),
  action("localization_job.update", "console_propose_localization_job_update", "Preview edits to an existing localization-job draft. Supply its discovered jobId and at least one of name, targetLocales or steps. Omitted fields stay unchanged; arrays replace the existing selection. Requires jobs.update and jobs.view for all old and new target locales, then human confirmation. Keeps the existing source snapshot; starts no translation or spending.", "jobs.update", { ...schema({ jobId: id, ...jobChanges }, ["jobId"]), anyOf: Object.entries(jobChanges).map(([key, value]) => ({ properties: { [key]: value }, required: [key] })) }, false),
];
export const CONSOLE_ACTIONS = Object.freeze([
  {
    name: "projects.list",
    toolName: "console_list_projects",
    description: "Search permitted projects in pages. Optionally filter by organization and business unit. Follow page.nextCursor until hasMore is false. Prefer console_report_workspace for counts.",
    permission: "strings.view", scope: "visible_projects", readOnly: true,
    inputSchema: schema({ organizationId: id, businessUnitId: id, search, ...paging }, []),
  },
  {
    name: "project.sync.status",
    toolName: "console_get_sync_status",
    description: "Read a project's last repository push and pull, state hash, and actor attribution. Does not run sync.",
    permission: "strings.view", scope: "project", readOnly: true,
    inputSchema: {
      type: "object", required: ["projectSlug"], additionalProperties: false,
      properties: { projectSlug: text },
    },
  },
  ...WORKSPACE_ACTIONS,
  ...REPORT_ACTIONS,
]);

const validator = new Ajv({ allErrors: false, strict: true });
const validators = new Map();
export function validateActionInput(action, input) {
  if (!validators.has(action.name)) validators.set(action.name, validator.compile(action.inputSchema));
  const validate = validators.get(action.name);
  return validate(input) ? null : `Invalid action input: ${validator.errorsText(validate.errors)}`;
}
