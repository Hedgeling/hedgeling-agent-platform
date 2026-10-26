import { createHash, randomUUID } from "node:crypto";
import express from "express";
import { auditRequest, insertAuditEvent } from "./audit.js";
import {
  requirePlatformAdmin,
  requirePlatformOperationsAccess,
} from "./auth.js";
import { requireOrganizationPermission } from "./authorization.js";
import { query, withTransaction } from "./db.js";
import { organizationFeatureAccess } from "./entitlements.js";
import {
  createPinnedStripeClient,
  stripeApiVersion,
  stripeNodeSdkVersion,
} from "./stripe-client.js";
import { isUuid } from "./validation.js";
import { settleStatementIfPaid } from "./work-admin.js";

export const organizationMoneyRouter = express.Router();
export const platformMoneyRouter = express.Router();

const provider = "stripe";
const programVersion = "us-usd-v1";
// Stripe's eight-digit amount ceiling is lower than PostgreSQL bigint and
// keeps every provider-bound conversion exactly representable in JavaScript.
const maximumMinorUnits = 99_999_999n;
const stripeIdempotencyRetentionMs = 24 * 60 * 60 * 1000;
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
let stripeClientOverride = null;

for (const parameter of ["organizationId", "vendorRelationshipId", "statementId"]) {
  organizationMoneyRouter.param(parameter, (req, res, next, value) => (
    isUuid(value) ? next() : res.status(400).json({ error: `${parameter} is invalid` })
  ));
}

export const requiredCertificationChecks = Object.freeze([
  "connect_account_ready",
  "late_success_quarantine",
  "card_success",
  "card_failure",
  "ach_processing_success",
  "ach_failure",
  "ach_return",
  "checkout_expiry",
  "transfer_release",
  "transfer_reversal",
  "refund",
  "card_dispute",
  "payout_late_failure",
  "rolling_cap_contention",
  "idempotency_retention",
  "event_replay",
  "reconciliation",
  "legal_finance_risk_approval",
  "support_runbook",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function enabled(name) {
  return process.env[name] === "true";
}

function providerMode() {
  const value = clean(process.env.HEDGELING_FACILITATED_PAYMENTS_MODE || "test").toLowerCase();
  if (!["test", "live"].includes(value)) {
    throw new Error("HEDGELING_FACILITATED_PAYMENTS_MODE must be test or live");
  }
  return value;
}

function requireFacilitatedPaymentsFoundation() {
  if (!enabled("HEDGELING_FACILITATED_PAYMENTS_ENABLED")) {
    throw httpError(
      503,
      "Facilitated payments are not enabled",
      "facilitated_payments_disabled",
    );
  }
}

function httpError(status, message, code = null, details = null) {
  const error = Object.assign(new Error(message), { status });
  if (code) error.code = code;
  if (details) error.details = details;
  return error;
}

function integerSetting(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function absoluteUrl(name) {
  const value = clean(process.env[name]);
  if (!value) throw new Error(`${name} is required when collection is enabled`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  if (
    (process.env.NODE_ENV === "production" || providerMode() === "live")
    && url.protocol !== "https:"
  ) {
    throw new Error(`${name} must use HTTPS in production and live mode`);
  }
  return url;
}

export function facilitatedMoneyConfiguration() {
  return {
    collectionEnabled: enabled("HEDGELING_FACILITATED_COLLECTION_ENABLED"),
    transfersEnabled: enabled("HEDGELING_FACILITATED_TRANSFERS_ENABLED"),
    refundsEnabled: enabled("HEDGELING_FACILITATED_REFUNDS_ENABLED"),
    liveApproved: enabled("HEDGELING_FACILITATED_LIVE_APPROVED"),
    achTransferHoldDays: integerSetting("HEDGELING_ACH_TRANSFER_HOLD_DAYS", 7, 0, 90),
    payoutReconciliationReturnRiskDays: integerSetting(
      "HEDGELING_PAYOUT_RECONCILIATION_RETURN_RISK_DAYS",
      14,
      1,
      90,
    ),
    payoutReconciliationMaxPages: integerSetting(
      "HEDGELING_PAYOUT_RECONCILIATION_MAX_PAGES",
      5,
      1,
      100,
    ),
    payoutReconciliationPageSize: integerSetting(
      "HEDGELING_PAYOUT_RECONCILIATION_PAGE_SIZE",
      100,
      1,
      100,
    ),
    payoutReconciliationMaxLagMinutes: integerSetting(
      "HEDGELING_PAYOUT_RECONCILIATION_MAX_LAG_MINUTES",
      60,
      5,
      1440,
    ),
    payoutReconciliationLeaseMinutes: integerSetting(
      "HEDGELING_PAYOUT_RECONCILIATION_LEASE_MINUTES",
      15,
      5,
      120,
    ),
    stripeApiVersion,
    stripeNodeSdkVersion,
  };
}

export function validateFacilitatedMoneyConfiguration() {
  const configuration = facilitatedMoneyConfiguration();
  const anyOperation = configuration.collectionEnabled
    || configuration.transfersEnabled
    || configuration.refundsEnabled;
  if (anyOperation && !enabled("HEDGELING_FACILITATED_PAYMENTS_ENABLED")) {
    throw new Error("Facilitated money operations require HEDGELING_FACILITATED_PAYMENTS_ENABLED");
  }
  if (providerMode() === "live" && anyOperation && !configuration.liveApproved) {
    throw new Error("Live facilitated money operations require explicit live approval");
  }
  if (configuration.collectionEnabled) {
    absoluteUrl("STRIPE_VENDOR_PAYMENT_SUCCESS_URL");
    absoluteUrl("STRIPE_VENDOR_PAYMENT_CANCEL_URL");
  }
  return true;
}

export function setFacilitatedMoneyTestClient(client) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Facilitated-money test client is available only in NODE_ENV=test");
  }
  stripeClientOverride = client;
}

function stripeClient() {
  if (stripeClientOverride) return stripeClientOverride;
  const secret = clean(process.env.STRIPE_CONNECT_SECRET_KEY);
  if (!secret) throw httpError(503, "Stripe Connect is not configured", "connect_not_configured");
  return createPinnedStripeClient(secret);
}

async function callStripe(operation, message) {
  try {
    return await operation();
  } catch (cause) {
    throw Object.assign(new Error(message), { status: 502, cause });
  }
}

export function stripeIdempotencyRequestInFlight(error) {
  const visited = new Set();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const type = clean(current.type || current.raw?.type).toLowerCase();
    const code = clean(current.code || current.raw?.code).toLowerCase();
    const message = clean(current.message || current.raw?.message).toLowerCase();
    if (code === "idempotency_key_in_use") return true;
    if (
      ["stripeidempotencyerror", "idempotency_error"].includes(type)
      && (
        /currently .*in[- ]progress/.test(message)
        || /currently .*in use/.test(message)
        || /another .*request .*idempotency key/.test(message)
      )
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export function transferClaimPastIdempotencyWindow(releaseClaimedAt, now = Date.now()) {
  if (!releaseClaimedAt) return false;
  const claimedAt = new Date(releaseClaimedAt).getTime();
  return Number.isFinite(claimedAt) && now - claimedAt >= stripeIdempotencyRetentionMs;
}

function providerRequestInFlight(error, operation) {
  return Object.assign(
    httpError(
      409,
      `Stripe is still processing this ${operation}; retry or reconcile shortly`,
      "provider_request_in_flight",
    ),
    { cause: error },
  );
}

function stripeTimestamp(value) {
  return Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function idempotencyKey(req) {
  const value = clean(req.get("idempotency-key") || req.body?.idempotencyKey);
  if (!value || value.length > 200) {
    throw httpError(400, "Idempotency-Key is required and cannot exceed 200 characters");
  }
  return value;
}

function bounded(value, field, maximum, required = true) {
  const normalized = clean(value);
  if ((!normalized && required) || normalized.length > maximum) {
    throw httpError(400, `${field} ${required ? "is required and " : ""}cannot exceed ${maximum} characters`);
  }
  return normalized || null;
}

function minorUnits(value, field = "amountMinor") {
  const normalized = clean(value);
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw httpError(400, `${field} must be a positive integer in minor units`);
  }
  const parsed = BigInt(normalized);
  if (parsed > maximumMinorUnits) throw httpError(400, `${field} exceeds the supported maximum`);
  return normalized;
}

function requireHuman(req, message = "This payment action requires a human user") {
  if (!req.auth?.user?.id || req.auth?.principalType === "service_account") {
    throw httpError(403, message);
  }
  return req.auth.user.id;
}

async function requirePlatformHuman(req) {
  return requireHuman(req, "This facilitated-payment operation requires a platform human");
}

function operationEnabled(key) {
  if (!enabled("HEDGELING_FACILITATED_PAYMENTS_ENABLED")) {
    throw httpError(503, "Facilitated payments are disabled", "facilitated_payments_disabled");
  }
  const configuration = facilitatedMoneyConfiguration();
  if (!configuration[key]) {
    throw httpError(503, `Facilitated ${key.replace("Enabled", "")} are disabled`, "operation_disabled");
  }
  return configuration;
}

async function certificationReadiness(client) {
  const result = await client.query(
    `select check_key as "checkKey", status, evidence, notes,
            certified_by_user_id as "certifiedByUserId",
            certified_at as "certifiedAt"
     from facilitated_payment_certifications
     where provider = 'stripe' and provider_mode = $1 and superseded_at is null`,
    [providerMode()],
  );
  const byKey = new Map(result.rows.map((row) => [row.checkKey, row]));
  const missing = requiredCertificationChecks.filter(
    (checkKey) => byKey.get(checkKey)?.status !== "passed",
  );
  return {
    checks: requiredCertificationChecks.map((checkKey) => (
      byKey.get(checkKey) || { checkKey, status: "pending", evidence: {}, notes: null }
    )),
    missing,
    ready: missing.length === 0,
  };
}

async function requireCertifiedForLive(client) {
  if (providerMode() !== "live") return;
  if (!facilitatedMoneyConfiguration().liveApproved) {
    throw httpError(503, "Live payment movement has not been approved", "live_not_approved");
  }
  const readiness = await certificationReadiness(client);
  if (!readiness.ready) {
    throw httpError(503, "Live payment certification is incomplete", "certification_incomplete", {
      missing: readiness.missing,
    });
  }
}

const statementContextSelect = `
  select statement.id, statement.vendor_relationship_id as "vendorRelationshipId",
         statement.statement_number as "statementNumber", statement.status,
         statement.subtotal_minor::text as "amountMinor", statement.currency,
         relationship.customer_organization_id as "customerOrganizationId",
         relationship.agency_organization_id as "agencyOrganizationId",
         relationship.status as "relationshipStatus",
         customer.status as "customerStatus", agency.status as "agencyStatus",
         account.id as "connectedAccountId",
         account.provider_account_id as "providerAccountId",
         account.onboarding_state as "accountState",
         account.transfers_capability as "transfersCapability",
         account.payouts_enabled as "payoutsEnabled",
         customer_enrollment.status as "customerEnrollmentStatus",
         customer_enrollment.per_payment_cap_minor::text as "customerPerPaymentCapMinor",
         customer_enrollment.rolling_cap_minor::text as "customerRollingCapMinor",
         customer_enrollment.rolling_period_days as "customerRollingPeriodDays",
         agency_enrollment.status as "agencyEnrollmentStatus",
         agency_enrollment.per_payment_cap_minor::text as "agencyPerPaymentCapMinor",
         agency_enrollment.rolling_cap_minor::text as "agencyRollingCapMinor",
         agency_enrollment.rolling_period_days as "agencyRollingPeriodDays"
  from payable_statements statement
  join vendor_relationships relationship
    on relationship.id = statement.vendor_relationship_id
  join organizations customer on customer.id = relationship.customer_organization_id
  join organizations agency on agency.id = relationship.agency_organization_id
  left join agency_connected_accounts account
    on account.agency_organization_id = relationship.agency_organization_id
   and account.provider = 'stripe' and account.provider_mode = $2
   and account.superseded_at is null
  left join facilitated_payment_program_enrollments customer_enrollment
    on customer_enrollment.organization_id = relationship.customer_organization_id
   and customer_enrollment.provider = 'stripe' and customer_enrollment.provider_mode = $2
   and customer_enrollment.superseded_at is null
  left join facilitated_payment_program_enrollments agency_enrollment
    on agency_enrollment.organization_id = relationship.agency_organization_id
   and agency_enrollment.provider = 'stripe' and agency_enrollment.provider_mode = $2
   and agency_enrollment.superseded_at is null
  where statement.id = $1`;

async function statementContext(client, statementId, { organizationId = null, lock = false } = {}) {
  const result = await client.query(
    `${statementContextSelect}${lock ? " for update of statement, relationship" : ""}`,
    [statementId, providerMode()],
  );
  const context = result.rows[0];
  if (!context) throw httpError(404, "Payable statement not found");
  if (
    organizationId
    && ![context.customerOrganizationId, context.agencyOrganizationId].includes(organizationId)
  ) {
    throw httpError(404, "Payable statement not found");
  }
  return context;
}

async function featureEnabled(client, organizationId) {
  return (await organizationFeatureAccess(
    organizationId,
    "facilitated_payments",
    client,
  )).enabled;
}

async function openDisputeExists(client, statementId) {
  const result = await client.query(
    `select 1
     from payable_statement_items item
     join work_order_disputes dispute on dispute.work_order_id = item.work_order_id
     where item.payable_statement_id = $1 and dispute.status = 'open'
     limit 1`,
    [statementId],
  );
  return Boolean(result.rows[0]);
}

async function collectionEligibility(
  client,
  context,
  { statementStatuses = ["finalized"] } = {},
) {
  const reasons = [];
  if (!statementStatuses.includes(context.status)) reasons.push("statement_state_ineligible");
  if (context.relationshipStatus !== "active") reasons.push("relationship_not_active");
  if (context.customerStatus !== "active") reasons.push("customer_not_active");
  if (context.agencyStatus !== "active") reasons.push("agency_not_active");
  if (context.customerEnrollmentStatus !== "approved") reasons.push("customer_not_enrolled");
  if (context.agencyEnrollmentStatus !== "approved") reasons.push("agency_not_enrolled");
  if (context.accountState !== "ready" || !context.providerAccountId) reasons.push("account_not_ready");
  if (
    !context.amountMinor
    || BigInt(context.amountMinor) <= 0n
    || BigInt(context.amountMinor) > maximumMinorUnits
  ) reasons.push("provider_amount_unsupported");
  if (await openDisputeExists(client, context.id)) reasons.push("statement_disputed");
  if (!await featureEnabled(client, context.customerOrganizationId)) reasons.push("customer_feature_disabled");
  if (!await featureEnabled(client, context.agencyOrganizationId)) reasons.push("agency_feature_disabled");
  if (
    context.customerPerPaymentCapMinor
    && BigInt(context.amountMinor) > BigInt(context.customerPerPaymentCapMinor)
  ) reasons.push("customer_payment_cap_exceeded");
  if (
    context.agencyPerPaymentCapMinor
    && BigInt(context.amountMinor) > BigInt(context.agencyPerPaymentCapMinor)
  ) reasons.push("agency_payment_cap_exceeded");
  return { eligible: reasons.length === 0, reasons };
}

async function lockCollectionCaps(client, context) {
  for (const organizationId of [
    context.customerOrganizationId,
    context.agencyOrganizationId,
  ].sort()) {
    await client.query(
      "select pg_advisory_xact_lock(hashtext($1))",
      [`facilitated-collection-cap:${organizationId}`],
    );
  }
}

async function collectionRollingCapReasons(client, context, attemptId = null) {
  const reasons = [];
  for (const [party, organizationId, cap, days] of [
    [
      "customer",
      context.customerOrganizationId,
      context.customerRollingCapMinor,
      context.customerRollingPeriodDays,
    ],
    [
      "agency",
      context.agencyOrganizationId,
      context.agencyRollingCapMinor,
      context.agencyRollingPeriodDays,
    ],
  ]) {
    if (!cap || !days) {
      reasons.push(`${party}_rolling_cap_missing`);
      continue;
    }
    const usage = await client.query(
      `select coalesce(sum(attempt.amount_minor),0)::bigint as total
       from facilitated_payment_attempts attempt
       where (
         ($1 = 'customer' and attempt.customer_organization_id = $2)
         or ($1 = 'agency' and attempt.agency_organization_id = $2)
       )
         and attempt.state in ('created','requires_action','processing','succeeded')
         and attempt.created_at >= now() - ($3::integer * interval '1 day')
         and ($4::uuid is null or attempt.id <> $4)`,
      [party, organizationId, days, attemptId],
    );
    if (BigInt(usage.rows[0].total) + BigInt(context.amountMinor) > BigInt(cap)) {
      reasons.push(`${party}_rolling_cap_exceeded`);
    }
  }
  return reasons;
}

async function organizationAudit(client, req, context, event) {
  for (const organizationId of [
    context.customerOrganizationId,
    context.agencyOrganizationId,
  ]) {
    await auditRequest(client, req, { organizationId, ...event });
  }
}

async function systemAudit(client, context, event) {
  for (const organizationId of [
    context.customerOrganizationId,
    context.agencyOrganizationId,
  ]) {
    await insertAuditEvent(client, {
      auth: { principalType: "platform" },
      organizationId,
      ...event,
    });
  }
}

async function queueNotification(client, organizationId, type, resourceType, resourceId, payload) {
  await client.query(
    `insert into facilitated_payment_notifications(
       organization_id, notification_type, resource_type, resource_id, payload
     ) values($1, $2, $3, $4, $5)
     on conflict(
       organization_id, notification_type, resource_type, resource_id
     ) do nothing`,
    [organizationId, type, resourceType, resourceId, JSON.stringify(payload)],
  );
}

async function createException(
  client,
  { type, severity = "high", organizationId = null, resourceType, resourceId, details },
) {
  return client.query(
    `insert into facilitated_payment_exceptions(
       exception_type, severity, organization_id, resource_type, resource_id, details
     ) values($1, $2, $3, $4, $5, $6)
     on conflict(exception_type, resource_type, resource_id)
       where status = 'open'
     do update set severity = excluded.severity, details = excluded.details,
                   updated_at = now()
     returning id`,
    [type, severity, organizationId, resourceType, resourceId, JSON.stringify(details || {})],
  ).then((result) => result.rows[0]);
}

async function ensureCustomerRecord(req, organizationId) {
  const userId = requireHuman(req);
  const mode = providerMode();
  let customer = await withTransaction(async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtext($1))",
      [`facilitated-customer:${organizationId}:${mode}`],
    );
    const existing = await client.query(
      `select * from facilitated_payment_customers
       where customer_organization_id = $1 and provider = 'stripe'
         and provider_mode = $2 and superseded_at is null`,
      [organizationId, mode],
    );
    if (existing.rows[0]) return existing.rows[0];
    return client.query(
      `insert into facilitated_payment_customers(
         customer_organization_id, provider_mode, created_by_user_id
       ) values($1, $2, $3) returning *`,
      [organizationId, mode, userId],
    ).then((result) => result.rows[0]);
  });
  if (customer.provider_customer_id) return customer;
  const organization = await query(
    "select name from organizations where id = $1",
    [organizationId],
  ).then((result) => result.rows[0]);
  const providerCustomer = await callStripe(
    () => stripeClient().customers.create(
      {
        name: organization?.name || "Hedgeling customer",
        metadata: {
          hedgeling_payment_customer_id: customer.id,
          hedgeling_organization_id: organizationId,
          hedgeling_provider_mode: mode,
        },
      },
      { idempotencyKey: `hedgeling-payment-customer-${customer.id}` },
    ),
    "Stripe could not create the payment customer",
  );
  if (!/^cus_[A-Za-z0-9]+$/.test(clean(providerCustomer?.id))) {
    throw new Error("Stripe returned an invalid customer identifier");
  }
  customer = await query(
    `update facilitated_payment_customers
     set provider_customer_id = $2, updated_at = now()
     where id = $1 and (provider_customer_id is null or provider_customer_id = $2)
     returning *`,
    [customer.id, providerCustomer.id],
  ).then((result) => result.rows[0]);
  if (!customer) throw httpError(409, "The payment customer was linked concurrently; retry");
  return customer;
}

function attemptResponse(attempt) {
  return {
    id: attempt.id,
    state: attempt.state,
    checkoutStatus: attempt.checkout_status,
    url: attempt.provider_session_url,
    expiresAt: attempt.provider_session_expires_at,
    failureCode: attempt.failure_code,
    failureMessage: attempt.failure_message,
  };
}

async function createPaymentSession(req, res) {
  operationEnabled("collectionEnabled");
  const userId = requireHuman(req);
  const key = idempotencyKey(req);
  const requestFingerprint = fingerprint({
    statementId: req.params.statementId,
    organizationId: req.authorizedOrganizationId,
    paymentMethods: ["card", "us_bank_account"],
  });
  const preliminaryContext = await statementContext(
    { query },
    req.params.statementId,
    { organizationId: req.authorizedOrganizationId },
  );
  if (preliminaryContext.customerOrganizationId !== req.authorizedOrganizationId) {
    throw httpError(403, "Only the customer organization can initiate payment");
  }
  const existingAttempt = await query(
    `select * from facilitated_payment_attempts
     where payable_statement_id = $1 and idempotency_key = $2`,
    [preliminaryContext.id, key],
  ).then((result) => result.rows[0]);
  if (existingAttempt) {
    if (existingAttempt.request_fingerprint !== requestFingerprint) {
      throw httpError(409, "The idempotency key belongs to another payment request");
    }
    const recoverableCreation = existingAttempt.state === "created"
      && existingAttempt.checkout_status === "creating"
      && !existingAttempt.provider_session_id;
    if (!recoverableCreation) {
      return res.json({ attempt: attemptResponse(existingAttempt), replayed: true });
    }
  }
  const preliminaryEligibility = await collectionEligibility(
    { query },
    preliminaryContext,
  );
  if (!preliminaryEligibility.eligible) {
    throw httpError(
      409,
      "This statement is not eligible for facilitated payment",
      "payment_ineligible",
      preliminaryEligibility,
    );
  }
  await requireCertifiedForLive({ query });
  const customer = await ensureCustomerRecord(req, req.authorizedOrganizationId);
  const reservation = await withTransaction(async (client) => {
    await requireCertifiedForLive(client);
    await client.query(
      "select pg_advisory_xact_lock(hashtext($1))",
      [`facilitated-statement:${req.params.statementId}`],
    );
    const context = await statementContext(client, req.params.statementId, {
      organizationId: req.authorizedOrganizationId,
      lock: true,
    });
    if (context.customerOrganizationId !== req.authorizedOrganizationId) {
      throw httpError(403, "Only the customer organization can initiate payment");
    }
    await lockCollectionCaps(client, context);
    const existing = await client.query(
      `select * from facilitated_payment_attempts
       where payable_statement_id = $1 and idempotency_key = $2`,
      [context.id, key],
    ).then((result) => result.rows[0]);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw httpError(409, "The idempotency key belongs to another payment request");
      }
      const recoverableCreation = existing.state === "created"
        && existing.checkout_status === "creating"
        && !existing.provider_session_id;
      return {
        context,
        attempt: existing,
        replayed: !recoverableCreation,
        resumeProviderCreation: recoverableCreation,
      };
    }
    const active = await client.query(
      `select * from facilitated_payment_attempts
       where payable_statement_id = $1
         and (state in ('created', 'requires_action', 'processing', 'succeeded')
              or checkout_status in ('creating', 'open'))
       order by created_at desc limit 1`,
      [context.id],
    ).then((result) => result.rows[0]);
    if (active) {
      if (
        active.state === "created"
        && active.checkout_status === "creating"
        && !active.provider_session_id
      ) {
        return {
          context,
          attempt: active,
          replayed: false,
          resumeProviderCreation: true,
        };
      }
      throw httpError(409, "This statement already has active payment activity", "payment_active", {
        attemptId: active.id,
        state: active.state,
      });
    }
    const eligibility = await collectionEligibility(client, context);
    if (!eligibility.eligible) {
      throw httpError(409, "This statement is not eligible for facilitated payment", "payment_ineligible", eligibility);
    }
    const rollingCapReasons = await collectionRollingCapReasons(client, context);
    if (rollingCapReasons.length) {
      throw httpError(
        409,
        "This payment would exceed a rolling collection cap",
        "rolling_cap_exceeded",
        { reasons: rollingCapReasons },
      );
    }
    const attemptNumber = await client.query(
      `select coalesce(max(attempt_number), 0) + 1 as number
       from facilitated_payment_attempts where payable_statement_id = $1`,
      [context.id],
    ).then((result) => result.rows[0].number);
    const attempt = await client.query(
      `insert into facilitated_payment_attempts(
         payable_statement_id, vendor_relationship_id,
         customer_organization_id, agency_organization_id,
         connected_account_id, payment_customer_id, provider_mode,
         attempt_number, amount_minor, currency, idempotency_key,
         request_fingerprint, created_by_user_id
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       returning *`,
      [
        context.id,
        context.vendorRelationshipId,
        context.customerOrganizationId,
        context.agencyOrganizationId,
        context.connectedAccountId,
        customer.id,
        providerMode(),
        attemptNumber,
        context.amountMinor,
        context.currency,
        key,
        requestFingerprint,
        userId,
      ],
    ).then((result) => result.rows[0]);
    await organizationAudit(client, req, context, {
      action: "facilitated_payment.attempt_created",
      resourceType: "facilitated_payment_attempt",
      resourceId: attempt.id,
      afterState: attemptResponse(attempt),
    });
    return { context, attempt, replayed: false };
  });
  if (reservation.replayed) {
    return res.json({ attempt: attemptResponse(reservation.attempt), replayed: true });
  }

  const attempt = reservation.attempt;
  const successUrl = absoluteUrl("STRIPE_VENDOR_PAYMENT_SUCCESS_URL");
  successUrl.searchParams.set("vendorPayment", "success");
  successUrl.searchParams.set("attemptId", attempt.id);
  const cancelUrl = absoluteUrl("STRIPE_VENDOR_PAYMENT_CANCEL_URL");
  cancelUrl.searchParams.set("vendorPayment", "cancel");
  cancelUrl.searchParams.set("attemptId", attempt.id);
  const metadata = {
    hedgeling_payment_attempt_id: attempt.id,
    hedgeling_statement_id: reservation.context.id,
    hedgeling_customer_organization_id: reservation.context.customerOrganizationId,
    hedgeling_agency_organization_id: reservation.context.agencyOrganizationId,
    hedgeling_connected_account_id: reservation.context.connectedAccountId,
    hedgeling_provider_mode: providerMode(),
  };
  let session;
  try {
    session = await callStripe(
      () => stripeClient().checkout.sessions.create(
        {
          mode: "payment",
          customer: customer.provider_customer_id,
          client_reference_id: attempt.id,
          payment_method_types: ["card", "us_bank_account"],
          line_items: [{
            quantity: 1,
            price_data: {
              currency: reservation.context.currency.toLowerCase(),
              unit_amount: Number(reservation.context.amountMinor),
              product_data: {
                name: `Statement ${reservation.context.statementNumber}`,
                description: "Translation and localization services",
              },
            },
          }],
          payment_intent_data: {
            metadata,
            transfer_group: `hedgeling_statement_${reservation.context.id}`,
          },
          metadata,
          success_url: successUrl.toString(),
          cancel_url: cancelUrl.toString(),
        },
        { idempotencyKey: `hedgeling-checkout-${attempt.id}` },
      ),
      "Stripe could not create the payment session",
    );
    if (!session?.id || !session?.expires_at) {
      throw new Error("Stripe returned an incomplete payment session");
    }
    if (session.status === "expired") {
      const expired = await query(
        `update facilitated_payment_attempts
         set state = 'canceled', checkout_status = 'expired',
             provider_session_id = $2, provider_session_expires_at = $3,
             provider_state_updated_at = now(), completed_at = now(),
             updated_at = now()
         where id = $1 and state = 'created' returning *`,
        [attempt.id, session.id, stripeTimestamp(session.expires_at)],
      ).then((result) => result.rows[0]);
      return res.status(409).json({
        error: "The recovered Checkout session has expired; start a new attempt",
        code: "checkout_expired",
        attempt: attemptResponse(expired),
      });
    }
    if (!session.url) throw new Error("Stripe returned a payment session without a URL");
    const updated = await query(
      `update facilitated_payment_attempts
       set state = 'requires_action', checkout_status = 'open',
           provider_session_id = $2, provider_session_url = $3,
           provider_session_expires_at = $4, provider_state_updated_at = now(),
           updated_at = now()
       where id = $1 and state = 'created'
       returning *`,
      [attempt.id, session.id, session.url, stripeTimestamp(session.expires_at)],
    ).then((result) => result.rows[0]);
    if (!updated) {
      await stripeClient().checkout.sessions.expire(session.id).catch(() => {});
      throw httpError(409, "The payment attempt changed while Stripe created its session");
    }
    return res.status(201).json({ attempt: attemptResponse(updated), replayed: false });
  } catch (error) {
    if (session?.id) await stripeClient().checkout.sessions.expire(session.id).catch(() => {});
    await query(
      `update facilitated_payment_attempts
       set failure_code = 'session_creation_uncertain', failure_message = $2,
           updated_at = now()
       where id = $1 and state = 'created'`,
      [attempt.id, clean(error.message || error).slice(0, 2000)],
    ).catch(() => {});
    throw error;
  }
}

