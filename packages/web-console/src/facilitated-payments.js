import { randomUUID } from "node:crypto";
import express from "express";
import { auditRequest, insertAuditEvent } from "./audit.js";
import {
  requirePlatformAdmin,
  requirePlatformOperationsAccess,
} from "./auth.js";
import { requireOrganizationPermission } from "./authorization.js";
import { query, withTransaction } from "./db.js";
import { organizationFeatureAccess } from "./entitlements.js";
import { createPinnedStripeClient } from "./stripe-client.js";
import { isUuid } from "./validation.js";
import {
  facilitatedMoneyConfiguration,
  processFacilitatedMoneyEvent,
  setFacilitatedMoneyTestClient,
  validateFacilitatedMoneyConfiguration,
} from "./facilitated-money.js";

export const organizationPaymentsRouter = express.Router();
export const platformPaymentsRouter = express.Router();

const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
const provider = "stripe";
const featureKey = "facilitated_payments";
const programVersion = "us-usd-v1";
const maximumMinorUnits = 9_223_372_036_854_775_807n;
let stripeClientOverride = null;

function clean(value) {
  return String(value ?? "").trim();
}

function httpError(status, message, code = null, details = null) {
  const error = Object.assign(new Error(message), { status });
  if (code) error.code = code;
  if (details) error.details = details;
  return error;
}

function facilitatedPaymentsEnabled() {
  return process.env.HEDGELING_FACILITATED_PAYMENTS_ENABLED === "true";
}

function providerMode() {
  const mode = clean(process.env.HEDGELING_FACILITATED_PAYMENTS_MODE || "test").toLowerCase();
  if (!["test", "live"].includes(mode)) {
    throw new Error("HEDGELING_FACILITATED_PAYMENTS_MODE must be test or live");
  }
  return mode;
}

function providerEventReplayLeaseMinutes() {
  const value = Number(
    process.env.HEDGELING_PROVIDER_EVENT_REPLAY_LEASE_MINUTES || 15,
  );
  if (!Number.isInteger(value) || value < 1 || value > 1440) {
    throw new Error(
      "HEDGELING_PROVIDER_EVENT_REPLAY_LEASE_MINUTES must be an integer from 1 to 1440",
    );
  }
  return value;
}

function requiredUrl(name) {
  const value = clean(process.env[name]);
  if (!value) throw new Error(`${name} is required when facilitated payments are enabled`);
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

function connectSecretKey() {
  return clean(process.env.STRIPE_CONNECT_SECRET_KEY);
}

function stripeClient() {
  if (stripeClientOverride) return stripeClientOverride;
  if (!facilitatedPaymentsEnabled()) {
    throw httpError(503, "Facilitated payments are not enabled", "facilitated_payments_disabled");
  }
  if (!connectSecretKey()) {
    throw httpError(503, "Stripe Connect is not configured", "connect_not_configured");
  }
  return createPinnedStripeClient(connectSecretKey());
}

async function callStripe(operation, publicMessage) {
  try {
    return await operation();
  } catch (cause) {
    throw Object.assign(new Error(publicMessage), { status: 502, cause });
  }
}

function stripeTimestamp(value) {
  return Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

function callbackUrl(name, organizationId, flow) {
  const url = requiredUrl(name);
  url.searchParams.set("connect", flow);
  url.searchParams.set("organizationId", organizationId);
  return url.toString();
}

function parseMinorUnits(value, field) {
  const normalized = clean(value);
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw httpError(400, `${field} must be a positive integer in minor units`);
  }
  const amount = BigInt(normalized);
  if (amount > maximumMinorUnits) {
    throw httpError(400, `${field} exceeds the supported maximum`);
  }
  return normalized;
}

function stringArray(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map(clean)
      .filter(Boolean),
  )].sort();
}

function transferCapability(account) {
  return ["active", "pending"].includes(account?.capabilities?.transfers)
    ? account.capabilities.transfers
    : "inactive";
}

export function connectedAccountProjection(
  account,
  previousState = "not_started",
  previousDisabledReason = null,
) {
  const requirements = account?.requirements || {};
  const futureRequirements = account?.future_requirements || {};
  const due = stringArray([
    ...(requirements.currently_due || []),
    ...(requirements.past_due || []),
  ]);
  const pendingVerification = stringArray(requirements.pending_verification);
  const futureDue = stringArray([
    ...(futureRequirements.currently_due || []),
    ...(futureRequirements.eventually_due || []),
    ...(futureRequirements.past_due || []),
  ]);
  const transfersCapability = transferCapability(account);
  const payoutsEnabled = account?.payouts_enabled === true;
  const detailsSubmitted = account?.details_submitted === true;
  const providerDisabledReason = clean(requirements.disabled_reason) || null;
  const ready = !account?.deleted
    && transfersCapability === "active"
    && payoutsEnabled
    && detailsSubmitted
    && due.length === 0
    && !providerDisabledReason;
  const stickyDisabled = previousState === "disabled";
  const restricted = !account?.deleted && !stickyDisabled && !ready && (
    Boolean(providerDisabledReason)
    || (requirements.past_due || []).length > 0
    || previousState === "ready"
    || previousState === "restricted"
  );
  let onboardingState = "pending";
  if (account?.deleted || stickyDisabled) onboardingState = "disabled";
  else if (ready) onboardingState = "ready";
  else if (restricted) onboardingState = "restricted";

  let disabledReason = providerDisabledReason;
  if (!disabledReason && onboardingState === "restricted") {
    if ((requirements.past_due || []).length) disabledReason = "requirements_past_due";
    else if (due.length) disabledReason = "requirements_due";
    else if (transfersCapability !== "active") {
      disabledReason = `transfers_${transfersCapability}`;
    } else if (!payoutsEnabled) disabledReason = "payouts_disabled";
    else disabledReason = "account_not_ready";
  }
  if (account?.deleted) disabledReason = "provider_account_deleted";
  else if (stickyDisabled) {
    disabledReason = clean(previousDisabledReason) || "account_disabled";
  }

  return {
    onboardingState,
    transfersCapability,
    payoutsEnabled,
    detailsSubmitted,
    requirementsDue: due,
    requirementsPendingVerification: pendingVerification,
    futureRequirementsDue: futureDue,
    requirementsDeadline: stripeTimestamp(requirements.current_deadline),
    disabledReason,
  };
}

