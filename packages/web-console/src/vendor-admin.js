import crypto from "node:crypto";
import express from "express";
import { query, withTransaction } from "./db.js";
import { auditRequest } from "./audit.js";
import { requireOrganizationPermission } from "./authorization.js";
import { isUuid, optionalTimestamp } from "./validation.js";
import { evaluateVendorEligibility } from "./vendor-eligibility.js";

const router = express.Router();
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
const relationshipStatuses = new Set(["invited", "onboarding", "active", "suspended", "terminated"]);
const valueScopeTypes = new Set(["locale", "service_type", "content_classification"]);
const resourceScopeTypes = new Set(["business_unit", "project"]);
const linguistRoleKeys = new Set(["agency_linguist", "agency_lead_linguist"]);
const rateCardUnitTypes = new Set([
  "source_word",
  "target_word",
  "character",
  "string",
  "hour",
  "fixed_job",
]);
const localePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

for (const parameter of [
  "organizationId",
  "vendorRelationshipId",
  "approvedLinguistId",
  "rateCardId",
]) {
  router.param(parameter, (req, res, next, value) => (
    isUuid(value) ? next() : res.status(400).json({ error: `${parameter} is invalid` })
  ));
}

function clean(value) {
  return String(value ?? "").trim();
}

function slug(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function currency(value, fallback = "USD") {
  const normalized = clean(value || fallback).toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) throw httpError(400, "Currency must be a three-letter ISO code");
  return normalized;
}

function optionalDate(value, fieldName) {
  if (value == null || value === "") return null;
  const normalized = value instanceof Date
    ? value.toISOString().slice(0, 10)
    : value;
  if (typeof normalized !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw httpError(400, `${fieldName} must be an ISO date`);
  }
  const parsed = Date.parse(`${normalized}T00:00:00Z`);
  if (
    !Number.isFinite(parsed)
    || new Date(parsed).toISOString().slice(0, 10) !== normalized
  ) {
    throw httpError(400, `${fieldName} must be an ISO date`);
  }
  return normalized;
}

