import express from "express";
import { query, withTransaction } from "./db.js";
import { auditRequest } from "./audit.js";
import {
  isPlatformAdmin,
  organizationIdentityAllows,
  organizationPermissions,
  projectPermissions,
  requireOrganizationPermission,
} from "./authorization.js";
import { isUuid, optionalTimestamp } from "./validation.js";
import {
  evaluateVendorEligibility,
  evaluateVendorWorkAccess,
} from "./vendor-eligibility.js";
import { measureText } from "./usage.js";

const adminRouter = express.Router();
const personalRouter = express.Router();
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const unitTypes = new Set([
  "source_word",
  "target_word",
  "character",
  "string",
  "hour",
  "fixed_job",
]);
const localePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

for (const router of [adminRouter, personalRouter]) {
  for (const parameter of [
    "organizationId",
    "vendorRelationshipId",
    "workOrderId",
    "workAssignmentId",
    "sourceStringId",
    "disputeId",
    "statementId",
    "paymentRecordId",
  ]) {
    router.param(parameter, (req, res, next, value) => (
      isUuid(value) ? next() : res.status(400).json({ error: `${parameter} is invalid` })
    ));
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function bounded(value, fieldName, maximum, { required = false, lower = false } = {}) {
  const normalized = clean(value);
  if (!normalized) {
    if (required) throw httpError(400, `${fieldName} is required`);
    return null;
  }
  if (normalized.length > maximum) {
    throw httpError(400, `${fieldName} cannot exceed ${maximum} characters`);
  }
  return lower ? normalized.toLowerCase() : normalized;
}

function decimal(value, fieldName, { required = false, signed = false } = {}) {
  if (value == null || value === "") {
    if (required) throw httpError(400, `${fieldName} is required`);
    return null;
  }
  const normalized = clean(value);
  const pattern = signed
    ? /^-?\d{1,16}(?:\.\d{1,4})?$/
    : /^\d{1,16}(?:\.\d{1,4})?$/;
  if (!pattern.test(normalized)) {
    throw httpError(400, `${fieldName} must be a valid decimal with at most four decimal places`);
  }
  return normalized;
}

function safeInteger(value, fieldName, { required = false, positive = false } = {}) {
  if (value == null || value === "") {
    if (required) throw httpError(400, `${fieldName} is required`);
    return null;
  }
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw httpError(400, `${fieldName} must be a ${positive ? "positive" : "non-negative"} integer`);
  }
  return value;
}

function positiveCursor(value, fieldName) {
  const normalized = clean(value);
  if (!normalized) return null;
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw httpError(400, `${fieldName} must be a positive integer`);
  }
  return normalized;
}

function locale(value, fieldName, required = false) {
  const normalized = bounded(value, fieldName, 100, { required });
  if (normalized && !localePattern.test(normalized)) {
    throw httpError(400, `${fieldName} must use a valid locale tag`);
  }
  return normalized;
}

