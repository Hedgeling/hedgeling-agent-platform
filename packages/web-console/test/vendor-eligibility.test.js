import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateVendorEligibility,
  evaluateVendorWorkAccess,
} from "../src/vendor-eligibility.js";

const ids = {
  relationship: "00000000-0000-4000-8000-000000000001",
  customer: "00000000-0000-4000-8000-000000000002",
  agency: "00000000-0000-4000-8000-000000000003",
  membership: "00000000-0000-4000-8000-000000000004",
  user: "00000000-0000-4000-8000-000000000005",
  approval: "00000000-0000-4000-8000-000000000006",
  project: "00000000-0000-4000-8000-000000000007",
  businessUnit: "00000000-0000-4000-8000-000000000008",
  assignment: "00000000-0000-4000-8000-000000000009",
  workOrder: "00000000-0000-4000-8000-000000000010",
  sourceString: "00000000-0000-4000-8000-000000000011",
};

function fixture(overrides = {}) {
  const state = {
    facts: {
      relationship_id: ids.relationship,
      customer_organization_id: ids.customer,
      agency_organization_id: ids.agency,
      relationship_status: "active",
      effective_from: "2026-01-01",
      effective_to: null,
      requires_linguist_approval: true,
      agency_may_assign_linguists: false,
      customer_status: "active",
      agency_status: "active",
      agency_membership_id: ids.membership,
      user_id: ids.user,
      membership_status: "active",
      membership_expires_at: null,
      user_status: "active",
      email: "linguist@example.com",
      display_name: "Test Linguist",
      approval_id: ids.approval,
      approval_status: "approved",
      approval_expires_at: null,
      approval_conditions: { locales: ["fr-CA"] },
    },
    project: {
      id: ids.project,
      name: "Game UI",
      business_unit_id: ids.businessUnit,
      business_unit_name: "Game",
    },
    scopes: [
      { scope_type: "business_unit", scope_id: ids.businessUnit, scope_value: null },
      { scope_type: "locale", scope_id: null, scope_value: "fr-CA" },
    ],
    roles: [{ conditions: {} }],
    ...overrides,
  };
  return async (text) => {
    if (text.includes("from vendor_relationships vr")) return { rows: [state.facts] };
    if (text.includes("from projects p")) return { rows: [state.project] };
    if (text.includes("from vendor_relationship_scopes")) return { rows: state.scopes };
    if (text.includes("from role_assignments ra")) return { rows: state.roles };
    throw new Error(`Unexpected eligibility query: ${text}`);
  };
}

function evaluate(database, overrides = {}) {
  return evaluateVendorEligibility({
    vendorRelationshipId: ids.relationship,
    agencyMembershipId: ids.membership,
    projectId: ids.project,
    locale: "fr-CA",
    at: "2026-07-24T12:00:00.000Z",
    database,
    ...overrides,
  });
}

test("eligible agency linguist remains blocked until a work assignment exists", async () => {
  const result = await evaluate(fixture());
  assert.equal(result.eligibleForAssignment, true);
  assert.deepEqual(result.denialReasons, []);
  assert.deepEqual(result.contentAccess, {
    allowed: false,
    code: "work_assignment_missing",
    message: "An active Phase 5 work assignment is required for customer-content access.",
    requiresWorkAssignment: true,
  });
});

test("eligibility reports independent relationship, scope, and approval blockers together", async () => {
  const database = fixture({
    facts: {
      ...fixtureFacts(),
      relationship_status: "suspended",
      effective_to: "2026-07-23",
      approval_expires_at: "2026-07-24T11:59:00.000Z",
    },
    scopes: [
      { scope_type: "project", scope_id: "00000000-0000-4000-8000-000000000099", scope_value: null },
      { scope_type: "locale", scope_id: null, scope_value: "de-DE" },
    ],
  });
  const result = await evaluate(database);
  const codes = result.denialReasons.map((reason) => reason.code);
  assert.deepEqual(codes, [
    "relationship_not_active",
    "relationship_expired",
    "project_out_of_scope",
    "locale_out_of_scope",
    "linguist_approval_expired",
  ]);
  assert.equal(result.contentAccess.code, "relationship_not_active");
});

test("nomination and agency linguist role are independent prerequisites", async () => {
  const database = fixture({
    facts: {
      ...fixtureFacts(),
      approval_id: null,
      approval_status: null,
      approval_conditions: null,
    },
    roles: [],
  });
  const result = await evaluate(database);
  const codes = result.denialReasons.map((reason) => reason.code);
  assert.ok(codes.includes("agency_linguist_role_missing"));
  assert.ok(codes.includes("linguist_nomination_missing"));
  assert.ok(codes.includes("linguist_approval_missing"));
});