function nonNegativeInteger(value, fieldName, fallback) {
  if (value == null || value === "") return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw httpError(400, `${fieldName} must be a non-negative integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value, fieldName, fallback = null) {
  if (value == null || value === "") return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw httpError(400, `${fieldName} must be a non-negative safe integer`);
  }
  return value;
}

function booleanSetting(value, fallback, fieldName) {
  if (value == null) return fallback;
  if (typeof value !== "boolean") throw httpError(400, `${fieldName} must be a boolean`);
  return value;
}

function validateDateRange(effectiveFrom, effectiveTo) {
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
    throw httpError(400, "effectiveTo cannot be before effectiveFrom");
  }
}

function relationshipJson(row) {
  if (!row) return null;
  const relationship = {
    id: row.id,
    customerOrganizationId: row.customer_organization_id,
    customerName: row.customer_name,
    agencyOrganizationId: row.agency_organization_id,
    agencyName: row.agency_name,
    status: row.status,
    defaultCurrency: row.default_currency,
    paymentTermsDays: row.payment_terms_days,
    customerVendorNumber: row.customer_vendor_number,
    requiresLinguistApproval: row.requires_linguist_approval,
    agencyMayAssignLinguists: row.agency_may_assign_linguists,
    maximumSubcontractingDepth: row.maximum_subcontracting_depth,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.rate_card_count != null) {
    relationship.summary = {
      rateCardCount: Number(row.rate_card_count),
      openWorkOrderCount: Number(row.open_work_order_count),
      payableStatementCount: Number(row.payable_statement_count),
      openStatementCount: Number(row.open_statement_count),
    };
  }
  return relationship;
}

async function relationshipForParty(client, relationshipId, organizationId, { lock = false } = {}) {
  const result = await client.query(
    `select vr.*, customer.name as customer_name, agency.name as agency_name
     from vendor_relationships vr
     join organizations customer on customer.id = vr.customer_organization_id
     join organizations agency on agency.id = vr.agency_organization_id
     where vr.id = $1
       and (vr.customer_organization_id = $2 or vr.agency_organization_id = $2)
     ${lock ? "for update of vr" : ""}`,
    [relationshipId, organizationId],
  );
  if (!result.rows[0]) throw httpError(404, "Vendor relationship not found");
  return result.rows[0];
}

function relationshipParty(relationship, organizationId) {
  if (relationship.customer_organization_id === organizationId) return "customer";
  if (relationship.agency_organization_id === organizationId) return "agency";
  return null;
}

function requireParty(relationship, organizationId, expectedParty) {
  if (relationshipParty(relationship, organizationId) !== expectedParty) {
    throw httpError(403, `Only the ${expectedParty} organization can perform this action`);
  }
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

async function auditRelationship(client, req, relationship, action, resourceType, resourceId, beforeState, afterState) {
  await auditForOrganization(
    client,
    req,
    relationship.customer_organization_id,
    action,
    resourceType,
    resourceId,
    beforeState,
    afterState,
  );
  await auditForOrganization(
    client,
    req,
    relationship.agency_organization_id,
    action,
    resourceType,
    resourceId,
    beforeState,
    afterState,
  );
}

function relationshipSettings(body, defaults) {
  const effectiveFrom = optionalDate(
    Object.hasOwn(body, "effectiveFrom") ? body.effectiveFrom : defaults.effectiveFrom,
    "effectiveFrom",
  );
  const effectiveTo = optionalDate(
    Object.hasOwn(body, "effectiveTo") ? body.effectiveTo : defaults.effectiveTo,
    "effectiveTo",
  );
  validateDateRange(effectiveFrom, effectiveTo);
  return {
    defaultCurrency: currency(body.defaultCurrency, defaults.defaultCurrency),
    paymentTermsDays: nonNegativeInteger(
      Object.hasOwn(body, "paymentTermsDays") ? body.paymentTermsDays : defaults.paymentTermsDays,
      "paymentTermsDays",
      30,
    ),
    customerVendorNumber: Object.hasOwn(body, "customerVendorNumber")
      ? clean(body.customerVendorNumber) || null
      : defaults.customerVendorNumber,
    requiresLinguistApproval: booleanSetting(
      body.requiresLinguistApproval,
      defaults.requiresLinguistApproval,
      "requiresLinguistApproval",
    ),
    agencyMayAssignLinguists: booleanSetting(
      body.agencyMayAssignLinguists,
      defaults.agencyMayAssignLinguists,
      "agencyMayAssignLinguists",
    ),
    maximumSubcontractingDepth: nonNegativeInteger(
      Object.hasOwn(body, "maximumSubcontractingDepth")
        ? body.maximumSubcontractingDepth
        : defaults.maximumSubcontractingDepth,
      "maximumSubcontractingDepth",
      0,
    ),
    effectiveFrom,
    effectiveTo,
  };
}

async function validateScopes(client, relationship, inputScopes) {
  if (!Array.isArray(inputScopes) || inputScopes.length > 200) {
    throw httpError(400, "scopes must be an array with at most 200 entries");
  }
  const scopes = [];
  const seen = new Set();
  for (const input of inputScopes) {
    const scopeType = clean(input?.scopeType);
    if (resourceScopeTypes.has(scopeType)) {
      const scopeId = clean(input.scopeId);
      if (!isUuid(scopeId) || input.scopeValue != null) {
        throw httpError(400, `${scopeType} scopes require only a valid scopeId`);
      }
      const owner = scopeType === "business_unit"
        ? await client.query(
          "select 1 from business_units where id = $1 and organization_id = $2",
          [scopeId, relationship.customer_organization_id],
        )
        : await client.query(
          `select 1 from projects p join business_units bu on bu.id = p.business_unit_id
           where p.id = $1 and bu.organization_id = $2`,
          [scopeId, relationship.customer_organization_id],
        );
      if (!owner.rows[0]) throw httpError(400, `${scopeType} scope does not belong to the customer`);
      const key = `${scopeType}:${scopeId}`;
      if (!seen.has(key)) scopes.push({ scopeType, scopeId, scopeValue: null });
      seen.add(key);
      continue;
    }
    if (!valueScopeTypes.has(scopeType)) throw httpError(400, "Unsupported relationship scope type");
    if (input.scopeId != null) throw httpError(400, `${scopeType} scopes require only scopeValue`);
    let scopeValue = clean(input.scopeValue);
    if (!scopeValue || scopeValue.length > 100) {
      throw httpError(400, `${scopeType} scopeValue must contain 1 to 100 characters`);
    }
    if (scopeType === "locale") {
      if (!localePattern.test(scopeValue)) throw httpError(400, "Locale scopes must use valid locale tags");
    } else {
      scopeValue = scopeValue.toLowerCase();
    }
    const key = `${scopeType}:${scopeValue.toLowerCase()}`;
    if (!seen.has(key)) scopes.push({ scopeType, scopeId: null, scopeValue });
    seen.add(key);
  }
  return scopes;
}

function normalizedConditionValues(value, fieldName, validator = () => true) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw httpError(400, `${fieldName} must be an array`);
  const values = [...new Set(value.map(clean).filter(Boolean))].sort();
  if (values.length > 50 || values.some((entry) => entry.length > 100 || !validator(entry))) {
    throw httpError(400, `${fieldName} contains invalid values`);
  }
  return values;
}

async function validateLinguistConditions(client, relationshipId, input) {
  const conditions = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const allowedKeys = new Set(["locales", "serviceTypes", "contentClassifications"]);
  if (Object.keys(conditions).some((key) => !allowedKeys.has(key))) {
    throw httpError(400, "Unsupported linguist approval condition");
  }
  const normalized = {
    locales: normalizedConditionValues(conditions.locales, "locales", (value) => localePattern.test(value)),
    serviceTypes: normalizedConditionValues(conditions.serviceTypes, "serviceTypes")
      .map((value) => value.toLowerCase()),
    contentClassifications: normalizedConditionValues(
      conditions.contentClassifications,
      "contentClassifications",
    ).map((value) => value.toLowerCase()),
  };
  const scopeRows = await client.query(
    `select scope_type, scope_value from vendor_relationship_scopes
     where vendor_relationship_id = $1 and scope_value is not null`,
    [relationshipId],
  );
  const scopeMap = new Map();
  for (const row of scopeRows.rows) {
    const values = scopeMap.get(row.scope_type) || new Set();
    values.add(row.scope_value.toLowerCase());
    scopeMap.set(row.scope_type, values);
  }
  const conditionScopeTypes = {
    locales: "locale",
    serviceTypes: "service_type",
    contentClassifications: "content_classification",
  };
  for (const [key, scopeType] of Object.entries(conditionScopeTypes)) {
    const allowed = scopeMap.get(scopeType);
    if (allowed && normalized[key].some((value) => !allowed.has(value.toLowerCase()))) {
      throw httpError(400, `${key} must stay within the vendor relationship scope`);
    }
  }
  return Object.fromEntries(Object.entries(normalized).filter(([, values]) => values.length));
}

function normalizedDecimal(value, fieldName, decimalPlaces, integerPlaces) {
  const normalized = clean(value);
  const pattern = new RegExp(`^\\d{1,${integerPlaces}}(?:\\.\\d{1,${decimalPlaces}})?$`);
  if (!pattern.test(normalized)) {
    throw httpError(
      400,
      `${fieldName} must be a non-negative decimal with at most ${decimalPlaces} decimal places`,
    );
  }
  return normalized;
}

function optionalBoundedValue(value, fieldName, { lower = false, maximum = 100 } = {}) {
  const normalized = clean(value);
  if (!normalized) return null;
  if (normalized.length > maximum) {
    throw httpError(400, `${fieldName} cannot exceed ${maximum} characters`);
  }
  return lower ? normalized.toLowerCase() : normalized;
}

function optionalLocale(value, fieldName) {
  const normalized = optionalBoundedValue(value, fieldName);
  if (normalized && !localePattern.test(normalized)) {
    throw httpError(400, `${fieldName} must use a valid locale tag`);
  }
  return normalized;
}

function rateCardJson(row, lines = []) {
  return {
    id: row.id,
    vendorRelationshipId: row.vendor_relationship_id,
    version: row.version,
    currency: row.currency,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    paymentTermsDays: row.payment_terms_days,
    minimumChargeMinor: row.minimum_charge_minor == null
      ? null
      : Number(row.minimum_charge_minor),
    notes: row.notes,
    submittedByUserId: row.submitted_by_user_id,
    approvedByUserId: row.approved_by_user_id,
    rejectedByUserId: row.rejected_by_user_id,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines,
  };
}

function rateCardLineJson(row) {
  return {
    id: row.id,
    serviceType: row.service_type,
    unitType: row.unit_type,
    unitRate: row.unit_rate,
    sourceLocale: row.source_locale,
    targetLocale: row.target_locale,
    businessUnitId: row.business_unit_id,
    projectId: row.project_id,
    contentType: row.content_type,
    matchBand: row.match_band,
    minimumUnits: row.minimum_units,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

async function loadRateCardLines(client, rateCardId) {
  const result = await client.query(
    `select *
     from rate_card_lines
     where rate_card_id = $1
     order by lower(service_type), unit_type, lower(coalesce(source_locale, '')),
              lower(coalesce(target_locale, '')), id`,
    [rateCardId],
  );
  return result.rows.map(rateCardLineJson);
}

async function rateCardForParty(
  client,
  relationshipId,
  rateCardId,
  organizationId,
  { lock = false } = {},
) {
  const result = await client.query(
    `select card.*, relationship.customer_organization_id,
            relationship.agency_organization_id, relationship.status as relationship_status,
            customer.name as customer_name, agency.name as agency_name
     from rate_cards card
     join vendor_relationships relationship
       on relationship.id = card.vendor_relationship_id
     join organizations customer on customer.id = relationship.customer_organization_id
     join organizations agency on agency.id = relationship.agency_organization_id
     where card.id = $1
       and card.vendor_relationship_id = $2
       and (
         relationship.customer_organization_id = $3
         or relationship.agency_organization_id = $3
       )
     ${lock ? "for update of card, relationship" : ""}`,
    [rateCardId, relationshipId, organizationId],
  );
  if (!result.rows[0]) throw httpError(404, "Rate card not found");
  return result.rows[0];
}

function assertRateCardMutationRelationship(relationship) {
  if (!["onboarding", "active"].includes(relationship.status)) {
    throw httpError(409, "Rate cards can be changed only while the relationship is onboarding or active");
  }
}

function rateCardSettings(body, defaults) {
  const effectiveFrom = optionalDate(
    Object.hasOwn(body, "effectiveFrom") ? body.effectiveFrom : defaults.effectiveFrom,
    "effectiveFrom",
  );
  const effectiveTo = optionalDate(
    Object.hasOwn(body, "effectiveTo") ? body.effectiveTo : defaults.effectiveTo,
    "effectiveTo",
  );
  validateDateRange(effectiveFrom, effectiveTo);
  const notes = Object.hasOwn(body, "notes")
    ? optionalBoundedValue(body.notes, "notes", { maximum: 2000 })
    : defaults.notes;
  return {
    currency: currency(body.currency, defaults.currency),
    effectiveFrom,
    effectiveTo,
    paymentTermsDays: nonNegativeInteger(
      Object.hasOwn(body, "paymentTermsDays")
        ? body.paymentTermsDays
        : defaults.paymentTermsDays,
      "paymentTermsDays",
      defaults.paymentTermsDays ?? 30,
    ),
    minimumChargeMinor: nonNegativeSafeInteger(
      Object.hasOwn(body, "minimumChargeMinor")
        ? body.minimumChargeMinor
        : defaults.minimumChargeMinor,
      "minimumChargeMinor",
      null,
    ),
    notes,
  };
}

async function validateRateCardLines(client, relationship, inputLines) {
  if (!Array.isArray(inputLines) || inputLines.length > 500) {
    throw httpError(400, "lines must be an array with at most 500 entries");
  }
  const normalized = inputLines.map((input, index) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw httpError(400, `lines[${index}] must be an object`);
    }
    const serviceType = optionalBoundedValue(
      input.serviceType,
      `lines[${index}].serviceType`,
      { lower: true },
    );
    if (!serviceType) throw httpError(400, `lines[${index}].serviceType is required`);
    const unitType = clean(input.unitType);
    if (!rateCardUnitTypes.has(unitType)) {
      throw httpError(400, `lines[${index}].unitType is unsupported`);
    }
    const businessUnitId = clean(input.businessUnitId) || null;
    const projectId = clean(input.projectId) || null;
    if (businessUnitId && !isUuid(businessUnitId)) {
      throw httpError(400, `lines[${index}].businessUnitId is invalid`);
    }
    if (projectId && !isUuid(projectId)) {
      throw httpError(400, `lines[${index}].projectId is invalid`);
    }
    if (projectId && !businessUnitId) {
      throw httpError(400, `lines[${index}].businessUnitId is required for a project rate`);
    }
    const metadata = input.metadata == null ? {} : input.metadata;
    if (
      !metadata
      || typeof metadata !== "object"
      || Array.isArray(metadata)
      || JSON.stringify(metadata).length > 8000
    ) {
      throw httpError(400, `lines[${index}].metadata must be an object under 8 KB`);
    }
    return {
      serviceType,
      unitType,
      unitRate: normalizedDecimal(input.unitRate, `lines[${index}].unitRate`, 8, 12),
      sourceLocale: optionalLocale(input.sourceLocale, `lines[${index}].sourceLocale`),
      targetLocale: optionalLocale(input.targetLocale, `lines[${index}].targetLocale`),
      businessUnitId,
      projectId,
      contentType: optionalBoundedValue(
        input.contentType,
        `lines[${index}].contentType`,
        { lower: true },
      ),
      matchBand: optionalBoundedValue(
        input.matchBand,
        `lines[${index}].matchBand`,
        { lower: true },
      ),
      minimumUnits: input.minimumUnits == null || input.minimumUnits === ""
        ? null
        : normalizedDecimal(input.minimumUnits, `lines[${index}].minimumUnits`, 4, 16),
      metadata,
    };
  });

  const businessUnitIds = [...new Set(normalized.map((line) => line.businessUnitId).filter(Boolean))];
  const projectIds = [...new Set(normalized.map((line) => line.projectId).filter(Boolean))];
  const businessUnits = businessUnitIds.length
    ? await client.query(
      `select id
       from business_units
       where id = any($1::uuid[]) and organization_id = $2`,
      [businessUnitIds, relationship.customer_organization_id],
    )
    : { rows: [] };
  const projects = projectIds.length
    ? await client.query(
      `select project.id, project.business_unit_id
       from projects project
       join business_units business_unit on business_unit.id = project.business_unit_id
       where project.id = any($1::uuid[])
         and business_unit.organization_id = $2`,
      [projectIds, relationship.customer_organization_id],
    )
    : { rows: [] };
  const ownedBusinessUnits = new Set(businessUnits.rows.map((row) => row.id));
  const ownedProjects = new Map(projects.rows.map((row) => [row.id, row.business_unit_id]));
  const structuralScopes = await client.query(
    `select scope_type, scope_id
     from vendor_relationship_scopes
     where vendor_relationship_id = $1
       and scope_type in ('business_unit', 'project')`,
    [relationship.id],
  );
  const scopedBusinessUnits = new Set(
    structuralScopes.rows
      .filter((scope) => scope.scope_type === "business_unit")
      .map((scope) => scope.scope_id),
  );
  const scopedProjects = new Set(
    structuralScopes.rows
      .filter((scope) => scope.scope_type === "project")
      .map((scope) => scope.scope_id),
  );
  for (const [index, line] of normalized.entries()) {
    if (line.businessUnitId && !ownedBusinessUnits.has(line.businessUnitId)) {
      throw httpError(400, `lines[${index}].businessUnitId does not belong to the customer`);
    }
    if (
      line.projectId
      && (
        !ownedProjects.has(line.projectId)
        || ownedProjects.get(line.projectId) !== line.businessUnitId
      )
    ) {
      throw httpError(400, `lines[${index}].projectId does not match the customer business unit`);
    }
    if (
      line.projectId
      && !scopedProjects.has(line.projectId)
      && !scopedBusinessUnits.has(line.businessUnitId)
    ) {
      throw httpError(400, `lines[${index}].projectId is outside the relationship scope`);
    }
    if (
      line.businessUnitId
      && !line.projectId
      && !scopedBusinessUnits.has(line.businessUnitId)
    ) {
      throw httpError(400, `lines[${index}].businessUnitId is outside the relationship scope`);
    }
  }

  const selectors = new Set();
  for (const line of normalized) {
    const selector = [
      line.serviceType,
      line.unitType,
      line.sourceLocale?.toLowerCase() || "",
      line.targetLocale?.toLowerCase() || "",
      line.businessUnitId || "",
      line.projectId || "",
      line.contentType || "",
      line.matchBand || "",
    ].join("|");
    if (selectors.has(selector)) {
      throw httpError(400, "Rate-card lines must have unique pricing selectors");
    }
    selectors.add(selector);
  }
  return normalized;
}

async function insertRateCardLines(client, rateCardId, lines) {
  for (const line of lines) {
    await client.query(
      `insert into rate_card_lines(
         rate_card_id, service_type, unit_type, unit_rate, source_locale,
         target_locale, business_unit_id, project_id, content_type,
         match_band, minimum_units, metadata
       ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        rateCardId,
        line.serviceType,
        line.unitType,
        line.unitRate,
        line.sourceLocale,
        line.targetLocale,
        line.businessUnitId,
        line.projectId,
        line.contentType,
        line.matchBand,
        line.minimumUnits,
        JSON.stringify(line.metadata),
      ],
    );
  }
}