function paymentMethodType(object) {
  const chargeType = typeof object?.latest_charge === "object"
    ? object.latest_charge?.payment_method_details?.type
    : object?.payment_method_details?.type;
  if (["card", "us_bank_account"].includes(chargeType)) return chargeType;
  const types = object?.payment_method_types || [];
  if (types.length === 1 && ["card", "us_bank_account"].includes(types[0])) return types[0];
  return null;
}

function providerObjectId(value) {
  return typeof value === "string" ? value : value?.id || null;
}

function providerEventMode(event) {
  return event.livemode === true ? "live" : "test";
}

function validateAttemptMetadata(attempt, object, event) {
  const metadata = object?.metadata || {};
  if (
    metadata.hedgeling_payment_attempt_id !== attempt.id
    || metadata.hedgeling_statement_id !== attempt.payable_statement_id
    || metadata.hedgeling_customer_organization_id !== attempt.customer_organization_id
    || metadata.hedgeling_agency_organization_id !== attempt.agency_organization_id
    || metadata.hedgeling_connected_account_id !== attempt.connected_account_id
    || metadata.hedgeling_provider_mode !== attempt.provider_mode
    || providerEventMode(event) !== attempt.provider_mode
  ) {
    throw new Error("Stripe payment metadata does not match its Hedgeling attempt");
  }
}

async function attemptForEvent(client, object, event) {
  const attemptId = clean(object?.metadata?.hedgeling_payment_attempt_id);
  if (!attemptId) return null;
  if (!isUuid(attemptId)) {
    throw new Error("Stripe payment metadata contains an invalid Hedgeling attempt ID");
  }
  const attempt = await client.query(
    `select * from facilitated_payment_attempts where id = $1 for update`,
    [attemptId],
  ).then((result) => result.rows[0] || null);
  if (!attempt) throw new Error("Stripe payment metadata has no local attempt");
  validateAttemptMetadata(attempt, object, event);
  if (object.amount != null && BigInt(object.amount) !== BigInt(attempt.amount_minor)) {
    throw new Error("Stripe payment amount does not match its statement");
  }
  if (object.currency && clean(object.currency).toUpperCase() !== attempt.currency) {
    throw new Error("Stripe payment currency does not match its statement");
  }
  return attempt;
}

async function applySucceededPayment(client, attempt, event, object) {
  const chargeId = providerObjectId(object.latest_charge || object.charge);
  if (!chargeId) throw new Error("Succeeded Stripe payment is missing its charge");
  const intentId = object.object === "payment_intent"
    ? object.id
    : providerObjectId(object.payment_intent);
  if (!intentId) throw new Error("Succeeded Stripe payment is missing its PaymentIntent");
  const eventTime = stripeTimestamp(event.created);
  await client.query(
    `update facilitated_payment_attempts
     set state = 'succeeded', checkout_status = 'complete',
         provider_payment_intent_id = $2, provider_charge_id = $3,
         payment_method_type = coalesce($4, payment_method_type),
         provider_state_updated_at = $5, completed_at = $5, updated_at = now()
     where id = $1 and state in ('created', 'requires_action', 'processing')`,
    [attempt.id, intentId, chargeId, paymentMethodType(object), eventTime],
  );
  const succeededAttempt = await client.query(
    "select * from facilitated_payment_attempts where id = $1",
    [attempt.id],
  ).then((result) => result.rows[0]);
  if (succeededAttempt.state !== "succeeded") {
    if (succeededAttempt.provider_payment_intent_id === intentId) return null;
    throw new Error("Stripe success conflicts with the local attempt state");
  }
  const existing = await client.query(
    "select id from facilitated_payments where payment_attempt_id = $1",
    [attempt.id],
  ).then((result) => result.rows[0]);
  if (existing) return existing.id;

  const context = await statementContext(client, attempt.payable_statement_id, { lock: true });
  await lockCollectionCaps(client, context);
  const eligibility = await collectionEligibility(client, context);
  eligibility.reasons.push(
    ...await collectionRollingCapReasons(client, context, attempt.id),
  );
  eligibility.eligible = eligibility.reasons.length === 0;
  const externalRecord = await client.query(
    "select 1 from payment_records where payable_statement_id = $1 limit 1",
    [context.id],
  ).then((result) => result.rows[0]);
  if (externalRecord) {
    eligibility.eligible = false;
    eligibility.reasons.push("payment_record_already_exists");
  }
  const applicationState = eligibility.eligible ? "applied" : "unapplied";
  const payment = await client.query(
    `insert into facilitated_payments(
       payment_attempt_id, payable_statement_id, vendor_relationship_id,
       customer_organization_id, agency_organization_id, connected_account_id,
       amount_minor, currency, provider_mode, provider_payment_intent_id,
       provider_charge_id, application_state, unapplied_reason, succeeded_at
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     returning *`,
    [
      attempt.id,
      context.id,
      context.vendorRelationshipId,
      context.customerOrganizationId,
      context.agencyOrganizationId,
      context.connectedAccountId,
      context.amountMinor,
      context.currency,
      providerMode(),
      intentId,
      chargeId,
      applicationState,
      eligibility.eligible ? null : eligibility.reasons.join(","),
      eventTime,
    ],
  ).then((result) => result.rows[0]);
  await client.query(
    `insert into facilitated_funding_facts(
       facilitated_payment_id, fact_type, amount_minor, currency,
       provider_object_id, provider_event_id, occurred_at
     ) values($1, 'payment_succeeded', $2, $3, $4, $5, $6)`,
    [payment.id, payment.amount_minor, payment.currency, intentId, event.id, eventTime],
  );
  if (eligibility.eligible) {
    const paymentRecord = await client.query(
      `insert into payment_records(
         payable_statement_id, amount_minor, currency, status, record_source,
         payment_method, external_reference, paid_at, reported_by_party,
         confirmed_at, idempotency_key
       ) values(
         $1,$2,$3,'confirmed','facilitated',$4,$5,$6,'customer',$6,$7
       ) returning id`,
      [
        context.id,
        context.amountMinor,
        context.currency,
        paymentMethodType(object) || "stripe",
        intentId,
        eventTime,
        `facilitated:${payment.id}`,
      ],
    ).then((result) => result.rows[0]);
    await client.query(
      `update facilitated_payments set payment_record_id = $2, updated_at = now()
       where id = $1`,
      [payment.id, paymentRecord.id],
    );
    await settleStatementIfPaid(client, context.id);
    await client.query(
      `insert into facilitated_transfer_instructions(
         facilitated_payment_id, connected_account_id, amount_minor, currency,
         transfer_group, funds_available_at, transfer_releasable_at
       ) values($1,$2,$3,$4,$5,$6,$7)`,
      [
        payment.id,
        context.connectedAccountId,
        context.amountMinor,
        context.currency,
        `hedgeling_statement_${context.id}`,
        succeededAttempt.funds_available_at,
        succeededAttempt.transfer_releasable_at,
      ],
    );
    for (const organizationId of [
      context.customerOrganizationId,
      context.agencyOrganizationId,
    ]) {
      await queueNotification(
        client,
        organizationId,
        "facilitated_payment.succeeded",
        "facilitated_payment",
        payment.id,
        { statementId: context.id, amountMinor: context.amountMinor, currency: context.currency },
      );
    }
  } else {
    await createException(client, {
      type: "payment_succeeded_ineligible",
      severity: "critical",
      organizationId: context.customerOrganizationId,
      resourceType: "facilitated_payment",
      resourceId: payment.id,
      details: { statementId: context.id, reasons: eligibility.reasons },
    });
  }
  await systemAudit(client, context, {
    action: eligibility.eligible
      ? "facilitated_payment.applied"
      : "facilitated_payment.unapplied",
    resourceType: "facilitated_payment",
    resourceId: payment.id,
    afterState: {
      amountMinor: context.amountMinor,
      currency: context.currency,
      applicationState,
      reasons: eligibility.reasons,
    },
    metadata: { providerEventId: event.id },
  });
  return payment.id;
}