export function facilitatedPaymentsConfiguration() {
  const money = facilitatedMoneyConfiguration();
  return {
    enabled: facilitatedPaymentsEnabled(),
    provider,
    providerMode: providerMode(),
    programVersion,
    providerEventReplayLeaseMinutes: providerEventReplayLeaseMinutes(),
    ...money,
  };
}

export function validateFacilitatedPaymentsConfiguration() {
  const mode = providerMode();
  providerEventReplayLeaseMinutes();
  validateFacilitatedMoneyConfiguration();
  if (!facilitatedPaymentsEnabled()) return true;
  for (const name of ["STRIPE_CONNECT_SECRET_KEY", "STRIPE_CONNECT_WEBHOOK_SECRET"]) {
    if (!clean(process.env[name])) {
      throw new Error(`${name} is required when facilitated payments are enabled`);
    }
  }
  const secretKey = connectSecretKey();
  if (mode === "live" && !/^[sr]k_live_/.test(secretKey)) {
    throw new Error("Live facilitated payments require a live Stripe Connect secret key");
  }
  if (mode === "test" && /^[sr]k_live_/.test(secretKey)) {
    throw new Error("Test facilitated payments cannot use a live Stripe Connect secret key");
  }
  requiredUrl("STRIPE_CONNECT_ONBOARDING_RETURN_URL");
  requiredUrl("STRIPE_CONNECT_ONBOARDING_REFRESH_URL");
  return true;
}

export function setFacilitatedPaymentsTestClient(client) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Facilitated-payment test client is only available in NODE_ENV=test");
  }
  stripeClientOverride = client;
  setFacilitatedMoneyTestClient(client);
}

const enrollmentSelect = `
  select enrollment.id, enrollment.organization_id as "organizationId",
         enrollment.provider, enrollment.program_version as "programVersion",
         enrollment.party_type as "partyType",
         enrollment.provider_mode as "providerMode", enrollment.status,
         enrollment.country, enrollment.currencies,
         enrollment.payment_methods as "paymentMethods",
         enrollment.per_payment_cap_minor::text as "perPaymentCapMinor",
         enrollment.rolling_cap_minor::text as "rollingCapMinor",
         enrollment.rolling_period_days as "rollingPeriodDays",
         enrollment.manual_transfer_required as "manualTransferRequired",
         enrollment.terms_version as "termsVersion",
         enrollment.policy_version as "policyVersion",
         enrollment.acceptance_evidence as "acceptanceEvidence",
         enrollment.status_reason as "statusReason",
         enrollment.approved_by_user_id as "approvedByUserId",
         enrollment.approved_at as "approvedAt",
         enrollment.created_at as "createdAt"
  from facilitated_payment_program_enrollments enrollment`;

const accountSelect = `
  select account.id, account.agency_organization_id as "agencyOrganizationId",
         account.provider, account.provider_mode as "providerMode",
         account.provider_account_id as "providerAccountId",
         account.account_controller as "accountController",
         account.country, account.default_currency as "defaultCurrency",
         account.onboarding_state as "onboardingState",
         account.transfers_capability as "transfersCapability",
         account.payouts_enabled as "payoutsEnabled",
         account.details_submitted as "detailsSubmitted",
         account.requirements_due as "requirementsDue",
         account.requirements_pending_verification as "requirementsPendingVerification",
         account.future_requirements_due as "futureRequirementsDue",
         account.requirements_deadline as "requirementsDeadline",
         account.disabled_reason as "disabledReason",
         account.provider_state_updated_at as "providerStateUpdatedAt",
         account.last_webhook_at as "lastWebhookAt",
         account.created_at as "createdAt", account.updated_at as "updatedAt"
  from agency_connected_accounts account`;

async function currentEnrollment(organizationId, client = { query }) {
  const result = await client.query(
    `${enrollmentSelect}
     where enrollment.organization_id = $1
       and enrollment.provider = 'stripe'
       and enrollment.provider_mode = $2
       and enrollment.superseded_at is null`,
    [organizationId, providerMode()],
  );
  return result.rows[0] || null;
}

async function currentAccount(organizationId, client = { query }) {
  const result = await client.query(
    `${accountSelect}
     where account.agency_organization_id = $1
       and account.provider = 'stripe'
       and account.provider_mode = $2
       and account.superseded_at is null`,
    [organizationId, providerMode()],
  );
  return result.rows[0] || null;
}

async function programState(organizationId) {
  const organizationResult = await query(
    `select id, name, organization_type as "organizationType", status,
            default_currency as "defaultCurrency"
     from organizations where id = $1`,
    [organizationId],
  );
  const organization = organizationResult.rows[0];
  if (!organization) throw httpError(404, "Organization not found");
  const [enrollment, feature] = await Promise.all([
    currentEnrollment(organizationId),
    organizationFeatureAccess(organizationId, featureKey),
  ]);
  return {
    configuration: facilitatedPaymentsConfiguration(),
    organization,
    feature,
    enrollment,
  };
}

async function requireAgencyHuman(req, client) {
  const userId = req.auth?.user?.id;
  if (!userId || req.auth?.principalType === "service_account") {
    throw httpError(403, "Payout-account actions require an agency human");
  }
  const membership = await client.query(
    `select membership.id
     from organization_memberships membership
     join organizations organization
       on organization.id = membership.organization_id
      and organization.organization_type = 'agency'
      and organization.status = 'active'
     where membership.organization_id = $1 and membership.user_id = $2
       and membership.status = 'active'
       and (membership.expires_at is null or membership.expires_at > now())`,
    [req.authorizedOrganizationId, userId],
  );
  if (!membership.rows[0]) {
    throw httpError(403, "An active agency membership is required");
  }
  return userId;
}

async function requirePlatformHuman(req) {
  if (!req.auth?.user?.id || req.auth?.principalType === "service_account") {
    throw httpError(403, "This facilitated-payment action requires a platform human");
  }
  return req.auth.user.id;
}

function providerAccountMetadata(localAccount) {
  return {
    hedgeling_connected_account_id: localAccount.id,
    hedgeling_organization_id: localAccount.agencyOrganizationId,
    hedgeling_program_version: programVersion,
    hedgeling_provider_mode: localAccount.providerMode,
  };
}