function requireLoadedOrganizationPermission(req, permission) {
  if (!req.organizationPermissions?.includes(permission)) {
    throw httpError(403, "You do not have permission for this organization");
  }
}

router.get(
  "/organizations/:organizationId/vendor-relationships",
  requireOrganizationPermission("vendors.view"),
  route(async (req, res) => {
    const result = await query(
      `with selected_relationships as (
         select *
         from vendor_relationships
         where customer_organization_id = $1 or agency_organization_id = $1
       ),
       rate_card_counts as (
         select card.vendor_relationship_id, count(*)::int as count
         from rate_cards card
         join selected_relationships relationship
           on relationship.id = card.vendor_relationship_id
         group by card.vendor_relationship_id
       ),
       work_order_counts as (
         select work_order.vendor_relationship_id,
                count(*) filter (
                  where work_order.status not in ('paid', 'canceled')
                )::int as open_count
         from work_orders work_order
         join selected_relationships relationship
           on relationship.id = work_order.vendor_relationship_id
         group by work_order.vendor_relationship_id
       ),
       statement_counts as (
         select statement.vendor_relationship_id, count(*)::int as count,
                count(*) filter (
                  where statement.status not in ('paid', 'void')
                )::int as open_count
         from payable_statements statement
         join selected_relationships relationship
           on relationship.id = statement.vendor_relationship_id
         group by statement.vendor_relationship_id
       )
       select vr.*, customer.name as customer_name, agency.name as agency_name,
              coalesce(rate_card_counts.count, 0) as rate_card_count,
              coalesce(work_order_counts.open_count, 0) as open_work_order_count,
              coalesce(statement_counts.count, 0) as payable_statement_count,
              coalesce(statement_counts.open_count, 0) as open_statement_count
       from selected_relationships vr
       join organizations customer on customer.id = vr.customer_organization_id
       join organizations agency on agency.id = vr.agency_organization_id
       left join rate_card_counts on rate_card_counts.vendor_relationship_id = vr.id
       left join work_order_counts on work_order_counts.vendor_relationship_id = vr.id
       left join statement_counts on statement_counts.vendor_relationship_id = vr.id
       order by lower(case when vr.customer_organization_id = $1 then agency.name else customer.name end)`,
      [req.authorizedOrganizationId],
    );
    res.json({ vendorRelationships: result.rows.map(relationshipJson) });
  }),
);