function pastOrCurrentTimestamp(value, fieldName) {
  if (value == null || value === "") return new Date().toISOString();
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw httpError(400, `${fieldName} must be an ISO-8601 timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp > Date.now()) {
    throw httpError(400, `${fieldName} cannot be in the future`);
  }
  return new Date(timestamp).toISOString();
}

function conciseDecimal(value) {
  if (!Number.isFinite(value)) return null;
  return value.toFixed(4).replace(/\.?0+$/, "");
}

function deliveryReview(workOrder, itemRows, submissionRows) {
  const sourceMeasurements = itemRows.map((item) => (
    measureText(item.sourceTextForCount, workOrder.source_locale)
  ));
  const computedSourceWords = sourceMeasurements.reduce(
    (total, measurement) => total + measurement.words,
    0,
  );
  const countingVersion = sourceMeasurements[0]?.countingVersion
    || measureText("", workOrder.source_locale).countingVersion;
  const latestSubmission = submissionRows[0] || null;
  let comparisonBasis = null;
  let expectedUnits = null;
  if (workOrder.unit_type === "source_word") {
    comparisonBasis = "computed_source_words";
    expectedUnits = computedSourceWords;
  } else if (workOrder.estimated_units != null) {
    comparisonBasis = "estimated_units";
    expectedUnits = Number(workOrder.estimated_units);
  }

  let warning = null;
  if (latestSubmission && Number.isFinite(expectedUnits)) {
    const deliveredUnits = Number(latestSubmission.deliveredUnits);
    const differenceUnits = deliveredUnits - expectedUnits;
    if (Math.abs(differenceUnits) > 0.00005) {
      const delivered = conciseDecimal(deliveredUnits);
      const expected = conciseDecimal(expectedUnits);
      const basisLabel = comparisonBasis === "computed_source_words"
        ? "computed source-word total"
        : "work-order estimate";
      warning = {
        code: comparisonBasis === "computed_source_words"
          ? "delivered_source_word_variance"
          : "delivered_estimate_variance",
        comparisonBasis,
        expectedUnits: expected,
        deliveredUnits: delivered,
        differenceUnits: conciseDecimal(differenceUnits),
        differencePercent: expectedUnits === 0
          ? null
          : Math.round((differenceUnits / expectedUnits) * 10000) / 100,
        message:
          `Delivered units (${delivered}) differ from the ${basisLabel} (${expected}).`,
      };
    }
  }

  return {
    computedSourceWords,
    sourceWordCountingVersion: countingVersion,
    deliveredUnits: latestSubmission?.deliveredUnits ?? null,
    unitType: workOrder.unit_type,
    estimatedUnits: workOrder.estimated_units,
    warning,
  };
}

function dateOnly(value, fieldName) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw httpError(400, `${fieldName} must be an ISO date`);
  }
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(parsed)
    || new Date(parsed).toISOString().slice(0, 10) !== value
  ) {
    throw httpError(400, `${fieldName} must be an ISO date`);
  }
  return value;
}

function currencyExponent(currency) {
  if (["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"].includes(currency)) {
    return 0;
  }
  if (["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"].includes(currency)) return 3;
  return 2;
}

function party(relationship, organizationId) {
  if (relationship.customer_organization_id === organizationId) return "customer";
  if (relationship.agency_organization_id === organizationId) return "agency";
  return null;
}

function requireParty(relationship, organizationId, expected) {
  if (party(relationship, organizationId) !== expected) {
    throw httpError(403, `Only the ${expected} organization can perform this action`);
  }
}

const loadOrganizationAccess = route(async (req, res, next) => {
  const organizationId = clean(req.params.organizationId);
  const organization = await query(
    "select id, status from organizations where id = $1",
    [organizationId],
  );
  if (!organization.rows[0]) {
    return res.status(404).json({ error: "Organization not found" });
  }
  if (!isPlatformAdmin(req.auth)) {
    const serviceOwner = req.auth?.principalType === "service_account"
      && req.auth.serviceAccount?.organizationId === organizationId;
    const membership = req.auth?.user?.id
      ? await query(
        `select 1
         from organization_memberships
         where organization_id = $1 and user_id = $2 and status = 'active'
           and (expires_at is null or expires_at > now())`,
        [organizationId, req.auth.user.id],
      )
      : { rows: [] };
    const identityAllowed = await organizationIdentityAllows(req.auth, organizationId);
    const supportPermissions = await organizationPermissions(req.auth, organizationId);
    if (
      organization.rows[0].status !== "active"
      || !identityAllowed
      || (!serviceOwner && !membership.rows[0] && !supportPermissions.length)
    ) {
      return res.status(403).json({ error: "You do not have access to this organization" });
    }
  }
  req.authorizedOrganizationId = organizationId;
  req.organizationPermissions = await organizationPermissions(req.auth, organizationId);
  return next();
});

async function hasProjectWorkPermission(req, workOrder, permission) {
  if (req.organizationPermissions?.includes(permission)) return true;
  if (workOrder.customer_organization_id !== req.authorizedOrganizationId) return false;
  const permissions = await projectPermissions(
    req.auth,
    {
      id: workOrder.project_id,
      businessUnitId: workOrder.business_unit_id,
      organizationId: workOrder.customer_organization_id,
    },
    {
      locale: workOrder.target_locale || null,
      allowUnknownLocale: !workOrder.target_locale,
    },
  );
  req.projectWorkPermissions ||= new Map();
  req.projectWorkPermissions.set(workOrder.project_id, new Set(permissions));
  return permissions.includes(permission);
}

async function requireProjectWorkPermission(req, workOrder, permission) {
  if (!(await hasProjectWorkPermission(req, workOrder, permission))) {
    throw httpError(403, "You do not have permission for this work order");
  }
}

function hasWorkResponsePermission(req, workOrder, permission) {
  return req.organizationPermissions?.includes(permission)
    || req.workOrderPermissions?.get(workOrder.id)?.has(permission)
    || req.projectWorkPermissions?.get(workOrder.projectId)?.has(permission)
    || false;
}

async function visibleWorkOrderIds(req, relationship, candidates) {
  if (req.organizationPermissions?.includes("work_orders.view")) {
    return new Set(candidates.map((candidate) => candidate.id));
  }
  if (
    relationship.customer_organization_id !== req.authorizedOrganizationId
    || !candidates.length
  ) {
    return new Set();
  }
  const candidateIds = candidates.map((candidate) => candidate.id);
  let permissions;
  if (req.auth?.principalType === "service_account") {
    permissions = await query(
      `select distinct work_order.id as "workOrderId", permission.key
       from work_orders work_order
       join projects project on project.id = work_order.project_id
       join business_units business_unit on business_unit.id = project.business_unit_id
       join role_assignments assignment on (
         (assignment.scope_type = 'project' and assignment.scope_id = project.id)
         or (
           assignment.inherit_to_children
           and assignment.scope_type = 'business_unit'
           and assignment.scope_id = business_unit.id
         )
         or (
           assignment.inherit_to_children
           and assignment.scope_type = 'organization'
           and assignment.scope_id = business_unit.organization_id
         )
       )
       join role_permissions role_permission
         on role_permission.role_id = assignment.role_id
       join permissions permission on permission.id = role_permission.permission_id
       join service_accounts account
         on account.id = $2
        and account.organization_id = business_unit.organization_id
        and account.status = 'active'
       where work_order.id = any($1::uuid[])
         and assignment.principal_type = 'service_account'
         and assignment.principal_id = account.id
         and assignment.revoked_at is null
         and (assignment.expires_at is null or assignment.expires_at > now())
         and (
           not (assignment.conditions ? 'locales')
           or assignment.conditions->'locales' ? work_order.target_locale
           or work_order.target_locale is null
         )`,
      [candidateIds, req.auth.serviceAccount.id],
    );
  } else if (req.auth?.user?.id) {
    permissions = await query(
      `with active_membership as (
         select membership.id
         from organization_memberships membership
         where membership.user_id = $2 and membership.organization_id = $3
           and membership.status = 'active'
           and (membership.expires_at is null or membership.expires_at > now())
       ),
       active_teams as (
         select team_membership.team_id
         from team_memberships team_membership
         where team_membership.organization_membership_id in (
           select id from active_membership
         )
       )
       select distinct work_order.id as "workOrderId", permission.key
       from work_orders work_order
       join projects project on project.id = work_order.project_id
       join business_units business_unit on business_unit.id = project.business_unit_id
       join organizations organization
         on organization.id = business_unit.organization_id
        and organization.status = 'active'
       join role_assignments assignment on (
         (assignment.scope_type = 'project' and assignment.scope_id = project.id)
         or (
           assignment.inherit_to_children
           and assignment.scope_type = 'business_unit'
           and assignment.scope_id = business_unit.id
         )
         or (
           assignment.inherit_to_children
           and assignment.scope_type = 'organization'
           and assignment.scope_id = business_unit.organization_id
         )
       )
       join role_permissions role_permission
         on role_permission.role_id = assignment.role_id
       join permissions permission on permission.id = role_permission.permission_id
       where work_order.id = any($1::uuid[])
         and exists(select 1 from active_membership)
         and (
           (assignment.principal_type = 'user' and assignment.principal_id = $2)
           or (
             assignment.principal_type = 'team'
             and assignment.principal_id in (select team_id from active_teams)
           )
         )
         and assignment.revoked_at is null
         and (assignment.expires_at is null or assignment.expires_at > now())
         and (
           not (assignment.conditions ? 'locales')
           or assignment.conditions->'locales' ? work_order.target_locale
           or work_order.target_locale is null
         )`,
      [candidateIds, req.auth.user.id, req.authorizedOrganizationId],
    );
  } else {
    return new Set();
  }
  req.workOrderPermissions = new Map();
  for (const row of permissions.rows) {
    const keys = req.workOrderPermissions.get(row.workOrderId) || new Set();
    keys.add(row.key);
    req.workOrderPermissions.set(row.workOrderId, keys);
  }
  return new Set(
    [...req.workOrderPermissions]
      .filter(([, keys]) => keys.has("work_orders.view"))
      .map(([workOrderId]) => workOrderId),
  );
}

async function relationshipForParty(client, relationshipId, organizationId, { lock = false } = {}) {
  const result = await client.query(
    `select relationship.*, customer.name as customer_name, agency.name as agency_name
     from vendor_relationships relationship
     join organizations customer on customer.id = relationship.customer_organization_id
     join organizations agency on agency.id = relationship.agency_organization_id
     where relationship.id = $1
       and (
         relationship.customer_organization_id = $2
         or relationship.agency_organization_id = $2
       )
     ${lock ? "for update of relationship" : ""}`,
    [relationshipId, organizationId],
  );
  if (!result.rows[0]) throw httpError(404, "Vendor relationship not found");
  return result.rows[0];
}

async function workOrderForParty(
  client,
  relationshipId,
  workOrderId,
  organizationId,
  { lock = false } = {},
) {
  const result = await client.query(
    `select work_order.*, relationship.customer_organization_id,
            relationship.agency_organization_id,
            relationship.status as relationship_status,
            relationship.agency_may_assign_linguists,
            customer.name as customer_name, agency.name as agency_name,
            project.name as project_name,
            project.business_unit_id, business_unit.name as business_unit_name
     from work_orders work_order
     join vendor_relationships relationship
       on relationship.id = work_order.vendor_relationship_id
     join organizations customer on customer.id = relationship.customer_organization_id
     join organizations agency on agency.id = relationship.agency_organization_id
     join projects project on project.id = work_order.project_id
     join business_units business_unit on business_unit.id = project.business_unit_id
     where work_order.id = $1
       and work_order.vendor_relationship_id = $2
       and (
         relationship.customer_organization_id = $3
         or relationship.agency_organization_id = $3
       )
     ${lock ? "for update of work_order, relationship" : ""}`,
    [workOrderId, relationshipId, organizationId],
  );
  if (!result.rows[0]) throw httpError(404, "Work order not found");
  return result.rows[0];
}

async function auditForOrganization(
  client,
  req,
  organizationId,
  action,
  resourceType,
  resourceId,
  beforeState,
  afterState,
) {
  await auditRequest(client, req, {
    organizationId,
    action,
    resourceType,
    resourceId,
    beforeState,
    afterState,
  });
}

async function auditRelationship(
  client,
  req,
  relationship,
  action,
  resourceType,
  resourceId,
  beforeState,
  afterState,
) {
  for (const organizationId of [
    relationship.customer_organization_id,
    relationship.agency_organization_id,
  ]) {
    await auditForOrganization(
      client,
      req,
      organizationId,
      action,
      resourceType,
      resourceId,
      beforeState,
      afterState,
    );
  }
}

function workOrderInput(body, defaults = {}) {
  const unitType = clean(body.unitType || defaults.unitType || "source_word");
  if (!unitTypes.has(unitType)) throw httpError(400, "unitType is unsupported");
  const dueAt = body.dueAt == null || body.dueAt === ""
    ? defaults.dueAt || null
    : optionalTimestamp(body.dueAt, "dueAt");
  return {
    title: bounded(body.title ?? defaults.title, "title", 200, { required: true }),
    description: bounded(body.description ?? defaults.description, "description", 5000),
    serviceType: bounded(
      body.serviceType ?? defaults.serviceType,
      "serviceType",
      100,
      { required: true, lower: true },
    ),
    sourceLocale: locale(body.sourceLocale ?? defaults.sourceLocale, "sourceLocale"),
    targetLocale: locale(body.targetLocale ?? defaults.targetLocale, "targetLocale", true),
    contentClassification: bounded(
      body.contentClassification ?? defaults.contentClassification,
      "contentClassification",
      100,
      { lower: true },
    ),
    matchBand: bounded(body.matchBand ?? defaults.matchBand, "matchBand", 100, { lower: true }),
    unitType,
    estimatedUnits: decimal(body.estimatedUnits ?? defaults.estimatedUnits, "estimatedUnits"),
    dueAt,
  };
}

async function validateProjectAndItems(client, relationship, projectId, inputIds) {
  if (!isUuid(projectId)) throw httpError(400, "projectId is invalid");
  if (!Array.isArray(inputIds) || inputIds.length > 2000) {
    throw httpError(400, "sourceStringIds must be an array with at most 2,000 entries");
  }
  const sourceStringIds = [...new Set(inputIds.map(clean).filter(Boolean))];
  if (sourceStringIds.some((id) => !isUuid(id))) {
    throw httpError(400, "sourceStringIds contains an invalid identifier");
  }
  const project = await client.query(
    `select project.id, project.business_unit_id
     from projects project
     join business_units business_unit on business_unit.id = project.business_unit_id
     where project.id = $1
       and business_unit.organization_id = $2
       and exists(
         select 1 from vendor_relationship_scopes scope
         where scope.vendor_relationship_id = $3
           and (
             (scope.scope_type = 'project' and scope.scope_id = project.id)
             or (scope.scope_type = 'business_unit' and scope.scope_id = project.business_unit_id)
           )
       )`,
    [projectId, relationship.customer_organization_id, relationship.id],
  );
  if (!project.rows[0]) {
    throw httpError(400, "Project is not owned by the customer and inside the relationship scope");
  }
  if (sourceStringIds.length) {
    const count = await client.query(
      `select count(*)::int as count
       from source_strings
       where project_id = $1 and id = any($2::uuid[])`,
      [projectId, sourceStringIds],
    );
    if (count.rows[0].count !== sourceStringIds.length) {
      throw httpError(400, "Every source string must belong to the work-order project");
    }
  }
  return { project: project.rows[0], sourceStringIds };
}

async function replaceWorkOrderItems(client, workOrderId, sourceStringIds) {
  await client.query("delete from work_order_items where work_order_id = $1", [workOrderId]);
  for (const sourceStringId of sourceStringIds) {
    await client.query(
      "insert into work_order_items(work_order_id, source_string_id) values($1, $2)",
      [workOrderId, sourceStringId],
    );
  }
}

async function selectApplicableRate(client, workOrder) {
  const result = await client.query(
    `select card.id as rate_card_id, line.id as rate_card_line_id,
            card.currency, card.payment_terms_days, card.minimum_charge_minor,
            line.unit_rate, line.minimum_units
     from rate_cards card
     join rate_card_lines line on line.rate_card_id = card.id
     where card.vendor_relationship_id = $1
       and card.status = 'approved'
       and (card.effective_from is null or card.effective_from <= current_date)
       and (card.effective_to is null or card.effective_to >= current_date)
       and lower(line.service_type) = lower($2)
       and line.unit_type = $3
       and (line.project_id is null or line.project_id = $4)
       and (line.business_unit_id is null or line.business_unit_id = $5)
       and (line.target_locale is null or lower(line.target_locale) = lower($6))
       and (line.source_locale is null or lower(line.source_locale) = lower($7))
       and (line.content_type is null or lower(line.content_type) = lower($8))
       and (line.match_band is null or lower(line.match_band) = lower($9))
     order by
       (line.project_id is not null) desc,
       (line.business_unit_id is not null) desc,
       (line.target_locale is not null) desc,
       (line.source_locale is not null) desc,
       (line.content_type is not null) desc,
       (line.match_band is not null) desc,
       line.id
     limit 1`,
    [
      workOrder.vendor_relationship_id,
      workOrder.service_type,
      workOrder.unit_type,
      workOrder.project_id,
      workOrder.business_unit_id,
      workOrder.target_locale,
      workOrder.source_locale,
      workOrder.content_classification,
      workOrder.match_band,
    ],
  );
  if (!result.rows[0]) {
    throw httpError(409, "No current approved rate-card line matches this work order");
  }
  return result.rows[0];
}

function groupedRows(rows, key = "_workOrderId") {
  const groups = new Map();
  for (const row of rows) {
    const groupId = row[key];
    const values = groups.get(groupId) || [];
    const { [key]: _groupId, ...value } = row;
    values.push(value);
    groups.set(groupId, values);
  }
  return groups;
}

async function workOrderDetailsBatch(client, workOrderIds) {
  const uniqueIds = [...new Set(workOrderIds)];
  if (!uniqueIds.length) return [];
  const order = await client.query(
    `select work_order.*, project.name as "projectName",
            business_unit.name as "businessUnitName",
            customer.name as "customerName", agency.name as "agencyName"
     from work_orders work_order
     join vendor_relationships relationship
       on relationship.id = work_order.vendor_relationship_id
     join organizations customer on customer.id = relationship.customer_organization_id
     join organizations agency on agency.id = relationship.agency_organization_id
     join projects project on project.id = work_order.project_id
     join business_units business_unit on business_unit.id = project.business_unit_id
     where work_order.id = any($1::uuid[])
     order by work_order.work_order_number desc`,
    [uniqueIds],
  );
  const items = await client.query(
      `select item.work_order_id as "_workOrderId", item.id,
              item.source_string_id as "sourceStringId",
              source.source_text as "sourceTextForCount"
       from work_order_items item
       join source_strings source on source.id = item.source_string_id
       where item.work_order_id = any($1::uuid[])
       order by item.work_order_id, item.created_at, item.id`,
    [uniqueIds],
  );
  const assignments = await client.query(
      `select assignment.work_order_id as "_workOrderId", assignment.id,
              assignment.agency_membership_id as "agencyMembershipId",
              assignment.assignment_role as "assignmentRole", assignment.status,
              assignment.assigned_by_party as "assignedByParty",
              assignment.assigned_at as "assignedAt",
              user_account.email, user_account.display_name as "displayName"
       from work_assignments assignment
       join organization_memberships membership
         on membership.id = assignment.agency_membership_id
       join users user_account on user_account.id = membership.user_id
       where assignment.work_order_id = any($1::uuid[])
       order by assignment.work_order_id, assignment.created_at`,
    [uniqueIds],
  );
  const submissions = await client.query(
      `select work_order_id as "_workOrderId", id,
              work_assignment_id as "workAssignmentId",
              delivered_units::text as "deliveredUnits", notes,
              quality_status as "qualityStatus", quality_reason as "qualityReason",
              quality_decided_at as "qualityDecidedAt", created_at as "createdAt"
       from work_submissions
       where work_order_id = any($1::uuid[])
       order by work_order_id, created_at desc`,
    [uniqueIds],
  );
  const ledger = await client.query(
      `select work_order_id as "_workOrderId", id, entry_type as "entryType",
              quantity::text, unit_type as "unitType", unit_rate::text as "unitRate",
              amount_minor::text as "amountMinor", currency, reason,
              created_at as "createdAt"
       from work_ledger_entries
       where work_order_id = any($1::uuid[])
       order by work_order_id, created_at`,
    [uniqueIds],
  );
  const disputes = await client.query(
      `select work_order_id as "_workOrderId", id,
              opened_by_party as "openedByParty", reason, status, resolution,
              resolved_at as "resolvedAt", created_at as "createdAt"
       from work_order_disputes
       where work_order_id = any($1::uuid[])
       order by work_order_id, created_at desc`,
    [uniqueIds],
  );
  const itemsByOrder = groupedRows(items.rows);
  const assignmentsByOrder = groupedRows(assignments.rows);
  const submissionsByOrder = groupedRows(submissions.rows);
  const ledgerByOrder = groupedRows(ledger.rows);
  const disputesByOrder = groupedRows(disputes.rows);
  return order.rows.map((row) => {
    const detailItems = itemsByOrder.get(row.id) || [];
    const detailAssignments = assignmentsByOrder.get(row.id) || [];
    const detailSubmissions = submissionsByOrder.get(row.id) || [];
    const detailLedger = ledgerByOrder.get(row.id) || [];
    const detailDisputes = disputesByOrder.get(row.id) || [];
    const publicItems = detailItems.map(({ sourceTextForCount: _sourceText, ...item }) => item);
    return {
      id: row.id,
      vendorRelationshipId: row.vendor_relationship_id,
      workOrderNumber: row.work_order_number,
      projectId: row.project_id,
      projectName: row.projectName,
      businessUnitName: row.businessUnitName,
      customerName: row.customerName,
      agencyName: row.agencyName,
      title: row.title,
      description: row.description,
      serviceType: row.service_type,
      sourceLocale: row.source_locale,
      targetLocale: row.target_locale,
      contentClassification: row.content_classification,
      matchBand: row.match_band,
      unitType: row.unit_type,
      estimatedUnits: row.estimated_units,
      dueAt: row.due_at,
      status: row.status,
      rateCardId: row.rate_card_id,
      rateCardLineId: row.rate_card_line_id,
      snapshotCurrency: row.snapshot_currency,
      snapshotCurrencyExponent: row.snapshot_currency_exponent,
      snapshotUnitRate: row.snapshot_unit_rate,
      snapshotMinimumUnits: row.snapshot_minimum_units,
      snapshotMinimumChargeMinor: row.snapshot_minimum_charge_minor,
      snapshotPaymentTermsDays: row.snapshot_payment_terms_days,
      cancellationReason: row.cancellation_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items: publicItems,
      assignments: detailAssignments,
      submissions: detailSubmissions,
      deliveryReview: deliveryReview(row, detailItems, detailSubmissions),
      ledger: detailLedger,
      disputes: detailDisputes,
      payableTotalMinor: detailLedger.reduce(
        (total, entry) => total + BigInt(entry.amountMinor),
        0n,
      ).toString(),
    };
  });
}

async function workOrderDetails(client, workOrderId) {
  const workOrder = (await workOrderDetailsBatch(client, [workOrderId]))[0];
  if (!workOrder) throw httpError(404, "Work order not found");
  return workOrder;
}

function workOrderForResponse(req, workOrder) {
  const response = structuredClone(workOrder);
  if (
    !hasWorkResponsePermission(req, workOrder, "work_orders.manage")
    && !hasWorkResponsePermission(req, workOrder, "quality.approve")
  ) {
    delete response.description;
    response.submissions = response.submissions.map((submission) => {
      const redacted = { ...submission };
      delete redacted.notes;
      delete redacted.qualityReason;
      return redacted;
    });
  }
  if (!req.organizationPermissions?.includes("rate_cards.view")) {
    for (const field of [
      "rateCardId",
      "rateCardLineId",
      "snapshotCurrency",
      "snapshotCurrencyExponent",
      "snapshotUnitRate",
      "snapshotMinimumUnits",
      "snapshotMinimumChargeMinor",
      "snapshotPaymentTermsDays",
    ]) {
      delete response[field];
    }
  }
  if (!req.organizationPermissions?.includes("payables.view")) {
    delete response.ledger;
    delete response.payableTotalMinor;
    delete response.disputes;
  }
  return response;
}

async function insertApprovedDeliveryLedger(client, workOrder, submission, actorId) {
  const amount = await client.query(
    `select greatest(
       round(
         greatest($1::numeric, coalesce($2::numeric, 0))
         * $3::numeric
         * power(10::numeric, $4::integer)
       )::bigint,
       coalesce($5::bigint, 0)
     ) as amount_minor`,
    [
      submission.delivered_units,
      workOrder.snapshot_minimum_units,
      workOrder.snapshot_unit_rate,
      workOrder.snapshot_currency_exponent,
      workOrder.snapshot_minimum_charge_minor,
    ],
  );
  const result = await client.query(
    `insert into work_ledger_entries(
       work_order_id, work_submission_id, entry_type, quantity, unit_type,
       unit_rate, amount_minor, currency, idempotency_key, created_by_user_id
     ) values($1, $2, 'approved_delivery', $3, $4, $5, $6, $7, $8, $9)
     on conflict(work_order_id, idempotency_key) do nothing
     returning *`,
    [
      workOrder.id,
      submission.id,
      submission.delivered_units,
      workOrder.unit_type,
      workOrder.snapshot_unit_rate,
      amount.rows[0].amount_minor,
      workOrder.snapshot_currency,
      `quality-approval:${submission.id}`,
      actorId,
    ],
  );
  return result.rows[0];
}

function denyWorkAccess(res, access) {
  return res.status(403).json({
    error: access.contentAccess.message,
    code: access.contentAccess.code,
    denialReasons: access.denialReasons,
  });
}

async function assertStatementHasNoOpenDisputes(client, statementId) {
  const openDispute = await client.query(
    `select 1
     from payable_statement_items item
     join work_order_disputes dispute
       on dispute.work_order_id = item.work_order_id
      and dispute.status = 'open'
     where item.payable_statement_id = $1
     limit 1`,
    [statementId],
  );
  if (openDispute.rows[0]) {
    throw httpError(409, "Resolve all work-order disputes before continuing");
  }
}

export async function settleStatementIfPaid(client, statementId) {
  const totals = await client.query(
    `select statement.status, statement.subtotal_minor,
            coalesce(sum(payment.amount_minor) filter (
              where payment.status = 'confirmed'
            ), 0)::bigint as confirmed_minor
     from payable_statements statement
     left join payment_records payment
       on payment.payable_statement_id = statement.id
     where statement.id = $1
     group by statement.id`,
    [statementId],
  );
  const row = totals.rows[0];
  if (
    row?.status !== "finalized"
    || BigInt(row.confirmed_minor) !== BigInt(row.subtotal_minor)
  ) {
    return false;
  }
  await client.query(
    `update payable_statements set status = 'paid', paid_at = now(), updated_at = now()
     where id = $1`,
    [statementId],
  );
  await client.query(
    `update work_orders set status = 'paid', updated_at = now()
     where id in (
       select work_order_id from payable_statement_items
       where payable_statement_id = $1
     )`,
    [statementId],
  );
  return true;
}

async function lockPersonalAssignment(client, assignmentId, userId) {
  const reference = await client.query(
    `select work_order.vendor_relationship_id,
            relationship.customer_organization_id,
            relationship.agency_organization_id,
            assignment.agency_membership_id
     from work_assignments assignment
     join organization_memberships membership
       on membership.id = assignment.agency_membership_id
     join work_orders work_order on work_order.id = assignment.work_order_id
     join vendor_relationships relationship
       on relationship.id = work_order.vendor_relationship_id
     where assignment.id = $1 and membership.user_id = $2`,
    [assignmentId, userId],
  );
  if (!reference.rows[0]) throw httpError(404, "Work assignment not found");
  const facts = reference.rows[0];
  // Administrative paths lock the relationship before the order. Preserve that
  // ordering here so personal work and admin decisions cannot deadlock.
  await client.query(
    "select id from vendor_relationships where id = $1 for share",
    [facts.vendor_relationship_id],
  );
  const locked = await client.query(
    `select work_order.*
     from work_assignments assignment
     join work_orders work_order on work_order.id = assignment.work_order_id
     where assignment.id = $1
     for update of assignment, work_order`,
    [assignmentId],
  );
  await client.query(
    `select organization.id
     from organizations organization
     where organization.id = any($1::uuid[])
     order by organization.id
     for share`,
    [[facts.customer_organization_id, facts.agency_organization_id]],
  );
  await client.query(
    `select membership.id
     from organization_memberships membership
     join users user_account on user_account.id = membership.user_id
     where membership.id = $1 and membership.user_id = $2
     for share of membership, user_account`,
    [facts.agency_membership_id, userId],
  );
  await client.query(
    `select team_membership.team_id
     from team_memberships team_membership
     where team_membership.organization_membership_id = $1
     order by team_membership.team_id
     for share`,
    [facts.agency_membership_id],
  );
  await client.query(
    `select assignment.id
     from role_assignments assignment
     where (
         assignment.principal_type = 'user'
         and assignment.principal_id = $1
       )
       or (
         assignment.principal_type = 'team'
         and assignment.principal_id in (
           select team_id from team_memberships
           where organization_membership_id = $2
         )
       )
     order by assignment.id
     for share`,
    [userId, facts.agency_membership_id],
  );
  await client.query(
    `select approval.id
     from vendor_approved_linguists approval
     where approval.vendor_relationship_id = $1
       and approval.agency_membership_id = $2
     for share`,
    [facts.vendor_relationship_id, facts.agency_membership_id],
  );
  return locked.rows[0];
}

adminRouter.get(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/work-orders",
  loadOrganizationAccess,
  route(async (req, res) => {
    const relationship = await relationshipForParty(
      { query },
      req.params.vendorRelationshipId,
      req.authorizedOrganizationId,
    );
    const organizationWide = req.organizationPermissions?.includes("work_orders.view");
    const beforeWorkOrderNumber = positiveCursor(
      req.query.beforeWorkOrderNumber,
      "beforeWorkOrderNumber",
    );
    const result = await query(
      `select work_order.id, work_order.project_id as "projectId",
              project.business_unit_id as "businessUnitId",
              work_order.target_locale as "targetLocale"
       from work_orders work_order
       join projects project on project.id = work_order.project_id
       where work_order.vendor_relationship_id = $1
         and ($2::bigint is null or work_order.work_order_number < $2)
       order by work_order.work_order_number desc
       ${organizationWide ? "limit 251" : ""}`,
      [relationship.id, beforeWorkOrderNumber],
    );
    const visibleIds = await visibleWorkOrderIds(req, relationship, result.rows);
    const visibleRows = result.rows.filter((row) => visibleIds.has(row.id));
    const selectedRows = visibleRows.slice(0, 250);
    const workOrders = await workOrderDetailsBatch(
      { query },
      selectedRows.map((row) => row.id),
    );
    if (
      !req.organizationPermissions?.includes("work_orders.view")
      && workOrders.length === 0
    ) {
      throw httpError(403, "You do not have permission to view work orders");
    }
    res.json({
      workOrders: workOrders.map((workOrder) => workOrderForResponse(req, workOrder)),
      page: {
        limit: 250,
        hasMore: visibleRows.length > 250,
        nextBeforeWorkOrderNumber: visibleRows.length > 250
          ? String(workOrders.at(-1)?.workOrderNumber || "")
          : null,
      },
    });
  }),
);

adminRouter.post(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/work-orders",
  loadOrganizationAccess,
  route(async (req, res) => {
    const workOrder = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      requireParty(relationship, req.authorizedOrganizationId, "customer");
      if (relationship.status !== "active") throw httpError(409, "The vendor relationship must be active");
      const input = workOrderInput(req.body || {});
      const validated = await validateProjectAndItems(
        client,
        relationship,
        clean(req.body.projectId),
        req.body.sourceStringIds || [],
      );
      await requireProjectWorkPermission(req, {
        project_id: validated.project.id,
        business_unit_id: validated.project.business_unit_id,
        customer_organization_id: relationship.customer_organization_id,
        target_locale: input.targetLocale,
      }, "work_orders.manage");
      const created = await client.query(
        `insert into work_orders(
           vendor_relationship_id, work_order_number, project_id, title,
           description, service_type, source_locale, target_locale,
           content_classification, match_band, unit_type, estimated_units,
           due_at, created_by_user_id
         ) values(
           $1,
           (select coalesce(max(work_order_number), 0) + 1
            from work_orders where vendor_relationship_id = $1),
           $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
         ) returning id`,
        [
          relationship.id,
          validated.project.id,
          input.title,
          input.description,
          input.serviceType,
          input.sourceLocale,
          input.targetLocale,
          input.contentClassification,
          input.matchBand,
          input.unitType,
          input.estimatedUnits,
          input.dueAt,
          req.auth?.user?.id || null,
        ],
      );
      await replaceWorkOrderItems(client, created.rows[0].id, validated.sourceStringIds);
      const after = await workOrderDetails(client, created.rows[0].id);
      await auditRelationship(
        client,
        req,
        relationship,
        "work_order.created",
        "work_order",
        created.rows[0].id,
        null,
        after,
      );
      return after;
    });
    res.status(201).json({ workOrder: workOrderForResponse(req, workOrder) });
  }),
);

adminRouter.put(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/work-orders/:workOrderId",
  loadOrganizationAccess,
  route(async (req, res) => {
    const workOrder = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      requireParty(relationship, req.authorizedOrganizationId, "customer");
      const beforeRow = await workOrderForParty(
        client,
        relationship.id,
        req.params.workOrderId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      await requireProjectWorkPermission(req, beforeRow, "work_orders.manage");
      if (beforeRow.status !== "draft") throw httpError(409, "Only a draft work order can be edited");
      const before = await workOrderDetails(client, beforeRow.id);
      const input = workOrderInput(req.body || {}, {
        title: beforeRow.title,
        description: beforeRow.description,
        serviceType: beforeRow.service_type,
        sourceLocale: beforeRow.source_locale,
        targetLocale: beforeRow.target_locale,
        contentClassification: beforeRow.content_classification,
        matchBand: beforeRow.match_band,
        unitType: beforeRow.unit_type,
        estimatedUnits: beforeRow.estimated_units,
        dueAt: beforeRow.due_at,
      });
      const validated = await validateProjectAndItems(
        client,
        relationship,
        clean(req.body.projectId || beforeRow.project_id),
        req.body.sourceStringIds || before.items.map((item) => item.sourceStringId),
      );
      await requireProjectWorkPermission(req, {
        project_id: validated.project.id,
        business_unit_id: validated.project.business_unit_id,
        customer_organization_id: relationship.customer_organization_id,
        target_locale: input.targetLocale,
      }, "work_orders.manage");
      await client.query(
        `update work_orders set
           project_id = $2, title = $3, description = $4, service_type = $5,
           source_locale = $6, target_locale = $7, content_classification = $8,
           match_band = $9, unit_type = $10, estimated_units = $11,
           due_at = $12, updated_at = now()
         where id = $1`,
        [
          beforeRow.id,
          validated.project.id,
          input.title,
          input.description,
          input.serviceType,
          input.sourceLocale,
          input.targetLocale,
          input.contentClassification,
          input.matchBand,
          input.unitType,
          input.estimatedUnits,
          input.dueAt,
        ],
      );
      await replaceWorkOrderItems(client, beforeRow.id, validated.sourceStringIds);
      const after = await workOrderDetails(client, beforeRow.id);
      await auditRelationship(
        client,
        req,
        relationship,
        "work_order.updated",
        "work_order",
        beforeRow.id,
        before,
        after,
      );
      return after;
    });
    res.json({ workOrder: workOrderForResponse(req, workOrder) });
  }),
);

adminRouter.post(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/work-orders/:workOrderId/transitions",
  loadOrganizationAccess,
  route(async (req, res) => {
    const action = clean(req.body?.action);
    if (!["offer", "accept", "quality_approve", "quality_reject", "payable_approve", "cancel"].includes(action)) {
      throw httpError(400, "Unsupported work-order transition");
    }
    const requiredPermission = {
      offer: "work_orders.manage",
      accept: "work_orders.manage",
      quality_approve: "quality.approve",
      quality_reject: "quality.approve",
      payable_approve: "payables.approve",
      cancel: "work_orders.manage",
    }[action];
    const reason = ["quality_reject", "cancel"].includes(action)
      ? bounded(req.body.reason, "reason", 2000, { required: true })
      : null;
    const workOrder = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      const before = await workOrderForParty(
        client,
        relationship.id,
        req.params.workOrderId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      if (action === "payable_approve") {
        if (!req.organizationPermissions?.includes(requiredPermission)) {
          throw httpError(403, "Payable approval requires organization-scoped permission");
        }
      } else {
        await requireProjectWorkPermission(req, before, requiredPermission);
      }
      const beforeState = await workOrderDetails(client, before.id);
      const actorId = req.auth?.user?.id || null;
      let targetStatus;
      if (action === "offer") {
        requireParty(relationship, req.authorizedOrganizationId, "customer");
        if (before.status !== "draft") throw httpError(409, "Only a draft can be offered");
        if (!beforeState.items.length) throw httpError(409, "A work order needs at least one source string");
        const rate = await selectApplicableRate(client, before);
        targetStatus = "offered";
        await client.query(
          `update work_orders set
             status = 'offered', rate_card_id = $2, rate_card_line_id = $3,
             snapshot_currency = $4, snapshot_currency_exponent = $5,
             snapshot_unit_rate = $6, snapshot_minimum_units = $7,
             snapshot_minimum_charge_minor = $8,
             snapshot_payment_terms_days = $9,
             offered_by_user_id = $10, offered_at = now(), updated_at = now()
           where id = $1`,
          [
            before.id,
            rate.rate_card_id,
            rate.rate_card_line_id,
            rate.currency,
            currencyExponent(rate.currency),
            rate.unit_rate,
            rate.minimum_units,
            rate.minimum_charge_minor,
            rate.payment_terms_days,
            actorId,
          ],
        );
      } else if (action === "accept") {
        requireParty(relationship, req.authorizedOrganizationId, "agency");
        if (before.status !== "offered") throw httpError(409, "Only an offered work order can be accepted");
        if (relationship.status !== "active") throw httpError(409, "The relationship must be active");
        targetStatus = "accepted";
        await client.query(
          `update work_orders set status = 'accepted', accepted_by_user_id = $2,
             accepted_at = now(), updated_at = now()
           where id = $1`,
          [before.id, actorId],
        );
      } else if (action === "quality_approve" || action === "quality_reject") {
        requireParty(relationship, req.authorizedOrganizationId, "customer");
        if (before.status !== "submitted") throw httpError(409, "Only submitted work can receive a quality decision");
        const submission = await client.query(
          `select * from work_submissions
           where work_order_id = $1 and quality_status = 'pending'
           order by created_at desc limit 1 for update`,
          [before.id],
        );
        if (!submission.rows[0]) throw httpError(409, "No pending delivery submission exists");
        if (action === "quality_approve") {
          targetStatus = "quality_approved";
          await client.query(
            `update work_submissions set quality_status = 'approved',
               quality_decided_by_user_id = $2, quality_decided_at = now()
             where id = $1`,
            [submission.rows[0].id, actorId],
          );
          await insertApprovedDeliveryLedger(client, before, submission.rows[0], actorId);
          await client.query(
            `update work_orders set status = 'quality_approved',
               quality_approved_by_user_id = $2, quality_approved_at = now(),
               updated_at = now()
             where id = $1`,
            [before.id, actorId],
          );
          await client.query(
            `update work_assignments set status = 'completed', updated_at = now()
             where work_order_id = $1 and status = 'active'`,
            [before.id],
          );
        } else {
          targetStatus = "in_progress";
          await client.query(
            `update work_submissions set quality_status = 'rejected',
               quality_reason = $2, quality_decided_by_user_id = $3,
               quality_decided_at = now()
             where id = $1`,
            [submission.rows[0].id, reason, actorId],
          );
          await client.query(
            `update work_orders set status = 'in_progress', submitted_at = null,
               updated_at = now()
             where id = $1`,
            [before.id],
          );
        }
      } else if (action === "payable_approve") {
        requireParty(relationship, req.authorizedOrganizationId, "customer");
        if (before.status !== "quality_approved") {
          throw httpError(409, "Quality approval is required before payable approval");
        }
        const openDispute = await client.query(
          "select 1 from work_order_disputes where work_order_id = $1 and status = 'open'",
          [before.id],
        );
        if (openDispute.rows[0]) throw httpError(409, "Resolve the open dispute before payable approval");
        targetStatus = "payable_approved";
        await client.query(
          `update work_orders set status = 'payable_approved',
             payable_approved_by_user_id = $2, payable_approved_at = now(),
             updated_at = now()
           where id = $1`,
          [before.id, actorId],
        );
      } else {
        const currentParty = party(relationship, req.authorizedOrganizationId);
        const cancelable = currentParty === "customer"
          ? ["draft", "offered", "accepted", "in_progress"]
          : ["offered", "accepted"];
        if (!cancelable.includes(before.status)) {
          throw httpError(409, `The ${currentParty} cannot cancel a ${before.status} work order`);
        }
        targetStatus = "canceled";
        await client.query(
          `update work_assignments set status = 'revoked',
             revoked_by_user_id = $2, revoked_at = now(),
             revocation_reason = $3, updated_at = now()
           where work_order_id = $1 and status = 'active'`,
          [before.id, actorId, `Work order canceled: ${reason}`],
        );
        await client.query(
          `update work_orders set status = 'canceled', canceled_by_user_id = $2,
             canceled_at = now(), cancellation_reason = $3, updated_at = now()
           where id = $1`,
          [before.id, actorId, reason],
        );
      }
      const after = await workOrderDetails(client, before.id);
      await auditRelationship(
        client,
        req,
        relationship,
        action === "quality_reject" ? "work_order.quality_rejected" : `work_order.${targetStatus}`,
        "work_order",
        before.id,
        beforeState,
        after,
      );
      return after;
    });
    res.json({ workOrder: workOrderForResponse(req, workOrder) });
  }),
);

adminRouter.post(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/work-orders/:workOrderId/assignments",
  loadOrganizationAccess,
  route(async (req, res) => {
    const agencyMembershipId = clean(req.body.agencyMembershipId);
    if (!isUuid(agencyMembershipId)) throw httpError(400, "agencyMembershipId is invalid");
    const assignmentRole = clean(req.body.assignmentRole || "translator");
    if (!["translator", "reviewer", "lead"].includes(assignmentRole)) {
      throw httpError(400, "assignmentRole is invalid");
    }
    const assignment = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      const workOrder = await workOrderForParty(
        client,
        relationship.id,
        req.params.workOrderId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      await requireProjectWorkPermission(req, workOrder, "work_orders.manage");
      if (!["accepted", "in_progress"].includes(workOrder.status)) {
        throw httpError(409, "Assignments require accepted or in-progress work");
      }
      const assigningParty = party(relationship, req.authorizedOrganizationId);
      if (assigningParty === "agency" && !relationship.agency_may_assign_linguists) {
        throw httpError(403, "This relationship requires customer-managed assignment");
      }
      const eligibility = await evaluateVendorEligibility({
        vendorRelationshipId: relationship.id,
        agencyMembershipId,
        projectId: workOrder.project_id,
        locale: workOrder.target_locale,
        serviceType: workOrder.service_type,
        contentClassification: workOrder.content_classification,
        database: client,
      });
      if (!eligibility.eligibleForAssignment) {
        const error = httpError(409, "The linguist is not eligible for this work order");
        error.details = { denialReasons: eligibility.denialReasons };
        throw error;
      }
      const current = await client.query(
        `select 1 from work_assignments
         where work_order_id = $1 and agency_membership_id = $2 and status = 'active'`,
        [workOrder.id, agencyMembershipId],
      );
      if (current.rows[0]) throw httpError(409, "This linguist already has an active assignment");
      const result = await client.query(
        `insert into work_assignments(
           work_order_id, agency_membership_id, assignment_role,
           assigned_by_party, assigned_by_user_id
         ) values($1, $2, $3, $4, $5)
         returning id, work_order_id as "workOrderId",
                   agency_membership_id as "agencyMembershipId",
                   assignment_role as "assignmentRole", status,
                   assigned_by_party as "assignedByParty",
                   assigned_at as "assignedAt"`,
        [
          workOrder.id,
          agencyMembershipId,
          assignmentRole,
          assigningParty,
          req.auth?.user?.id || null,
        ],
      );
      await auditRelationship(
        client,
        req,
        relationship,
        "work_assignment.created",
        "work_assignment",
        result.rows[0].id,
        null,
        result.rows[0],
      );
      return result.rows[0];
    });
    res.status(201).json({ assignment });
  }),
);

adminRouter.patch(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/work-orders/:workOrderId/assignments/:workAssignmentId",
  loadOrganizationAccess,
  route(async (req, res) => {
    const reason = bounded(req.body.reason, "reason", 1000, { required: true });
    const assignment = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      const workOrder = await workOrderForParty(
        client,
        relationship.id,
        req.params.workOrderId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      await requireProjectWorkPermission(req, workOrder, "work_orders.manage");
      if (["submitted", "quality_approved", "payable_approved", "included_in_statement", "paid"].includes(workOrder.status)) {
        throw httpError(409, "Assignments cannot be revoked after delivery submission");
      }
      const before = await client.query(
        `select * from work_assignments
         where id = $1 and work_order_id = $2 for update`,
        [req.params.workAssignmentId, workOrder.id],
      );
      if (!before.rows[0]) throw httpError(404, "Work assignment not found");
      if (before.rows[0].status !== "active") throw httpError(409, "Only an active assignment can be revoked");
      const updated = await client.query(
        `update work_assignments set status = 'revoked', revoked_by_user_id = $2,
           revoked_at = now(), revocation_reason = $3, updated_at = now()
         where id = $1 returning *`,
        [before.rows[0].id, req.auth?.user?.id || null, reason],
      );
      await auditRelationship(
        client,
        req,
        relationship,
        "work_assignment.revoked",
        "work_assignment",
        before.rows[0].id,
        before.rows[0],
        updated.rows[0],
      );
      return updated.rows[0];
    });
    res.json({ assignment });
  }),
);

adminRouter.post(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/work-orders/:workOrderId/adjustments",
  requireOrganizationPermission("payables.approve"),
  route(async (req, res) => {
    const amountMinor = Number(req.body.amountMinor);
    if (!Number.isSafeInteger(amountMinor) || amountMinor === 0) {
      throw httpError(400, "amountMinor must be a non-zero safe integer");
    }
    const reason = bounded(req.body.reason, "reason", 2000, { required: true });
    const idempotencyKey = bounded(req.body.idempotencyKey, "idempotencyKey", 200, { required: true });
    const result = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      requireParty(relationship, req.authorizedOrganizationId, "customer");
      const workOrder = await workOrderForParty(
        client,
        relationship.id,
        req.params.workOrderId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      const existing = await client.query(
        `select * from work_ledger_entries
         where work_order_id = $1 and idempotency_key = $2`,
        [workOrder.id, idempotencyKey],
      );
      if (existing.rows[0]) {
        const entry = existing.rows[0];
        if (
          entry.entry_type !== "adjustment"
          || Number(entry.amount_minor) !== amountMinor
          || entry.reason !== reason
        ) {
          throw httpError(409, "The idempotency key belongs to a different ledger entry");
        }
        return { entry, replayed: true };
      }
      if (!["quality_approved", "payable_approved"].includes(workOrder.status)) {
        throw httpError(409, "Adjustments require quality-approved work outside a statement");
      }
      const statement = await client.query(
        `select 1
         from payable_statement_items item
         join payable_statements statement
           on statement.id = item.payable_statement_id
         where item.work_order_id = $1 and statement.status <> 'void'
         limit 1`,
        [workOrder.id],
      );
      if (statement.rows[0]) {
        throw httpError(409, "Work inside an open statement cannot be adjusted");
      }
      const result = await client.query(
        `insert into work_ledger_entries(
           work_order_id, entry_type, amount_minor, currency, reason,
           idempotency_key, created_by_user_id
         ) values($1, 'adjustment', $2, $3, $4, $5, $6)
         on conflict(work_order_id, idempotency_key) do nothing
         returning *`,
        [
          workOrder.id,
          amountMinor,
          workOrder.snapshot_currency,
          reason,
          idempotencyKey,
          req.auth?.user?.id || null,
        ],
      );
      if (!result.rows[0]) throw httpError(409, "The adjustment was created concurrently; retry it");
      await auditRelationship(
        client,
        req,
        relationship,
        "work_ledger.adjustment_recorded",
        "work_ledger_entry",
        result.rows[0].id,
        null,
        result.rows[0],
      );
      return { entry: result.rows[0], replayed: false };
    });
    if (result.replayed) res.set("Idempotency-Replayed", "true");
    res.status(result.replayed ? 200 : 201).json(result);
  }),
);

adminRouter.post(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/work-orders/:workOrderId/disputes",
  requireOrganizationPermission("disputes.open"),
  route(async (req, res) => {
    const reason = bounded(req.body.reason, "reason", 2000, { required: true });
    const dispute = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      const workOrder = await workOrderForParty(
        client,
        relationship.id,
        req.params.workOrderId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      if (!["quality_approved", "payable_approved", "included_in_statement"].includes(workOrder.status)) {
        throw httpError(409, "A dispute requires quality-approved unpaid work");
      }
      const result = await client.query(
        `insert into work_order_disputes(
           work_order_id, opened_by_party, opened_by_user_id, reason
         ) values($1, $2, $3, $4)
         returning *`,
        [
          workOrder.id,
          party(relationship, req.authorizedOrganizationId),
          req.auth?.user?.id || null,
          reason,
        ],
      );
      await auditRelationship(
        client,
        req,
        relationship,
        "work_order.dispute_opened",
        "work_order_dispute",
        result.rows[0].id,
        null,
        result.rows[0],
      );
      return result.rows[0];
    });
    res.status(201).json({ dispute });
  }),
);

adminRouter.patch(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/work-orders/:workOrderId/disputes/:disputeId",
  requireOrganizationPermission("payables.approve"),
  route(async (req, res) => {
    const status = clean(req.body.status);
    if (!["resolved", "rejected"].includes(status)) throw httpError(400, "status is invalid");
    const resolution = bounded(req.body.resolution, "resolution", 2000, { required: true });
    const dispute = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      requireParty(relationship, req.authorizedOrganizationId, "customer");
      const workOrder = await workOrderForParty(
        client,
        relationship.id,
        req.params.workOrderId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      const before = await client.query(
        `select * from work_order_disputes
         where id = $1 and work_order_id = $2 for update`,
        [req.params.disputeId, workOrder.id],
      );
      if (!before.rows[0]) throw httpError(404, "Dispute not found");
      if (before.rows[0].status !== "open") throw httpError(409, "Only an open dispute can be resolved");
      const updated = await client.query(
        `update work_order_disputes set status = $2, resolution = $3,
           resolved_by_user_id = $4, resolved_at = now(), updated_at = now()
         where id = $1 returning *`,
        [before.rows[0].id, status, resolution, req.auth?.user?.id || null],
      );
      await auditRelationship(
        client,
        req,
        relationship,
        `work_order.dispute_${status}`,
        "work_order_dispute",
        before.rows[0].id,
        before.rows[0],
        updated.rows[0],
      );
      return updated.rows[0];
    });
    res.json({ dispute });
  }),
);

async function statementDetailsBatch(client, statementIds) {
  const uniqueIds = [...new Set(statementIds)];
  if (!uniqueIds.length) return [];
  const statement = await client.query(
    `select statement.*, customer.name as "customerName", agency.name as "agencyName"
     from payable_statements statement
     join vendor_relationships relationship
       on relationship.id = statement.vendor_relationship_id
     join organizations customer on customer.id = relationship.customer_organization_id
     join organizations agency on agency.id = relationship.agency_organization_id
     where statement.id = any($1::uuid[])
     order by statement.statement_number desc`,
    [uniqueIds],
  );
  const items = await client.query(
      `select item.payable_statement_id as "_statementId", item.id,
              item.work_order_id as "workOrderId",
              item.amount_minor::text as "amountMinor",
              item.released_at as "releasedAt",
              work_order.work_order_number as "workOrderNumber",
              work_order.title
       from payable_statement_items item
       join work_orders work_order on work_order.id = item.work_order_id
       where item.payable_statement_id = any($1::uuid[])
       order by item.payable_statement_id, work_order.work_order_number`,
    [uniqueIds],
  );
  const payments = await client.query(
      `select payable_statement_id as "_statementId", id,
              amount_minor::text as "amountMinor", currency, status,
              record_source as "recordSource", payment_method as "paymentMethod",
              external_reference as "externalReference", paid_at as "paidAt",
              reported_by_party as "reportedByParty",
              confirmed_at as "confirmedAt", rejection_reason as "rejectionReason",
              created_at as "createdAt"
       from payment_records
       where payable_statement_id = any($1::uuid[])
       order by payable_statement_id, created_at`,
    [uniqueIds],
  );
  const itemsByStatement = groupedRows(items.rows, "_statementId");
  const paymentsByStatement = groupedRows(payments.rows, "_statementId");
  return statement.rows.map((row) => {
    const detailPayments = paymentsByStatement.get(row.id) || [];
    return {
      id: row.id,
      vendorRelationshipId: row.vendor_relationship_id,
      statementNumber: row.statement_number,
      customerName: row.customerName,
      agencyName: row.agencyName,
      currency: row.currency,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      status: row.status,
      subtotalMinor: String(row.subtotal_minor),
      dueDate: row.due_date,
      notes: row.notes,
      voidReason: row.void_reason,
      createdAt: row.created_at,
      items: itemsByStatement.get(row.id) || [],
      payments: detailPayments,
      confirmedPaymentMinor: detailPayments
        .filter((payment) => payment.status === "confirmed")
        .reduce((total, payment) => total + BigInt(payment.amountMinor), 0n)
        .toString(),
    };
  });
}

async function statementDetails(client, statementId) {
  const statement = (await statementDetailsBatch(client, [statementId]))[0];
  if (!statement) throw httpError(404, "Payable statement not found");
  return statement;
}

adminRouter.get(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/payable-statements",
  requireOrganizationPermission("payables.view"),
  route(async (req, res) => {
    const relationship = await relationshipForParty(
      { query },
      req.params.vendorRelationshipId,
      req.authorizedOrganizationId,
    );
    const beforeStatementNumber = positiveCursor(
      req.query.beforeStatementNumber,
      "beforeStatementNumber",
    );
    const result = await query(
      `select id from payable_statements
       where vendor_relationship_id = $1
         and ($2::bigint is null or statement_number < $2)
       order by statement_number desc
       limit 251`,
      [relationship.id, beforeStatementNumber],
    );
    const statements = await statementDetailsBatch(
      { query },
      result.rows.slice(0, 250).map((row) => row.id),
    );
    res.json({
      statements,
      page: {
        limit: 250,
        hasMore: result.rows.length > 250,
        nextBeforeStatementNumber: result.rows.length > 250
          ? String(statements.at(-1)?.statementNumber || "")
          : null,
      },
    });
  }),
);

adminRouter.post(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/payable-statements",
  requireOrganizationPermission("payables.approve"),
  route(async (req, res) => {
    const workOrderIds = Array.isArray(req.body.workOrderIds)
      ? [...new Set(req.body.workOrderIds.map(clean).filter(Boolean))]
      : [];
    if (!workOrderIds.length || workOrderIds.length > 500 || workOrderIds.some((id) => !isUuid(id))) {
      throw httpError(400, "workOrderIds must contain 1 to 500 valid identifiers");
    }
    const periodStart = dateOnly(req.body.periodStart, "periodStart");
    const periodEnd = dateOnly(req.body.periodEnd, "periodEnd");
    if (periodEnd < periodStart) {
      throw httpError(400, "A valid statement period is required");
    }
    const statement = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      requireParty(relationship, req.authorizedOrganizationId, "customer");
      const locked = await client.query(
        `select work_order.id
         from work_orders work_order
         where work_order.id = any($1::uuid[])
           and work_order.vendor_relationship_id = $2
           and work_order.status = 'payable_approved'
           and not exists(
             select 1 from work_order_disputes dispute
             where dispute.work_order_id = work_order.id and dispute.status = 'open'
           )
           and not exists(
             select 1
             from payable_statement_items existing_item
             join payable_statements existing_statement
               on existing_statement.id = existing_item.payable_statement_id
             where existing_item.work_order_id = work_order.id
               and existing_statement.status <> 'void'
           )
         order by work_order.id
         for update`,
        [workOrderIds, relationship.id],
      );
      if (locked.rows.length !== workOrderIds.length) {
        throw httpError(409, "Every work order must be payable-approved, undisputed, and outside another statement");
      }
      const eligible = await client.query(
        `select work_order.id, work_order.snapshot_currency,
                coalesce(sum(ledger.amount_minor), 0)::bigint as amount_minor
         from work_orders work_order
         join work_ledger_entries ledger on ledger.work_order_id = work_order.id
         where work_order.id = any($1::uuid[])
         group by work_order.id, work_order.snapshot_currency`,
        [workOrderIds],
      );
      const currencies = new Set(eligible.rows.map((row) => row.snapshot_currency));
      if (currencies.size !== 1) throw httpError(409, "A statement can contain only one currency");
      const created = await client.query(
        `insert into payable_statements(
           vendor_relationship_id, statement_number, currency, period_start,
           period_end, notes, created_by_user_id
         ) values(
           $1,
           (select coalesce(max(statement_number), 0) + 1
            from payable_statements where vendor_relationship_id = $1),
           $2, $3, $4, $5, $6
         ) returning id`,
        [
          relationship.id,
          [...currencies][0],
          periodStart,
          periodEnd,
          bounded(req.body.notes, "notes", 5000),
          req.auth?.user?.id || null,
        ],
      );
      for (const row of eligible.rows) {
        await client.query(
          `insert into payable_statement_items(
             payable_statement_id, work_order_id, amount_minor
           ) values($1, $2, $3)`,
          [created.rows[0].id, row.id, row.amount_minor],
        );
      }
      const after = await statementDetails(client, created.rows[0].id);
      await auditRelationship(
        client,
        req,
        relationship,
        "payable_statement.created",
        "payable_statement",
        created.rows[0].id,
        null,
        after,
      );
      return after;
    });
    res.status(201).json({ statement });
  }),
);

adminRouter.post(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/payable-statements/:statementId/transitions",
  requireOrganizationPermission("payables.approve"),
  route(async (req, res) => {
    const action = clean(req.body.action);
    if (!["finalize", "void"].includes(action)) throw httpError(400, "Statement action is invalid");
    const reason = action === "void"
      ? bounded(req.body.reason, "reason", 2000, { required: true })
      : null;
    const statement = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      requireParty(relationship, req.authorizedOrganizationId, "customer");
      const before = await client.query(
        `select * from payable_statements
         where id = $1 and vendor_relationship_id = $2 for update`,
        [req.params.statementId, relationship.id],
      );
      if (!before.rows[0]) throw httpError(404, "Payable statement not found");
      const beforeState = await statementDetails(client, before.rows[0].id);
      let finalizedState = null;
      let settledWithoutPayment = false;
      if (action === "finalize") {
        if (before.rows[0].status !== "draft") throw httpError(409, "Only a draft statement can be finalized");
        await assertStatementHasNoOpenDisputes(client, before.rows[0].id);
        const totals = await client.query(
          `select coalesce(sum(item.amount_minor), 0)::bigint as subtotal_minor,
                  coalesce(max(work_order.snapshot_payment_terms_days), 0)::int as terms_days
           from payable_statement_items item
           join work_orders work_order on work_order.id = item.work_order_id
           where item.payable_statement_id = $1`,
          [before.rows[0].id],
        );
        if (BigInt(totals.rows[0].subtotal_minor) < 0n) {
          throw httpError(409, "A statement total cannot be negative");
        }
        await client.query(
          `update payable_statements set status = 'finalized',
             subtotal_minor = $2, due_date = current_date + $3::integer,
             finalized_by_user_id = $4, finalized_at = now(), updated_at = now()
           where id = $1`,
          [
            before.rows[0].id,
            totals.rows[0].subtotal_minor,
            totals.rows[0].terms_days,
            req.auth?.user?.id || null,
          ],
        );
        await client.query(
          `update work_orders set status = 'included_in_statement', updated_at = now()
           where id in (
             select work_order_id from payable_statement_items
             where payable_statement_id = $1
           )`,
          [before.rows[0].id],
        );
        finalizedState = await statementDetails(client, before.rows[0].id);
        if (BigInt(totals.rows[0].subtotal_minor) === 0n) {
          settledWithoutPayment = await settleStatementIfPaid(client, before.rows[0].id);
        }
      } else {
        if (!["draft", "finalized"].includes(before.rows[0].status)) {
          throw httpError(409, "Only an unpaid statement can be voided");
        }
        const payments = await client.query(
          `select 1 from payment_records where payable_statement_id = $1
           union all
           select 1 from facilitated_payments where payable_statement_id = $1
           union all
           select 1 from facilitated_payment_attempts
           where payable_statement_id = $1
             and (
               state in ('created', 'requires_action', 'processing', 'succeeded')
               or checkout_status in ('creating', 'open')
             )
           limit 1`,
          [before.rows[0].id],
        );
        if (payments.rows[0]) {
          throw httpError(409, "A statement with payment activity cannot be voided");
        }
        await client.query(
          `update payable_statements set status = 'void', voided_by_user_id = $2,
             voided_at = now(), void_reason = $3, updated_at = now()
           where id = $1`,
          [before.rows[0].id, req.auth?.user?.id || null, reason],
        );
        await client.query(
          `update payable_statement_items set released_at = now()
           where payable_statement_id = $1 and released_at is null`,
          [before.rows[0].id],
        );
        if (before.rows[0].status === "finalized") {
          await client.query(
            `update work_orders set status = 'payable_approved', updated_at = now()
             where id in (
               select work_order_id from payable_statement_items
               where payable_statement_id = $1
             )`,
            [before.rows[0].id],
          );
        }
      }
      const after = await statementDetails(client, before.rows[0].id);
      await auditRelationship(
        client,
        req,
        relationship,
        action === "finalize" ? "payable_statement.finalized" : "payable_statement.voided",
        "payable_statement",
        before.rows[0].id,
        beforeState,
        finalizedState || after,
      );
      if (settledWithoutPayment) {
        await auditRelationship(
          client,
          req,
          relationship,
          "payable_statement.paid",
          "payable_statement",
          before.rows[0].id,
          finalizedState,
          after,
        );
      }
      return after;
    });
    res.json({ statement });
  }),
);

adminRouter.post(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/payable-statements/:statementId/payments",
  requireOrganizationPermission("payment_records.manage"),
  route(async (req, res) => {
    const amountMinor = safeInteger(req.body.amountMinor, "amountMinor", { required: true, positive: true });
    const idempotencyKey = bounded(req.body.idempotencyKey, "idempotencyKey", 200, { required: true });
    const paymentMethod = bounded(req.body.paymentMethod, "paymentMethod", 100, { required: true });
    const externalReference = bounded(
      req.body.externalReference,
      "externalReference",
      200,
      { required: true },
    );
    const paidAt = pastOrCurrentTimestamp(req.body.paidAt, "paidAt");
    const result = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      const statementResult = await client.query(
        `select * from payable_statements
         where id = $1 and vendor_relationship_id = $2 for update`,
        [req.params.statementId, relationship.id],
      );
      const statement = statementResult.rows[0];
      if (!statement) throw httpError(404, "Payable statement not found");
      const reportingParty = party(relationship, req.authorizedOrganizationId);
      const status = reportingParty === "customer" ? "confirmed" : "reported";
      const existing = await client.query(
        `select * from payment_records
         where payable_statement_id = $1 and idempotency_key = $2`,
        [statement.id, idempotencyKey],
      );
      if (existing.rows[0]) {
        const record = existing.rows[0];
        const sameRequest = Number(record.amount_minor) === amountMinor
          && record.payment_method === paymentMethod
          && record.external_reference === externalReference
          && new Date(record.paid_at).toISOString() === paidAt
          && record.reported_by_party === reportingParty;
        if (!sameRequest) {
          throw httpError(409, "The idempotency key belongs to a different payment record");
        }
        return {
          payment: record,
          statement: await statementDetails(client, statement.id),
          replayed: true,
        };
      }
      if (statement.status !== "finalized") throw httpError(409, "Payments require a finalized statement");
      const facilitatedAttempt = await client.query(
        `select 1 from facilitated_payments where payable_statement_id = $1
         union all
         select 1 from facilitated_payment_attempts
         where payable_statement_id = $1
           and (
             state in ('created', 'requires_action', 'processing', 'succeeded')
             or checkout_status in ('creating', 'open')
           )
         limit 1`,
        [statement.id],
      );
      if (facilitatedAttempt.rows[0]) {
        throw httpError(
          409,
          "External payment records cannot overlap active or completed facilitated settlement",
        );
      }
      await assertStatementHasNoOpenDisputes(client, statement.id);
      if (status === "confirmed") {
        const confirmed = await client.query(
          `select coalesce(sum(amount_minor), 0)::bigint as total
           from payment_records
           where payable_statement_id = $1 and status = 'confirmed'`,
          [statement.id],
        );
        if (BigInt(confirmed.rows[0].total) + BigInt(amountMinor) > BigInt(statement.subtotal_minor)) {
          throw httpError(409, "Confirmed payments cannot exceed the statement total");
        }
      }
      const created = await client.query(
        `insert into payment_records(
           payable_statement_id, amount_minor, currency, status,
           payment_method, external_reference, paid_at, reported_by_party,
           reported_by_user_id, confirmed_by_user_id, confirmed_at,
           idempotency_key
         ) values(
           $1, $2, $3, $4, $5, $6, $7, $8, $9::uuid,
           case when $4 = 'confirmed' then $9::uuid else null::uuid end,
           case when $4 = 'confirmed' then now() else null end,
           $10
         )
         on conflict(payable_statement_id, idempotency_key) do nothing
         returning *`,
        [
          statement.id,
          amountMinor,
          statement.currency,
          status,
          paymentMethod,
          externalReference,
          paidAt,
          reportingParty,
          req.auth?.user?.id || null,
          idempotencyKey,
        ],
      );
      const record = created.rows[0];
      if (!record) throw httpError(409, "The payment was created concurrently; retry it");
      await auditRelationship(
        client,
        req,
        relationship,
        `payment_record.${status}`,
        "payment_record",
        record.id,
        null,
        record,
      );
      const paid = status === "confirmed"
        ? await settleStatementIfPaid(client, statement.id)
        : false;
      if (paid) {
        await auditRelationship(
          client,
          req,
          relationship,
          "payable_statement.paid",
          "payable_statement",
          statement.id,
          { status: "finalized" },
          { status: "paid" },
        );
      }
      return {
        payment: record,
        statement: await statementDetails(client, statement.id),
        replayed: false,
      };
    });
    if (result.replayed) res.set("Idempotency-Replayed", "true");
    res.status(result.replayed ? 200 : 201).json(result);
  }),
);

adminRouter.patch(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/payable-statements/:statementId/payments/:paymentRecordId",
  requireOrganizationPermission("payment_records.manage"),
  route(async (req, res) => {
    const status = clean(req.body.status);
    if (!["confirmed", "rejected"].includes(status)) throw httpError(400, "status is invalid");
    const rejectionReason = status === "rejected"
      ? bounded(req.body.reason, "reason", 1000, { required: true })
      : null;
    const result = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      requireParty(relationship, req.authorizedOrganizationId, "customer");
      const statementResult = await client.query(
        `select * from payable_statements
         where id = $1 and vendor_relationship_id = $2 for update`,
        [req.params.statementId, relationship.id],
      );
      const statement = statementResult.rows[0];
      if (!statement || statement.status !== "finalized") {
        throw httpError(409, "A finalized statement is required");
      }
      await assertStatementHasNoOpenDisputes(client, statement.id);
      const before = await client.query(
        `select * from payment_records
         where id = $1 and payable_statement_id = $2 for update`,
        [req.params.paymentRecordId, statement.id],
      );
      if (!before.rows[0]) throw httpError(404, "Payment record not found");
      if (before.rows[0].status !== "reported") {
        throw httpError(409, "Only an agency-reported payment can be decided");
      }
      if (status === "confirmed") {
        const confirmed = await client.query(
          `select coalesce(sum(amount_minor), 0)::bigint as total
           from payment_records
           where payable_statement_id = $1 and status = 'confirmed'`,
          [statement.id],
        );
        if (
          BigInt(confirmed.rows[0].total) + BigInt(before.rows[0].amount_minor)
          > BigInt(statement.subtotal_minor)
        ) {
          throw httpError(409, "Confirmed payments cannot exceed the statement total");
        }
      }
      const updated = await client.query(
        `update payment_records set status = $2,
           confirmed_by_user_id =
             case when $2 = 'confirmed' then $3::uuid else null::uuid end,
           confirmed_at = case when $2 = 'confirmed' then now() else null end,
           rejection_reason = $4
         where id = $1 returning *`,
        [before.rows[0].id, status, req.auth?.user?.id || null, rejectionReason],
      );
      const paid = status === "confirmed"
        ? await settleStatementIfPaid(client, statement.id)
        : false;
      if (paid) {
        await auditRelationship(
          client,
          req,
          relationship,
          "payable_statement.paid",
          "payable_statement",
          statement.id,
          { status: "finalized" },
          { status: "paid" },
        );
      }
      await auditRelationship(
        client,
        req,
        relationship,
        `payment_record.${status}`,
        "payment_record",
        before.rows[0].id,
        before.rows[0],
        updated.rows[0],
      );
      return {
        payment: updated.rows[0],
        statement: await statementDetails(client, statement.id),
      };
    });
    res.json(result);
  }),
);

personalRouter.get("/assignments", route(async (req, res) => {
  const result = await query(
    `select assignment.id, assignment.status as "assignmentStatus",
            assignment.assignment_role as "assignmentRole",
            work_order.id as "workOrderId",
            work_order.work_order_number as "workOrderNumber",
            work_order.title, work_order.status as "workOrderStatus",
            work_order.source_locale as "sourceLocale",
            work_order.target_locale as "targetLocale",
            work_order.service_type as "serviceType",
            work_order.due_at as "dueAt",
            customer.name as "customerName",
            project.name as "projectName",
            (
              select count(*)::int from work_order_items item
              where item.work_order_id = work_order.id
            ) as "itemCount"
     from work_assignments assignment
     join organization_memberships membership
       on membership.id = assignment.agency_membership_id
     join work_orders work_order on work_order.id = assignment.work_order_id
     join vendor_relationships relationship
       on relationship.id = work_order.vendor_relationship_id
     join organizations customer on customer.id = relationship.customer_organization_id
     join organizations agency on agency.id = relationship.agency_organization_id
     join users linguist on linguist.id = membership.user_id
     join projects project on project.id = work_order.project_id
     where membership.user_id = $1
       and linguist.status = 'active'
       and customer.status = 'active'
       and agency.status = 'active'
       and membership.status = 'active'
       and (membership.expires_at is null or membership.expires_at > now())
       and assignment.status in ('active', 'completed')
       and work_order.status in (
         'accepted', 'in_progress', 'submitted', 'quality_approved',
         'payable_approved', 'included_in_statement', 'paid'
       )
       and relationship.status = 'active'
       and (
         relationship.effective_from is null
         or relationship.effective_from <= (now() at time zone 'UTC')::date
       )
       and (
         relationship.effective_to is null
         or relationship.effective_to >= (now() at time zone 'UTC')::date
       )
       and exists(
         select 1
         from vendor_relationship_scopes scope
         where scope.vendor_relationship_id = relationship.id
           and (
             (scope.scope_type = 'project' and scope.scope_id = project.id)
             or (
               scope.scope_type = 'business_unit'
               and scope.scope_id = project.business_unit_id
             )
           )
       )
       and (
         not exists(
           select 1 from vendor_relationship_scopes scope
           where scope.vendor_relationship_id = relationship.id
             and scope.scope_type = 'locale'
         )
         or exists(
           select 1 from vendor_relationship_scopes scope
           where scope.vendor_relationship_id = relationship.id
             and scope.scope_type = 'locale'
             and lower(scope.scope_value) = lower(work_order.target_locale)
         )
       )
       and (
         not exists(
           select 1 from vendor_relationship_scopes scope
           where scope.vendor_relationship_id = relationship.id
             and scope.scope_type = 'service_type'
         )
         or exists(
           select 1 from vendor_relationship_scopes scope
           where scope.vendor_relationship_id = relationship.id
             and scope.scope_type = 'service_type'
             and lower(scope.scope_value) = lower(work_order.service_type)
         )
       )
       and (
         not exists(
           select 1 from vendor_relationship_scopes scope
           where scope.vendor_relationship_id = relationship.id
             and scope.scope_type = 'content_classification'
         )
         or exists(
           select 1 from vendor_relationship_scopes scope
           where scope.vendor_relationship_id = relationship.id
             and scope.scope_type = 'content_classification'
             and lower(scope.scope_value) = lower(work_order.content_classification)
         )
       )
       and exists(
         select 1
         from role_assignments role_assignment
         join roles role on role.id = role_assignment.role_id
         where role.key in ('agency_linguist', 'agency_lead_linguist')
           and role_assignment.scope_type = 'organization'
           and role_assignment.scope_id = relationship.agency_organization_id
           and role_assignment.revoked_at is null
           and (
             role_assignment.expires_at is null
             or role_assignment.expires_at > now()
           )
           and (
             (
               role_assignment.principal_type = 'user'
               and role_assignment.principal_id = membership.user_id
             )
             or (
               role_assignment.principal_type = 'team'
               and role_assignment.principal_id in (
                 select team_membership.team_id
                 from team_memberships team_membership
                 where team_membership.organization_membership_id = membership.id
               )
             )
           )
           and case
             when jsonb_typeof(role_assignment.conditions->'locales') = 'array'
               then jsonb_array_length(role_assignment.conditions->'locales') = 0
               or exists(
                 select 1
                 from jsonb_array_elements_text(
                   role_assignment.conditions->'locales'
                 ) allowed_locale(value)
                 where lower(allowed_locale.value) = lower(work_order.target_locale)
               )
             else true
           end
       )
       and exists(
         select 1
         from vendor_approved_linguists approval
         where approval.vendor_relationship_id = relationship.id
           and approval.agency_membership_id = membership.id
           and approval.status = 'approved'
           and (approval.expires_at is null or approval.expires_at > now())
           and case
             when jsonb_typeof(approval.conditions->'locales') = 'array'
               then jsonb_array_length(approval.conditions->'locales') = 0
               or exists(
                 select 1
                 from jsonb_array_elements_text(
                   approval.conditions->'locales'
                 ) allowed_locale(value)
                 where lower(allowed_locale.value) = lower(work_order.target_locale)
               )
             else true
           end
           and case
             when jsonb_typeof(approval.conditions->'serviceTypes') = 'array'
               then jsonb_array_length(approval.conditions->'serviceTypes') = 0
               or exists(
                 select 1
                 from jsonb_array_elements_text(
                   approval.conditions->'serviceTypes'
                 ) allowed_service(value)
                 where lower(allowed_service.value) = lower(work_order.service_type)
               )
             else true
           end
           and case
             when jsonb_typeof(approval.conditions->'contentClassifications') = 'array'
               then jsonb_array_length(
                 approval.conditions->'contentClassifications'
               ) = 0
               or exists(
                 select 1
                 from jsonb_array_elements_text(
                   approval.conditions->'contentClassifications'
                 ) allowed_classification(value)
                 where lower(allowed_classification.value)
                   = lower(work_order.content_classification)
               )
             else true
           end
       )
     order by work_order.due_at nulls last, work_order.created_at desc`,
    [req.auth.user.id],
  );
  res.json({ assignments: result.rows });
}));

personalRouter.get(
  "/assignments/:workAssignmentId/content",
  route(async (req, res) => {
    const access = await evaluateVendorWorkAccess({
      assignmentId: req.params.workAssignmentId,
      userId: req.auth.user.id,
      mode: "view",
    });
    if (!access.contentAccess.allowed) return denyWorkAccess(res, access);
    const result = await query(
      `select source.id, source.source_hash as "sourceHash",
              source.source_text as "sourceText", source.shape, source.purpose,
              source.visual_context as "visualContext",
              source.limit_chars as "limitChars",
              translation.text as "translationText",
              translation.human_status as "humanStatus",
              translation.updated_at as "translationUpdatedAt"
       from work_assignments assignment
       join work_orders work_order on work_order.id = assignment.work_order_id
       join work_order_items item on item.work_order_id = work_order.id
       join source_strings source on source.id = item.source_string_id
       left join translations translation
         on translation.source_string_id = source.id
        and lower(translation.locale) = lower(work_order.target_locale)
       where assignment.id = $1
       order by lower(source.source_text)`,
      [req.params.workAssignmentId],
    );
    res.json({ access: access.contentAccess, items: result.rows });
  }),
);

personalRouter.put(
  "/assignments/:workAssignmentId/content/:sourceStringId/translations/:locale",
  route(async (req, res) => {
    const text = bounded(req.body.text, "text", 100000, { required: true });
    const translation = await withTransaction(async (client) => {
      const lockedWorkOrder = await lockPersonalAssignment(
        client,
        req.params.workAssignmentId,
        req.auth.user.id,
      );
      const access = await evaluateVendorWorkAccess({
        assignmentId: req.params.workAssignmentId,
        userId: req.auth.user.id,
        sourceStringId: req.params.sourceStringId,
        mode: "edit",
        database: client,
      });
      if (!access.contentAccess.allowed) {
        const error = httpError(403, access.contentAccess.message);
        error.code = access.contentAccess.code;
        error.details = { denialReasons: access.denialReasons };
        throw error;
      }
      if (clean(req.params.locale).toLowerCase() !== clean(access.context.locale).toLowerCase()) {
        throw httpError(403, "The assignment authorizes only its target locale");
      }
      const targetLocale = access.context.locale;
      const relationship = await client.query(
        "select * from vendor_relationships where id = $1",
        [lockedWorkOrder.vendor_relationship_id],
      );
      await client.query(
        "select id from source_strings where id = $1 for update",
        [req.params.sourceStringId],
      );
      const existing = await client.query(
        `select id, text, human_status
         from translations
         where source_string_id = $1 and locale = $2
         for update`,
        [req.params.sourceStringId, targetLocale],
      );
      if (existing.rows[0]?.human_status === "verified") {
        const error = httpError(
          409,
          "A verified customer translation must be reopened before agency editing",
        );
        error.code = "verified_translation_protected";
        error.details = {
          translationId: existing.rows[0].id,
          previousHumanStatus: existing.rows[0].human_status,
        };
        throw error;
      }
      const upserted = await client.query(
        `insert into translations(
           source_string_id, locale, text, mt_status, human_status, source
         ) values($1, $2, $3, 'ready', 'pending', 'human')
         on conflict(source_string_id, locale) do update set
           text = excluded.text, human_status = 'pending',
           source = 'human', updated_at = now()
         returning *`,
        [req.params.sourceStringId, targetLocale, text],
      );
      await client.query(
        `insert into translation_revisions(
           translation_id, source_string_id, locale, previous_text,
           next_text, revision_source, instruction
         ) values($1, $2, $3, $4, $5, 'human', $6)`,
        [
          upserted.rows[0].id,
          req.params.sourceStringId,
          targetLocale,
          existing.rows[0]?.text ?? null,
          text,
          `Agency work assignment ${req.params.workAssignmentId}`,
        ],
      );
      await auditRelationship(
        client,
        req,
        relationship.rows[0],
        "work_assignment.translation_updated",
        "source_string",
        req.params.sourceStringId,
        existing.rows[0] || null,
        { locale: targetLocale, translationId: upserted.rows[0].id },
      );
      return {
        translation: upserted.rows[0],
        previousHumanStatus: existing.rows[0]?.human_status ?? null,
      };
    });
    res.json(translation);
  }),
);

personalRouter.post(
  "/assignments/:workAssignmentId/start",
  route(async (req, res) => {
    const result = await withTransaction(async (client) => {
      const lockedWorkOrder = await lockPersonalAssignment(
        client,
        req.params.workAssignmentId,
        req.auth.user.id,
      );
      const access = await evaluateVendorWorkAccess({
        assignmentId: req.params.workAssignmentId,
        userId: req.auth.user.id,
        mode: "edit",
        database: client,
      });
      if (!access.contentAccess.allowed) {
        const error = httpError(403, access.contentAccess.message);
        error.code = access.contentAccess.code;
        error.details = { denialReasons: access.denialReasons };
        throw error;
      }
      if (lockedWorkOrder.status === "accepted") {
        await client.query(
          "update work_orders set status = 'in_progress', started_at = now(), updated_at = now() where id = $1",
          [lockedWorkOrder.id],
        );
      } else if (lockedWorkOrder.status !== "in_progress") {
        throw httpError(409, "This work order cannot be started");
      }
      const relationship = await client.query(
        "select * from vendor_relationships where id = $1",
        [lockedWorkOrder.vendor_relationship_id],
      );
      await auditRelationship(
        client,
        req,
        relationship.rows[0],
        "work_order.in_progress",
        "work_order",
        lockedWorkOrder.id,
        { status: lockedWorkOrder.status },
        { status: "in_progress" },
      );
      return { id: lockedWorkOrder.id, status: "in_progress" };
    });
    res.json({ workOrder: result });
  }),
);

personalRouter.post(
  "/assignments/:workAssignmentId/submit",
  route(async (req, res) => {
    const deliveredUnits = decimal(req.body.deliveredUnits, "deliveredUnits", { required: true });
    const notes = bounded(req.body.notes, "notes", 5000);
    const idempotencyKey = bounded(req.body.idempotencyKey, "idempotencyKey", 200, { required: true });
    const result = await withTransaction(async (client) => {
      const lockedWorkOrder = await lockPersonalAssignment(
        client,
        req.params.workAssignmentId,
        req.auth.user.id,
      );
      const existing = await client.query(
        `select * from work_submissions
         where work_order_id = $1 and idempotency_key = $2`,
        [lockedWorkOrder.id, idempotencyKey],
      );
      if (existing.rows[0]) {
        const sameRequest = existing.rows[0].work_assignment_id === req.params.workAssignmentId
          && Number(existing.rows[0].delivered_units) === Number(deliveredUnits)
          && (existing.rows[0].notes || null) === notes;
        if (!sameRequest) {
          throw httpError(409, "The idempotency key belongs to a different submission");
        }
        return { submission: existing.rows[0], replayed: true };
      }
      const access = await evaluateVendorWorkAccess({
        assignmentId: req.params.workAssignmentId,
        userId: req.auth.user.id,
        mode: "submit",
        database: client,
      });
      if (!access.contentAccess.allowed) {
        const error = httpError(403, access.contentAccess.message);
        error.code = access.contentAccess.code;
        error.details = { denialReasons: access.denialReasons };
        throw error;
      }
      if (!["accepted", "in_progress"].includes(lockedWorkOrder.status)) {
        throw httpError(409, "This work order cannot be submitted");
      }
      const submission = await client.query(
        `insert into work_submissions(
           work_order_id, work_assignment_id, delivered_units, notes,
           submitted_by_user_id, idempotency_key
         ) values($1, $2, $3, $4, $5, $6)
         returning *`,
        [
          lockedWorkOrder.id,
          req.params.workAssignmentId,
          deliveredUnits,
          notes,
          req.auth.user.id,
          idempotencyKey,
        ],
      );
      await client.query(
        `update work_orders set status = 'submitted', submitted_at = now(),
           updated_at = now() where id = $1`,
        [lockedWorkOrder.id],
      );
      const relationship = await client.query(
        "select * from vendor_relationships where id = $1",
        [lockedWorkOrder.vendor_relationship_id],
      );
      await auditRelationship(
        client,
        req,
        relationship.rows[0],
        "work_order.submitted",
        "work_order",
        lockedWorkOrder.id,
        { status: lockedWorkOrder.status },
        { status: "submitted", submissionId: submission.rows[0].id },
      );
      return { submission: submission.rows[0], replayed: false };
    });
    if (result.replayed) res.set("Idempotency-Replayed", "true");
    res.status(result.replayed ? 200 : 201).json(result);
  }),
);

export { adminRouter, personalRouter };