async function processCheckoutEvent(client, event) {
  const session = event.data.object;
  const attempt = await attemptForEvent(client, session, event);
  if (!attempt) return null;
  if (session.amount_total != null && BigInt(session.amount_total) !== BigInt(attempt.amount_minor)) {
    throw new Error("Stripe Checkout amount does not match its statement");
  }
  const eventTime = stripeTimestamp(event.created);
  const intentId = providerObjectId(session.payment_intent);
  if (event.type === "checkout.session.expired") {
    await client.query(
      `update facilitated_payment_attempts
       set state = case
             when state in ('created', 'requires_action', 'processing')
               then 'canceled'
             else state
           end,
           checkout_status = 'expired',
           provider_payment_intent_id = coalesce($2, provider_payment_intent_id),
           provider_state_updated_at = $3,
           completed_at = case
             when state in ('created', 'requires_action', 'processing')
               then $3
             else completed_at
           end,
           updated_at = now()
       where id = $1 and checkout_status in ('creating', 'open')`,
      [attempt.id, intentId, eventTime],
    );
  } else if (event.type === "checkout.session.async_payment_failed") {
    await client.query(
      `update facilitated_payment_attempts
       set state = 'failed', checkout_status = 'complete',
           provider_payment_intent_id = coalesce($2, provider_payment_intent_id),
           failure_code = 'async_payment_failed',
           failure_message = 'Stripe reported that the delayed payment failed',
           provider_state_updated_at = $3, completed_at = $3, updated_at = now()
       where id = $1 and state in ('created', 'requires_action', 'processing')`,
      [attempt.id, intentId, eventTime],
    );
  } else {
    await client.query(
      `update facilitated_payment_attempts
       set state = case when state in ('created','requires_action') then 'processing' else state end,
           checkout_status = 'complete',
           provider_payment_intent_id = coalesce($2, provider_payment_intent_id),
           payment_method_type = coalesce($3, payment_method_type),
           provider_state_updated_at = $4, updated_at = now()
       where id = $1`,
      [attempt.id, intentId, paymentMethodType(session), eventTime],
    );
  }
  return { type: "facilitated_payment_attempt", id: attempt.id };
}

async function processPaymentIntentEvent(client, event) {
  const intent = event.data.object;
  const attempt = await attemptForEvent(client, intent, event);
  if (!attempt) return null;
  const eventTime = stripeTimestamp(event.created);
  if (event.type === "payment_intent.succeeded") {
    const paymentId = await applySucceededPayment(client, attempt, event, intent);
    return {
      type: paymentId ? "facilitated_payment" : "facilitated_payment_attempt",
      id: paymentId || attempt.id,
    };
  }
  if (event.type === "payment_intent.processing") {
    await client.query(
      `update facilitated_payment_attempts
       set state = 'processing', provider_payment_intent_id = $2,
           payment_method_type = coalesce($3, payment_method_type),
           provider_state_updated_at = $4, updated_at = now()
       where id = $1 and state in ('created','requires_action')`,
      [attempt.id, intent.id, paymentMethodType(intent), eventTime],
    );
  } else if (event.type === "payment_intent.payment_failed") {
    // Checkout can reuse a PaymentIntent after a failed card-method attempt.
    // Keep the hosted attempt non-terminal until Checkout expires/cancels or
    // its delayed-method failure event arrives, so a later signed success can
    // still settle the same immutable statement attempt.
    await client.query(
      `update facilitated_payment_attempts
       set state = case when state = 'created' then 'requires_action' else state end,
           provider_payment_intent_id = $2,
           failure_code = $3, failure_message = $4,
           provider_state_updated_at = $5, updated_at = now()
       where id = $1 and state in ('created','requires_action','processing')`,
      [
        attempt.id,
        intent.id,
        clean(intent.last_payment_error?.code || event.type),
        clean(intent.last_payment_error?.message || "Stripe payment method failed").slice(0, 2000),
        eventTime,
      ],
    );
  } else if (event.type === "payment_intent.canceled") {
    await client.query(
      `update facilitated_payment_attempts
       set state = $2, provider_payment_intent_id = $3,
           failure_code = $4, failure_message = $5,
           provider_state_updated_at = $6, completed_at = $6, updated_at = now()
       where id = $1 and state in ('created','requires_action','processing')`,
      [
        attempt.id,
        "canceled",
        intent.id,
        clean(intent.last_payment_error?.code || intent.cancellation_reason || event.type),
        clean(intent.last_payment_error?.message || "Stripe payment did not succeed").slice(0, 2000),
        eventTime,
      ],
    );
  }
  return { type: "facilitated_payment_attempt", id: attempt.id };
}

async function paymentForProviderObject(client, object) {
  const chargeId = providerObjectId(object.charge) || (
    object.object === "charge" ? object.id : null
  );
  const intentId = providerObjectId(object.payment_intent);
  if (!chargeId && !intentId) return null;
  const result = await client.query(
    `select payment.*, attempt.payment_method_type,
            attempt.provider_balance_transaction_id,
            attempt.funds_available_at, attempt.transfer_releasable_at
     from facilitated_payments payment
     join facilitated_payment_attempts attempt on attempt.id = payment.payment_attempt_id
     where ($1::text is not null and payment.provider_charge_id = $1)
        or ($2::text is not null and payment.provider_payment_intent_id = $2)
     for update of payment, attempt`,
    [chargeId, intentId],
  );
  if (!result.rows.length) return null;
  if (
    result.rows.length !== 1
    || (chargeId && result.rows[0].provider_charge_id !== chargeId)
    || (intentId && result.rows[0].provider_payment_intent_id !== intentId)
  ) {
    throw new Error("Stripe object references conflicting Hedgeling payments");
  }
  return result.rows[0];
}

async function openRecoveryForPayment(client, payment, type, exposureMinor) {
  await client.query(
    `insert into facilitated_recovery_cases(
       facilitated_payment_id, case_type, exposure_minor, currency
     ) values($1,$2,$3,$4)
     on conflict(facilitated_payment_id, case_type)
       where facilitated_payment_id is not null and status in ('open','recovering')
     do update set exposure_minor = greatest(
       facilitated_recovery_cases.exposure_minor, excluded.exposure_minor
     ), updated_at = now()`,
    [payment.id, type, exposureMinor, payment.currency],
  );
}

async function transferredAmount(client, paymentId) {
  const result = await client.query(
    `select case when state in ('transferred','partially_reversed','reversed')
                 then amount_minor else 0 end as amount_minor
     from facilitated_transfer_instructions where facilitated_payment_id = $1`,
    [paymentId],
  );
  return BigInt(result.rows[0]?.amount_minor || 0);
}

async function processDisputeEvent(client, event) {
  const dispute = event.data.object;
  const payment = await paymentForProviderObject(client, dispute);
  if (!payment) return null;
  if (
    BigInt(dispute.amount) > BigInt(payment.amount_minor)
    || clean(dispute.currency).toUpperCase() !== payment.currency
    || providerEventMode(event) !== payment.provider_mode
  ) {
    throw new Error("Stripe dispute does not match its Hedgeling payment");
  }
  const classification = providerDisputeClassification(
    dispute.payment_method_details?.type || payment.payment_method_type,
  );
  if (!classification) {
    throw new Error(
      "Stripe dispute payment method is unknown; reconcile its payment before replay",
    );
  }
  const status = providerDisputeStatus(dispute.status);
  if (!status) throw new Error(`Unsupported Stripe dispute status: ${dispute.status}`);
  const eventTime = stripeTimestamp(event.created);
  const existing = await client.query(
    `select * from facilitated_provider_disputes
     where provider_dispute_id = $1 for update`,
    [dispute.id],
  ).then((result) => result.rows[0] || null);
  if (
    existing?.provider_state_updated_at
    && new Date(existing.provider_state_updated_at).getTime() > new Date(eventTime).getTime()
  ) {
    return { type: "facilitated_provider_dispute", id: existing.id };
  }
  const saved = await client.query(
    `insert into facilitated_provider_disputes(
       facilitated_payment_id, provider_dispute_id, classification,
       amount_minor, currency, status, reason, evidence_due_at,
       provider_state_updated_at, opened_at, closed_at
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict(provider_dispute_id) do update set
       status = excluded.status, reason = excluded.reason,
       evidence_due_at = excluded.evidence_due_at,
       provider_state_updated_at = excluded.provider_state_updated_at,
       closed_at = excluded.closed_at, updated_at = now()
     returning *`,
    [
      payment.id,
      dispute.id,
      classification,
      dispute.amount,
      payment.currency,
      status,
      clean(dispute.reason) || null,
      stripeTimestamp(dispute.evidence_details?.due_by),
      eventTime,
      stripeTimestamp(dispute.created) || eventTime,
      ["warning_closed", "won", "lost"].includes(status) ? eventTime : null,
    ],
  ).then((result) => result.rows[0]);
  const favorable = ["warning_closed", "won"].includes(status);
  const factType = status === "warning_closed"
    ? "dispute_warning_closed"
    : classification === "return" && !favorable
      ? "return_recorded"
    : status === "won"
      ? "funds_reinstated"
      : status === "lost"
        ? "dispute_lost"
        : "dispute_opened";
  await client.query(
    `insert into facilitated_funding_facts(
       facilitated_payment_id, fact_type, amount_minor, currency,
       provider_object_id, provider_event_id, occurred_at,
       metadata
     ) values($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict do nothing`,
    [
      payment.id,
      factType,
      dispute.amount,
      payment.currency,
      dispute.id,
      event.id,
      eventTime,
      JSON.stringify({ classification, status }),
    ],
  );
  if (!favorable) {
    const transferExposure = await transferredAmount(client, payment.id);
    if (transferExposure > 0n) {
      await openRecoveryForPayment(
        client,
        payment,
        classification === "return" ? "return_after_transfer" : "dispute_after_transfer",
        String(transferExposure < BigInt(dispute.amount) ? transferExposure : BigInt(dispute.amount)),
      );
    }
    await createException(client, {
      type: classification === "return" ? "ach_return" : "provider_dispute",
      severity: "critical",
      organizationId: payment.customer_organization_id,
      resourceType: "facilitated_payment",
      resourceId: payment.id,
      details: { providerDisputeId: dispute.id, amountMinor: String(dispute.amount), status },
    });
  }
  await queueNotification(
    client,
    payment.customer_organization_id,
    `facilitated_payment.${classification}.${status}`,
    "facilitated_payment",
    payment.id,
    { providerDisputeId: dispute.id, status, amountMinor: String(dispute.amount) },
  );
  await queueNotification(
    client,
    payment.agency_organization_id,
    `facilitated_payment.${classification}.${status}`,
    "facilitated_payment",
    payment.id,
    { providerDisputeId: dispute.id, status, amountMinor: String(dispute.amount) },
  );
  await systemAudit(client, {
    customerOrganizationId: payment.customer_organization_id,
    agencyOrganizationId: payment.agency_organization_id,
  }, {
    action: `facilitated_payment.${classification}_${status}`,
    resourceType: "facilitated_provider_dispute",
    resourceId: saved.id,
    afterState: {
      classification,
      status,
      amountMinor: String(dispute.amount),
      currency: payment.currency,
    },
    metadata: { providerEventId: event.id },
  });
  return { type: "facilitated_provider_dispute", id: saved.id };
}

async function processRefundEvent(client, event) {
  const object = event.data.object;
  const refundObject = object.object === "refund"
    ? object
    : object.refunds?.data?.[0] || null;
  if (!refundObject?.id) return null;
  const refund = await client.query(
    `select refund.*, payment.customer_organization_id,
            payment.agency_organization_id, payment.provider_mode,
            payment.provider_charge_id
     from facilitated_refunds refund
     join facilitated_payments payment on payment.id = refund.facilitated_payment_id
     where refund.provider_refund_id = $1 for update of refund`,
    [refundObject.id],
  ).then((result) => result.rows[0] || null);
  if (!refund) {
    if (clean(refundObject.metadata?.hedgeling_refund_id)) {
      throw new Error("Stripe refund carries Hedgeling metadata but has no local mapping");
    }
    return null;
  }
  if (
    providerEventMode(event) !== refund.provider_mode
    || BigInt(refundObject.amount) !== BigInt(refund.amount_minor)
    || clean(refundObject.currency).toUpperCase() !== refund.currency
  ) {
    throw new Error("Stripe refund does not match its Hedgeling refund");
  }
  const statusMap = {
    pending: "pending",
    requires_action: "requires_action",
    succeeded: "succeeded",
    failed: "failed",
    canceled: "canceled",
  };
  const status = statusMap[refundObject.status];
  if (!status) throw new Error(`Unsupported Stripe refund status: ${refundObject.status}`);
  const eventTime = stripeTimestamp(event.created);
  if (
    refund.provider_state_updated_at
    && new Date(refund.provider_state_updated_at).getTime() > new Date(eventTime).getTime()
    && refund.status !== status
  ) {
    return { type: "facilitated_refund", id: refund.id };
  }
  await client.query(
    `update facilitated_refunds
     set status = $2,
         provider_state_updated_at = greatest(
           coalesce(provider_state_updated_at, '-infinity'::timestamptz),
           $3::timestamptz
         ),
         succeeded_at = case when $2 = 'succeeded'
                             then coalesce(succeeded_at, $3::timestamptz)
                             else succeeded_at end,
         failure_code = $4, failure_message = $5, updated_at = now()
     where id = $1`,
    [
      refund.id,
      status,
      eventTime,
      clean(refundObject.failure_reason) || null,
      status === "failed" ? "Stripe reported that the refund failed" : null,
    ],
  );
  if (status === "succeeded") {
    await client.query(
      `insert into facilitated_funding_facts(
         facilitated_payment_id, fact_type, amount_minor, currency,
         provider_object_id, provider_event_id, occurred_at
       ) values($1,'refund_succeeded',$2,$3,$4,$5,$6)
       on conflict do nothing`,
      [
        refund.facilitated_payment_id,
        refund.amount_minor,
        refund.currency,
        refundObject.id,
        event.id,
        eventTime,
      ],
    );
    const payment = {
      id: refund.facilitated_payment_id,
      currency: refund.currency,
    };
    const exposure = await transferredAmount(client, payment.id);
    if (exposure > 0n) {
      await openRecoveryForPayment(
        client,
        payment,
        "refund_after_transfer",
        String(exposure < BigInt(refund.amount_minor) ? exposure : BigInt(refund.amount_minor)),
      );
    }
  }
  for (const organizationId of [
    refund.customer_organization_id,
    refund.agency_organization_id,
  ]) {
    await queueNotification(
      client,
      organizationId,
      `facilitated_refund.${status}`,
      "facilitated_refund",
      refund.id,
      {
        paymentId: refund.facilitated_payment_id,
        amountMinor: String(refund.amount_minor),
        currency: refund.currency,
      },
    );
  }
  await systemAudit(client, {
    customerOrganizationId: refund.customer_organization_id,
    agencyOrganizationId: refund.agency_organization_id,
  }, {
    action: `facilitated_refund.${status}`,
    resourceType: "facilitated_refund",
    resourceId: refund.id,
    afterState: {
      status,
      amountMinor: String(refund.amount_minor),
      currency: refund.currency,
      providerRefundId: refundObject.id,
    },
    metadata: { providerEventId: event.id },
  });
  return { type: "facilitated_refund", id: refund.id };
}