router.post(
  "/organizations/:organizationId/vendor-relationships",
  requireOrganizationPermission("vendors.invite"),
  route(async (req, res) => {
    const ownerEmail = clean(req.body.ownerEmail).toLowerCase();
    const requestedAgencyId = clean(req.body.agencyOrganizationId);
    if (requestedAgencyId && !isUuid(requestedAgencyId)) {
      throw httpError(400, "agencyOrganizationId must be a valid UUID");
    }
    const agencyName = clean(req.body.agencyName);
    const agencySlug = slug(req.body.agencySlug || agencyName);
    if (!requestedAgencyId && (!agencyName || !agencySlug || !ownerEmail.includes("@"))) {
      throw httpError(400, "A new agency requires agencyName, a valid slug, and ownerEmail");
    }
    const token = requestedAgencyId ? null : crypto.randomBytes(32).toString("base64url");
    const tokenDigest = token
      ? crypto.createHash("sha256").update(token).digest("hex")
      : null;
    const result = await withTransaction(async (client) => {
      const customerResult = await client.query(
        `select id, name, organization_type, status, default_currency
         from organizations where id = $1 for update`,
        [req.authorizedOrganizationId],
      );
      const customer = customerResult.rows[0];
      if (customer.organization_type !== "customer" || customer.status !== "active") {
        throw httpError(409, "Only an active customer organization can onboard an agency");
      }
      const settings = relationshipSettings(req.body, {
        defaultCurrency: customer.default_currency,
        paymentTermsDays: 30,
        customerVendorNumber: null,
        requiresLinguistApproval: true,
        agencyMayAssignLinguists: false,
        maximumSubcontractingDepth: 0,
        effectiveFrom: null,
        effectiveTo: null,
      });
      let agency;
      let invitation = null;
      if (requestedAgencyId) {
        const agencyResult = await client.query(
          `select id, name, organization_type, status from organizations where id = $1`,
          [requestedAgencyId],
        );
        agency = agencyResult.rows[0];
        if (!agency || agency.organization_type !== "agency" || agency.status !== "active") {
          throw httpError(400, "The selected organization is not an active agency");
        }
      } else {
        const agencyResult = await client.query(
          `insert into organizations(slug, name, organization_type, default_currency)
           values($1, $2, 'agency', $3)
           returning id, name, organization_type, status`,
          [agencySlug, agencyName, settings.defaultCurrency],
        );
        agency = agencyResult.rows[0];
        const userResult = await client.query(
          `insert into users(email, display_name, status) values($1, $2, 'invited')
           on conflict((lower(email))) do update set updated_at = now()
           returning id, email`,
          [ownerEmail, clean(req.body.ownerDisplayName) || null],
        );
        const membershipResult = await client.query(
          `insert into organization_memberships(
             organization_id, user_id, membership_type, status, invited_by_user_id
           ) values($1, $2, 'internal', 'invited', $3)
           returning id`,
          [agency.id, userResult.rows[0].id, req.auth?.user?.id || null],
        );
        invitation = (await client.query(
          `insert into invitations(
             organization_id, email, token_digest, membership_type, invited_by_user_id, expires_at
           ) values($1, $2, $3, 'internal', $4, now() + interval '7 days')
           returning id, email, expires_at as "expiresAt"`,
          [agency.id, ownerEmail, tokenDigest, req.auth?.user?.id || null],
        )).rows[0];
        const ownerRole = await client.query(
          "select id from roles where organization_id is null and key = 'agency_owner'",
        );
        await client.query(
          `insert into role_assignments(
             principal_type, principal_id, role_id, scope_type, scope_id,
             inherit_to_children, granted_by_user_id
           ) values('user', $1, $2, 'organization', $3, true, $4)`,
          [userResult.rows[0].id, ownerRole.rows[0].id, agency.id, req.auth?.user?.id || null],
        );
        await auditForOrganization(
          client,
          req,
          agency.id,
          "agency.created",
          "organization",
          agency.id,
          null,
          { id: agency.id, name: agency.name, ownerEmail },
        );
        await auditForOrganization(
          client,
          req,
          agency.id,
          "member.invited",
          "organization_membership",
          membershipResult.rows[0].id,
          null,
          { email: ownerEmail, roleKey: "agency_owner" },
        );
      }
      const relationshipResult = await client.query(
        `insert into vendor_relationships(
           customer_organization_id, agency_organization_id, default_currency,
           payment_terms_days, customer_vendor_number, requires_linguist_approval,
           agency_may_assign_linguists, maximum_subcontracting_depth,
           effective_from, effective_to
         ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning *`,
        [
          customer.id,
          agency.id,
          settings.defaultCurrency,
          settings.paymentTermsDays,
          settings.customerVendorNumber,
          settings.requiresLinguistApproval,
          settings.agencyMayAssignLinguists,
          settings.maximumSubcontractingDepth,
          settings.effectiveFrom,
          settings.effectiveTo,
        ],
      );
      const relationship = {
        ...relationshipResult.rows[0],
        customer_name: customer.name,
        agency_name: agency.name,
      };
      await auditRelationship(
        client,
        req,
        relationship,
        "vendor_relationship.invited",
        "vendor_relationship",
        relationship.id,
        null,
        relationshipJson(relationship),
      );
      return { relationship: relationshipJson(relationship), invitation };
    });
    res.status(201).json({
      vendorRelationship: result.relationship,
      agencyOwnerInvitation: result.invitation,
      ...(token ? { onboardingToken: token } : {}),
    });
  }),
);