function validateProviderAccount(localAccount, providerAccount, eventMode = null) {
  if (!providerAccount?.id || providerAccount.id !== localAccount.providerAccountId) {
    throw new Error("Stripe account does not match the connected-account record");
  }
  if (
    providerAccount.metadata?.hedgeling_connected_account_id !== localAccount.id
    || providerAccount.metadata?.hedgeling_organization_id !== localAccount.agencyOrganizationId
    || providerAccount.metadata?.hedgeling_program_version !== programVersion
    || providerAccount.metadata?.hedgeling_provider_mode !== localAccount.providerMode
  ) {
    throw new Error("Stripe account metadata does not match its Hedgeling owner");
  }
  if (eventMode && eventMode !== localAccount.providerMode) {
    throw new Error("Stripe account event mode does not match the connected-account record");
  }
}

async function synchronizeConnectedAccount(
  client,
  localAccount,
  providerAccount,
  observedAt,
  { providerEventId = null, lastWebhookAt = null, req = null } = {},
) {
  const beforeResult = await client.query(
    `${accountSelect} where account.id = $1 for update`,
    [localAccount.id],
  );
  const before = beforeResult.rows[0];
  if (!before) throw new Error("Connected-account record disappeared during synchronization");
  validateProviderAccount(before, providerAccount);
  const projection = connectedAccountProjection(
    providerAccount,
    before.onboardingState,
    before.disabledReason,
  );
  if (lastWebhookAt) {
    await client.query(
      `update agency_connected_accounts
       set last_webhook_at = greatest(
         coalesce(last_webhook_at, '-infinity'::timestamptz),
         $2::timestamptz
       )
       where id = $1`,
      [localAccount.id, lastWebhookAt],
    );
  }
  if (
    before.providerStateUpdatedAt
    && new Date(before.providerStateUpdatedAt).getTime() > new Date(observedAt).getTime()
  ) {
    return { account: before, stale: true };
  }
  const updated = await client.query(
    `update agency_connected_accounts
     set onboarding_state = $2, transfers_capability = $3,
         payouts_enabled = $4, details_submitted = $5,
         requirements_due = $6, requirements_pending_verification = $7,
         future_requirements_due = $8, requirements_deadline = $9,
         disabled_reason = $10, provider_state_updated_at = $11,
         updated_at = now()
     where id = $1
     returning id, agency_organization_id as "agencyOrganizationId",
               provider, provider_mode as "providerMode",
               provider_account_id as "providerAccountId",
               account_controller as "accountController",
               country, default_currency as "defaultCurrency",
               onboarding_state as "onboardingState",
               transfers_capability as "transfersCapability",
               payouts_enabled as "payoutsEnabled",
               details_submitted as "detailsSubmitted",
               requirements_due as "requirementsDue",
               requirements_pending_verification as "requirementsPendingVerification",
               future_requirements_due as "futureRequirementsDue",
               requirements_deadline as "requirementsDeadline",
               disabled_reason as "disabledReason",
               provider_state_updated_at as "providerStateUpdatedAt",
               last_webhook_at as "lastWebhookAt",
               created_at as "createdAt", updated_at as "updatedAt"`,
    [
      localAccount.id,
      projection.onboardingState,
      projection.transfersCapability,
      projection.payoutsEnabled,
      projection.detailsSubmitted,
      JSON.stringify(projection.requirementsDue),
      JSON.stringify(projection.requirementsPendingVerification),
      JSON.stringify(projection.futureRequirementsDue),
      projection.requirementsDeadline,
      projection.disabledReason,
      observedAt,
    ],
  );
  const after = updated.rows[0];
  const event = {
    organizationId: localAccount.agencyOrganizationId,
    action: "payout_account.synchronized",
    resourceType: "agency_connected_account",
    resourceId: localAccount.id,
    beforeState: before,
    afterState: after,
    metadata: {
      provider,
      providerEventId,
      source: providerEventId ? "webhook" : "reconciliation",
    },
  };
  if (req) await auditRequest(client, req, event);
  else {
    await insertAuditEvent(client, {
      auth: { principalType: "platform" },
      ...event,
    });
  }
  return { account: after, stale: false };
}

async function ensureLocalConnectedAccount(req) {
  if (!facilitatedPaymentsEnabled()) {
    throw httpError(503, "Facilitated payments are not enabled", "facilitated_payments_disabled");
  }
  const mode = providerMode();
  return withTransaction(async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtext($1))",
      [`facilitated-connect:${req.authorizedOrganizationId}:${mode}`],
    );
    const userId = await requireAgencyHuman(req, client);
    const feature = await organizationFeatureAccess(
      req.authorizedOrganizationId,
      featureKey,
      client,
    );
    if (!feature.enabled) {
      throw httpError(403, "Facilitated payments are not enabled for this agency", "feature_disabled");
    }
    const enrollment = await client.query(
      `${enrollmentSelect}
       where enrollment.organization_id = $1
         and enrollment.provider = 'stripe'
         and enrollment.provider_mode = $2
         and enrollment.superseded_at is null
       for update`,
      [req.authorizedOrganizationId, mode],
    );
    if (enrollment.rows[0]?.status !== "approved") {
      throw httpError(409, "The agency is not approved for the payment program", "program_enrollment_required");
    }
    let account = await currentAccount(req.authorizedOrganizationId, client);
    if (!account) {
      const inserted = await client.query(
        `insert into agency_connected_accounts(
           agency_organization_id, provider_mode, created_by_user_id
         ) values($1, $2, $3)
         returning id`,
        [req.authorizedOrganizationId, mode, userId],
      );
      account = await client.query(
        `${accountSelect} where account.id = $1`,
        [inserted.rows[0].id],
      ).then((result) => result.rows[0]);
      await auditRequest(client, req, {
        organizationId: req.authorizedOrganizationId,
        action: "payout_account.created",
        resourceType: "agency_connected_account",
        resourceId: account.id,
        afterState: account,
      });
    }
    if (account.onboardingState === "disabled") {
      throw httpError(409, "The connected account is disabled", "payout_account_disabled");
    }
    return account;
  });
}