async function processPayoutEvent(client, event) {
  const payout = event.data.object;
  const accountContext = clean(event.account);
  if (!accountContext) return null;
  const reconciliation = event.hedgelingReconciliation || null;
  const account = await client.query(
    `select id, agency_organization_id, provider_account_id, provider_mode,
            default_currency
     from agency_connected_accounts
     where provider_account_id = $1 and provider_mode = $2
       and superseded_at is null for update`,
    [accountContext, providerEventMode(event)],
  ).then((result) => result.rows[0] || null);
  if (!account) return null;
  const statusMap = {
    pending: "pending",
    in_transit: "in_transit",
    paid: "paid",
    failed: "failed",
    canceled: "canceled",
  };
  const status = statusMap[payout.status];
  if (!status) throw new Error(`Unsupported Stripe payout status: ${payout.status}`);
  const eventTime = stripeTimestamp(event.created);
  if (!eventTime) throw new Error("Stripe payout observation is missing its provider timestamp");
  const amountMinor = clean(payout.amount);
  const currency = clean(payout.currency).toUpperCase();
  if (!/^[1-9][0-9]*$/.test(amountMinor) || BigInt(amountMinor) > maximumMinorUnits) {
    throw new Error("Stripe payout amount is invalid");
  }
  if (currency !== account.default_currency) {
    throw new Error("Stripe payout currency does not match the connected account");
  }
  const arrivalAt = stripeTimestamp(payout.arrival_date);
  const failureCode = clean(payout.failure_code) || null;
  const failureMessage = clean(payout.failure_message) || null;
  const previous = await client.query(
    "select * from facilitated_payouts where provider_payout_id = $1 for update",
    [payout.id],
  ).then((result) => result.rows[0] || null);
  if (previous && previous.connected_account_id !== account.id) {
    throw new Error("Stripe payout belongs to a different connected account");
  }
  if (
    previous
    && (
      String(previous.amount_minor) !== amountMinor
      || previous.currency !== currency
    )
  ) {
    throw new Error("Stripe payout amount or currency changed after first observation");
  }
  if (
    previous?.provider_state_updated_at
    && new Date(previous.provider_state_updated_at).getTime() > new Date(eventTime).getTime()
  ) {
    if (reconciliation) {
      await client.query(
        `update facilitated_payouts
         set last_reconciled_at = greatest(
           coalesce(last_reconciled_at, '-infinity'::timestamptz),
           $2::timestamptz
         )
         where id = $1`,
        [previous.id, reconciliation.observedAt || eventTime],
      );
    }
    return {
      type: "facilitated_payout",
      id: previous.id,
      accountContext,
      unchanged: true,
      stale: true,
    };
  }
  const timestampValue = (value) => (
    value ? new Date(value).toISOString() : null
  );
  const unchanged = previous
    && previous.status === status
    && timestampValue(previous.arrival_at) === timestampValue(arrivalAt)
    && (previous.failure_code || null) === failureCode
    && (previous.failure_message || null) === failureMessage;
  if (unchanged) {
    if (reconciliation) {
      await client.query(
        `update facilitated_payouts
         set last_reconciled_at = greatest(
           coalesce(last_reconciled_at, '-infinity'::timestamptz),
           $2::timestamptz
         ), updated_at = updated_at
         where id = $1`,
        [previous.id, reconciliation.observedAt || eventTime],
      );
    }
    return {
      type: "facilitated_payout",
      id: previous.id,
      accountContext,
      unchanged: true,
      stale: false,
    };
  }
  const saved = await client.query(
    `insert into facilitated_payouts(
       connected_account_id, provider_payout_id, amount_minor, currency,
       status, arrival_at, provider_state_updated_at, paid_at, failed_at,
       failure_code, failure_message, last_reconciled_at
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict(provider_payout_id) do update set
       status = excluded.status, arrival_at = excluded.arrival_at,
       provider_state_updated_at = excluded.provider_state_updated_at,
       paid_at = coalesce(facilitated_payouts.paid_at, excluded.paid_at),
       failed_at = excluded.failed_at, failure_code = excluded.failure_code,
       failure_message = excluded.failure_message,
       last_reconciled_at = coalesce(
         excluded.last_reconciled_at, facilitated_payouts.last_reconciled_at
       ), updated_at = now()
     returning *`,
    [
      account.id,
      payout.id,
      amountMinor,
      currency,
      status,
      arrivalAt,
      eventTime,
      status === "paid" ? eventTime : null,
      status === "failed" ? eventTime : null,
      failureCode,
      failureMessage,
      reconciliation?.observedAt || null,
    ],
  ).then((result) => result.rows[0]);
  if (previous?.status === "paid" && status === "failed") {
    await client.query(
      `insert into facilitated_recovery_cases(
         payout_id, case_type, exposure_minor, currency
       ) values($1,'payout_failure',$2,$3)
       on conflict(payout_id, case_type)
         where payout_id is not null and status in ('open','recovering')
       do update set exposure_minor = excluded.exposure_minor, updated_at = now()`,
      [saved.id, saved.amount_minor, saved.currency],
    );
    await createException(client, {
      type: "payout_late_failure",
      severity: "critical",
      organizationId: account.agency_organization_id,
      resourceType: "facilitated_payout",
      resourceId: saved.id,
      details: { providerPayoutId: payout.id, previousStatus: previous.status },
    });
  }
  await queueNotification(
    client,
    account.agency_organization_id,
    `facilitated_payout.${status}`,
    "facilitated_payout",
    saved.id,
    {
      providerPayoutId: payout.id,
      amountMinor: String(saved.amount_minor),
      currency: saved.currency,
    },
  );
  await insertAuditEvent(client, {
    auth: { principalType: "platform" },
    organizationId: account.agency_organization_id,
    action: `facilitated_payout.${status}`,
    resourceType: "facilitated_payout",
    resourceId: saved.id,
    beforeState: previous ? { status: previous.status } : null,
    afterState: {
      status,
      amountMinor: String(saved.amount_minor),
      currency: saved.currency,
      providerPayoutId: payout.id,
    },
    metadata: {
      providerEventId: reconciliation ? null : event.id,
      reconciliationScanId: reconciliation?.scanId || null,
      providerRequestId: reconciliation?.providerRequestId || null,
      source: reconciliation ? "reconciliation" : "webhook",
    },
  });
  return {
    type: "facilitated_payout",
    id: saved.id,
    accountContext,
    unchanged: false,
    stale: false,
  };
}

export async function processFacilitatedMoneyEvent(client, event) {
  if (!stripeTimestamp(event.created)) {
    throw new Error("Stripe money event is missing its provider timestamp");
  }
  if (event.type.startsWith("checkout.session.")) {
    const target = await processCheckoutEvent(client, event);
    return target ? { status: "processed", target } : null;
  }
  if (event.type.startsWith("payment_intent.")) {
    const target = await processPaymentIntentEvent(client, event);
    return target ? { status: "processed", target } : null;
  }
  if (
    event.type.startsWith("charge.dispute.")
    || event.type === "charge.dispute.created"
  ) {
    const target = await processDisputeEvent(client, event);
    return target ? { status: "processed", target } : null;
  }
  if (
    event.type.startsWith("refund.")
    || event.type === "charge.refunded"
    || event.type === "charge.refund.updated"
  ) {
    const target = await processRefundEvent(client, event);
    return target ? { status: "processed", target } : null;
  }
  if (event.type.startsWith("payout.")) {
    const target = await processPayoutEvent(client, event);
    return target ? { status: "processed", target } : null;
  }
  return null;
}

function providerRequestId(result) {
  return clean(result?.lastResponse?.requestId || result?.last_response?.request_id) || null;
}

function payoutCheckpointSelect() {
  return `
    select checkpoint.connected_account_id as "connectedAccountId",
           account.agency_organization_id as "agencyOrganizationId",
           account.provider_account_id as "providerAccountId",
           checkpoint.provider_mode as "providerMode",
           checkpoint.scan_status as "scanStatus",
           checkpoint.scan_id as "scanId",
           checkpoint.scan_range_start as "scanRangeStart",
           checkpoint.scan_range_end as "scanRangeEnd",
           checkpoint.next_page_cursor as "nextPageCursor",
           checkpoint.local_candidates_completed_at as "localCandidatesCompletedAt",
           checkpoint.provider_pages_completed_at as "providerPagesCompletedAt",
           checkpoint.last_provider_request_id as "lastProviderRequestId",
           checkpoint.last_started_at as "lastStartedAt",
           checkpoint.last_completed_at as "lastCompletedAt",
           checkpoint.last_successful_scan_at as "lastSuccessfulScanAt",
           checkpoint.last_failure_at as "lastFailureAt",
           checkpoint.observed_count as "observedCount",
           checkpoint.changed_count as "changedCount",
           checkpoint.unchanged_count as "unchangedCount",
           checkpoint.failed_count as "failedCount",
           checkpoint.last_error as "lastError",
           checkpoint.updated_at as "updatedAt"
    from facilitated_payout_reconciliation_checkpoints checkpoint
    join agency_connected_accounts account
      on account.id = checkpoint.connected_account_id`;
}

async function claimPayoutReconciliation(connectedAccountId, req = null) {
  const configuration = facilitatedMoneyConfiguration();
  return withTransaction(async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtext($1))",
      [`payout-reconciliation:${connectedAccountId}`],
    );
    const account = await client.query(
      `select id, agency_organization_id as "agencyOrganizationId",
              provider_account_id as "providerAccountId",
              provider_mode as "providerMode", default_currency as "defaultCurrency"
       from agency_connected_accounts
       where id = $1 and provider = 'stripe' and superseded_at is null
       for update`,
      [connectedAccountId],
    ).then((result) => result.rows[0] || null);
    if (!account?.providerAccountId) {
      throw httpError(404, "Connected Stripe account not found");
    }
    if (account.providerMode !== providerMode()) {
      throw httpError(409, "Connected account belongs to another provider mode");
    }
    await client.query(
      `insert into facilitated_payout_reconciliation_checkpoints(
         connected_account_id, provider_mode
       ) values($1, $2)
       on conflict(connected_account_id) do nothing`,
      [account.id, account.providerMode],
    );
    const checkpoint = await client.query(
      `${payoutCheckpointSelect()}
       where checkpoint.connected_account_id = $1
       for update of checkpoint`,
      [account.id],
    ).then((result) => result.rows[0]);
    const leaseActive = checkpoint.scanStatus === "running"
      && checkpoint.lastStartedAt
      && Date.now() - new Date(checkpoint.lastStartedAt).getTime()
        < configuration.payoutReconciliationLeaseMinutes * 60 * 1000;
    if (leaseActive) {
      throw httpError(
        409,
        "A payout reconciliation scan is already running for this connected account",
        "payout_reconciliation_in_progress",
      );
    }
    const resumable = Boolean(
      ["partial", "failed", "running"].includes(checkpoint.scanStatus)
      && checkpoint.scanId
      && checkpoint.scanRangeStart
      && checkpoint.scanRangeEnd,
    );
    const scanId = resumable ? checkpoint.scanId : randomUUID();
    const scanRangeEnd = resumable
      ? checkpoint.scanRangeEnd
      : new Date();
    const scanRangeStart = resumable
      ? checkpoint.scanRangeStart
      : new Date(
        new Date(scanRangeEnd).getTime()
        - configuration.payoutReconciliationReturnRiskDays * 24 * 60 * 60 * 1000,
      );
    const nextPageCursor = resumable ? checkpoint.nextPageCursor : null;
    const leaseId = randomUUID();
    const claimed = await client.query(
      `update facilitated_payout_reconciliation_checkpoints
       set scan_status = 'running', scan_id = $2, lease_id = $7,
           scan_range_start = $3, scan_range_end = $4,
           next_page_cursor = $5, last_started_at = now(),
           last_error = null,
           local_candidates_completed_at = case
             when $6 then local_candidates_completed_at else null end,
           provider_pages_completed_at = case
             when $6 then provider_pages_completed_at else null end,
           observed_count = case when $6 then observed_count else 0 end,
           changed_count = case when $6 then changed_count else 0 end,
           unchanged_count = case when $6 then unchanged_count else 0 end,
           failed_count = case when $6 then failed_count else 0 end,
           updated_at = now()
       where connected_account_id = $1
       returning scan_id as "scanId", scan_range_start as "scanRangeStart",
                 scan_range_end as "scanRangeEnd",
                 next_page_cursor as "nextPageCursor",
                 local_candidates_completed_at as "localCandidatesCompletedAt",
                 provider_pages_completed_at as "providerPagesCompletedAt",
                 lease_id as "leaseId",
                 observed_count as "observedCount",
                 changed_count as "changedCount",
                 unchanged_count as "unchangedCount",
                 failed_count as "failedCount"`,
      [
        account.id,
        scanId,
        scanRangeStart,
        scanRangeEnd,
        nextPageCursor,
        resumable,
        leaseId,
      ],
    ).then((result) => result.rows[0]);
    await insertAuditEvent(client, {
      auth: req?.auth || { principalType: "platform" },
      organizationId: account.agencyOrganizationId,
      action: resumable
        ? "facilitated_payout_reconciliation.resumed"
        : "facilitated_payout_reconciliation.started",
      resourceType: "agency_connected_account",
      resourceId: account.id,
      afterState: {
        scanId,
        scanRangeStart,
        scanRangeEnd,
        nextPageCursor,
      },
      requestId: req?.get?.("x-request-id") || null,
      ipAddress: req?.ip || null,
    });
    return { account, checkpoint: claimed, resumed: resumable, configuration, req };
  });
}

async function applyPayoutReconciliationBatch(claim, observations, {
  nextPageCursor = undefined,
  localCandidatesCompleted = false,
  providerPagesCompleted = false,
} = {}) {
  return withTransaction(async (client) => {
    const lease = await client.query(
      `select connected_account_id
       from facilitated_payout_reconciliation_checkpoints
       where connected_account_id = $1 and scan_id = $2 and lease_id = $3
         and scan_status = 'running'
       for update`,
      [
        claim.account.id,
        claim.checkpoint.scanId,
        claim.checkpoint.leaseId,
      ],
    );
    if (!lease.rows[0]) {
      throw httpError(
        409,
        "The payout reconciliation lease was replaced by another worker",
        "payout_reconciliation_lease_lost",
      );
    }
    const counts = { observed: 0, changed: 0, unchanged: 0 };
    let lastProviderRequestId = null;
    for (const observation of observations) {
      const { payout, observedAt, requestId } = observation;
      if (!payout?.id || payout.object !== "payout") {
        throw new Error("Stripe payout reconciliation returned an invalid payout object");
      }
      const outcome = await processPayoutEvent(client, {
        id: `reconciliation_${claim.checkpoint.scanId}_${payout.id}_${clean(payout.status)}`,
        type: `payout.${clean(payout.status) || "updated"}`,
        account: claim.account.providerAccountId,
        livemode: claim.account.providerMode === "live",
        created: Math.floor(new Date(observedAt).getTime() / 1000),
        data: { object: payout },
        hedgelingReconciliation: {
          scanId: claim.checkpoint.scanId,
          observedAt,
          providerRequestId: requestId,
        },
      });
      counts.observed += 1;
      counts[outcome.unchanged ? "unchanged" : "changed"] += 1;
      lastProviderRequestId = requestId || lastProviderRequestId;
    }
    await client.query(
      `update facilitated_payout_reconciliation_checkpoints
       set observed_count = observed_count + $4,
           changed_count = changed_count + $5,
           unchanged_count = unchanged_count + $6,
           next_page_cursor = case when $7 then $8 else next_page_cursor end,
           local_candidates_completed_at = case when $9 then now()
             else local_candidates_completed_at end,
           provider_pages_completed_at = case when $10 then now()
             else provider_pages_completed_at end,
           last_provider_request_id = coalesce($11, last_provider_request_id),
           updated_at = now()
       where connected_account_id = $1 and scan_id = $2 and lease_id = $3`,
      [
        claim.account.id,
        claim.checkpoint.scanId,
        claim.checkpoint.leaseId,
        counts.observed,
        counts.changed,
        counts.unchanged,
        nextPageCursor !== undefined,
        nextPageCursor ?? null,
        localCandidatesCompleted,
        providerPagesCompleted,
        lastProviderRequestId,
      ],
    );
    return { counts, lastProviderRequestId };
  });
}