router.get(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId",
  requireOrganizationPermission("vendors.view"),
  route(async (req, res) => {
    const relationship = await relationshipForParty(
      { query },
      req.params.vendorRelationshipId,
      req.authorizedOrganizationId,
    );
    const [scopes, linguists, eligibleProjects] = await Promise.all([
      query(
        `select scope.id, scope.scope_type as "scopeType", scope.scope_id as "scopeId",
                scope.scope_value as "scopeValue",
                coalesce(bu.name, project.name, scope.scope_value) as "scopeName",
                scope.created_at as "createdAt"
         from vendor_relationship_scopes scope
         left join business_units bu
           on scope.scope_type = 'business_unit' and bu.id = scope.scope_id
         left join projects project
           on scope.scope_type = 'project' and project.id = scope.scope_id
         where scope.vendor_relationship_id = $1
         order by scope.scope_type, coalesce(scope.scope_value, scope.scope_id::text)`,
        [relationship.id],
      ),
      query(
        `select val.id, val.agency_membership_id as "agencyMembershipId",
                u.email, u.display_name as "displayName", val.status, val.conditions,
                val.approved_at as "approvedAt", val.expires_at as "expiresAt",
                val.created_at as "createdAt", val.updated_at as "updatedAt"
         from vendor_approved_linguists val
         join organization_memberships om on om.id = val.agency_membership_id
         join users u on u.id = om.user_id
         where val.vendor_relationship_id = $1
         order by lower(coalesce(u.display_name, u.email))`,
        [relationship.id],
      ),
      query(
        `select distinct p.id, p.name, p.business_unit_id as "businessUnitId",
                bu.name as "businessUnitName"
         from projects p
         join business_units bu on bu.id = p.business_unit_id
         where bu.organization_id = $2
           and exists(
             select 1 from vendor_relationship_scopes scope
             where scope.vendor_relationship_id = $1
               and (
                 (scope.scope_type = 'project' and scope.scope_id = p.id)
                 or (scope.scope_type = 'business_unit' and scope.scope_id = bu.id)
               )
           )
         order by p.name`,
        [relationship.id, relationship.customer_organization_id],
      ),
    ]);
    res.json({
      vendorRelationship: relationshipJson(relationship),
      scopes: scopes.rows,
      linguists: linguists.rows,
      eligibleProjects: eligibleProjects.rows,
    });
  }),
);

router.post(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/eligibility-check",
  requireOrganizationPermission("vendors.view"),
  route(async (req, res) => {
    const agencyMembershipId = clean(req.body.agencyMembershipId);
    const projectId = clean(req.body.projectId);
    if (!isUuid(agencyMembershipId) || !isUuid(projectId)) {
      throw httpError(400, "Valid agencyMembershipId and projectId values are required");
    }
    const relationship = await relationshipForParty(
      { query },
      req.params.vendorRelationshipId,
      req.authorizedOrganizationId,
    );
    if (relationshipParty(relationship, req.authorizedOrganizationId) === "customer") {
      const disclosed = await query(
        `select 1 from vendor_approved_linguists
         where vendor_relationship_id = $1 and agency_membership_id = $2`,
        [relationship.id, agencyMembershipId],
      );
      if (!disclosed.rows[0]) throw httpError(404, "Linguist nomination not found");
    }
    const context = {
      locale: clean(req.body.locale) || null,
      serviceType: clean(req.body.serviceType) || null,
      contentClassification: clean(req.body.contentClassification) || null,
    };
    if (Object.values(context).some((value) => value && value.length > 100)) {
      throw httpError(400, "Eligibility context values cannot exceed 100 characters");
    }
    const eligibility = await evaluateVendorEligibility({
      vendorRelationshipId: relationship.id,
      agencyMembershipId,
      projectId,
      ...context,
    });
    res.json({ eligibility });
  }),
);

router.patch(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId",
  requireOrganizationPermission("vendors.manage"),
  route(async (req, res) => {
    const updatedRelationship = await withTransaction(async (client) => {
      const before = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      requireParty(before, req.authorizedOrganizationId, "customer");
      if (before.status === "terminated") throw httpError(409, "A terminated relationship cannot be changed");
      const settings = relationshipSettings(req.body, {
        defaultCurrency: before.default_currency,
        paymentTermsDays: before.payment_terms_days,
        customerVendorNumber: before.customer_vendor_number,
        requiresLinguistApproval: before.requires_linguist_approval,
        agencyMayAssignLinguists: before.agency_may_assign_linguists,
        maximumSubcontractingDepth: before.maximum_subcontracting_depth,
        effectiveFrom: before.effective_from,
        effectiveTo: before.effective_to,
      });
      const updated = await client.query(
        `update vendor_relationships set
           default_currency = $2, payment_terms_days = $3, customer_vendor_number = $4,
           requires_linguist_approval = $5, agency_may_assign_linguists = $6,
           maximum_subcontracting_depth = $7, effective_from = $8, effective_to = $9,
           updated_at = now()
         where id = $1 returning *`,
        [
          before.id,
          settings.defaultCurrency,
          settings.paymentTermsDays,
          settings.customerVendorNumber,
          settings.requiresLinguistApproval,
          settings.agencyMayAssignLinguists,
          settings.maximumSubcontractingDepth,
          settings.effectiveFrom,
          settings.effectiveTo,
        ],
      );
      const after = {
        ...updated.rows[0],
        customer_name: before.customer_name,
        agency_name: before.agency_name,
      };
      if (!before.requires_linguist_approval && settings.requiresLinguistApproval) {
        const autoApproved = await client.query(
          `select *
           from vendor_approved_linguists
           where vendor_relationship_id = $1
             and status = 'approved'
             and approved_by_user_id is null
           for update`,
          [before.id],
        );
        for (const autoApproval of autoApproved.rows) {
          const reset = await client.query(
            `update vendor_approved_linguists
             set status = 'pending', approved_at = null, updated_at = now()
             where id = $1
             returning *`,
            [autoApproval.id],
          );
          await auditRelationship(
            client,
            req,
            after,
            "vendor_linguist.auto_approval_reset",
            "vendor_approved_linguist",
            autoApproval.id,
            autoApproval,
            reset.rows[0],
          );
        }
      }
      await auditRelationship(
        client,
        req,
        before,
        "vendor_relationship.updated",
        "vendor_relationship",
        before.id,
        relationshipJson(before),
        relationshipJson(after),
      );
      return after;
    });
    res.json({ vendorRelationship: relationshipJson(updatedRelationship) });
  }),
);