async function ensureProviderAccount(req, localAccount) {
  if (localAccount.providerAccountId) return localAccount;
  const account = await callStripe(
    () => stripeClient().accounts.create(
      {
        country: "US",
        default_currency: "usd",
        controller: {
          fees: { payer: "application" },
          losses: { payments: "application" },
          stripe_dashboard: { type: "express" },
        },
        capabilities: { transfers: { requested: true } },
        business_profile: {
          product_description: "Professional translation and localization services",
        },
        metadata: providerAccountMetadata(localAccount),
      },
      { idempotencyKey: `hedgeling-connect-account-${localAccount.id}` },
    ),
    "Stripe could not create the connected account",
  );
  if (!/^acct_[A-Za-z0-9]+$/.test(clean(account?.id))) {
    throw new Error("Stripe returned an invalid connected-account identifier");
  }
  const linked = await withTransaction(async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtext($1))",
      [`facilitated-connect:${localAccount.agencyOrganizationId}:${localAccount.providerMode}`],
    );
    const updated = await client.query(
      `update agency_connected_accounts
       set provider_account_id = $2, onboarding_state = 'pending', updated_at = now()
       where id = $1
         and (provider_account_id is null or provider_account_id = $2)
       returning id`,
      [localAccount.id, account.id],
    );
    if (!updated.rows[0]) {
      throw httpError(409, "The agency connected account was linked concurrently; retry");
    }
    const current = await client.query(
      `${accountSelect} where account.id = $1`,
      [localAccount.id],
    ).then((result) => result.rows[0]);
    validateProviderAccount(current, account);
    const synchronized = await synchronizeConnectedAccount(
      client,
      current,
      account,
      new Date().toISOString(),
      { req },
    );
    return synchronized.account;
  });
  return linked;
}

async function loadExistingAccountForHuman(req) {
  if (!facilitatedPaymentsEnabled()) {
    throw httpError(503, "Facilitated payments are not enabled", "facilitated_payments_disabled");
  }
  return withTransaction(async (client) => {
    await requireAgencyHuman(req, client);
    const account = await currentAccount(req.authorizedOrganizationId, client);
    if (!account?.providerAccountId) {
      throw httpError(404, "Connected account not found");
    }
    if (account.providerMode !== providerMode()) {
      throw httpError(409, "Connected account belongs to another provider mode");
    }
    return account;
  });
}

async function organizationPayoutAccount(req, res) {
  const state = await programState(req.authorizedOrganizationId);
  if (state.organization.organizationType !== "agency") {
    throw httpError(409, "Payout accounts are available only to agency organizations");
  }
  const account = await currentAccount(req.authorizedOrganizationId);
  let canManage = false;
  if (
    req.organizationPermissions.includes("payout_accounts.manage")
    && req.auth?.user?.id
    && req.auth?.principalType !== "service_account"
  ) {
    const membership = await query(
      `select 1 from organization_memberships
       where organization_id = $1 and user_id = $2 and status = 'active'
         and (expires_at is null or expires_at > now())`,
      [req.authorizedOrganizationId, req.auth.user.id],
    );
    canManage = Boolean(membership.rows[0]);
  }
  return res.json({
    ...state,
    connectedAccount: account,
    canManage,
    ready: state.configuration.enabled
      && state.feature.enabled
      && state.enrollment?.status === "approved"
      && account?.onboardingState === "ready",
  });
}

organizationPaymentsRouter.get(
  "/organizations/:organizationId/payout-account",
  requireOrganizationPermission("payout_accounts.view"),
  route(organizationPayoutAccount),
);

organizationPaymentsRouter.post(
  "/organizations/:organizationId/payout-account/onboarding",
  requireOrganizationPermission("payout_accounts.manage"),
  route(async (req, res) => {
    let account = await ensureLocalConnectedAccount(req);
    account = await ensureProviderAccount(req, account);
    await query(
      `update connected_account_onboarding_links
       set status = 'expired', updated_at = now()
       where connected_account_id = $1 and status = 'issued'
         and expires_at <= now()`,
      [account.id],
    );
    const linkIntent = await query(
      `insert into connected_account_onboarding_links(
         connected_account_id, created_by_user_id
       ) values($1, $2)
       returning id`,
      [account.id, req.auth.user.id],
    );
    const linkId = linkIntent.rows[0].id;
    let link;
    try {
      link = await callStripe(
        () => stripeClient().accountLinks.create(
          {
            account: account.providerAccountId,
            refresh_url: callbackUrl(
              "STRIPE_CONNECT_ONBOARDING_REFRESH_URL",
              req.authorizedOrganizationId,
              "refresh",
            ),
            return_url: callbackUrl(
              "STRIPE_CONNECT_ONBOARDING_RETURN_URL",
              req.authorizedOrganizationId,
              "return",
            ),
            type: "account_onboarding",
            collection_options: {
              fields: "eventually_due",
              future_requirements: "include",
            },
          },
          { idempotencyKey: `hedgeling-connect-onboarding-${linkId}` },
        ),
        "Stripe could not create the onboarding link",
      );
      const providerCreatedAt = stripeTimestamp(link.created);
      const expiresAt = stripeTimestamp(link.expires_at);
      if (!link.url || !providerCreatedAt || !expiresAt) {
        throw new Error("Stripe returned an incomplete onboarding link");
      }
      await withTransaction(async (client) => {
        await client.query(
          `update connected_account_onboarding_links
           set status = 'issued', provider_created_at = $2, expires_at = $3,
               updated_at = now()
           where id = $1`,
          [linkId, providerCreatedAt, expiresAt],
        );
        await auditRequest(client, req, {
          organizationId: req.authorizedOrganizationId,
          action: "payout_account.onboarding_link_issued",
          resourceType: "connected_account_onboarding_link",
          resourceId: linkId,
          metadata: {
            connectedAccountId: account.id,
            expiresAt,
          },
        });
      });
      return res.status(201).json({
        onboarding: { id: linkId, url: link.url, expiresAt },
        connectedAccount: account,
      });
    } catch (error) {
      await query(
        `update connected_account_onboarding_links
         set status = 'failed', last_error = $2, updated_at = now()
         where id = $1`,
        [linkId, clean(error.message || error).slice(0, 2000)],
      ).catch(() => {});
      throw error;
    }
  }),
);

organizationPaymentsRouter.post(
  "/organizations/:organizationId/payout-account/refresh",
  requireOrganizationPermission("payout_accounts.manage"),
  route(async (req, res) => {
    const account = await loadExistingAccountForHuman(req);
    const providerAccount = await callStripe(
      () => stripeClient().accounts.retrieve(account.providerAccountId),
      "Stripe could not refresh the connected account",
    );
    const synchronized = await withTransaction((client) => synchronizeConnectedAccount(
      client,
      account,
      providerAccount,
      new Date().toISOString(),
      { req },
    ));
    res.json({ connectedAccount: synchronized.account, stale: synchronized.stale });
  }),
);