async function recordPayoutReconciliationFailure(claim, error) {
  const message = clean(error.message || error).slice(0, 2000);
  await withTransaction(async (client) => {
    const failed = await client.query(
      `update facilitated_payout_reconciliation_checkpoints
       set scan_status = 'failed', failed_count = failed_count + 1,
           lease_id = null, last_failure_at = now(), last_error = $4,
           updated_at = now()
       where connected_account_id = $1 and scan_id = $2 and lease_id = $3
       returning connected_account_id`,
      [
        claim.account.id,
        claim.checkpoint.scanId,
        claim.checkpoint.leaseId,
        message,
      ],
    );
    if (!failed.rows[0]) return;
    await createException(client, {
      type: "payout_reconciliation_failed",
      severity: "high",
      organizationId: claim.account.agencyOrganizationId,
      resourceType: "agency_connected_account",
      resourceId: claim.account.id,
      details: {
        scanId: claim.checkpoint.scanId,
        providerAccountId: claim.account.providerAccountId,
        error: message,
      },
    });
    await insertAuditEvent(client, {
      auth: claim.req?.auth || { principalType: "platform" },
      organizationId: claim.account.agencyOrganizationId,
      action: "facilitated_payout_reconciliation.failed",
      resourceType: "agency_connected_account",
      resourceId: claim.account.id,
      afterState: { scanId: claim.checkpoint.scanId, error: message },
      requestId: claim.req?.get?.("x-request-id") || null,
      ipAddress: claim.req?.ip || null,
    });
  });
}

async function completePayoutReconciliation(claim, {
  partial,
  nextPageCursor,
  lastProviderRequestId,
  counts,
}) {
  return withTransaction(async (client) => {
    const completed = await client.query(
      `update facilitated_payout_reconciliation_checkpoints
       set scan_status = $3, next_page_cursor = $4,
           lease_id = null,
           last_provider_request_id = coalesce($5, last_provider_request_id),
           last_completed_at = now(),
           last_successful_scan_at = case when $3 = 'idle' then now()
             else last_successful_scan_at end,
           last_error = null, updated_at = now()
       where connected_account_id = $1 and scan_id = $2 and lease_id = $6
       returning scan_status as "scanStatus", scan_id as "scanId",
                 scan_range_start as "scanRangeStart",
                 scan_range_end as "scanRangeEnd",
                 next_page_cursor as "nextPageCursor",
                 last_provider_request_id as "lastProviderRequestId",
                 last_started_at as "lastStartedAt",
                 last_completed_at as "lastCompletedAt",
                 last_successful_scan_at as "lastSuccessfulScanAt",
                 observed_count as "observedCount",
                 changed_count as "changedCount",
                 unchanged_count as "unchangedCount",
                 failed_count as "failedCount", last_error as "lastError"`,
      [
        claim.account.id,
        claim.checkpoint.scanId,
        partial ? "partial" : "idle",
        nextPageCursor,
        lastProviderRequestId,
        claim.checkpoint.leaseId,
      ],
    ).then((result) => result.rows[0]);
    if (!completed) {
      throw httpError(
        409,
        "The payout reconciliation lease was replaced before completion",
        "payout_reconciliation_lease_lost",
      );
    }
    if (!partial) {
      await client.query(
        `update facilitated_payment_exceptions
         set status = 'resolved',
             resolution = 'Payout reconciliation completed successfully',
             resolved_at = now(), updated_at = now()
         where exception_type = 'payout_reconciliation_failed'
           and resource_type = 'agency_connected_account'
           and resource_id = $1 and status = 'open'`,
        [claim.account.id],
      );
    }
    await insertAuditEvent(client, {
      auth: claim.req?.auth || { principalType: "platform" },
      organizationId: claim.account.agencyOrganizationId,
      action: partial
        ? "facilitated_payout_reconciliation.page_checkpointed"
        : "facilitated_payout_reconciliation.completed",
      resourceType: "agency_connected_account",
      resourceId: claim.account.id,
      afterState: completed,
      metadata: {
        pageObserved: counts.observed,
        pageChanged: counts.changed,
        pageUnchanged: counts.unchanged,
      },
      requestId: claim.req?.get?.("x-request-id") || null,
      ipAddress: claim.req?.ip || null,
    });
    return completed;
  });
}

export async function reconcilePayoutsForAccount(connectedAccountId, { req = null } = {}) {
  requireFacilitatedPaymentsFoundation();
  const claim = await claimPayoutReconciliation(connectedAccountId, req);
  const observedAt = new Date().toISOString();
  let cursor = claim.checkpoint.nextPageCursor || null;
  let lastProviderRequestId = null;
  const counts = { observed: 0, changed: 0, unchanged: 0 };
  const addCounts = (next) => {
    counts.observed += next.observed;
    counts.changed += next.changed;
    counts.unchanged += next.unchanged;
  };
  try {
    if (!claim.checkpoint.localCandidatesCompletedAt) {
      const localCandidates = await query(
        `select provider_payout_id as id
         from facilitated_payouts
         where connected_account_id = $1
           and (
             status in ('pending', 'in_transit')
             or (
               status = 'paid'
               and paid_at >= $2::timestamptz
             )
           )
         order by updated_at
        limit 250`,
        [claim.account.id, claim.checkpoint.scanRangeStart],
      );
      const observations = [];
      for (const candidate of localCandidates.rows) {
        const payout = await callStripe(
          () => stripeClient().payouts.retrieve(
            candidate.id,
            {},
            { stripeAccount: claim.account.providerAccountId },
          ),
          "Stripe could not retrieve a payout during reconciliation",
        );
        const requestId = providerRequestId(payout);
        lastProviderRequestId = requestId || lastProviderRequestId;
        observations.push({
          payout,
          observedAt,
          requestId,
        });
      }
      const applied = await applyPayoutReconciliationBatch(claim, observations, {
        localCandidatesCompleted: true,
      });
      addCounts(applied.counts);
    }

    let hasMore = false;
    if (!claim.checkpoint.providerPagesCompletedAt) {
      for (
        let pageNumber = 0;
        pageNumber < claim.configuration.payoutReconciliationMaxPages;
        pageNumber += 1
      ) {
        const page = await callStripe(
          () => stripeClient().payouts.list(
            {
              limit: claim.configuration.payoutReconciliationPageSize,
              created: {
                gte: Math.floor(new Date(claim.checkpoint.scanRangeStart).getTime() / 1000),
                lte: Math.floor(new Date(claim.checkpoint.scanRangeEnd).getTime() / 1000),
              },
              ...(cursor ? { starting_after: cursor } : {}),
            },
            { stripeAccount: claim.account.providerAccountId },
          ),
          "Stripe could not list connected-account payouts",
        );
        if (!Array.isArray(page?.data) || typeof page.has_more !== "boolean") {
          throw new Error("Stripe returned an invalid payout page");
        }
        if (page.has_more && page.data.length === 0) {
          throw new Error("Stripe returned an empty payout page with has_more=true");
        }
        const requestId = providerRequestId(page);
        lastProviderRequestId = requestId || lastProviderRequestId;
        hasMore = page.has_more;
        cursor = hasMore ? page.data.at(-1).id : null;
        const applied = await applyPayoutReconciliationBatch(
          claim,
          page.data.map((payout) => ({ payout, observedAt, requestId })),
          {
            nextPageCursor: cursor,
            providerPagesCompleted: !hasMore,
          },
        );
        addCounts(applied.counts);
        if (!hasMore) break;
      }
    }
    const checkpoint = await completePayoutReconciliation(claim, {
      partial: hasMore,
      nextPageCursor: cursor,
      lastProviderRequestId,
      counts,
    });
    return {
      connectedAccountId: claim.account.id,
      providerAccountId: claim.account.providerAccountId,
      status: hasMore ? "partial" : "succeeded",
      resumed: claim.resumed,
      counts,
      checkpoint,
    };
  } catch (error) {
    await recordPayoutReconciliationFailure(claim, error).catch((recordingError) => {
      console.error("[facilitated-money] Failed to record payout reconciliation failure", {
        connectedAccountId: claim.account.id,
        scanId: claim.checkpoint.scanId,
        error: clean(recordingError.message || recordingError).slice(0, 500),
      });
    });
    throw error;
  }
}

export async function reconcilePayoutAccounts({ limit = 25, req = null } = {}) {
  requireFacilitatedPaymentsFoundation();
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw httpError(400, "Payout reconciliation limit must be from 1 to 100");
  }
  const configuration = facilitatedMoneyConfiguration();
  const accounts = await query(
    `select account.id
     from agency_connected_accounts account
     left join facilitated_payout_reconciliation_checkpoints checkpoint
       on checkpoint.connected_account_id = account.id
     where account.provider = 'stripe' and account.provider_mode = $1
       and account.provider_account_id is not null
       and account.superseded_at is null
     order by checkpoint.last_successful_scan_at nulls first, account.updated_at
     limit $2`,
    [providerMode(), limit],
  );
  const outcomes = [];
  for (const account of accounts.rows) {
    try {
      outcomes.push(await reconcilePayoutsForAccount(account.id, { req }));
    } catch (error) {
      outcomes.push({
        connectedAccountId: account.id,
        status: "failed",
        error: clean(error.message || error),
        code: error.code || null,
      });
    }
  }
  const staleAccountCount = await query(
    `select count(*)::int as count
     from agency_connected_accounts account
     left join facilitated_payout_reconciliation_checkpoints checkpoint
       on checkpoint.connected_account_id = account.id
     where account.provider = 'stripe' and account.provider_mode = $1
       and account.provider_account_id is not null
       and account.superseded_at is null
       and (
         checkpoint.last_successful_scan_at is null
         or checkpoint.last_successful_scan_at
           < now() - make_interval(mins => $2)
       )`,
    [providerMode(), configuration.payoutReconciliationMaxLagMinutes],
  ).then((result) => result.rows[0].count);
  return {
    providerMode: providerMode(),
    maximumLagMinutes: configuration.payoutReconciliationMaxLagMinutes,
    staleAccountCount,
    outcomes,
  };
}

export function fundingProjection({
  amountMinor,
  refundedMinor = "0",
  activeReturnMinor = "0",
  activeDisputeMinor = "0",
}) {
  const amount = BigInt(amountMinor);
  const refunded = BigInt(refundedMinor);
  const returned = BigInt(activeReturnMinor);
  const disputed = BigInt(activeDisputeMinor);
  if (returned > 0n) return "returned";
  if (disputed > 0n) return "disputed";
  if (refunded >= amount) return "funding_reversed";
  if (refunded > 0n) return "partially_refunded";
  return "funded";
}

export function providerDisputeClassification(paymentMethod) {
  if (paymentMethod === "us_bank_account") return "return";
  if (paymentMethod === "card") return "dispute";
  return null;
}

export function providerDisputeStatus(status) {
  const statuses = {
    warning_needs_response: "warning_needs_response",
    warning_under_review: "warning_under_review",
    warning_closed: "warning_closed",
    needs_response: "needs_response",
    under_review: "under_review",
    won: "won",
    lost: "lost",
  };
  return statuses[status] || null;
}

async function paymentSummary(client, statementId) {
  const attempts = await client.query(
     `select id, state, checkout_status as "checkoutStatus",
            amount_minor::text as "amountMinor", currency,
            provider_session_url as "checkoutUrl",
            payment_method_type as "paymentMethodType",
            provider_session_expires_at as "sessionExpiresAt",
            funds_available_at as "fundsAvailableAt",
            transfer_releasable_at as "transferReleasableAt",
            failure_code as "failureCode", failure_message as "failureMessage",
            created_at as "createdAt", completed_at as "completedAt"
     from facilitated_payment_attempts where payable_statement_id = $1
     order by attempt_number desc`,
    [statementId],
  );
  const payment = await client.query(
    `select payment.id, payment.amount_minor::text as "amountMinor",
            payment.currency, payment.application_state as "applicationState",
            payment.unapplied_reason as "unappliedReason",
            payment.succeeded_at as "succeededAt",
            transfer.id as "transferId", transfer.state as "transferState",
            transfer.provider_transfer_id as "providerTransferId",
            transfer.transfer_releasable_at as "transferReleasableAt",
            transfer.transferred_at as "transferredAt",
            coalesce((
              select sum(amount_minor) from facilitated_refunds
              where facilitated_payment_id = payment.id and status = 'succeeded'
            ),0)::text as "refundedMinor",
            coalesce((
              select sum(amount_minor) from facilitated_provider_disputes
              where facilitated_payment_id = payment.id and classification = 'return'
                and status not in ('warning_closed', 'won')
            ),0)::text as "activeReturnMinor",
            coalesce((
              select sum(amount_minor) from facilitated_provider_disputes
              where facilitated_payment_id = payment.id and classification = 'dispute'
                and status not in ('warning_closed', 'won')
            ),0)::text as "activeDisputeMinor"
     from facilitated_payments payment
     left join facilitated_transfer_instructions transfer
       on transfer.facilitated_payment_id = payment.id
     where payment.payable_statement_id = $1
     order by payment.created_at desc limit 1`,
    [statementId],
  ).then((result) => result.rows[0] || null);
  if (payment) {
    payment.fundingState = fundingProjection({
      amountMinor: payment.amountMinor,
      refundedMinor: payment.refundedMinor,
      activeReturnMinor: payment.activeReturnMinor,
      activeDisputeMinor: payment.activeDisputeMinor,
    });
  }
  const refunds = payment
    ? await client.query(
      `select id, amount_minor::text as "amountMinor", currency, status,
              reason, reference, requested_at as "requestedAt",
              approved_at as "approvedAt", succeeded_at as "succeededAt"
       from facilitated_refunds where facilitated_payment_id = $1
       order by created_at`,
      [payment.id],
    ).then((result) => result.rows)
    : [];
  return { attempts: attempts.rows, payment, refunds };
}

organizationMoneyRouter.get(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/payable-statements/:statementId/facilitated-payment",
  requireOrganizationPermission("facilitated_payments.view"),
  route(async (req, res) => {
    const context = await statementContext(
      { query },
      req.params.statementId,
      { organizationId: req.authorizedOrganizationId },
    );
    if (context.vendorRelationshipId !== req.params.vendorRelationshipId) {
      throw httpError(404, "Payable statement not found");
    }
    const eligibility = await collectionEligibility({ query }, context);
    const summary = await paymentSummary({ query }, context.id);
    const canSeeCheckoutUrl = context.customerOrganizationId === req.authorizedOrganizationId
      && req.organizationPermissions.includes("facilitated_payments.initiate")
      && req.auth?.user?.id
      && req.auth?.principalType !== "service_account";
    if (!canSeeCheckoutUrl) {
      summary.attempts = summary.attempts.map(({ checkoutUrl, ...attempt }) => attempt);
    }
    res.json({
      context,
      eligibility,
      configuration: facilitatedMoneyConfiguration(),
      ...summary,
    });
  }),
);

organizationMoneyRouter.post(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/payable-statements/:statementId/payment-session",
  requireOrganizationPermission("facilitated_payments.initiate"),
  route(async (req, res) => {
    const context = await statementContext(
      { query },
      req.params.statementId,
      { organizationId: req.authorizedOrganizationId },
    );
    if (context.vendorRelationshipId !== req.params.vendorRelationshipId) {
      throw httpError(404, "Payable statement not found");
    }
    return createPaymentSession(req, res);
  }),
);

async function transferReleaseEligibility(client, transfer) {
  const reasons = [];
  const context = await statementContext(client, transfer.payable_statement_id);
  const eligibility = await collectionEligibility(
    client,
    context,
    { statementStatuses: ["paid"] },
  );
  reasons.push(...eligibility.reasons);
  if (transfer.application_state !== "applied") reasons.push("payment_unapplied");
  if (transfer.state !== "held") reasons.push("transfer_not_held");
  if (!transfer.funds_available_at) reasons.push("funds_not_reconciled");
  if (
    !transfer.transfer_releasable_at
    || new Date(transfer.transfer_releasable_at).getTime() > Date.now()
  ) reasons.push("risk_hold_active");
  const reversedFunding = await client.query(
    `select exists(
       select 1 from facilitated_provider_disputes
       where facilitated_payment_id = $1
         and status not in ('warning_closed', 'won')
     ) or exists(
       select 1 from facilitated_refunds
       where facilitated_payment_id = $1
         and status in ('submitting','pending','requires_action','succeeded')
     ) as blocked`,
    [transfer.facilitated_payment_id],
  );
  if (reversedFunding.rows[0].blocked) reasons.push("funding_exception");
  return { eligible: reasons.length === 0, reasons, context };
}

async function transferRow(client, transferId, lock = false) {
  return client.query(
    `select transfer.*, payment.payable_statement_id,
            payment.vendor_relationship_id, payment.customer_organization_id,
            payment.agency_organization_id, payment.application_state,
            payment.provider_mode,
            payment.provider_charge_id, attempt.payment_method_type,
            account.provider_account_id,
            customer_enrollment.rolling_cap_minor as customer_rolling_cap_minor,
            customer_enrollment.rolling_period_days as customer_rolling_period_days,
            agency_enrollment.rolling_cap_minor as agency_rolling_cap_minor,
            agency_enrollment.rolling_period_days as agency_rolling_period_days
     from facilitated_transfer_instructions transfer
     join facilitated_payments payment on payment.id = transfer.facilitated_payment_id
     join facilitated_payment_attempts attempt on attempt.id = payment.payment_attempt_id
     join agency_connected_accounts account on account.id = transfer.connected_account_id
     join facilitated_payment_program_enrollments customer_enrollment
       on customer_enrollment.organization_id = payment.customer_organization_id
      and customer_enrollment.provider_mode = $2
      and customer_enrollment.superseded_at is null
     join facilitated_payment_program_enrollments agency_enrollment
       on agency_enrollment.organization_id = payment.agency_organization_id
      and agency_enrollment.provider_mode = $2
      and agency_enrollment.superseded_at is null
     where transfer.id = $1${lock ? " for update of transfer" : ""}`,
    [transferId, providerMode()],
  ).then((result) => result.rows[0] || null);
}