router.post(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/transitions",
  requireOrganizationPermission("vendors.manage"),
  route(async (req, res) => {
    const requestedStatus = clean(req.body.status);
    if (!relationshipStatuses.has(requestedStatus) || requestedStatus === "invited") {
      throw httpError(400, "A valid target relationship status is required");
    }
    const updatedRelationship = await withTransaction(async (client) => {
      const before = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      const party = relationshipParty(before, req.authorizedOrganizationId);
      const allowed = {
        invited: { onboarding: ["agency"], terminated: ["customer", "agency"] },
        onboarding: { active: ["customer"], terminated: ["customer", "agency"] },
        active: { suspended: ["customer"], terminated: ["customer", "agency"] },
        suspended: { active: ["customer"], terminated: ["customer", "agency"] },
        terminated: {},
      };
      if (!allowed[before.status]?.[requestedStatus]?.includes(party)) {
        throw httpError(409, `The ${party} cannot transition ${before.status} to ${requestedStatus}`);
      }
      if (requestedStatus === "active") {
        const readiness = await client.query(
          `select
             exists(
               select 1 from organization_memberships
               where organization_id = $1 and status = 'active'
                 and (expires_at is null or expires_at > now())
             ) as agency_ready,
             exists(
               select 1 from vendor_relationship_scopes
               where vendor_relationship_id = $2 and scope_type in ('business_unit', 'project')
             ) as structurally_scoped,
             ($3::date is null or $3::date >= current_date) as not_expired`,
          [before.agency_organization_id, before.id, before.effective_to],
        );
        if (!readiness.rows[0].agency_ready) {
          throw httpError(409, "The agency must have an active member before activation");
        }
        if (!readiness.rows[0].structurally_scoped) {
          throw httpError(409, "At least one business unit or project scope is required before activation");
        }
        if (!readiness.rows[0].not_expired) {
          throw httpError(409, "An expired relationship cannot be activated");
        }
      }
      const updated = await client.query(
        `update vendor_relationships set status = $2,
           effective_from = case when $2 = 'active' then coalesce(effective_from, current_date) else effective_from end,
           effective_to = case when $2 = 'terminated' then current_date else effective_to end,
           updated_at = now()
         where id = $1 returning *`,
        [before.id, requestedStatus],
      );
      const after = {
        ...updated.rows[0],
        customer_name: before.customer_name,
        agency_name: before.agency_name,
      };
      await auditRelationship(
        client,
        req,
        before,
        `vendor_relationship.${requestedStatus}`,
        "vendor_relationship",
        before.id,
        relationshipJson(before),
        relationshipJson(after),
      );
      return after;
    });
    res.json({ vendorRelationship: relationshipJson(updatedRelationship) });
  }),
);

router.put(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/scopes",
  requireOrganizationPermission("vendors.manage"),
  route(async (req, res) => {
    const savedScopes = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      requireParty(relationship, req.authorizedOrganizationId, "customer");
      if (relationship.status === "terminated") throw httpError(409, "A terminated relationship cannot be changed");
      const scopes = await validateScopes(client, relationship, req.body.scopes);
      if (
        relationship.status === "active"
        && !scopes.some((scope) => resourceScopeTypes.has(scope.scopeType))
      ) {
        throw httpError(409, "An active relationship requires a business unit or project scope");
      }
      const before = await client.query(
        `select scope_type as "scopeType", scope_id as "scopeId", scope_value as "scopeValue"
         from vendor_relationship_scopes where vendor_relationship_id = $1
         order by scope_type, coalesce(scope_value, scope_id::text)`,
        [relationship.id],
      );
      await client.query(
        "delete from vendor_relationship_scopes where vendor_relationship_id = $1",
        [relationship.id],
      );
      for (const scope of scopes) {
        await client.query(
          `insert into vendor_relationship_scopes(
             vendor_relationship_id, scope_type, scope_id, scope_value
           ) values($1, $2, $3, $4)`,
          [relationship.id, scope.scopeType, scope.scopeId, scope.scopeValue],
        );
      }
      await client.query(
        "update vendor_relationships set updated_at = now() where id = $1",
        [relationship.id],
      );
      await auditRelationship(
        client,
        req,
        relationship,
        "vendor_relationship.scopes_updated",
        "vendor_relationship",
        relationship.id,
        { scopes: before.rows },
        { scopes },
      );
      return scopes;
    });
    res.json({ scopes: savedScopes });
  }),
);

router.get(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/linguists",
  requireOrganizationPermission("vendors.view"),
  route(async (req, res) => {
    await relationshipForParty(
      { query },
      req.params.vendorRelationshipId,
      req.authorizedOrganizationId,
    );
    const result = await query(
      `select val.id, val.agency_membership_id as "agencyMembershipId",
              u.email, u.display_name as "displayName", val.status, val.conditions,
              val.approved_at as "approvedAt", val.expires_at as "expiresAt",
              val.created_at as "createdAt", val.updated_at as "updatedAt"
       from vendor_approved_linguists val
       join organization_memberships om on om.id = val.agency_membership_id
       join users u on u.id = om.user_id
       where val.vendor_relationship_id = $1
       order by lower(coalesce(u.display_name, u.email))`,
      [req.params.vendorRelationshipId],
    );
    res.json({ linguists: result.rows });
  }),
);