organizationPaymentsRouter.post(
  "/organizations/:organizationId/payout-account/dashboard",
  requireOrganizationPermission("payout_accounts.manage"),
  route(async (req, res) => {
    const account = await loadExistingAccountForHuman(req);
    const loginLink = await callStripe(
      () => stripeClient().accounts.createLoginLink(account.providerAccountId),
      "Stripe could not create the Express Dashboard link",
    );
    if (!loginLink?.url) throw new Error("Stripe returned an incomplete dashboard link");
    await auditRequest({ query }, req, {
      organizationId: req.authorizedOrganizationId,
      action: "payout_account.dashboard_link_issued",
      resourceType: "agency_connected_account",
      resourceId: account.id,
      metadata: { providerCreatedAt: stripeTimestamp(loginLink.created) },
    });
    res.status(201).json({ url: loginLink.url });
  }),
);

platformPaymentsRouter.use(requirePlatformOperationsAccess);

for (const parameter of ["organizationId", "connectedAccountId"]) {
  platformPaymentsRouter.param(parameter, (req, res, next, value) => (
    isUuid(value) ? next() : res.status(400).json({ error: `${parameter} is invalid` })
  ));
}

platformPaymentsRouter.get(
  "/facilitated-payments/organizations/:organizationId/program",
  route(async (req, res) => {
    res.json(await programState(req.params.organizationId));
  }),
);

platformPaymentsRouter.put(
  "/facilitated-payments/organizations/:organizationId/program",
  requirePlatformAdmin,
  route(async (req, res) => {
    const actorId = await requirePlatformHuman(req);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const status = clean(body.status);
    const reason = clean(body.reason);
    if (!["approved", "suspended", "terminated"].includes(status)) {
      throw httpError(400, "Enrollment status is invalid");
    }
    if (!reason || reason.length > 2000) {
      throw httpError(400, "A status reason of at most 2000 characters is required");
    }
    if (typeof body.featureEnabled !== "boolean") {
      throw httpError(400, "featureEnabled must be true or false");
    }
    const state = await withTransaction(async (client) => {
      const mode = providerMode();
      await client.query(
        "select pg_advisory_xact_lock(hashtext($1))",
        [`facilitated-program:${req.params.organizationId}:${mode}`],
      );
      const organization = await client.query(
        `select id, organization_type as "organizationType", status
         from organizations where id = $1 for update`,
        [req.params.organizationId],
      ).then((result) => result.rows[0]);
      if (!organization) throw httpError(404, "Organization not found");
      if (!["customer", "agency"].includes(organization.organizationType)) {
        throw httpError(409, "This organization type cannot join the payment program");
      }
      if (status === "approved" && organization.status !== "active") {
        throw httpError(409, "Only active organizations can be approved");
      }
      const previous = await client.query(
        `${enrollmentSelect}
         where enrollment.organization_id = $1
           and enrollment.provider = 'stripe'
           and enrollment.provider_mode = $2
           and enrollment.superseded_at is null
         for update`,
        [req.params.organizationId, mode],
      ).then((result) => result.rows[0] || null);
      if (previous?.status === "terminated") {
        throw httpError(409, "A terminated program enrollment cannot be reopened");
      }
      const perPaymentCapMinor = parseMinorUnits(
        body.perPaymentCapMinor ?? previous?.perPaymentCapMinor,
        "perPaymentCapMinor",
      );
      const rollingCapMinor = parseMinorUnits(
        body.rollingCapMinor ?? previous?.rollingCapMinor,
        "rollingCapMinor",
      );
      if (BigInt(rollingCapMinor) < BigInt(perPaymentCapMinor)) {
        throw httpError(400, "rollingCapMinor must be at least perPaymentCapMinor");
      }
      const rollingPeriodDays = Number(
        body.rollingPeriodDays ?? previous?.rollingPeriodDays ?? 30,
      );
      if (!Number.isInteger(rollingPeriodDays) || rollingPeriodDays < 1 || rollingPeriodDays > 366) {
        throw httpError(400, "rollingPeriodDays must be an integer from 1 to 366");
      }
      const termsVersion = clean(body.termsVersion || previous?.termsVersion);
      const policyVersion = clean(body.policyVersion || previous?.policyVersion);
      const acceptanceReference = clean(
        body.acceptanceReference
        || previous?.acceptanceEvidence?.reference,
      );
      if (
        !termsVersion || termsVersion.length > 100
        || !policyVersion || policyVersion.length > 100
        || !acceptanceReference || acceptanceReference.length > 500
      ) {
        throw httpError(
          400,
          "Terms version, policy version, and acceptance reference are required",
        );
      }
      if (previous) {
        await client.query(
          `update facilitated_payment_program_enrollments
           set superseded_at = now(), updated_at = now() where id = $1`,
          [previous.id],
        );
      }
      const paymentMethods = organization.organizationType === "customer"
        ? ["card", "us_bank_account"]
        : [];
      const inserted = await client.query(
        `insert into facilitated_payment_program_enrollments(
           organization_id, program_version, party_type, provider_mode, status,
           payment_methods, per_payment_cap_minor, rolling_cap_minor,
           rolling_period_days, manual_transfer_required, terms_version,
           policy_version, acceptance_evidence, status_reason,
           approved_by_user_id, approved_at, changed_by_user_id
         ) values(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11, $12, $13,
           case when $5 = 'approved' then $14::uuid end,
           case when $5 = 'approved' then now() end,
           $14
         )
         returning id`,
        [
          req.params.organizationId,
          programVersion,
          organization.organizationType,
          mode,
          status,
          paymentMethods,
          perPaymentCapMinor,
          rollingCapMinor,
          rollingPeriodDays,
          termsVersion,
          policyVersion,
          JSON.stringify({ reference: acceptanceReference }),
          reason,
          actorId,
        ],
      );
      const previousFlag = await client.query(
        `select id, enabled
         from organization_feature_flag_overrides
         where organization_id = $1 and feature_key = $2 and superseded_at is null
         for update`,
        [req.params.organizationId, featureKey],
      ).then((result) => result.rows[0] || null);
      if (previousFlag) {
        await client.query(
          `update organization_feature_flag_overrides
           set superseded_at = now() where id = $1`,
          [previousFlag.id],
        );
      }
      await client.query(
        `insert into organization_feature_flag_overrides(
           organization_id, feature_key, enabled, reason, changed_by_user_id
         ) values($1, $2, $3, $4, $5)`,
        [
          req.params.organizationId,
          featureKey,
          body.featureEnabled,
          reason,
          actorId,
        ],
      );
      const after = await client.query(
        `${enrollmentSelect} where enrollment.id = $1`,
        [inserted.rows[0].id],
      ).then((result) => result.rows[0]);
      await auditRequest(client, req, {
        organizationId: req.params.organizationId,
        action: "facilitated_payment_program.updated",
        resourceType: "facilitated_payment_program_enrollment",
        resourceId: after.id,
        beforeState: previous,
        afterState: after,
        metadata: {
          providerMode: mode,
          featureEnabled: body.featureEnabled,
          previousFeatureEnabled: previousFlag?.enabled ?? null,
        },
      });
      return after;
    });
    res.json({ ...(await programState(req.params.organizationId)), enrollment: state });
  }),
);