async function claimTransferRelease(req) {
  const userId = await requirePlatformHuman(req);
  operationEnabled("transfersEnabled");
  return withTransaction(async (client) => {
    await requireCertifiedForLive(client);
    const initial = await transferRow(client, req.params.transferId, false);
    if (!initial) throw httpError(404, "Transfer instruction not found");
    const lockOrganizations = [
      initial.customer_organization_id,
      initial.agency_organization_id,
    ].sort();
    for (const organizationId of lockOrganizations) {
      await client.query(
        "select pg_advisory_xact_lock(hashtext($1))",
        [`facilitated-transfer-cap:${organizationId}`],
      );
    }
    const transfer = await transferRow(client, req.params.transferId, true);
    const release = await transferReleaseEligibility(client, transfer);
    if (!release.eligible) {
      throw httpError(409, "Transfer is not eligible for release", "transfer_ineligible", release);
    }
    for (const [party, organizationId, cap, days] of [
      [
        "customer",
        transfer.customer_organization_id,
        transfer.customer_rolling_cap_minor,
        transfer.customer_rolling_period_days,
      ],
      [
        "agency",
        transfer.agency_organization_id,
        transfer.agency_rolling_cap_minor,
        transfer.agency_rolling_period_days,
      ],
    ]) {
      const usage = await client.query(
        `select coalesce(sum(instruction.amount_minor),0)::bigint as total
         from facilitated_transfer_instructions instruction
         join facilitated_payments payment
           on payment.id = instruction.facilitated_payment_id
         where (
           ($1 = 'customer' and payment.customer_organization_id = $2)
           or ($1 = 'agency' and payment.agency_organization_id = $2)
         )
           and instruction.state in (
             'submitting','transferred','partially_reversed','reversed'
           )
           and instruction.release_claimed_at >= now() - ($3::integer * interval '1 day')`,
        [party, organizationId, days],
      );
      if (BigInt(usage.rows[0].total) + BigInt(transfer.amount_minor) > BigInt(cap)) {
        throw httpError(409, `${party} rolling transfer cap would be exceeded`, "rolling_cap_exceeded");
      }
    }
    await client.query(
      `update facilitated_transfer_instructions
       set state = 'submitting', released_by_user_id = $2,
           release_claimed_at = now(), failure_code = null,
           failure_message = null, updated_at = now()
       where id = $1`,
      [transfer.id, userId],
    );
    await organizationAudit(client, req, release.context, {
      action: "facilitated_transfer.release_claimed",
      resourceType: "facilitated_transfer_instruction",
      resourceId: transfer.id,
      beforeState: { state: "held" },
      afterState: { state: "submitting" },
    });
    return transfer;
  });
}

function transferSubmissionParameters(transfer) {
  const params = {
    amount: Number(transfer.amount_minor),
    currency: transfer.currency.toLowerCase(),
    destination: transfer.provider_account_id,
    transfer_group: transfer.transfer_group,
    metadata: {
      hedgeling_transfer_instruction_id: transfer.id,
      hedgeling_payment_id: transfer.facilitated_payment_id,
      hedgeling_statement_id: transfer.payable_statement_id,
      hedgeling_provider_mode: providerMode(),
    },
  };
  // source_transaction is safe for synchronous card charges. Async ACH is
  // released only after balance availability is reconciled and never uses it.
  if (transfer.payment_method_type === "card") {
    params.source_transaction = transfer.provider_charge_id;
  }
  return params;
}

async function recordTransferOutcomeException(transfer, type, details) {
  await withTransaction((client) => createException(client, {
    type,
    severity: "critical",
    organizationId: transfer.customer_organization_id,
    resourceType: "facilitated_transfer_instruction",
    resourceId: transfer.id,
    details,
  }));
}

function validateDiscoveredProviderTransfer(transfer, providerTransfer) {
  const mismatches = [];
  if (!clean(providerTransfer.id)) {
    mismatches.push("provider_id");
  }
  if (BigInt(providerTransfer.amount) !== BigInt(transfer.amount_minor)) {
    mismatches.push("amount");
  }
  if (clean(providerTransfer.currency).toUpperCase() !== transfer.currency) {
    mismatches.push("currency");
  }
  if (providerObjectId(providerTransfer.destination) !== transfer.provider_account_id) {
    mismatches.push("destination");
  }
  if (clean(providerTransfer.transfer_group) !== transfer.transfer_group) {
    mismatches.push("transfer_group");
  }
  if (
    providerTransfer.metadata?.hedgeling_transfer_instruction_id !== transfer.id
    || providerTransfer.metadata?.hedgeling_payment_id !== transfer.facilitated_payment_id
    || providerTransfer.metadata?.hedgeling_statement_id !== transfer.payable_statement_id
    || providerTransfer.metadata?.hedgeling_provider_mode !== transfer.provider_mode
  ) {
    mismatches.push("metadata");
  }
  if (providerTransfer.livemode !== (transfer.provider_mode === "live")) {
    mismatches.push("provider_mode");
  }
  if (mismatches.length) {
    throw httpError(
      409,
      "The provider transfer does not match the local release instruction",
      "provider_transfer_mismatch",
      { mismatches, providerTransferId: providerTransfer.id },
    );
  }
}

async function discoverProviderTransfer(transfer) {
  const result = await callStripe(
    () => stripeClient().transfers.list({
      destination: transfer.provider_account_id,
      transfer_group: transfer.transfer_group,
      limit: 100,
    }),
    "Stripe could not reconcile the transfer",
  );
  if (result?.has_more) {
    throw httpError(
      409,
      "Provider transfer reconciliation returned an unbounded result",
      "provider_transfer_reconciliation_ambiguous",
    );
  }
  const candidates = Array.isArray(result?.data) ? result.data : [];
  const matching = candidates.filter(
    (candidate) => (
      candidate?.metadata?.hedgeling_transfer_instruction_id === transfer.id
    ),
  );
  if (matching.length > 1) {
    throw httpError(
      409,
      "Multiple provider transfers reference the same release instruction",
      "provider_transfer_duplicate",
      { providerTransferIds: matching.map((candidate) => candidate.id) },
    );
  }
  if (!matching.length) {
    if (candidates.length) {
      throw httpError(
        409,
        "The transfer group contains a provider transfer with conflicting metadata",
        "provider_transfer_mismatch",
        { providerTransferIds: candidates.map((candidate) => candidate.id) },
      );
    }
    return null;
  }
  validateDiscoveredProviderTransfer(transfer, matching[0]);
  return matching[0];
}

async function finalizeProviderTransfer(req, transfer, providerTransfer, { replayed = false } = {}) {
  const finalized = await withTransaction(async (client) => {
    let current = await client.query(
      "select * from facilitated_transfer_instructions where id = $1 for update",
      [transfer.id],
    ).then((queryResult) => queryResult.rows[0] || null);
    if (
      current
      && ["transferred", "partially_reversed", "reversed"].includes(current.state)
      && current.provider_transfer_id === providerTransfer.id
    ) {
      return { transfer: current, finalizedNow: false };
    }
    if (current?.state === "failed") {
      await client.query(
        `update facilitated_transfer_instructions
         set state = 'held', updated_at = now() where id = $1`,
        [transfer.id],
      );
      current = await client.query(
        `update facilitated_transfer_instructions
         set state = 'submitting', updated_at = now()
         where id = $1 and state = 'held' returning *`,
        [transfer.id],
      ).then((queryResult) => queryResult.rows[0] || null);
    }
    if (current?.state !== "submitting") {
      await createException(client, {
        type: "provider_transfer_local_commit_failed",
        severity: "critical",
        organizationId: transfer.agency_organization_id,
        resourceType: "facilitated_transfer_instruction",
        resourceId: transfer.id,
        details: {
          providerTransferId: providerTransfer.id,
          localState: current?.state || null,
        },
      });
      return null;
    }
    const result = await client.query(
      `update facilitated_transfer_instructions
       set state = 'transferred', provider_transfer_id = $2,
           provider_state_updated_at = now(), transferred_at = now(),
           updated_at = now()
       where id = $1 and state = 'submitting'
       returning *`,
      [transfer.id, providerTransfer.id],
    ).then((queryResult) => queryResult.rows[0]);
    if (!result) return null;
    await organizationAudit(client, req, {
      customerOrganizationId: transfer.customer_organization_id,
      agencyOrganizationId: transfer.agency_organization_id,
    }, {
      action: "facilitated_transfer.transferred",
      resourceType: "facilitated_transfer_instruction",
      resourceId: transfer.id,
      beforeState: { state: current.state },
      afterState: { state: "transferred", providerTransferId: providerTransfer.id },
      metadata: { providerReconciled: replayed },
    });
    for (const organizationId of [
      transfer.customer_organization_id,
      transfer.agency_organization_id,
    ]) {
      await queueNotification(
        client,
        organizationId,
        "facilitated_transfer.transferred",
        "facilitated_transfer_instruction",
        transfer.id,
        {
          amountMinor: String(transfer.amount_minor),
          currency: transfer.currency,
          statementId: transfer.payable_statement_id,
        },
      );
    }
    return { transfer: result, finalizedNow: true };
  });
  if (!finalized) {
    throw new Error("Provider transfer succeeded but local finalization did not");
  }
  return {
    transfer: finalized.transfer,
    replayed: replayed || !finalized.finalizedNow,
  };
}

async function reconcileTransferBeyondIdempotencyWindow(req, transfer) {
  if (!transferClaimPastIdempotencyWindow(transfer.release_claimed_at)) return null;
  let providerTransfer;
  try {
    providerTransfer = await discoverProviderTransfer(transfer);
  } catch (error) {
    await recordTransferOutcomeException(
      transfer,
      error.code || "provider_transfer_reconciliation_failed",
      {
        message: clean(error.message || error),
        ...(error.details || {}),
      },
    );
    throw error;
  }
  if (providerTransfer) {
    try {
      return await finalizeProviderTransfer(
        req,
        transfer,
        providerTransfer,
        { replayed: true },
      );
    } catch (error) {
      await recordTransferOutcomeException(
        transfer,
        "provider_transfer_local_commit_failed",
        {
          providerTransferId: providerTransfer.id,
          message: clean(error.message || error),
        },
      );
      throw error;
    }
  }
  await recordTransferOutcomeException(
    transfer,
    "provider_transfer_outcome_unknown",
    {
      releaseClaimedAt: transfer.release_claimed_at,
      transferGroup: transfer.transfer_group,
      providerAccountId: transfer.provider_account_id,
    },
  );
  return null;
}

async function recordProviderAbsenceConfirmation(
  req,
  transfer,
  reason,
  evidenceReference,
) {
  const actorId = await requirePlatformHuman(req);
  await withTransaction(async (client) => {
    await client.query(
      `update facilitated_payment_exceptions
       set status = 'resolved', resolution = $2, resolved_by_user_id = $3,
           resolved_at = now(), updated_at = now()
       where exception_type = 'provider_transfer_outcome_unknown'
         and resource_type = 'facilitated_transfer_instruction'
         and resource_id = $1 and status = 'open'`,
      [transfer.id, `${reason} Evidence: ${evidenceReference}`, actorId],
    );
    await organizationAudit(client, req, {
      customerOrganizationId: transfer.customer_organization_id,
      agencyOrganizationId: transfer.agency_organization_id,
    }, {
      action: "facilitated_transfer.provider_absence_confirmed",
      resourceType: "facilitated_transfer_instruction",
      resourceId: transfer.id,
      beforeState: {
        state: transfer.state,
        releaseClaimedAt: transfer.release_claimed_at,
      },
      afterState: { exceptionalRetryAuthorized: true },
      metadata: { reason, evidenceReference },
    });
  });
}

async function submitClaimedTransfer(req, transfer, { replayed = false } = {}) {
  const params = transferSubmissionParameters(transfer);
  try {
    const providerTransfer = await callStripe(
      () => stripeClient().transfers.create(
        params,
        { idempotencyKey: `hedgeling-transfer-${transfer.id}` },
      ),
      "Stripe could not release the transfer",
    );
    if (!providerTransfer?.id) throw new Error("Stripe returned an incomplete transfer");
    return finalizeProviderTransfer(req, transfer, providerTransfer, { replayed });
  } catch (error) {
    if (stripeIdempotencyRequestInFlight(error)) {
      throw providerRequestInFlight(error, "transfer");
    }
    await query(
      `update facilitated_transfer_instructions
       set state = 'failed', failure_code = 'provider_transfer_failed',
           failure_message = $2, updated_at = now()
       where id = $1 and state = 'submitting'`,
      [transfer.id, clean(error.message || error).slice(0, 2000)],
    ).catch(() => {});
    throw error;
  }
}

async function resumeClaimedTransfer(req, transfer) {
  operationEnabled("transfersEnabled");
  await requirePlatformHuman(req);
  await requireCertifiedForLive({ query });
  const reconciled = await reconcileTransferBeyondIdempotencyWindow(req, transfer);
  if (reconciled) return reconciled;
  if (transferClaimPastIdempotencyWindow(transfer.release_claimed_at)) {
    throw httpError(
      409,
      "The provider idempotency window expired; confirm provider absence before retrying",
      "provider_transfer_outcome_unknown",
    );
  }
  return submitClaimedTransfer(req, transfer, { replayed: true });
}

async function reconcileTransfer(transferId, req) {
  const transfer = await transferRow({ query }, transferId, false);
  if (!transfer) throw httpError(404, "Transfer instruction not found");
  if (transfer.state !== "submitting") {
    return { transfer, replayed: true };
  }
  return resumeClaimedTransfer(req, transfer);
}

async function releaseTransfer(req, res) {
  const existing = await transferRow({ query }, req.params.transferId, false);
  if (!existing) throw httpError(404, "Transfer instruction not found");
  if (["transferred", "partially_reversed", "reversed"].includes(existing.state)) {
    operationEnabled("transfersEnabled");
    await requirePlatformHuman(req);
    return res.json({ transfer: existing, replayed: true });
  }
  const outcome = existing.state === "submitting"
    ? await resumeClaimedTransfer(req, existing)
    : await submitClaimedTransfer(req, await claimTransferRelease(req));
  return res.json(outcome);
}

async function approveRefund(req, res) {
  operationEnabled("refundsEnabled");
  const actorId = await requirePlatformHuman(req);
  const refund = await withTransaction(async (client) => {
    await requireCertifiedForLive(client);
    const row = await client.query(
      `select refund.*, payment.provider_charge_id,
              payment.customer_organization_id, payment.agency_organization_id
       from facilitated_refunds refund
       join facilitated_payments payment on payment.id = refund.facilitated_payment_id
       where refund.id = $1 for update of refund`,
      [req.params.refundId],
    ).then((result) => result.rows[0]);
    if (!row) throw httpError(404, "Refund request not found");
    if (["submitting", "pending", "requires_action", "succeeded"].includes(row.status)) {
      return row;
    }
    if (!["requested", "failed"].includes(row.status)) {
      throw httpError(409, "This refund cannot be approved");
    }
    await client.query(
      `update facilitated_refunds
       set status = 'submitting', approved_by_user_id = $2,
           approved_at = coalesce(approved_at, now()),
           failure_code = null, failure_message = null, updated_at = now()
       where id = $1 and status in ('requested','failed')`,
      [row.id, actorId],
    );
    return row;
  });
  if (["pending", "requires_action", "succeeded"].includes(refund.status)) {
    return res.json({ refund, replayed: true });
  }
  try {
    const providerRefund = await callStripe(
      () => stripeClient().refunds.create(
        {
          charge: refund.provider_charge_id,
          amount: Number(refund.amount_minor),
          reason: "requested_by_customer",
          metadata: {
            hedgeling_refund_id: refund.id,
            hedgeling_payment_id: refund.facilitated_payment_id,
            hedgeling_provider_mode: providerMode(),
          },
        },
        { idempotencyKey: `hedgeling-refund-${refund.id}` },
      ),
      "Stripe could not create the refund",
    );
    const status = ["pending", "requires_action", "succeeded"].includes(providerRefund.status)
      ? providerRefund.status
      : "failed";
    const updated = await withTransaction(async (client) => {
      let result = await client.query(
        `update facilitated_refunds
         set status = $2, provider_refund_id = $3,
             provider_state_updated_at = now(),
             succeeded_at = case when $2 = 'succeeded' then now() else null end,
             failure_code = $4, updated_at = now()
         where id = $1 and status = 'submitting' returning *`,
        [
          refund.id,
          status,
          providerRefund.id,
          status === "failed" ? clean(providerRefund.failure_reason) || "provider_failed" : null,
        ],
      ).then((resultRows) => resultRows.rows[0]);
      if (!result) {
        result = await client.query(
          "select * from facilitated_refunds where id = $1",
          [refund.id],
        ).then((resultRows) => resultRows.rows[0]);
      }
      if (
        !result
        || result.provider_refund_id !== providerRefund.id
      ) {
        throw new Error("Provider refund succeeded but local finalization conflicted");
      }
      await organizationAudit(client, req, {
        customerOrganizationId: refund.customer_organization_id,
        agencyOrganizationId: refund.agency_organization_id,
      }, {
        action: "facilitated_refund.provider_submitted",
        resourceType: "facilitated_refund",
        resourceId: refund.id,
        beforeState: { status: "submitting" },
        afterState: { status, providerRefundId: providerRefund.id },
      });
      return result;
    });
    return res.json({ refund: updated, replayed: false });
  } catch (error) {
    if (stripeIdempotencyRequestInFlight(error)) {
      throw providerRequestInFlight(error, "refund");
    }
    await query(
      `update facilitated_refunds set status = 'failed',
         failure_code = 'provider_request_failed', failure_message = $2,
         updated_at = now() where id = $1 and status = 'submitting'`,
      [refund.id, clean(error.message || error).slice(0, 2000)],
    ).catch(() => {});
    throw error;
  }
}