router.post(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/linguists",
  requireOrganizationPermission("vendors.manage"),
  route(async (req, res) => {
    const membershipId = clean(req.body.agencyMembershipId);
    if (!isUuid(membershipId)) throw httpError(400, "agencyMembershipId must be a valid UUID");
    const expiresAt = optionalTimestamp(req.body.expiresAt);
    const linguist = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      requireParty(relationship, req.authorizedOrganizationId, "agency");
      if (!["onboarding", "active"].includes(relationship.status)) {
        throw httpError(409, "Linguists can only be nominated during onboarding or an active relationship");
      }
      const membershipResult = await client.query(
        `select om.id, om.user_id
         from organization_memberships om
         where om.id = $1 and om.organization_id = $2 and om.status = 'active'
           and (om.expires_at is null or om.expires_at > now())`,
        [membershipId, relationship.agency_organization_id],
      );
      const membership = membershipResult.rows[0];
      if (!membership) throw httpError(400, "The linguist must be an active member of this agency");
      const eligibility = await client.query(
        `select 1
         from role_assignments ra
         join roles r on r.id = ra.role_id
         where ra.revoked_at is null
           and (ra.expires_at is null or ra.expires_at > now())
           and r.key = any($3::text[])
           and ra.scope_type = 'organization' and ra.scope_id = $2
           and (
             (ra.principal_type = 'user' and ra.principal_id = $1)
             or (
               ra.principal_type = 'team' and ra.principal_id in (
                 select tm.team_id from team_memberships tm
                 where tm.organization_membership_id = $4
               )
             )
           )
         limit 1`,
        [membership.user_id, relationship.agency_organization_id, [...linguistRoleKeys], membership.id],
      );
      if (!eligibility.rows[0]) {
        throw httpError(409, "The agency member must have an agency linguist role before nomination");
      }
      const conditions = await validateLinguistConditions(client, relationship.id, req.body.conditions);
      const existing = await client.query(
        `select * from vendor_approved_linguists
         where vendor_relationship_id = $1 and agency_membership_id = $2 for update`,
        [relationship.id, membership.id],
      );
      if (["pending", "approved"].includes(existing.rows[0]?.status)) {
        throw httpError(409, "This linguist already has a current nomination");
      }
      const status = relationship.requires_linguist_approval ? "pending" : "approved";
      const result = await client.query(
        `insert into vendor_approved_linguists(
           vendor_relationship_id, agency_membership_id, status, approved_at,
           expires_at, conditions
         ) values($1, $2, $3, case when $3 = 'approved' then now() else null end, $4, $5)
         on conflict(vendor_relationship_id, agency_membership_id) do update set
           status = excluded.status, approved_by_user_id = null,
           approved_at = excluded.approved_at, expires_at = excluded.expires_at,
           conditions = excluded.conditions, updated_at = now()
         returning id, agency_membership_id as "agencyMembershipId", status,
                   conditions, approved_at as "approvedAt", expires_at as "expiresAt"`,
        [relationship.id, membership.id, status, expiresAt, JSON.stringify(conditions)],
      );
      await auditRelationship(
        client,
        req,
        relationship,
        "vendor_linguist.nominated",
        "vendor_approved_linguist",
        result.rows[0].id,
        existing.rows[0] || null,
        result.rows[0],
      );
      return result.rows[0];
    });
    res.status(201).json({ linguist });
  }),
);

router.patch(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/linguists/:approvedLinguistId",
  requireOrganizationPermission("vendor_linguists.approve"),
  route(async (req, res) => {
    const requestedStatus = clean(req.body.status);
    if (!["approved", "rejected", "revoked"].includes(requestedStatus)) {
      throw httpError(400, "status must be approved, rejected, or revoked");
    }
    const linguist = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      requireParty(relationship, req.authorizedOrganizationId, "customer");
      if (relationship.status === "terminated") throw httpError(409, "A terminated relationship cannot be changed");
      const beforeResult = await client.query(
        `select * from vendor_approved_linguists
         where id = $1 and vendor_relationship_id = $2 for update`,
        [req.params.approvedLinguistId, relationship.id],
      );
      const before = beforeResult.rows[0];
      if (!before) throw httpError(404, "Approved linguist record not found");
      const allowed = {
        pending: ["approved", "rejected"],
        approved: ["revoked"],
        rejected: [],
        revoked: [],
      };
      if (!allowed[before.status].includes(requestedStatus)) {
        throw httpError(409, `A ${before.status} linguist cannot transition to ${requestedStatus}`);
      }
      const updated = await client.query(
        `update vendor_approved_linguists set status = $2,
           approved_by_user_id = case when $2 = 'approved' then $3 else approved_by_user_id end,
           approved_at = case when $2 = 'approved' then now() else approved_at end,
           updated_at = now()
         where id = $1
         returning id, agency_membership_id as "agencyMembershipId", status,
                   conditions, approved_at as "approvedAt", expires_at as "expiresAt"`,
        [before.id, requestedStatus, req.auth?.user?.id || null],
      );
      await auditRelationship(
        client,
        req,
        relationship,
        `vendor_linguist.${requestedStatus}`,
        "vendor_approved_linguist",
        before.id,
        before,
        updated.rows[0],
      );
      return updated.rows[0];
    });
    res.json({ linguist });
  }),
);

router.get(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/rate-cards",
  requireOrganizationPermission("rate_cards.view"),
  route(async (req, res) => {
    const relationship = await relationshipForParty(
      { query },
      req.params.vendorRelationshipId,
      req.authorizedOrganizationId,
    );
    const [cards, lines] = await Promise.all([
      query(
        `select *
         from rate_cards
         where vendor_relationship_id = $1
         order by version desc`,
        [relationship.id],
      ),
      query(
        `select line.*
         from rate_card_lines line
         join rate_cards card on card.id = line.rate_card_id
         where card.vendor_relationship_id = $1
         order by lower(line.service_type), line.unit_type,
                  lower(coalesce(line.source_locale, '')),
                  lower(coalesce(line.target_locale, '')), line.id`,
        [relationship.id],
      ),
    ]);
    const linesByCard = new Map();
    for (const line of lines.rows) {
      const cardLines = linesByCard.get(line.rate_card_id) || [];
      cardLines.push(rateCardLineJson(line));
      linesByCard.set(line.rate_card_id, cardLines);
    }
    const rateCards = cards.rows.map((card) => rateCardJson(
      card,
      linesByCard.get(card.id) || [],
    ));
    res.json({ rateCards });
  }),
);

router.post(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/rate-cards",
  requireOrganizationPermission("rate_cards.propose"),
  route(async (req, res) => {
    const rateCard = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      requireParty(relationship, req.authorizedOrganizationId, "agency");
      assertRateCardMutationRelationship(relationship);
      const open = await client.query(
        `select id
         from rate_cards
         where vendor_relationship_id = $1 and status in ('draft', 'submitted')`,
        [relationship.id],
      );
      if (open.rows[0]) {
        throw httpError(409, "This relationship already has an open rate-card proposal");
      }
      const settings = rateCardSettings(req.body || {}, {
        currency: relationship.default_currency,
        effectiveFrom: null,
        effectiveTo: null,
        paymentTermsDays: relationship.payment_terms_days,
        minimumChargeMinor: null,
        notes: null,
      });
      const lines = await validateRateCardLines(client, relationship, req.body?.lines || []);
      const result = await client.query(
        `insert into rate_cards(
           vendor_relationship_id, version, currency, effective_from, effective_to,
           payment_terms_days, minimum_charge_minor, notes
         ) values(
           $1,
           (select coalesce(max(version), 0) + 1 from rate_cards where vendor_relationship_id = $1),
           $2, coalesce($3::date, current_date), $4, $5, $6, $7
         )
         returning *`,
        [
          relationship.id,
          settings.currency,
          settings.effectiveFrom,
          settings.effectiveTo,
          settings.paymentTermsDays,
          settings.minimumChargeMinor,
          settings.notes,
        ],
      );
      await insertRateCardLines(client, result.rows[0].id, lines);
      const after = rateCardJson(
        result.rows[0],
        await loadRateCardLines(client, result.rows[0].id),
      );
      await auditRelationship(
        client,
        req,
        relationship,
        "rate_card.created",
        "rate_card",
        result.rows[0].id,
        null,
        after,
      );
      return after;
    });
    res.status(201).json({ rateCard });
  }),
);

