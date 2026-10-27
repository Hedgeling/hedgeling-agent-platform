import crypto from "node:crypto";
import { WORKSPACE_ACTIONS, validateActionInput } from "@hedgeling/api-contract";
import { query, withTransaction } from "./db.js";
import { organizationPermissions, projectPermissions } from "./authorization.js";
import { insertAuditEvent } from "./audit.js";
import { isHumanDecisionActor } from "./principal-policy.js";
import { library } from './library-integration.js';
import { projectLocales } from './project-locales-integration.js';
import { extractionWorkflow } from './extraction-integration.js';

import { fail } from "./action-errors.js";
import { accessibleOrganizations, readWorkspace, readJobs } from "./workspace-read.js";
import { pageRows } from "./pagination.js";
import { isWorkspaceUpdate, prepareWorkspaceUpdate, applyWorkspaceUpdate } from "./workspace-management.js";
export { fail, accessibleOrganizations };
function canonical(value) {
  if (value instanceof Date) return value.toJSON();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export const fingerprint = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const db = { query };
export async function authorizationStamp(auth, database = db) {
  // Include time-dependent validity: a grant expiring is an access change even
  // when nobody updates its row. Hashes stay server-side and contain no content.
  const state = await database.query(`with relevant_organizations as (
      select organization_id from organization_memberships where user_id=$1
      union select organization_id from support_access_grants where user_id=$1
    ) select
    (select coalesce(jsonb_agg(to_jsonb(m) || jsonb_build_object('unexpired',m.expires_at is null or m.expires_at>now()) order by m.id),'[]') from organization_memberships m where m.user_id=$1) as memberships,
    (select coalesce(jsonb_agg(to_jsonb(t) order by t.team_id),'[]') from team_memberships t join organization_memberships m on m.id=t.organization_membership_id where m.user_id=$1) as teams,
    (select coalesce(jsonb_agg(to_jsonb(a) || jsonb_build_object('unexpired',a.expires_at is null or a.expires_at>now()) order by a.id),'[]') from role_assignments a where
      (a.principal_type='user' and a.principal_id=$1) or (a.principal_type='team' and a.principal_id in
        (select t.team_id from team_memberships t join organization_memberships m on m.id=t.organization_membership_id where m.user_id=$1))) as assignments,
    (select coalesce(jsonb_agg(to_jsonb(p) order by p.role_id,p.permission_id),'[]') from role_permissions p) as permissions,
    (select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object('validNow',s.starts_at<=now() and s.expires_at>now()) order by s.id),'[]') from support_access_grants s where s.user_id=$1) as support,
    (select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('unexpired',r.expires_at>now()) order by r.id),'[]') from recovery_login_grants r where r.user_id=$1) as recovery,
    (select coalesce(jsonb_agg(to_jsonb(p) order by p.organization_id),'[]') from organization_identity_policies p where p.organization_id in (select organization_id from relevant_organizations)) as policies,
    (select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'status',c.status) order by c.id),'[]') from identity_connections c where c.organization_id in (select organization_id from relevant_organizations)) as connections,
    (select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'status',o.status) order by o.id),'[]') from organizations o where o.id in (select organization_id from relevant_organizations)) as organizations,
    (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'businessUnitId',p.business_unit_id,'purgedAt',p.data_purged_at) order by p.id),'[]') from projects p join business_units b on b.id=p.business_unit_id where b.organization_id in (select organization_id from relevant_organizations)) as projects,
    (select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'state',r.state,'exportAllowed',r.export_available_until>now()) order by r.id),'[]') from data_lifecycle_requests r where r.organization_id in (select organization_id from relevant_organizations)) as lifecycle`, [auth.user.id]);
  return fingerprint({ ...state.rows[0], identityConnectionId: auth.identityConnectionId || null });
}
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "workspace";
export function agentEnabled() { return process.env.HEDGELING_AGENT_ENABLED === "true"; }
export async function activeUser(auth, database = db) {
  if (auth?.principalType !== "user" || !auth.user?.id) throw fail(403, "A named human user is required");
  const user = (await database.query("select id from users where id = $1 and status = 'active'", [auth.user.id])).rows[0];
  if (!user) throw fail(403, "Your user account is no longer active");
  return user.id;
}
async function allowOrg(auth, organizationId, permission) {
  if (!(await organizationPermissions(auth, organizationId)).includes(permission)) throw fail(403, "You do not have permission for this organization action");
}
export async function assertRunScope(auth, organizationId) {
  await activeUser(auth);
  if (organizationId && !(await accessibleOrganizations(auth, organizationId)).some((o) => o.id === organizationId)) throw fail(403, "This conversation's organization is no longer accessible");
}
// Use the same authority for chat discovery, admission, replay and execution.
// Platform administration remains available in manual console workflows.
export function delegatedAgentAuth(auth, runId = auth.agentRunId) {
  return { ...auth, executionType: "agent", agentRunId: runId, platformAdmin: false,
    user: { ...auth.user, platformStaff: false } };
}
export const agentOrganizationAccessMessage = "Hedgeling needs an active organization or project role in this workspace. Platform-admin access alone does not grant chat access. Ask an organization owner to review your role in Admin → People & access, or choose another workspace.";
export async function assertAgentRunScope(auth, organizationId) {
  await activeUser(auth);
  if (organizationId && !(await accessibleOrganizations(delegatedAgentAuth(auth), organizationId)).some((o) => o.id === organizationId)) {
    throw fail(403, agentOrganizationAccessMessage, "agent_organization_access_required");
  }
}
function enforceScope(organizationId, context) {
  if (Object.hasOwn(context, "organizationId") && context.organizationId !== organizationId) throw fail(403, "Start a conversation in the selected organization before using this action", "agent_scope_mismatch");
}
function canonicalLocale(value) {
  try { return new Intl.Locale(value.replaceAll("_", "-")).toString(); }
  catch { throw fail(400, "Use a valid language or locale code", "invalid_locale"); }
}
function normalizeInput(action, input) {
  const error = validateActionInput(action, input);
  if (error) throw fail(400, error, "action_input_invalid");
  const value = { ...input };
  if (value.name) value.name = value.name.trim();
  if (value.sourceLocale) value.sourceLocale = canonicalLocale(value.sourceLocale);
  if (value.targetLocales) {
    value.targetLocales = [...new Set(value.targetLocales.map(canonicalLocale))].sort();
    if (value.targetLocales.includes(value.sourceLocale)) throw fail(400, "The source locale cannot also be a target");
  }
  return value;
}
async function project(input, database = db) {
  const row = (await database.query(`select p.id, p.slug, p.name, p.source_locale as "sourceLocale", p.updated_at as "updatedAt",
    p.business_unit_id as "businessUnitId", b.organization_id as "organizationId"
    from projects p join business_units b on b.id = p.business_unit_id where p.slug = $1 and p.data_purged_at is null`, [input.projectSlug])).rows[0];
  if (!row) throw fail(404, "Project not found");
  return row;
}
async function allowProject(auth, p, permission, locales) {
  for (const locale of locales || [null]) {
    if (!(await projectPermissions(auth, p, { locale })).includes(permission)) throw fail(403, "You do not have permission for this project or locale");
  }
}
async function creationLimits(client, organizationId, action, input) {
  // Serialize counts with all creation commands in this API.
  await client.query("select id from organizations where id = $1 for update", [organizationId]);
  const trial = (await client.query(`select 1 from billing_accounts a join subscriptions s on s.billing_account_id=a.id
    join product_plans p on p.id=s.plan_id where a.organization_id=$1 and p.key='self-service-trial-v1'
    and s.state <> 'canceled' limit 1`, [organizationId])).rowCount > 0;
  const counts = (await client.query(`select
    (select count(*) from business_units where organization_id=$1 and status='active')::int as units,
    (select count(*) from projects p join business_units b on b.id=p.business_unit_id where b.organization_id=$1 and p.data_purged_at is null)::int as projects`, [organizationId])).rows[0];
  if (action === "business_unit.create" && counts.units >= (trial ? 1 : 100)) throw fail(402, "The business-unit limit has been reached");
  if (action === "project.create" && (counts.projects >= (trial ? 1 : 250) || input.targetLocales.length > (trial ? 3 : 30))) throw fail(402, "The project or locale limit has been reached");
}
async function prepare(action, input, auth, context = {}, database = db) {
  const userId = await activeUser(auth, database);
  if (action.name.startsWith('library.')) return library.prepare(action.name, input, auth, context, database, database !== db);
  if (action.name === 'project.locales.add') return projectLocales.prepare(input, auth, context, database, database !== db);
  if (action.name.startsWith('extraction.')) return extractionWorkflow.prepare(action.name, input, auth, context, database, database !== db);
  if (isWorkspaceUpdate(action.name)) return prepareWorkspaceUpdate(action, input, auth, context, database, database !== db);
  let organizationId = null;
  let resources = {};
  let sideEffects = [];
  if (action.name === "organization.create") {
    enforceScope(null, context);
    if (process.env.HEDGELING_AGENT_ORG_CREATION_ENABLED !== "true") throw fail(403, "Organization creation is not available. Use an existing organization.");
    resources = { ownerUserId: userId };
    sideEffects = ["Create an empty customer organization", "Make you its initial owner", "Billing remains unconfigured; no subscription, credentials, projects or business units are created"];
  } else if (action.name === "business_unit.create") {
    organizationId = input.organizationId;
    await allowOrg(auth, organizationId, action.permission);
    const o = (await database.query("select name, updated_at from organizations where id=$1 and status='active'", [organizationId])).rows[0];
    if (!o) throw fail(404, "Organization not found");
    resources = { organization: o };
  } else if (action.name === "project.create") {
    const b = (await database.query("select id, name, organization_id, updated_at from business_units where id=$1 and status='active'", [input.businessUnitId])).rows[0];
    if (!b) throw fail(404, "Business unit not found");
    organizationId = b.organization_id;
    await allowOrg(auth, organizationId, action.permission);
    resources = { businessUnit: b };
    sideEffects = ["Configure the selected source and target locales", "No API credential, import, or translation work will be started"];
  } else {
    const p = await project(input, database);
    organizationId = p.organizationId;
    await allowProject(auth, p, action.permission, input.targetLocales);
    await allowProject(auth, p, "strings.view", input.targetLocales);
    if (!p.sourceLocale) throw fail(400, "Set the project's source locale before creating a job");
    const configured = (await database.query("select locale from locales where project_id=$1 and enabled=true", [p.id])).rows.map((l) => l.locale);
    if (input.targetLocales.some((l) => !configured.includes(l) || l === p.sourceLocale)) throw fail(400, "Choose target locales enabled in this project");
    const source = (await database.query("select id, source_hash, source_text, updated_at from source_strings where project_id=$1 order by id limit 10001", [p.id])).rows;
    if (source.length > 10000) throw fail(400, "This draft workflow supports up to 10,000 source strings");
    resources = { project: p, sourceCount: source.length, sourceVersion: fingerprint(source) };
    sideEffects = [source.length ? `Snapshot ${source.length} source strings` : "Create an incomplete draft; import source content before running it", "No translation, publication or vendor spending will start"];
  }
  enforceScope(organizationId, context);
  return { organizationId, preview: { action: action.name, fields: input, resources, sideEffects, cost: "No paid work is started" } };
}

export async function executeWorkspaceAction(name, input, auth, context = {}) {
  if (!agentEnabled()) throw fail(404, "The assistant workspace API is not enabled");
  const action = WORKSPACE_ACTIONS.find((a) => a.name === name);
  if (!action) throw fail(404, "Unknown workspace action");
  input = normalizeInput(action, input);
  if (name.startsWith('library.') && action.readOnly) { const result = await library.read(name, input, auth, context); return { ...result, uiTarget: { view: 'library', projectSlug: input.projectSlug, kind: input.kind || null, action: 'library.read' } }; }
  if (name === 'project.locales.get') return projectLocales.read(input, auth, context);
  if (name.startsWith('extraction.') && action.readOnly) return extractionWorkflow.read(name, input, auth, context);
  if (name === "organizations.list") {
    let organizations = (await accessibleOrganizations(auth)).filter((o) => !Object.hasOwn(context, "organizationId") || context.organizationId === null || o.id === context.organizationId);
    if (input.search) organizations = organizations.filter((o) => `${o.name} ${o.slug}`.toLowerCase().includes(input.search.toLowerCase()));
    const result = pageRows(organizations, { ...input, conversationOrganizationId: context.organizationId }, auth, name);
    return { organizations: result.items, page: result.page };
  }
  if (name === "workspace.get") return readWorkspace(auth, input, context);
  if (name === "localization_jobs.list") return readJobs(auth, input, context);
  const prepared = await prepare(action, input, auth, context);
  const proposal = await withTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`agent-proposals:${auth.user.id}`]);
    const count = (await client.query("select count(*)::int as n from agent_proposals where user_id=$1 and created_at>now()-interval '1 day'", [auth.user.id])).rows[0].n;
    if (count >= 200) throw fail(429, "Your daily preview limit has been reached");
    if (context.runId) {
      const run = (await client.query("select status, generation, lease_expires_at from agent_runs where id=$1 and user_id=$2 for update", [context.runId, auth.user.id])).rows[0];
      if (!run || !["planning", "reading"].includes(run.status) || run.generation !== context.generation || new Date(run.lease_expires_at) <= new Date()) throw fail(409, "The agent is paused or its controller has disconnected");
    }
    return (await client.query(`insert into agent_proposals(user_id, run_id, organization_id, action, input, preview, fingerprint)
      values($1,$2,$3,$4,$5,$6,$7) returning id, preview, fingerprint, status, expires_at as "expiresAt"`,
    [auth.user.id, context.runId || null, prepared.organizationId, name, input, prepared.preview, fingerprint(prepared.preview)])).rows[0];
  });
  return { proposal, uiTarget: prepared.uiTarget || { view: "workspace", organizationId: prepared.organizationId, action: name, ...(prepared.resource ? { resource: prepared.resource } : {}) } };
}