async function reverseTransfer(req, res) {
  operationEnabled("transfersEnabled");
  const actorId = await requirePlatformHuman(req);
  const amount = minorUnits(req.body.amountMinor);
  const reason = bounded(req.body.reason, "reason", 2000);
  const reference = bounded(req.body.reference, "reference", 500);
  const key = idempotencyKey(req);
  const requestFingerprint = fingerprint({ amount, reason, reference });
  const reservation = await withTransaction(async (client) => {
    await requireCertifiedForLive(client);
    const transfer = await transferRow(client, req.params.transferId, true);
    if (!transfer) throw httpError(404, "Transfer instruction not found");
    if (!["transferred", "partially_reversed"].includes(transfer.state)) {
      throw httpError(409, "Only a transferred instruction can be reversed");
    }
    const existing = await client.query(
      `select * from facilitated_transfer_reversals
       where transfer_instruction_id = $1 and idempotency_key = $2`,
      [transfer.id, key],
    ).then((result) => result.rows[0]);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw httpError(409, "The idempotency key belongs to another reversal");
      }
      if (existing.status === "failed") {
        const active = await client.query(
          `select coalesce(sum(amount_minor) filter(
             where status in ('submitting','succeeded')
           ),0)::bigint total
           from facilitated_transfer_reversals
           where transfer_instruction_id = $1 and id <> $2`,
          [transfer.id, existing.id],
        );
        if (
          BigInt(active.rows[0].total) + BigInt(existing.amount_minor)
          > BigInt(transfer.amount_minor)
        ) {
          throw httpError(409, "Transfer reversals cannot exceed the transferred amount");
        }
        const retry = await client.query(
          `update facilitated_transfer_reversals
           set status = 'submitting', failure_code = null,
               failure_message = null, updated_at = now()
           where id = $1 and status = 'failed' returning *`,
          [existing.id],
        ).then((result) => result.rows[0]);
        return { transfer, reversal: retry, replayed: false };
      }
      return { transfer, reversal: existing, replayed: true };
    }
    const reversed = await client.query(
      `select coalesce(sum(amount_minor) filter(where status in ('submitting','succeeded')),0)::bigint total
       from facilitated_transfer_reversals where transfer_instruction_id = $1`,
      [transfer.id],
    );
    if (BigInt(reversed.rows[0].total) + BigInt(amount) > BigInt(transfer.amount_minor)) {
      throw httpError(409, "Transfer reversals cannot exceed the transferred amount");
    }
    const reversal = await client.query(
      `insert into facilitated_transfer_reversals(
         transfer_instruction_id, amount_minor, currency, reason, reference,
         approved_by_user_id, idempotency_key, request_fingerprint
       ) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [transfer.id, amount, transfer.currency, reason, reference, actorId, key, requestFingerprint],
    ).then((result) => result.rows[0]);
    return { transfer, reversal, replayed: false };
  });
  if (reservation.replayed && reservation.reversal.status !== "submitting") {
    return res.json(reservation);
  }
  try {
    const providerReversal = await callStripe(
      () => stripeClient().transfers.createReversal(
        reservation.transfer.provider_transfer_id,
        {
          amount: Number(reservation.reversal.amount_minor),
          metadata: {
            hedgeling_transfer_reversal_id: reservation.reversal.id,
            hedgeling_provider_mode: providerMode(),
          },
        },
        { idempotencyKey: `hedgeling-transfer-reversal-${reservation.reversal.id}` },
      ),
      "Stripe could not reverse the transfer",
    );
    const finalized = await withTransaction(async (client) => {
      let reversal = await client.query(
        `update facilitated_transfer_reversals
         set status = 'succeeded', provider_reversal_id = $2,
             succeeded_at = now(), updated_at = now()
         where id = $1 and status = 'submitting' returning *`,
        [reservation.reversal.id, providerReversal.id],
      ).then((result) => result.rows[0]);
      let finalizedNow = true;
      if (!reversal) {
        reversal = await client.query(
          "select * from facilitated_transfer_reversals where id = $1 for update",
          [reservation.reversal.id],
        ).then((result) => result.rows[0] || null);
        finalizedNow = false;
      }
      if (
        !reversal
        || reversal.status !== "succeeded"
        || reversal.provider_reversal_id !== providerReversal.id
      ) {
        throw new Error("Provider transfer reversal succeeded but local finalization conflicted");
      }
      const total = await client.query(
        `select coalesce(sum(amount_minor) filter(where status = 'succeeded'),0)::bigint total
         from facilitated_transfer_reversals where transfer_instruction_id = $1`,
        [reservation.transfer.id],
      );
      await client.query(
        `update facilitated_transfer_instructions
         set state = case when $2::bigint >= amount_minor
                          then 'reversed' else 'partially_reversed' end,
             updated_at = now() where id = $1`,
        [reservation.transfer.id, total.rows[0].total],
      );
      if (finalizedNow) {
        await organizationAudit(client, req, {
          customerOrganizationId: reservation.transfer.customer_organization_id,
          agencyOrganizationId: reservation.transfer.agency_organization_id,
        }, {
          action: "facilitated_transfer.reversed",
          resourceType: "facilitated_transfer_reversal",
          resourceId: reversal.id,
          afterState: {
            amountMinor: String(reversal.amount_minor),
            currency: reversal.currency,
            providerReversalId: providerReversal.id,
          },
        });
      }
      return { reversal, finalizedNow };
    });
    return res.json({
      reversal: finalized.reversal,
      replayed: reservation.replayed || !finalized.finalizedNow,
    });
  } catch (error) {
    if (stripeIdempotencyRequestInFlight(error)) {
      throw providerRequestInFlight(error, "transfer reversal");
    }
    await query(
      `update facilitated_transfer_reversals
       set status = 'failed', failure_code = 'provider_reversal_failed',
           failure_message = $2, updated_at = now()
       where id = $1 and status = 'submitting'`,
      [reservation.reversal.id, clean(error.message || error).slice(0, 2000)],
    ).catch(() => {});
    throw error;
  }
}

async function reconcileAttempt(attemptId, req = null) {
  const attempt = await query(
    "select * from facilitated_payment_attempts where id = $1",
    [attemptId],
  ).then((result) => result.rows[0]);
  if (!attempt) throw httpError(404, "Payment attempt not found");
  if (attempt.provider_mode !== providerMode()) {
    throw httpError(409, "Payment attempt belongs to another provider mode");
  }
  let session = null;
  if (attempt.provider_session_id) {
    session = await callStripe(
      () => stripeClient().checkout.sessions.retrieve(attempt.provider_session_id),
      "Stripe could not reconcile the Checkout session",
    );
  }
  const intentId = providerObjectId(session?.payment_intent) || attempt.provider_payment_intent_id;
  let intent = null;
  if (intentId) {
    intent = await callStripe(
      () => stripeClient().paymentIntents.retrieve(
        intentId,
        { expand: ["latest_charge.balance_transaction"] },
      ),
      "Stripe could not reconcile the PaymentIntent",
    );
  }
  return withTransaction(async (client) => {
    const current = await client.query(
      "select * from facilitated_payment_attempts where id = $1 for update",
      [attempt.id],
    ).then((result) => result.rows[0]);
    if (session && session.status !== "open" && current.state !== "succeeded") {
      const fakeEvent = {
        id: `reconciliation_checkout_${session.id}`,
        type: session.status === "expired"
          ? "checkout.session.expired"
          : session.payment_status === "unpaid"
            ? "checkout.session.completed"
            : "checkout.session.async_payment_succeeded",
        livemode: providerMode() === "live",
        created: session.created,
        data: { object: session },
      };
      await processCheckoutEvent(client, fakeEvent);
    }
    if (intent) {
      const fakeEvent = {
        id: `reconciliation_intent_${intent.id}_${intent.status}`,
        type: intent.status === "succeeded"
          ? "payment_intent.succeeded"
          : intent.status === "processing"
            ? "payment_intent.processing"
            : intent.status === "canceled"
              ? "payment_intent.canceled"
              : "payment_intent.payment_failed",
        livemode: providerMode() === "live",
        created: intent.created,
        data: { object: intent },
      };
      await processPaymentIntentEvent(client, fakeEvent);
      const charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
      const balance = typeof charge?.balance_transaction === "object"
        ? charge.balance_transaction
        : null;
      const availability = stripeTimestamp(balance?.available_on);
      const method = charge?.payment_method_details?.type || paymentMethodType(intent);
      const hold = method === "us_bank_account"
        ? facilitatedMoneyConfiguration().achTransferHoldDays
        : 0;
      const holdAnchor = availability
        ? new Date(availability).getTime()
        : intent.created * 1000;
      const riskHold = new Date(
        holdAnchor + hold * 24 * 60 * 60 * 1000,
      ).toISOString();
      const releasable = availability ? riskHold : null;
      await client.query(
        `update facilitated_payment_attempts
         set provider_charge_id = coalesce($2, provider_charge_id),
             provider_balance_transaction_id = coalesce($3, provider_balance_transaction_id),
             payment_method_type = coalesce($4, payment_method_type),
             funds_available_at = coalesce($5, funds_available_at),
             transfer_releasable_at = case
               when $5::timestamptz is null then transfer_releasable_at
               else greatest($5::timestamptz, $6::timestamptz)
             end,
             updated_at = now()
         where id = $1`,
        [attempt.id, providerObjectId(intent.latest_charge), balance?.id || null, method, availability, releasable],
      );
      await client.query(
        `update facilitated_transfer_instructions transfer
         set funds_available_at = attempt.funds_available_at,
             transfer_releasable_at = attempt.transfer_releasable_at,
             updated_at = now()
         from facilitated_payments payment
         join facilitated_payment_attempts attempt
           on attempt.id = payment.payment_attempt_id
         where transfer.facilitated_payment_id = payment.id
           and attempt.id = $1`,
        [attempt.id],
      );
    }
    const updated = await client.query(
      `select id, state, checkout_status as "checkoutStatus",
              provider_payment_intent_id as "providerPaymentIntentId",
              provider_charge_id as "providerChargeId",
              provider_balance_transaction_id as "providerBalanceTransactionId",
              payment_method_type as "paymentMethodType",
              funds_available_at as "fundsAvailableAt",
              transfer_releasable_at as "transferReleasableAt"
       from facilitated_payment_attempts where id = $1`,
      [attempt.id],
    ).then((result) => result.rows[0]);
    if (req) {
      await auditRequest(client, req, {
        organizationId: attempt.customer_organization_id,
        action: "facilitated_payment.reconciled",
        resourceType: "facilitated_payment_attempt",
        resourceId: attempt.id,
        afterState: updated,
      });
    }
    return updated;
  });
}

async function reconcileRefund(refundId) {
  const refund = await query(
    `select refund.*, payment.provider_mode
     from facilitated_refunds refund
     join facilitated_payments payment on payment.id = refund.facilitated_payment_id
     where refund.id = $1`,
    [refundId],
  ).then((result) => result.rows[0]);
  if (!refund?.provider_refund_id) {
    throw httpError(409, "Refund has no provider object to reconcile");
  }
  if (refund.provider_mode !== providerMode()) {
    throw httpError(409, "Refund belongs to another provider mode");
  }
  const providerRefund = await callStripe(
    () => stripeClient().refunds.retrieve(refund.provider_refund_id),
    "Stripe could not reconcile the refund",
  );
  return withTransaction(async (client) => {
    const target = await processRefundEvent(client, {
      id: `reconciliation_refund_${providerRefund.id}_${providerRefund.status}`,
      type: "refund.updated",
      livemode: providerMode() === "live",
      created: providerRefund.created || Math.floor(Date.now() / 1000),
      data: { object: providerRefund },
    });
    return target;
  });
}

platformMoneyRouter.use(requirePlatformOperationsAccess);

for (const parameter of [
  "transferId",
  "paymentId",
  "refundId",
  "attemptId",
  "connectedAccountId",
  "exceptionId",
  "recoveryId",
]) {
  platformMoneyRouter.param(parameter, (req, res, next, value) => (
    isUuid(value) ? next() : res.status(400).json({ error: `${parameter} is invalid` })
  ));
}

platformMoneyRouter.get(
  "/facilitated-payments/operations",
  route(async (req, res) => {
    const configuration = facilitatedMoneyConfiguration();
    const [counts, certification] = await Promise.all([
      query(
        `select
           (select count(*) from facilitated_payment_attempts
             where state in ('created','requires_action','processing'))::int as "activeAttempts",
           (select count(*) from facilitated_transfer_instructions
             where state in ('held','submitting','failed'))::int as "transferQueue",
           (select count(*) from facilitated_refunds
             where status in ('requested','submitting','pending','requires_action'))::int
             as "refundQueue",
           (select count(*) from facilitated_payment_exceptions
             where status = 'open')::int as "openExceptions",
           (select count(*) from facilitated_payouts
             where status in ('pending','in_transit'))::int as "nonterminalPayouts",
           (select count(*) from facilitated_recovery_cases
             where status in ('open','recovering'))::int as "openRecoveryCases",
           (select count(*) from facilitated_payment_provider_events
             where status = 'failed')::int as "failedProviderEvents",
           (select count(*)
            from agency_connected_accounts account
            left join facilitated_payout_reconciliation_checkpoints checkpoint
              on checkpoint.connected_account_id = account.id
            where account.provider = 'stripe' and account.provider_mode = $1
              and account.provider_account_id is not null
              and account.superseded_at is null
              and (
                checkpoint.last_successful_scan_at is null
                or checkpoint.last_successful_scan_at
                  < now() - make_interval(mins => $2)
              ))::int as "stalePayoutReconciliations"`,
        [providerMode(), configuration.payoutReconciliationMaxLagMinutes],
      ).then((result) => result.rows[0]),
      certificationReadiness({ query }),
    ]);
    res.json({
      configuration,
      certification,
      counts,
    });
  }),
);

platformMoneyRouter.get(
  "/facilitated-payments/certification",
  route(async (req, res) => {
    res.json(await certificationReadiness({ query }));
  }),
);

platformMoneyRouter.put(
  "/facilitated-payments/certification/:checkKey",
  requirePlatformAdmin,
  route(async (req, res) => {
    const actorId = await requirePlatformHuman(req);
    const checkKey = clean(req.params.checkKey);
    if (!requiredCertificationChecks.includes(checkKey)) {
      throw httpError(400, "Certification check is invalid");
    }
    const status = clean(req.body.status);
    if (!["pending", "passed", "failed"].includes(status)) {
      throw httpError(400, "Certification status is invalid");
    }
    const notes = bounded(req.body.notes, "notes", 5000, false);
    const evidence = req.body.evidence ?? {};
    if (!evidence || Array.isArray(evidence) || typeof evidence !== "object") {
      throw httpError(400, "evidence must be an object");
    }
    const certification = await withTransaction(async (client) => {
      await client.query(
        "select pg_advisory_xact_lock(hashtext($1))",
        [`facilitated-certification:${providerMode()}:${checkKey}`],
      );
      const previous = await client.query(
        `select * from facilitated_payment_certifications
         where provider = 'stripe' and provider_mode = $1
           and check_key = $2 and superseded_at is null for update`,
        [providerMode(), checkKey],
      ).then((result) => result.rows[0] || null);
      if (previous) {
        await client.query(
          "update facilitated_payment_certifications set superseded_at = now() where id = $1",
          [previous.id],
        );
      }
      const inserted = await client.query(
        `insert into facilitated_payment_certifications(
           provider_mode, check_key, status, evidence, notes,
           certified_by_user_id
         ) values($1,$2,$3,$4,$5,$6) returning *`,
        [providerMode(), checkKey, status, JSON.stringify(evidence), notes, actorId],
      ).then((result) => result.rows[0]);
      await auditRequest(client, req, {
        action: "facilitated_payment.certification_updated",
        resourceType: "facilitated_payment_certification",
        resourceId: inserted.id,
        beforeState: previous,
        afterState: inserted,
      });
      return inserted;
    });
    res.json({ certification, readiness: await certificationReadiness({ query }) });
  }),
);

platformMoneyRouter.get(
  "/facilitated-payments/transfers",
  route(async (req, res) => {
    const state = clean(req.query.state);
    const result = await query(
      `select transfer.id, transfer.facilitated_payment_id as "paymentId",
              payment.payable_statement_id as "statementId",
              payment.customer_organization_id as "customerOrganizationId",
              payment.agency_organization_id as "agencyOrganizationId",
              transfer.amount_minor::text as "amountMinor", transfer.currency,
              transfer.state, transfer.provider_transfer_id as "providerTransferId",
              transfer.funds_available_at as "fundsAvailableAt",
              transfer.transfer_releasable_at as "transferReleasableAt",
              transfer.transferred_at as "transferredAt",
              transfer.failure_code as "failureCode",
              transfer.failure_message as "failureMessage"
       from facilitated_transfer_instructions transfer
       join facilitated_payments payment on payment.id = transfer.facilitated_payment_id
       where ($1 = '' or transfer.state = $1)
       order by transfer.created_at desc limit 250`,
      [state],
    );
    res.json({ transfers: result.rows });
  }),
);

platformMoneyRouter.post(
  "/facilitated-payments/transfers/:transferId/release",
  requirePlatformAdmin,
  route(releaseTransfer),
);

platformMoneyRouter.post(
  "/facilitated-payments/transfers/:transferId/retry",
  requirePlatformAdmin,
  route(async (req, res) => {
    await requirePlatformHuman(req);
    const transfer = await transferRow({ query }, req.params.transferId, false);
    if (!transfer) throw httpError(404, "Transfer instruction not found");
    if (
      ["failed", "submitting"].includes(transfer.state)
      && transferClaimPastIdempotencyWindow(transfer.release_claimed_at)
    ) {
      const reconciled = await reconcileTransferBeyondIdempotencyWindow(req, transfer);
      if (reconciled) return res.json(reconciled);
      if (req.body?.providerAbsenceConfirmed !== true) {
        throw httpError(
          409,
          "The provider idempotency window expired; explicit provider-absence confirmation is required",
          "provider_transfer_outcome_unknown",
        );
      }
      const reason = bounded(
        req.body?.providerAbsenceReason,
        "providerAbsenceReason",
        2000,
      );
      const evidenceReference = bounded(
        req.body?.providerAbsenceEvidence,
        "providerAbsenceEvidence",
        500,
      );
      if (transfer.state === "submitting") {
        operationEnabled("transfersEnabled");
        await requireCertifiedForLive({ query });
      }
      await recordProviderAbsenceConfirmation(
        req,
        transfer,
        reason,
        evidenceReference,
      );
      if (transfer.state === "submitting") {
        return res.json(await submitClaimedTransfer(
          req,
          transfer,
          { replayed: true },
        ));
      }
    }
    await query(
      `update facilitated_transfer_instructions
       set state = 'held', updated_at = now()
       where id = $1 and state = 'failed'`,
      [req.params.transferId],
    );
    return releaseTransfer(req, res);
  }),
);

platformMoneyRouter.post(
  "/facilitated-payments/transfers/:transferId/reversals",
  requirePlatformAdmin,
  route(reverseTransfer),
);

platformMoneyRouter.get(
  "/facilitated-payments/refunds",
  route(async (req, res) => {
    const result = await query(
      `select refund.id, refund.facilitated_payment_id as "paymentId",
              payment.payable_statement_id as "statementId",
              refund.amount_minor::text as "amountMinor", refund.currency,
              refund.status, refund.reason, refund.reference,
              refund.requested_at as "requestedAt",
              refund.approved_at as "approvedAt",
              refund.succeeded_at as "succeededAt"
       from facilitated_refunds refund
       join facilitated_payments payment on payment.id = refund.facilitated_payment_id
       order by refund.created_at desc limit 250`,
    );
    res.json({ refunds: result.rows });
  }),
);

platformMoneyRouter.get(
  "/facilitated-payments/payouts",
  route(async (req, res) => {
    const result = await query(
      `select payout.id, payout.connected_account_id as "connectedAccountId",
              account.agency_organization_id as "agencyOrganizationId",
              payout.provider_payout_id as "providerPayoutId",
              payout.amount_minor::text as "amountMinor", payout.currency,
              payout.status, payout.arrival_at as "arrivalAt",
              payout.paid_at as "paidAt", payout.failed_at as "failedAt",
              payout.failure_code as "failureCode",
              payout.failure_message as "failureMessage",
              payout.last_reconciled_at as "lastReconciledAt",
              payout.updated_at as "updatedAt"
       from facilitated_payouts payout
       join agency_connected_accounts account
         on account.id = payout.connected_account_id
       order by payout.updated_at desc limit 250`,
    );
    res.json({ payouts: result.rows });
  }),
);

platformMoneyRouter.get(
  "/facilitated-payments/payout-reconciliation",
  route(async (req, res) => {
    const configuration = facilitatedMoneyConfiguration();
    const result = await query(
      `${payoutCheckpointSelect()}
       where checkpoint.provider_mode = $1
       order by checkpoint.last_successful_scan_at nulls first,
                checkpoint.updated_at`,
      [providerMode()],
    );
    res.json({
      maximumLagMinutes: configuration.payoutReconciliationMaxLagMinutes,
      checkpoints: result.rows.map((checkpoint) => ({
        ...checkpoint,
        stale: !checkpoint.lastSuccessfulScanAt
          || Date.now() - new Date(checkpoint.lastSuccessfulScanAt).getTime()
            > configuration.payoutReconciliationMaxLagMinutes * 60 * 1000,
      })),
    });
  }),
);

platformMoneyRouter.post(
  "/facilitated-payments/accounts/:connectedAccountId/payouts/reconcile",
  route(async (req, res) => {
    await requirePlatformHuman(req);
    res.json(await reconcilePayoutsForAccount(req.params.connectedAccountId, { req }));
  }),
);

platformMoneyRouter.post(
  "/facilitated-payments/payouts/reconcile",
  route(async (req, res) => {
    await requirePlatformHuman(req);
    const limit = req.body?.limit == null ? 25 : Number(req.body.limit);
    res.json(await reconcilePayoutAccounts({ limit, req }));
  }),
);

platformMoneyRouter.post(
  "/facilitated-payments/payments/:paymentId/refunds",
  requirePlatformAdmin,
  route(async (req, res) => {
    operationEnabled("refundsEnabled");
    const actorId = await requirePlatformHuman(req);
    const amount = minorUnits(req.body.amountMinor);
    const reason = bounded(req.body.reason, "reason", 2000);
    const reference = bounded(req.body.reference, "reference", 500);
    const key = idempotencyKey(req);
    const requestFingerprint = fingerprint({ amount, reason, reference, source: "platform" });
    const result = await withTransaction(async (client) => {
      await requireCertifiedForLive(client);
      const payment = await client.query(
        "select * from facilitated_payments where id = $1 for update",
        [req.params.paymentId],
      ).then((queryResult) => queryResult.rows[0]);
      if (!payment) throw httpError(404, "Facilitated payment not found");
      const existing = await client.query(
        `select * from facilitated_refunds
         where facilitated_payment_id = $1 and idempotency_key = $2`,
        [payment.id, key],
      ).then((queryResult) => queryResult.rows[0]);
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) {
          throw httpError(409, "The idempotency key belongs to another refund request");
        }
        return { refund: existing, replayed: true };
      }
      const totals = await client.query(
        `select coalesce(sum(amount_minor) filter(
           where status not in ('failed','canceled')
         ),0)::bigint as total
         from facilitated_refunds where facilitated_payment_id = $1`,
        [payment.id],
      );
      if (BigInt(totals.rows[0].total) + BigInt(amount) > BigInt(payment.amount_minor)) {
        throw httpError(409, "Refund requests cannot exceed the payment amount");
      }
      const refund = await client.query(
        `insert into facilitated_refunds(
           facilitated_payment_id, amount_minor, currency, reason, reference,
           requested_by_user_id, idempotency_key, request_fingerprint
         ) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [payment.id, amount, payment.currency, reason, reference, actorId, key, requestFingerprint],
      ).then((queryResult) => queryResult.rows[0]);
      await organizationAudit(client, req, {
        customerOrganizationId: payment.customer_organization_id,
        agencyOrganizationId: payment.agency_organization_id,
      }, {
        action: "facilitated_refund.requested_by_platform",
        resourceType: "facilitated_refund",
        resourceId: refund.id,
        afterState: { amountMinor: amount, currency: payment.currency, status: "requested" },
      });
      return { refund, replayed: false };
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }),
);