platformPaymentsRouter.post(
  "/facilitated-payments/accounts/:connectedAccountId/reconcile",
  route(async (req, res) => {
    await requirePlatformHuman(req);
    if (!facilitatedPaymentsEnabled()) {
      throw httpError(503, "Facilitated payments are not enabled");
    }
    const account = await query(
      `${accountSelect}
       where account.id = $1 and account.superseded_at is null`,
      [req.params.connectedAccountId],
    ).then((result) => result.rows[0]);
    if (!account?.providerAccountId) throw httpError(404, "Connected account not found");
    if (account.providerMode !== providerMode()) {
      throw httpError(409, "Connected account belongs to another provider mode");
    }
    const providerAccount = await callStripe(
      () => stripeClient().accounts.retrieve(account.providerAccountId),
      "Stripe could not reconcile the connected account",
    );
    const synchronized = await withTransaction((client) => synchronizeConnectedAccount(
      client,
      account,
      providerAccount,
      new Date().toISOString(),
      { req },
    ));
    res.json({ connectedAccount: synchronized.account, stale: synchronized.stale });
  }),
);

async function accountForProviderEvent(client, providerAccount, event) {
  const providerAccountId = clean(providerAccount?.id);
  if (!providerAccountId) throw new Error("Stripe account event is missing an account ID");
  if (event.account && event.account !== providerAccountId) {
    throw new Error("Stripe event account context does not match its Account object");
  }
  const result = await client.query(
    `${accountSelect}
     where account.provider = 'stripe'
       and account.provider_account_id = $1
       and account.superseded_at is null
     for update`,
    [providerAccountId],
  );
  const localAccount = result.rows[0] || null;
  const hedgelingAccountId = clean(
    providerAccount.metadata?.hedgeling_connected_account_id,
  );
  if (!localAccount) {
    if (!hedgelingAccountId) return null;
    throw new Error("Stripe account carries Hedgeling metadata but has no local mapping");
  }
  validateProviderAccount(
    localAccount,
    providerAccount,
    event.livemode === true ? "live" : "test",
  );
  return localAccount;
}

async function processProviderEvent(client, event) {
  if (event.type === "account.updated") {
    const localAccount = await accountForProviderEvent(client, event.data.object, event);
    if (!localAccount) return { status: "ignored", target: null };
    const eventTime = stripeTimestamp(event.created);
    if (!eventTime) throw new Error("Stripe account event is missing its provider timestamp");
    await synchronizeConnectedAccount(
      client,
      localAccount,
      event.data.object,
      eventTime,
      {
        providerEventId: event.id,
        lastWebhookAt: new Date().toISOString(),
      },
    );
    return {
      status: "processed",
      target: {
        type: "agency_connected_account",
        id: localAccount.id,
        accountContext: localAccount.providerAccountId,
      },
    };
  }
  if (event.type === "account.application.deauthorized") {
    const accountContext = clean(event.account);
    if (!accountContext) return { status: "ignored", target: null };
    const localAccount = await client.query(
      `${accountSelect}
       where account.provider = 'stripe'
         and account.provider_account_id = $1
         and account.superseded_at is null
       for update`,
      [accountContext],
    ).then((result) => result.rows[0] || null);
    if (!localAccount) return { status: "ignored", target: null };
    const eventMode = event.livemode === true ? "live" : "test";
    if (eventMode !== localAccount.providerMode) {
      throw new Error("Stripe deauthorization mode does not match the connected account");
    }
    const eventTime = stripeTimestamp(event.created);
    if (!eventTime) throw new Error("Stripe deauthorization event is missing its provider timestamp");
    await client.query(
      `update agency_connected_accounts
       set last_webhook_at = greatest(
         coalesce(last_webhook_at, '-infinity'::timestamptz),
         now()
       )
       where id = $1`,
      [localAccount.id],
    );
    if (
      localAccount.providerStateUpdatedAt
      && new Date(localAccount.providerStateUpdatedAt).getTime() > new Date(eventTime).getTime()
    ) {
      return {
        status: "processed",
        target: {
          type: "agency_connected_account",
          id: localAccount.id,
          accountContext,
        },
      };
    }
    await client.query(
      `update agency_connected_accounts
       set onboarding_state = 'disabled',
           disabled_reason = 'provider_application_deauthorized',
           provider_state_updated_at = $2,
           last_webhook_at = now(), updated_at = now()
       where id = $1`,
      [localAccount.id, eventTime],
    );
    await insertAuditEvent(client, {
      auth: { principalType: "platform" },
      organizationId: localAccount.agencyOrganizationId,
      action: "payout_account.deauthorized",
      resourceType: "agency_connected_account",
      resourceId: localAccount.id,
      beforeState: localAccount,
      metadata: { provider, providerEventId: event.id },
    });
    return {
      status: "processed",
      target: {
        type: "agency_connected_account",
        id: localAccount.id,
        accountContext,
      },
    };
  }
  const moneyOutcome = await processFacilitatedMoneyEvent(client, event);
  if (moneyOutcome) return moneyOutcome;
  return {
    status: "ignored",
    target: {
      type: null,
      id: null,
      accountContext: clean(event.account) || null,
    },
  };
}

