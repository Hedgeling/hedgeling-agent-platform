import { query } from "./db.js";
import { isUuid } from "./validation.js";
import { lifecycleMode } from "./data-lifecycle-status.js";

const denialMessages = {
  customer_organization_inactive: "The customer organization is not active.",
  agency_organization_inactive: "The agency organization is not active.",
  user_inactive: "The linguist user account is not active.",
  agency_membership_inactive: "The linguist does not have an active agency membership.",
  agency_membership_expired: "The linguist's agency membership has expired.",
  agency_linguist_role_missing: "The agency member does not have an active agency linguist role.",
  agency_role_locale_required: "A locale is required to evaluate the linguist's agency role.",
  agency_role_locale_out_of_scope: "The requested locale is outside the linguist's agency role.",
  relationship_not_active: "The vendor relationship is not active.",
  relationship_not_started: "The vendor relationship is not effective yet.",
  relationship_expired: "The vendor relationship has expired.",
  structural_scope_missing: "The vendor relationship has no business-unit or project scope.",
  project_out_of_scope: "The project is outside the vendor relationship scope.",
  locale_required: "A locale is required by the vendor relationship scope.",
  locale_out_of_scope: "The locale is outside the vendor relationship scope.",
  service_type_required: "A service type is required by the vendor relationship scope.",
  service_type_out_of_scope: "The service type is outside the vendor relationship scope.",
  content_classification_required: "A content classification is required by the vendor relationship scope.",
  content_classification_out_of_scope: "The content classification is outside the vendor relationship scope.",
  linguist_nomination_missing: "The agency has not nominated this linguist to the customer.",
  linguist_approval_missing: "Customer approval is required for this linguist.",
  linguist_approval_pending: "Customer approval for this linguist is pending.",
  linguist_approval_rejected: "Customer approval for this linguist was rejected.",
  linguist_approval_revoked: "Customer approval for this linguist was revoked.",
  linguist_approval_expired: "Customer approval for this linguist has expired.",
  linguist_locale_required: "A locale is required by the linguist approval.",
  linguist_locale_out_of_scope: "The locale is outside the linguist approval.",
  linguist_service_type_required: "A service type is required by the linguist approval.",
  linguist_service_type_out_of_scope: "The service type is outside the linguist approval.",
  linguist_content_classification_required: "A content classification is required by the linguist approval.",
  linguist_content_classification_out_of_scope: "The content classification is outside the linguist approval.",
  work_assignment_missing: "An active Phase 5 work assignment is required for customer-content access.",
  work_assignment_inactive: "The work assignment is not active.",
  work_order_content_item_missing: "The requested string is not included in this work order.",
  work_order_not_readable: "The work order is not in a state that permits assigned content access.",
  work_order_not_editable: "The work order is not in a state that permits assigned translation edits.",
  customer_data_lifecycle_restricted: "The customer has scheduled this project for deletion.",
};

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function clean(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalized(value) {
  return clean(value)?.toLowerCase() || null;
}

function currentDate(at) {
  const date = at instanceof Date ? at : new Date(at || Date.now());
  if (Number.isNaN(date.getTime())) throw httpError(400, "Eligibility evaluation time is invalid");
  return {
    instant: date,
    isoDate: date.toISOString().slice(0, 10),
    isoTimestamp: date.toISOString(),
  };
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function addDenial(denials, code, details = {}) {
  if (denials.some((denial) => denial.code === code)) return;
  denials.push({ code, message: denialMessages[code], ...details });
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.map(normalized).filter(Boolean)
    : [];
}

function evaluateRestrictedValue({
  denials,
  values,
  requestedValue,
  requiredCode,
  outOfScopeCode,
  source,
}) {
  if (!values.length) return;
  const requested = normalized(requestedValue);
  if (!requested) {
    addDenial(denials, requiredCode, { source });
  } else if (!values.includes(requested)) {
    addDenial(denials, outOfScopeCode, { source, requestedValue });
  }
}

async function databaseQuery(database, text, params) {
  return typeof database === "function"
    ? database(text, params)
    : database.query(text, params);
}

async function loadEligibilityFacts(database, relationshipId, agencyMembershipId) {
  const result = await databaseQuery(
    database,
    `select
       vr.id as relationship_id,
       vr.customer_organization_id,
       vr.agency_organization_id,
       vr.status as relationship_status,
       vr.effective_from,
       vr.effective_to,
       vr.requires_linguist_approval,
       vr.agency_may_assign_linguists,
       customer.status as customer_status,
       agency.status as agency_status,
       om.id as agency_membership_id,
       om.user_id,
       om.status as membership_status,
       om.expires_at as membership_expires_at,
       users.status as user_status,
       users.email,
       users.display_name,
       approval.id as approval_id,
       approval.status as approval_status,
       approval.expires_at as approval_expires_at,
       approval.conditions as approval_conditions
     from vendor_relationships vr
     join organizations customer on customer.id = vr.customer_organization_id
     join organizations agency on agency.id = vr.agency_organization_id
     join organization_memberships om
       on om.id = $2 and om.organization_id = vr.agency_organization_id
     join users on users.id = om.user_id
     left join vendor_approved_linguists approval
       on approval.vendor_relationship_id = vr.id
      and approval.agency_membership_id = om.id
     where vr.id = $1`,
    [relationshipId, agencyMembershipId],
  );
  if (!result.rows[0]) {
    throw httpError(404, "Vendor relationship or agency membership not found");
  }
  return result.rows[0];
}

async function loadProjectContext(database, customerOrganizationId, projectId) {
  if (!isUuid(projectId)) throw httpError(400, "projectId must be a valid UUID");
  const result = await databaseQuery(
    database,
    `select p.id, p.name, p.business_unit_id, bu.name as business_unit_name,
            p.data_purged_at as "dataPurgedAt",
            lifecycle.state as "lifecycleState",
            lifecycle.export_available_until as "exportAvailableUntil"
     from projects p
     join business_units bu on bu.id = p.business_unit_id
     left join lateral (
       select request.state, request.export_available_until
       from data_lifecycle_requests request
       where request.organization_id = $2
         and request.state in ('scheduled', 'processing', 'failed', 'purged')
         and (
           request.target_type = 'organization'
           or (request.target_type = 'project' and request.project_id = p.id)
         )
       order by (request.target_type = 'organization') desc,
                request.requested_at desc
       limit 1
     ) lifecycle on true
     where p.id = $1 and bu.organization_id = $2`,
    [projectId, customerOrganizationId],
  );
  if (!result.rows[0]) throw httpError(400, "Project context does not belong to the customer");
  return result.rows[0];
}

async function loadScopes(database, relationshipId) {
  const result = await databaseQuery(
    database,
    `select scope_type, scope_id, scope_value
     from vendor_relationship_scopes
     where vendor_relationship_id = $1`,
    [relationshipId],
  );
  return result.rows;
}

async function loadAgencyRoleConditions(database, facts, evaluatedAt) {
  const result = await databaseQuery(
    database,
    `select ra.conditions
     from role_assignments ra
     join roles r on r.id = ra.role_id
     where r.key in ('agency_linguist', 'agency_lead_linguist')
       and ra.scope_type = 'organization'
       and ra.scope_id = $2
       and ra.revoked_at is null
       and (ra.expires_at is null or ra.expires_at > $4::timestamptz)
       and (
         (ra.principal_type = 'user' and ra.principal_id = $1)
         or (
           ra.principal_type = 'team' and ra.principal_id in (
             select tm.team_id from team_memberships tm
             where tm.organization_membership_id = $3
           )
         )
       )`,
    [
      facts.user_id,
      facts.agency_organization_id,
      facts.agency_membership_id,
      evaluatedAt.isoTimestamp,
    ],
  );
  return result.rows.map((row) => row.conditions || {});
}

function evaluateAgencyRole(denials, roleConditions, locale) {
  if (!roleConditions.length) {
    addDenial(denials, "agency_linguist_role_missing");
    return;
  }
  const unrestricted = roleConditions.some((conditions) => !stringArray(conditions.locales).length);
  if (unrestricted) return;
  const requestedLocale = normalized(locale);
  if (!requestedLocale) {
    addDenial(denials, "agency_role_locale_required");
    return;
  }
  if (!roleConditions.some((conditions) => stringArray(conditions.locales).includes(requestedLocale))) {
    addDenial(denials, "agency_role_locale_out_of_scope", { requestedValue: locale });
  }
}

function evaluateRelationshipScopes(denials, scopes, project, context) {
  const structuralScopes = scopes.filter(
    (scope) => scope.scope_type === "business_unit" || scope.scope_type === "project",
  );
  if (!structuralScopes.length) {
    addDenial(denials, "structural_scope_missing");
  } else if (!structuralScopes.some((scope) => (
    (scope.scope_type === "business_unit" && scope.scope_id === project.business_unit_id)
    || (scope.scope_type === "project" && scope.scope_id === project.id)
  ))) {
    addDenial(denials, "project_out_of_scope", { projectId: project.id });
  }

  const valuesFor = (scopeType) => scopes
    .filter((scope) => scope.scope_type === scopeType)
    .map((scope) => normalized(scope.scope_value))
    .filter(Boolean);
  evaluateRestrictedValue({
    denials,
    values: valuesFor("locale"),
    requestedValue: context.locale,
    requiredCode: "locale_required",
    outOfScopeCode: "locale_out_of_scope",
    source: "vendor_relationship",
  });
  evaluateRestrictedValue({
    denials,
    values: valuesFor("service_type"),
    requestedValue: context.serviceType,
    requiredCode: "service_type_required",
    outOfScopeCode: "service_type_out_of_scope",
    source: "vendor_relationship",
  });
  evaluateRestrictedValue({
    denials,
    values: valuesFor("content_classification"),
    requestedValue: context.contentClassification,
    requiredCode: "content_classification_required",
    outOfScopeCode: "content_classification_out_of_scope",
    source: "vendor_relationship",
  });
}

function evaluateApproval(denials, facts, context, evaluatedAt) {
  if (!facts.approval_id) {
    addDenial(denials, "linguist_nomination_missing");
    if (facts.requires_linguist_approval) addDenial(denials, "linguist_approval_missing");
    return;
  }
  if (facts.approval_status !== "approved") {
    const code = {
      pending: "linguist_approval_pending",
      rejected: "linguist_approval_rejected",
      revoked: "linguist_approval_revoked",
    }[facts.approval_status] || "linguist_approval_missing";
    addDenial(denials, code);
    return;
  }
  if (
    facts.approval_expires_at
    && new Date(facts.approval_expires_at).getTime() <= evaluatedAt.instant.getTime()
  ) {
    addDenial(denials, "linguist_approval_expired");
  }
  const conditions = facts.approval_conditions || {};
  evaluateRestrictedValue({
    denials,
    values: stringArray(conditions.locales),
    requestedValue: context.locale,
    requiredCode: "linguist_locale_required",
    outOfScopeCode: "linguist_locale_out_of_scope",
    source: "linguist_approval",
  });
  evaluateRestrictedValue({
    denials,
    values: stringArray(conditions.serviceTypes),
    requestedValue: context.serviceType,
    requiredCode: "linguist_service_type_required",
    outOfScopeCode: "linguist_service_type_out_of_scope",
    source: "linguist_approval",
  });
  evaluateRestrictedValue({
    denials,
    values: stringArray(conditions.contentClassifications),
    requestedValue: context.contentClassification,
    requiredCode: "linguist_content_classification_required",
    outOfScopeCode: "linguist_content_classification_out_of_scope",
    source: "linguist_approval",
  });
}

export async function evaluateVendorEligibility({
  vendorRelationshipId,
  agencyMembershipId,
  projectId,
  locale = null,
  serviceType = null,
  contentClassification = null,
  at = null,
  database = query,
}) {
  if (!isUuid(vendorRelationshipId) || !isUuid(agencyMembershipId)) {
    throw httpError(400, "Relationship and agency membership IDs must be valid UUIDs");
  }
  const evaluatedAt = currentDate(at);
  const facts = await loadEligibilityFacts(database, vendorRelationshipId, agencyMembershipId);
  const project = await loadProjectContext(
    database,
    facts.customer_organization_id,
    projectId,
  );
  const scopes = await loadScopes(database, vendorRelationshipId);
  const roleConditions = await loadAgencyRoleConditions(database, facts, evaluatedAt);
  const context = {
    locale: clean(locale),
    serviceType: clean(serviceType),
    contentClassification: clean(contentClassification),
  };
  const denials = [];

  if (lifecycleMode({
    dataPurgedAt: project.dataPurgedAt,
    state: project.lifecycleState,
    exportAvailableUntil: project.exportAvailableUntil,
  }, evaluatedAt.instant.getTime()) !== "active") {
    addDenial(denials, "customer_data_lifecycle_restricted");
  }

  if (facts.customer_status !== "active") addDenial(denials, "customer_organization_inactive");
  if (facts.agency_status !== "active") addDenial(denials, "agency_organization_inactive");
  if (facts.user_status !== "active") addDenial(denials, "user_inactive");
  if (facts.membership_status !== "active") {
    addDenial(denials, "agency_membership_inactive", { status: facts.membership_status });
  }
  if (
    facts.membership_expires_at
    && new Date(facts.membership_expires_at).getTime() <= evaluatedAt.instant.getTime()
  ) {
    addDenial(denials, "agency_membership_expired");
  }
  evaluateAgencyRole(denials, roleConditions, context.locale);

  if (facts.relationship_status !== "active") {
    addDenial(denials, "relationship_not_active", { status: facts.relationship_status });
  }
  if (facts.effective_from && dateOnly(facts.effective_from) > evaluatedAt.isoDate) {
    addDenial(denials, "relationship_not_started");
  }
  if (facts.effective_to && dateOnly(facts.effective_to) < evaluatedAt.isoDate) {
    addDenial(denials, "relationship_expired");
  }
  evaluateRelationshipScopes(denials, scopes, project, context);
  evaluateApproval(denials, facts, context, evaluatedAt);

  const eligibleForAssignment = denials.length === 0;
  const contentDenial = eligibleForAssignment
    ? {
      code: "work_assignment_missing",
      message: denialMessages.work_assignment_missing,
    }
    : denials[0];
  return {
    evaluatedAt: evaluatedAt.isoTimestamp,
    vendorRelationshipId: facts.relationship_id,
    customerOrganizationId: facts.customer_organization_id,
    agencyOrganizationId: facts.agency_organization_id,
    agencyMembershipId: facts.agency_membership_id,
    relationship: {
      status: facts.relationship_status,
      effectiveFrom: dateOnly(facts.effective_from),
      effectiveTo: dateOnly(facts.effective_to),
    },
    linguist: {
      email: facts.email,
      displayName: facts.display_name,
      membershipStatus: facts.membership_status,
      approvalStatus: facts.approval_status,
    },
    project: {
      id: project.id,
      name: project.name,
      businessUnitId: project.business_unit_id,
      businessUnitName: project.business_unit_name,
    },
    context,
    eligibleForAssignment,
    denialReasons: denials,
    assignmentPolicy: {
      agencyMayAssignLinguists: facts.agency_may_assign_linguists,
      customerApprovalRequired: facts.requires_linguist_approval,
    },
    contentAccess: {
      allowed: false,
      code: contentDenial.code,
      message: contentDenial.message,
      requiresWorkAssignment: true,
    },
  };
}

export function vendorEligibilityDenialMessages() {
  return { ...denialMessages };
}

export async function evaluateVendorWorkAccess({
  assignmentId,
  userId,
  sourceStringId = null,
  mode = "view",
  at = null,
  database = query,
}) {
  if (!isUuid(assignmentId) || !isUuid(userId)) {
    throw httpError(400, "Assignment and user IDs must be valid UUIDs");
  }
  if (sourceStringId && !isUuid(sourceStringId)) {
    throw httpError(400, "sourceStringId must be a valid UUID");
  }
  if (!["view", "edit", "submit"].includes(mode)) {
    throw httpError(400, "Work access mode is invalid");
  }
  const result = await databaseQuery(
    database,
    `select assignment.id, assignment.status as assignment_status,
            assignment.agency_membership_id, work_order.id as work_order_id,
            work_order.vendor_relationship_id, work_order.project_id,
            work_order.status as work_order_status, work_order.source_locale,
            work_order.target_locale, work_order.service_type,
            work_order.content_classification,
            membership.user_id
     from work_assignments assignment
     join work_orders work_order on work_order.id = assignment.work_order_id
     join organization_memberships membership
       on membership.id = assignment.agency_membership_id
     where assignment.id = $1 and membership.user_id = $2`,
    [assignmentId, userId],
  );
  const assignment = result.rows[0];
  if (!assignment) throw httpError(404, "Work assignment not found");
  const eligibility = await evaluateVendorEligibility({
    vendorRelationshipId: assignment.vendor_relationship_id,
    agencyMembershipId: assignment.agency_membership_id,
    projectId: assignment.project_id,
    locale: assignment.target_locale,
    serviceType: assignment.service_type,
    contentClassification: assignment.content_classification,
    at,
    database,
  });
  const denials = [...eligibility.denialReasons];
  if (
    assignment.assignment_status !== "active"
    && !(mode === "view" && assignment.assignment_status === "completed")
  ) {
    addDenial(denials, "work_assignment_inactive", { status: assignment.assignment_status });
  }
  const readableStates = new Set([
    "accepted",
    "in_progress",
    "submitted",
    "quality_approved",
    "payable_approved",
    "included_in_statement",
    "paid",
  ]);
  const editableStates = new Set(["accepted", "in_progress"]);
  if (!readableStates.has(assignment.work_order_status)) {
    addDenial(denials, "work_order_not_readable", { status: assignment.work_order_status });
  } else if (mode !== "view" && !editableStates.has(assignment.work_order_status)) {
    addDenial(denials, "work_order_not_editable", { status: assignment.work_order_status });
  }
  if (sourceStringId) {
    const item = await databaseQuery(
      database,
      `select 1
       from work_order_items
       where work_order_id = $1 and source_string_id = $2`,
      [assignment.work_order_id, sourceStringId],
    );
    if (!item.rows[0]) addDenial(denials, "work_order_content_item_missing");
  }
  const allowed = denials.length === 0;
  return {
    ...eligibility,
    assignment: {
      id: assignment.id,
      status: assignment.assignment_status,
      workOrderId: assignment.work_order_id,
      workOrderStatus: assignment.work_order_status,
    },
    denialReasons: denials,
    contentAccess: {
      allowed,
      code: allowed ? "work_assignment_authorized" : denials[0].code,
      message: allowed
        ? "The active assignment authorizes this work-order content."
        : denials[0].message,
      requiresWorkAssignment: true,
    },
  };
}