router.put(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/rate-cards/:rateCardId",
  requireOrganizationPermission("rate_cards.propose"),
  route(async (req, res) => {
    if (!Array.isArray(req.body?.lines)) {
      throw httpError(400, "lines is required when replacing a rate-card draft");
    }
    const rateCard = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      requireParty(relationship, req.authorizedOrganizationId, "agency");
      assertRateCardMutationRelationship(relationship);
      const before = await rateCardForParty(
        client,
        relationship.id,
        req.params.rateCardId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      if (before.status !== "draft") {
        throw httpError(409, "Only a draft rate card can be edited");
      }
      const beforeState = rateCardJson(before, await loadRateCardLines(client, before.id));
      const settings = rateCardSettings(req.body, {
        currency: before.currency,
        effectiveFrom: before.effective_from,
        effectiveTo: before.effective_to,
        paymentTermsDays: before.payment_terms_days,
        minimumChargeMinor: before.minimum_charge_minor == null
          ? null
          : Number(before.minimum_charge_minor),
        notes: before.notes,
      });
      const lines = await validateRateCardLines(client, relationship, req.body.lines);
      const result = await client.query(
        `update rate_cards set
           currency = $2, effective_from = $3, effective_to = $4,
           payment_terms_days = $5, minimum_charge_minor = $6,
           notes = $7, updated_at = now()
         where id = $1
         returning *`,
        [
          before.id,
          settings.currency,
          settings.effectiveFrom,
          settings.effectiveTo,
          settings.paymentTermsDays,
          settings.minimumChargeMinor,
          settings.notes,
        ],
      );
      await client.query("delete from rate_card_lines where rate_card_id = $1", [before.id]);
      await insertRateCardLines(client, before.id, lines);
      const after = rateCardJson(result.rows[0], await loadRateCardLines(client, before.id));
      await auditRelationship(
        client,
        req,
        relationship,
        "rate_card.updated",
        "rate_card",
        before.id,
        beforeState,
        after,
      );
      return after;
    });
    res.json({ rateCard });
  }),
);

router.post(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/rate-cards/:rateCardId/transitions",
  requireOrganizationPermission("rate_cards.view"),
  route(async (req, res) => {
    const requestedStatus = clean(req.body?.status);
    if (!["submitted", "approved", "rejected"].includes(requestedStatus)) {
      throw httpError(400, "status must be submitted, approved, or rejected");
    }
    const requiredPermission = requestedStatus === "submitted"
      ? "rate_cards.propose"
      : "rate_cards.approve";
    requireLoadedOrganizationPermission(req, requiredPermission);
    const rejectionReason = requestedStatus === "rejected"
      ? optionalBoundedValue(req.body?.reason, "reason", { maximum: 1000 })
      : null;
    if (requestedStatus === "rejected" && !rejectionReason) {
      throw httpError(400, "A rejection reason is required");
    }

    const rateCard = await withTransaction(async (client) => {
      const relationship = await relationshipForParty(
        client,
        req.params.vendorRelationshipId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      assertRateCardMutationRelationship(relationship);
      const expectedParty = requestedStatus === "submitted" ? "agency" : "customer";
      requireParty(relationship, req.authorizedOrganizationId, expectedParty);
      const before = await rateCardForParty(
        client,
        relationship.id,
        req.params.rateCardId,
        req.authorizedOrganizationId,
        { lock: true },
      );
      const lines = await loadRateCardLines(client, before.id);
      const beforeState = rateCardJson(before, lines);
      const actorId = req.auth?.user?.id || null;
      let result;

      if (requestedStatus === "submitted") {
        if (before.status !== "draft") {
          throw httpError(409, "Only a draft rate card can be submitted");
        }
        if (!lines.length) {
          throw httpError(409, "A rate card requires at least one line before submission");
        }
        await validateRateCardLines(client, relationship, lines);
        result = await client.query(
          `update rate_cards set
             status = 'submitted', submitted_by_user_id = $2,
             submitted_at = now(), updated_at = now()
           where id = $1
           returning *`,
          [before.id, actorId],
        );
      } else {
        if (before.status !== "submitted") {
          throw httpError(409, `Only a submitted rate card can be ${requestedStatus}`);
        }
        if (requestedStatus === "approved") {
          await validateRateCardLines(client, relationship, lines);
          const validity = await client.query(
            `select
               ($1::date is null or $1::date <= current_date) as started,
               ($2::date is null or $2::date >= current_date) as not_expired`,
            [before.effective_from, before.effective_to],
          );
          if (!validity.rows[0].started) {
            throw httpError(409, "Future-scheduled rate-card approval is not supported yet");
          }
          if (!validity.rows[0].not_expired) {
            throw httpError(409, "An expired rate card cannot be approved");
          }
          const previous = await client.query(
            `update rate_cards set status = 'superseded', updated_at = now()
             where vendor_relationship_id = $1 and status = 'approved'
             returning *`,
            [relationship.id],
          );
          for (const superseded of previous.rows) {
            const previousLines = await loadRateCardLines(client, superseded.id);
            await auditRelationship(
              client,
              req,
              relationship,
              "rate_card.superseded",
              "rate_card",
              superseded.id,
              rateCardJson({ ...superseded, status: "approved" }, previousLines),
              rateCardJson(superseded, previousLines),
            );
          }
          result = await client.query(
            `update rate_cards set
               status = 'approved', effective_from = coalesce(effective_from, current_date),
               approved_by_user_id = $2, approved_at = now(), updated_at = now()
             where id = $1
             returning *`,
            [before.id, actorId],
          );
        } else {
          result = await client.query(
            `update rate_cards set
               status = 'rejected', rejected_by_user_id = $2,
               rejected_at = now(), rejection_reason = $3, updated_at = now()
             where id = $1
             returning *`,
            [before.id, actorId, rejectionReason],
          );
        }
      }

      const after = rateCardJson(result.rows[0], lines);
      await auditRelationship(
        client,
        req,
        relationship,
        `rate_card.${requestedStatus}`,
        "rate_card",
        before.id,
        beforeState,
        after,
      );
      return after;
    });
    res.json({ rateCard });
  }),
);

export default router;