export async function handleFacilitatedPaymentEvent(event) {
  if (!event?.id || !event?.type || !event?.data?.object) {
    throw new Error("Stripe Connect event payload is incomplete");
  }
  const payload = JSON.stringify(event);
  try {
    return await withTransaction(async (client) => {
      const inserted = await client.query(
        `insert into facilitated_payment_provider_events(
           provider, provider_event_id, connected_account_context, event_type,
           api_version, livemode, provider_created_at, status, attempts, payload
         ) values('stripe', $1, $2, $3, $4, $5, $6, 'processing', 1, $7)
         on conflict(provider, provider_event_id) do nothing
         returning id`,
        [
          event.id,
          clean(event.account) || null,
          event.type,
          event.api_version || null,
          event.livemode === true,
          stripeTimestamp(event.created),
          payload,
        ],
      );
      const eventRow = await client.query(
        `select id, status from facilitated_payment_provider_events
         where provider = 'stripe' and provider_event_id = $1
         for update`,
        [event.id],
      );
      if (!inserted.rows[0] && ["processed", "ignored"].includes(eventRow.rows[0]?.status)) {
        return { duplicate: true, status: eventRow.rows[0].status };
      }
      if (!inserted.rows[0]) {
        await client.query(
          `update facilitated_payment_provider_events
           set status = 'processing', attempts = attempts + 1, last_error = null
           where id = $1`,
          [eventRow.rows[0].id],
        );
      }
      const outcome = await processProviderEvent(client, event);
      await client.query(
        `update facilitated_payment_provider_events
         set connected_account_context = coalesce($2, connected_account_context),
             target_resource_type = $3, target_resource_id = $4,
             status = $5, processed_at = now(), last_error = null
         where provider = 'stripe' and provider_event_id = $1`,
        [
          event.id,
          outcome.target?.accountContext || null,
          outcome.target?.type || null,
          outcome.target?.id || null,
          outcome.status,
        ],
      );
      return { duplicate: false, status: outcome.status };
    });
  } catch (error) {
    try {
      await query(
        `insert into facilitated_payment_provider_events(
           provider, provider_event_id, connected_account_context, event_type,
           api_version, livemode, provider_created_at, status, attempts, payload,
           last_error
         ) values('stripe', $1, $2, $3, $4, $5, $6, 'failed', 1, $7, $8)
         on conflict(provider, provider_event_id) do update set
           status = 'failed',
           attempts = facilitated_payment_provider_events.attempts + 1,
           connected_account_context = excluded.connected_account_context,
           payload = excluded.payload,
           last_error = excluded.last_error`,
        [
          event.id,
          clean(event.account) || null,
          event.type,
          event.api_version || null,
          event.livemode === true,
          stripeTimestamp(event.created),
          payload,
          clean(error.message || error).slice(0, 2000),
        ],
      );
    } catch (recordingError) {
      console.error("[facilitated-payments] Failed to record provider-event failure", {
        providerEventId: event.id,
        processingError: clean(error.message || error).slice(0, 500),
        recordingError: clean(recordingError.message || recordingError).slice(0, 500),
      });
    }
    throw error;
  }
}

async function providerEventAuditOrganization(client, event) {
  if (!event.connected_account_context) return null;
  return client.query(
    `select agency_organization_id as id
     from agency_connected_accounts
     where provider = 'stripe' and provider_account_id = $1
       and superseded_at is null`,
    [event.connected_account_context],
  ).then((result) => result.rows[0]?.id || null);
}

export async function replayFacilitatedPaymentEvent(eventId, options = {}) {
  if (!/^evt_[A-Za-z0-9_]+$/.test(clean(eventId))) {
    throw httpError(400, "A valid Stripe event ID is required");
  }
  const reason = clean(options.reason || "Command-line provider-event replay");
  if (!reason || reason.length > 2000) {
    throw httpError(400, "A replay reason of at most 2000 characters is required");
  }
  const correlationId = clean(options.correlationId || randomUUID());
  if (!correlationId || correlationId.length > 200) {
    throw httpError(400, "Replay correlation ID is invalid");
  }
  const actorId = options.req?.auth?.user?.id || null;
  const claimed = await withTransaction(async (client) => {
    const event = await client.query(
      `select id, provider_event_id, connected_account_context,
              target_resource_type, target_resource_id, status, replay_status,
              replay_started_at, payload, last_error
       from facilitated_payment_provider_events
       where provider = 'stripe' and provider_event_id = $1
       for update`,
      [eventId],
    ).then((result) => result.rows[0] || null);
    if (!event || event.status !== "failed") {
      throw httpError(404, `No failed Stripe Connect event found for ${eventId}`);
    }
    if (
      event.replay_status === "processing"
      && event.replay_started_at
      && Date.now() - new Date(event.replay_started_at).getTime()
        < providerEventReplayLeaseMinutes() * 60 * 1000
    ) {
      throw httpError(
        409,
        `Stripe Connect event ${eventId} is already being replayed`,
        "provider_event_replay_in_progress",
      );
    }
    await client.query(
      `update facilitated_payment_provider_events
       set replay_status = 'processing', replay_started_at = now(),
           last_replayed_by_user_id = $2, last_replay_reason = $3,
           last_replay_correlation_id = $4
       where id = $1`,
      [event.id, actorId, reason, correlationId],
    );
    return event;
  });
  try {
    const outcome = await handleFacilitatedPaymentEvent(claimed.payload);
    await withTransaction(async (client) => {
      const organizationId = await providerEventAuditOrganization(client, claimed);
      await client.query(
        `update facilitated_payment_provider_events
         set replay_status = 'succeeded', last_replayed_at = now(),
             last_replayed_by_user_id = $2, last_replay_reason = $3,
             last_replay_correlation_id = $4
         where id = $1`,
        [claimed.id, actorId, reason, correlationId],
      );
      await insertAuditEvent(client, {
        auth: options.req?.auth || { principalType: "platform" },
        organizationId,
        action: "facilitated_provider_event.replayed",
        resourceType: "facilitated_payment_provider_event",
        resourceId: claimed.id,
        requestId: options.req?.get?.("x-request-id") || correlationId,
        ipAddress: options.req?.ip || null,
        beforeState: {
          status: claimed.status,
          replayStatus: claimed.replay_status,
          lastError: claimed.last_error,
        },
        afterState: { status: outcome.status, replayStatus: "succeeded" },
        metadata: { providerEventId: eventId, reason, correlationId },
      });
    });
    return { ...outcome, replayed: true, correlationId };
  } catch (error) {
    await withTransaction(async (client) => {
      const organizationId = await providerEventAuditOrganization(client, claimed);
      await client.query(
        `update facilitated_payment_provider_events
         set replay_status = 'failed', last_replayed_at = now(),
             last_replayed_by_user_id = $2, last_replay_reason = $3,
             last_replay_correlation_id = $4
         where id = $1`,
        [claimed.id, actorId, reason, correlationId],
      );
      await insertAuditEvent(client, {
        auth: options.req?.auth || { principalType: "platform" },
        organizationId,
        action: "facilitated_provider_event.replay_failed",
        resourceType: "facilitated_payment_provider_event",
        resourceId: claimed.id,
        requestId: options.req?.get?.("x-request-id") || correlationId,
        ipAddress: options.req?.ip || null,
        beforeState: { status: claimed.status, replayStatus: claimed.replay_status },
        afterState: { status: "failed", replayStatus: "failed" },
        metadata: {
          providerEventId: eventId,
          reason,
          correlationId,
          error: clean(error.message || error).slice(0, 500),
        },
      });
    }).catch((auditError) => {
      console.error("[facilitated-payments] Failed to record replay failure", {
        providerEventId: eventId,
        correlationId,
        error: clean(auditError.message || auditError).slice(0, 500),
      });
    });
    throw error;
  }
}