platformMoneyRouter.post(
  "/facilitated-payments/refunds/:refundId/approve",
  requirePlatformAdmin,
  route(approveRefund),
);

platformMoneyRouter.post(
  "/facilitated-payments/attempts/:attemptId/reconcile",
  route(async (req, res) => {
    await requirePlatformHuman(req);
    res.json({ attempt: await reconcileAttempt(req.params.attemptId, req) });
  }),
);

platformMoneyRouter.post(
  "/facilitated-payments/reconcile",
  route(async (req, res) => {
    await requirePlatformHuman(req);
    const attempts = await query(
      `select id from facilitated_payment_attempts
       where provider_mode = $1
         and (
           state in ('created','requires_action','processing')
           or (
             state = 'succeeded'
             and (funds_available_at is null or provider_balance_transaction_id is null)
           )
         )
       order by updated_at limit 50`,
      [providerMode()],
    );
    const refunds = await query(
      `select id from facilitated_refunds
       where provider_refund_id is not null
         and (
           status in ('submitting','pending','requires_action')
           or (
             status = 'succeeded'
             and not exists(
               select 1 from facilitated_funding_facts fact
               where fact.facilitated_payment_id = facilitated_refunds.facilitated_payment_id
                 and fact.fact_type = 'refund_succeeded'
                 and fact.provider_object_id = facilitated_refunds.provider_refund_id
             )
           )
         )
       order by updated_at limit 50`,
    );
    const transfers = await query(
      `select transfer.id
       from facilitated_transfer_instructions transfer
       join facilitated_payments payment
         on payment.id = transfer.facilitated_payment_id
       where payment.provider_mode = $1
         and transfer.state = 'submitting'
         and transfer.updated_at < now() - interval '5 minutes'
       order by transfer.updated_at limit 50`,
      [providerMode()],
    );
    const outcomes = [];
    for (const attempt of attempts.rows) {
      try {
        outcomes.push({
          id: attempt.id,
          resourceType: "facilitated_payment_attempt",
          status: "reconciled",
          result: await reconcileAttempt(attempt.id, req),
        });
      } catch (error) {
        outcomes.push({
          id: attempt.id,
          resourceType: "facilitated_payment_attempt",
          status: "failed",
          error: clean(error.message || error),
        });
      }
    }
    for (const transfer of transfers.rows) {
      try {
        outcomes.push({
          id: transfer.id,
          resourceType: "facilitated_transfer_instruction",
          status: "reconciled",
          result: await reconcileTransfer(transfer.id, req),
        });
      } catch (error) {
        outcomes.push({
          id: transfer.id,
          resourceType: "facilitated_transfer_instruction",
          status: "failed",
          error: clean(error.message || error),
        });
      }
    }
    for (const refund of refunds.rows) {
      try {
        outcomes.push({
          id: refund.id,
          resourceType: "facilitated_refund",
          status: "reconciled",
          result: await reconcileRefund(refund.id),
        });
      } catch (error) {
        outcomes.push({
          id: refund.id,
          resourceType: "facilitated_refund",
          status: "failed",
          error: clean(error.message || error),
        });
      }
    }
    await auditRequest({ query }, req, {
      action: "facilitated_payment_reconciliation.completed",
      resourceType: "facilitated_payment_reconciliation",
      afterState: {
        outcomeCount: outcomes.length,
        failedCount: outcomes.filter((outcome) => outcome.status === "failed").length,
      },
      metadata: {
        paymentAttemptCount: attempts.rowCount,
        transferCount: transfers.rowCount,
        refundCount: refunds.rowCount,
      },
    });
    res.json({ outcomes });
  }),
);

platformMoneyRouter.get(
  "/facilitated-payments/exceptions",
  route(async (req, res) => {
    const result = await query(
      `select id, exception_type as "exceptionType", severity,
              organization_id as "organizationId", resource_type as "resourceType",
              resource_id as "resourceId", status, details, resolution,
              created_at as "createdAt", resolved_at as "resolvedAt"
       from facilitated_payment_exceptions
       order by (status = 'open') desc, created_at desc limit 250`,
    );
    res.json({ exceptions: result.rows });
  }),
);

platformMoneyRouter.post(
  "/facilitated-payments/exceptions/:exceptionId/resolve",
  route(async (req, res) => {
    const actorId = await requirePlatformHuman(req);
    const resolution = bounded(req.body.resolution, "resolution", 5000);
    const exception = await withTransaction(async (client) => {
      const before = await client.query(
        `select * from facilitated_payment_exceptions
         where id = $1 and status = 'open' for update`,
        [req.params.exceptionId],
      ).then((result) => result.rows[0] || null);
      if (!before) throw httpError(404, "Open exception not found");
      const updated = await client.query(
        `update facilitated_payment_exceptions
         set status = 'resolved', resolution = $2, resolved_by_user_id = $3,
             resolved_at = now(), updated_at = now()
         where id = $1 returning *`,
        [req.params.exceptionId, resolution, actorId],
      ).then((result) => result.rows[0]);
      await auditRequest(client, req, {
        organizationId: before.organization_id,
        action: "facilitated_payment_exception.resolved",
        resourceType: "facilitated_payment_exception",
        resourceId: before.id,
        beforeState: { status: before.status },
        afterState: { status: updated.status, resolution },
      });
      return updated;
    });
    res.json({ exception });
  }),
);

platformMoneyRouter.get(
  "/facilitated-payments/recovery-cases",
  route(async (req, res) => {
    const result = await query(
      `select id, facilitated_payment_id as "paymentId", payout_id as "payoutId",
              case_type as "caseType", exposure_minor::text as "exposureMinor",
              currency, status, resolution, created_at as "createdAt",
              resolved_at as "resolvedAt"
       from facilitated_recovery_cases
       order by (status in ('open','recovering')) desc, created_at desc limit 250`,
    );
    res.json({ recoveryCases: result.rows });
  }),
);

platformMoneyRouter.post(
  "/facilitated-payments/recovery-cases/:recoveryId/resolve",
  requirePlatformAdmin,
  route(async (req, res) => {
    const actorId = await requirePlatformHuman(req);
    const status = clean(req.body.status);
    if (!["resolved", "written_off"].includes(status)) {
      throw httpError(400, "Recovery resolution status is invalid");
    }
    const resolution = bounded(req.body.resolution, "resolution", 5000);
    const recovery = await query(
      `update facilitated_recovery_cases
       set status = $2, resolution = $3, resolved_by_user_id = $4,
           resolved_at = now(), updated_at = now()
       where id = $1 and status in ('open','recovering') returning *`,
      [req.params.recoveryId, status, resolution, actorId],
    ).then((result) => result.rows[0]);
    if (!recovery) throw httpError(404, "Open recovery case not found");
    res.json({ recovery });
  }),
);


organizationMoneyRouter.post(
  "/organizations/:organizationId/vendor-relationships/:vendorRelationshipId/payable-statements/:statementId/refund-requests",
  requireOrganizationPermission("facilitated_payments.refund"),
  route(async (req, res) => {
    operationEnabled("refundsEnabled");
    const userId = requireHuman(req);
    const key = idempotencyKey(req);
    const amount = minorUnits(req.body.amountMinor);
    const reason = bounded(req.body.reason, "reason", 2000);
    const reference = bounded(req.body.reference, "reference", 500);
    const requestFingerprint = fingerprint({ amount, reason, reference });
    const result = await withTransaction(async (client) => {
      const context = await statementContext(client, req.params.statementId, {
        organizationId: req.authorizedOrganizationId,
        lock: true,
      });
      if (
        context.vendorRelationshipId !== req.params.vendorRelationshipId
        || context.customerOrganizationId !== req.authorizedOrganizationId
      ) {
        throw httpError(403, "Only the customer can request this refund");
      }
      const payment = await client.query(
        `select * from facilitated_payments
         where payable_statement_id = $1 and application_state = 'applied'
         for update`,
        [context.id],
      ).then((queryResult) => queryResult.rows[0]);
      if (!payment) throw httpError(409, "This statement has no applied facilitated payment");
      const existing = await client.query(
        `select * from facilitated_refunds
         where facilitated_payment_id = $1 and idempotency_key = $2`,
        [payment.id, key],
      ).then((queryResult) => queryResult.rows[0]);
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) {
          throw httpError(409, "The idempotency key belongs to another refund request");
        }
        return { refund: existing, replayed: true };
      }
      const totals = await client.query(
        `select coalesce(sum(amount_minor) filter(
           where status not in ('failed','canceled')
         ),0)::bigint as total
         from facilitated_refunds where facilitated_payment_id = $1`,
        [payment.id],
      );
      if (BigInt(totals.rows[0].total) + BigInt(amount) > BigInt(payment.amount_minor)) {
        throw httpError(409, "Refund requests cannot exceed the payment amount");
      }
      const refund = await client.query(
        `insert into facilitated_refunds(
           facilitated_payment_id, amount_minor, currency, reason, reference,
           requested_by_organization_id, requested_by_user_id,
           idempotency_key, request_fingerprint
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [
          payment.id,
          amount,
          payment.currency,
          reason,
          reference,
          req.authorizedOrganizationId,
          userId,
          key,
          requestFingerprint,
        ],
      ).then((queryResult) => queryResult.rows[0]);
      await organizationAudit(client, req, context, {
        action: "facilitated_refund.requested",
        resourceType: "facilitated_refund",
        resourceId: refund.id,
        afterState: { amountMinor: amount, currency: payment.currency, status: "requested" },
      });
      return { refund, replayed: false };
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }),
);