export async function confirmProposal(auth, proposalId, expectedFingerprint, controllerId) {
  if (!isHumanDecisionActor(auth)) throw fail(403, "Only the authenticated person can confirm a change");
  return withTransaction(async (client) => {
    await activeUser(auth, client);
    const proposal = (await client.query("select * from agent_proposals where id=$1 and user_id=$2 for update", [proposalId, auth.user.id])).rows[0];
    if (!proposal) throw fail(404, "Proposal not found");
    if (expectedFingerprint !== proposal.fingerprint) throw fail(409, "The displayed proposal has changed");
    if (proposal.status === "confirmed") {
      await assertRunScope(auth, proposal.organization_id);
      if (proposal.action.startsWith('library.')) await library.replay(proposal.input, auth, {}, client, proposal.result);
      else if (proposal.action === 'project.locales.add') await projectLocales.replay(proposal.input, auth, {}, client);
      else if (proposal.action.startsWith('extraction.')) await extractionWorkflow.replay(proposal.input, auth, {}, client);
      else if (isWorkspaceUpdate(proposal.action)) await prepareWorkspaceUpdate(WORKSPACE_ACTIONS.find((a) => a.name === proposal.action), proposal.input, auth, {}, client, false, true);
      else if (proposal.result?.projectSlug) await allowProject(auth, await project({ projectSlug: proposal.result.projectSlug }), "jobs.view", proposal.input.targetLocales);
      return { result: proposal.result, replayed: true };
    }
    if (proposal.status !== "pending" || new Date(proposal.expires_at) <= new Date()) throw fail(409, "This proposal is no longer available; ask for a new preview");
    let run;
    if (proposal.run_id) {
      run = (await client.query("select * from agent_runs where id=$1 for update", [proposal.run_id])).rows[0];
      if (run.status !== "awaiting_confirmation" || run.controller_id !== controllerId || new Date(run.lease_expires_at) <= new Date()) throw fail(409, "Resume this conversation before confirming the change");
      if (run.authorization_stamp !== await authorizationStamp(auth, client)) throw fail(403, "Your access changed. Start a new conversation.");
    }
    const action = WORKSPACE_ACTIONS.find((a) => a.name === proposal.action);
    const prepared = await prepare(action, proposal.input, auth, run ? { organizationId: run.organization_id } : {}, client);
    if (fingerprint(prepared.preview) !== proposal.fingerprint) throw fail(409, "The resource changed since this preview. Ask for a new preview.", "proposal_stale");
    const input = proposal.input;
    let result;
    let organizationId = prepared.organizationId;
    if (action.name.startsWith('library.')) {
      result = await library.apply(prepared, proposal, auth, client);
    } else if (action.name === 'project.locales.add') {
      result = await projectLocales.apply(prepared, client);
    } else if (action.name.startsWith('extraction.')) {
      result = await extractionWorkflow.apply(action.name, prepared, proposal, auth, client);
    } else if (isWorkspaceUpdate(action.name)) {
      result = await applyWorkspaceUpdate(action, input, prepared, client);
    } else if (action.name === "organization.create") {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`agent-org-create:${auth.user.id}`]);
      const count = (await client.query("select count(*)::int as count from agent_proposals where user_id=$1 and action='organization.create' and status='confirmed' and confirmed_at > now()-interval '1 day'", [auth.user.id])).rows[0].count;
      if (count >= 5) throw fail(429, "The daily organization creation limit has been reached");
      const org = (await client.query("insert into organizations(name,slug,metadata) values($1,$2,$3) returning id,name,slug", [input.name, `${slug(input.name)}-${crypto.randomUUID().slice(0, 8)}`, { acquisition: "agent_console", provisioning: "empty" }])).rows[0];
      organizationId = org.id;
      await client.query("insert into organization_memberships(organization_id,user_id,status,activated_at) values($1,$2,'active',now())", [org.id, auth.user.id]);
      await client.query(`insert into role_assignments(principal_type,principal_id,role_id,scope_type,scope_id,inherit_to_children,granted_by_user_id)
        select 'user',$1,id,'organization',$2,true,$1 from roles where key='organization_owner' and organization_id is null`, [auth.user.id, org.id]);
      await client.query("insert into organization_identity_policies(organization_id) values($1)", [org.id]);
      result = { organization: org };
      if (run) await client.query("update agent_runs set organization_id=$2 where id=$1", [run.id, org.id]);
    } else {
      await creationLimits(client, organizationId, action.name, input);
      if (action.name === "business_unit.create") {
        result = { businessUnit: (await client.query("insert into business_units(organization_id,name,slug) values($1,$2,$3) returning id,name,slug", [organizationId, input.name, slug(input.name)])).rows[0] };
      } else if (action.name === "project.create") {
        const p = (await client.query("insert into projects(business_unit_id,name,slug,source_locale) values($1,$2,$3,$4) returning id,name,slug", [input.businessUnitId, input.name, `${slug(input.name)}-${crypto.randomUUID().slice(0, 8)}`, input.sourceLocale])).rows[0];
        for (const locale of input.targetLocales) await client.query("insert into locales(project_id,locale) values($1,$2)", [p.id, locale]);
        result = { project: p };
      } else {
        const p = prepared.preview.resources.project;
        const snapshot = (await client.query("select id, source_hash, source_text, updated_at from source_strings where project_id=$1 order by id for share", [p.id])).rows;
        if (fingerprint(snapshot) !== prepared.preview.resources.sourceVersion) throw fail(409, "Source content changed; create a fresh preview");
        result = { job: (await client.query(`insert into localization_jobs(project_id,name,source_locale,target_locales,steps,source_snapshot,created_by_user_id,proposal_id)
          values($1,$2,$3,$4,$5,$6,$7,$8) returning id,name,status`, [p.id, input.name, p.sourceLocale, input.targetLocales, input.steps, JSON.stringify(snapshot), auth.user.id, proposal.id])).rows[0] };
        result.projectSlug = p.slug;
      }
    }
    const resourceType = { organization: "organization", business_unit: "business_unit", project: "project", localization_job: "job" }[action.name.split(".")[0]];
    const resource = result.organization || result.businessUnit || result.project || result.job;
    result.uiTarget ||= { view: "workspace", organizationId, projectSlug: result.project?.slug || result.projectSlug || null, action: action.name, resource: { type: resourceType, id: resource?.id } };
    await insertAuditEvent(client, { auth, organizationId, action: `${action.name}.confirmed`, resourceType: action.name.split(".")[0], resourceId: Object.values(result)[0]?.id || null,
      beforeState: prepared.preview.changes ? Object.fromEntries(prepared.preview.changes.map((c) => [c.field, c.before])) : undefined,
      afterState: result, metadata: { proposalId, projectId: prepared.preview.resources.project?.id || result.project?.id || null, agentRunId: proposal.run_id, initiatedBy: proposal.run_id ? "agent" : "manual", confirmation: "human", fingerprint: proposal.fingerprint } });
    await client.query("update agent_proposals set status='confirmed',result=$2,organization_id=$3,confirmed_at=now() where id=$1", [proposalId, result, organizationId]);
    if (run) {
      await client.query("insert into agent_events(run_id,kind,data) values($1,'result',$2)", [run.id, { proposalId, ...result }]);
      await client.query("update agent_runs set status='awaiting_input',updated_at=now(),authorization_stamp=$2,model_history=model_history || $3::jsonb where id=$1", [run.id,
        await authorizationStamp(auth, client), JSON.stringify([{ role: "user", confirmation: true, parts: [{ text: `Confirmed result: ${JSON.stringify(result)}` }] }])]);
      await client.query("insert into agent_events(run_id,kind,data) values($1,'state',$2)", [run.id, { status: "awaiting_input", organizationId }]);
    }
    return { result, replayed: false };
  });
}