export async function facilitatedPaymentsWebhook(req, res) {
  if (!facilitatedPaymentsEnabled() && !stripeClientOverride) {
    return res.status(503).json({ error: "Facilitated payments are not enabled" });
  }
  if (!Buffer.isBuffer(req.body)) {
    return res.status(400).json({
      error: "Stripe Connect webhook requires an unmodified raw request body",
    });
  }
  const signature = req.get("stripe-signature");
  if (!signature) return res.status(400).json({ error: "Stripe signature is required" });
  const client = stripeClient();
  let event;
  try {
    event = client.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
    );
  } catch {
    return res.status(400).json({
      error: "Stripe Connect webhook signature verification failed",
    });
  }
  const result = await handleFacilitatedPaymentEvent(event);
  return res.json({ received: true, ...result });
}

platformPaymentsRouter.get(
  "/facilitated-payments/provider-events",
  route(async (req, res) => {
    const status = clean(req.query.status);
    if (status && !["processing", "processed", "ignored", "failed"].includes(status)) {
      throw httpError(400, "Provider event status is invalid");
    }
    const domain = clean(req.query.domain);
    if (
      domain
      && !["connected_account", "payment", "refund", "dispute", "payout", "other"].includes(domain)
    ) {
      throw httpError(400, "Provider event domain is invalid");
    }
    const providerModeFilter = clean(req.query.providerMode);
    if (providerModeFilter && !["test", "live"].includes(providerModeFilter)) {
      throw httpError(400, "Provider event mode is invalid");
    }
    const receivedFrom = clean(req.query.receivedFrom);
    const receivedTo = clean(req.query.receivedTo);
    for (const [name, value] of [["receivedFrom", receivedFrom], ["receivedTo", receivedTo]]) {
      if (value && !Number.isFinite(Date.parse(value))) {
        throw httpError(400, `${name} must be an ISO timestamp`);
      }
    }
    const eventType = clean(req.query.eventType);
    const resourceType = clean(req.query.resourceType);
    const resourceId = clean(req.query.resourceId);
    if (resourceId && !isUuid(resourceId)) throw httpError(400, "Provider event resource ID is invalid");
    const providerEventId = clean(req.query.eventId);
    if (providerEventId && !/^evt_[A-Za-z0-9_]+$/.test(providerEventId)) {
      throw httpError(400, "Provider event ID is invalid");
    }
    const eventDomain = `
      case
        when event_type like 'account.%' then 'connected_account'
        when event_type like 'checkout.session.%'
          or event_type like 'payment_intent.%' then 'payment'
        when event_type like 'refund.%'
          or event_type in ('charge.refunded', 'charge.refund.updated') then 'refund'
        when event_type like 'charge.dispute.%' then 'dispute'
        when event_type like 'payout.%' then 'payout'
        else 'other'
      end`;
    const result = await query(
      `select id, provider_event_id as "providerEventId",
              connected_account_context as "connectedAccountContext",
              event_type as "eventType", livemode,
              ${eventDomain} as domain,
              provider_created_at as "providerCreatedAt",
              target_resource_type as "targetResourceType",
              target_resource_id as "targetResourceId",
              status, attempts, last_error as "lastError",
              replay_status as "replayStatus",
              last_replayed_at as "lastReplayedAt",
              last_replayed_by_user_id as "lastReplayedByUserId",
              last_replay_reason as "lastReplayReason",
              last_replay_correlation_id as "lastReplayCorrelationId",
              received_at as "receivedAt", processed_at as "processedAt"
       from facilitated_payment_provider_events
       where ($1::text = '' or status = $1)
         and ($2::text = '' or (${eventDomain}) = $2)
         and ($3::text = '' or (case when livemode then 'live' else 'test' end) = $3)
         and ($4::text = '' or event_type = $4)
         and ($5::text = '' or target_resource_type = $5)
         and ($6::uuid is null or target_resource_id = $6)
         and ($7::text = '' or provider_event_id = $7)
         and ($8::timestamptz is null or received_at >= $8)
         and ($9::timestamptz is null or received_at <= $9)
       order by received_at desc limit 250`,
      [
        status,
        domain,
        providerModeFilter,
        eventType,
        resourceType,
        resourceId || null,
        providerEventId,
        receivedFrom || null,
        receivedTo || null,
      ],
    );
    res.json({
      events: result.rows,
      filters: {
        status,
        domain,
        providerMode: providerModeFilter,
        eventType,
        resourceType,
        resourceId: resourceId || null,
        eventId: providerEventId,
        receivedFrom: receivedFrom || null,
        receivedTo: receivedTo || null,
      },
    });
  }),
);

platformPaymentsRouter.post(
  "/facilitated-payments/provider-events/:providerEventId/replay",
  route(async (req, res) => {
    await requirePlatformHuman(req);
    const eventId = req.params.providerEventId;
    if (clean(req.body?.confirmEventId) !== eventId) {
      throw httpError(400, "Replay confirmation must name the exact provider event ID");
    }
    const reason = clean(req.body?.reason);
    if (!reason || reason.length > 2000) {
      throw httpError(400, "A replay reason of at most 2000 characters is required");
    }
    const correlationId = clean(req.get("x-correlation-id") || randomUUID());
    res.json(await replayFacilitatedPaymentEvent(eventId, {
      req,
      reason,
      correlationId,
    }));
  }),
);