test("locale-conditioned agency roles fail closed for a different locale", async () => {
  const database = fixture({
    roles: [{ conditions: { locales: ["de-DE"] } }],
  });
  const result = await evaluate(database);
  assert.ok(result.denialReasons.some(
    (reason) => reason.code === "agency_role_locale_out_of_scope",
  ));
});

test("customer deletion scheduling closes agency assignment eligibility", async () => {
  const database = fixture({
    project: {
      id: ids.project,
      name: "Game UI",
      business_unit_id: ids.businessUnit,
      business_unit_name: "Game",
      lifecycleState: "scheduled",
      exportAvailableUntil: "2026-08-23T12:00:00.000Z",
    },
  });
  const result = await evaluate(database);
  assert.equal(result.eligibleForAssignment, false);
  assert.equal(
    result.denialReasons[0].code,
    "customer_data_lifecycle_restricted",
  );
});

function workFixture({
  assignmentStatus = "active",
  workOrderStatus = "in_progress",
  includesSourceString = true,
  eligibilityOverrides = {},
} = {}) {
  const eligibilityDatabase = fixture(eligibilityOverrides);
  return async (text, params) => {
    if (text.includes("from work_assignments assignment")) {
      return {
        rows: [{
          id: ids.assignment,
          assignment_status: assignmentStatus,
          agency_membership_id: ids.membership,
          work_order_id: ids.workOrder,
          vendor_relationship_id: ids.relationship,
          project_id: ids.project,
          work_order_status: workOrderStatus,
          source_locale: "en-US",
          target_locale: "fr-CA",
          service_type: "translation",
          content_classification: "game-ui",
          user_id: ids.user,
        }],
      };
    }
    if (text.includes("from work_order_items")) {
      assert.deepEqual(params, [ids.workOrder, ids.sourceString]);
      return { rows: includesSourceString ? [{ "?column?": 1 }] : [] };
    }
    return eligibilityDatabase(text, params);
  };
}

test("active assigned linguist can edit only explicitly attached work-order content", async () => {
  const allowed = await evaluateVendorWorkAccess({
    assignmentId: ids.assignment,
    userId: ids.user,
    sourceStringId: ids.sourceString,
    mode: "edit",
    at: "2026-07-24T12:00:00.000Z",
    database: workFixture(),
  });
  assert.equal(allowed.contentAccess.allowed, true);
  assert.equal(allowed.contentAccess.code, "work_assignment_authorized");

  const denied = await evaluateVendorWorkAccess({
    assignmentId: ids.assignment,
    userId: ids.user,
    sourceStringId: ids.sourceString,
    mode: "edit",
    at: "2026-07-24T12:00:00.000Z",
    database: workFixture({ includesSourceString: false }),
  });
  assert.equal(denied.contentAccess.allowed, false);
  assert.ok(denied.denialReasons.some(
    (reason) => reason.code === "work_order_content_item_missing",
  ));
});

test("completed assignments remain readable but cannot modify customer content", async () => {
  const readable = await evaluateVendorWorkAccess({
    assignmentId: ids.assignment,
    userId: ids.user,
    mode: "view",
    at: "2026-07-24T12:00:00.000Z",
    database: workFixture({
      assignmentStatus: "completed",
      workOrderStatus: "quality_approved",
    }),
  });
  assert.equal(readable.contentAccess.allowed, true);

  const editable = await evaluateVendorWorkAccess({
    assignmentId: ids.assignment,
    userId: ids.user,
    mode: "edit",
    at: "2026-07-24T12:00:00.000Z",
    database: workFixture({
      assignmentStatus: "completed",
      workOrderStatus: "quality_approved",
    }),
  });
  assert.equal(editable.contentAccess.allowed, false);
  assert.deepEqual(
    editable.denialReasons.slice(-2).map((reason) => reason.code),
    ["work_assignment_inactive", "work_order_not_editable"],
  );
});

function fixtureFacts() {
  return {
    relationship_id: ids.relationship,
    customer_organization_id: ids.customer,
    agency_organization_id: ids.agency,
    relationship_status: "active",
    effective_from: "2026-01-01",
    effective_to: null,
    requires_linguist_approval: true,
    agency_may_assign_linguists: false,
    customer_status: "active",
    agency_status: "active",
    agency_membership_id: ids.membership,
    user_id: ids.user,
    membership_status: "active",
    membership_expires_at: null,
    user_status: "active",
    email: "linguist@example.com",
    display_name: "Test Linguist",
    approval_id: ids.approval,
    approval_status: "approved",
    approval_expires_at: null,
    approval_conditions: { locales: ["fr-CA"] },
  };
}
