import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  if (process.env.HEDGELING_REQUIRE_TEST_DATABASE === "true") {
    throw new Error("TEST_DATABASE_URL is required and must point to a disposable PostgreSQL database");
  }
  console.log("Authorization integration test skipped: TEST_DATABASE_URL is not set.");
  process.exit(0);
}

const schemaName = `hedgeling_authz_${process.pid}_${Date.now()}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminPool = new pg.Pool({ connectionString });
const testUrl = new URL(connectionString);
// Match CI and keep fixed-duration trial assertions stable across DST changes.
testUrl.searchParams.set("options", `-csearch_path=${schemaName},public -ctimezone=UTC`);
process.env.NODE_ENV = "test";

await adminPool.query(`create schema ${schemaName}`);
process.env.DATABASE_URL = testUrl.toString();

const {
  pool,
  setDatabaseTestHooks,
  withTransaction,
} = await import("../src/db.js");
const { migrateDatabase } = await import("../src/migrations.js");
const { stageClosedBillingPeriod } = await import("../src/billing-meters.js");
const {
  requireAuthentication,
  setAuthenticationTestHooks,
} = await import("../src/auth.js");
const {
  isPlatformAdmin,
  listAccessibleProjects,
  organizationIdentityAllows,
  organizationPermissions,
  projectPermissions,
  requireOrganizationPermission,
  requireProjectPermission,
} = await import("../src/authorization.js");
const {
  effectiveOrganizationAccess,
  requireProjectEntitlement,
} = await import("../src/entitlements.js");
const {
  createStripeCheckoutSession,
  handleStripeEvent,
  replayFailedStripeEvent,
  setStripeTestClient,
} = await import("../src/stripe-billing.js");
const {
  handleFacilitatedPaymentEvent,
  organizationPaymentsRouter,
  platformPaymentsRouter,
  setFacilitatedPaymentsTestClient,
} = await import("../src/facilitated-payments.js");
const {
  organizationMoneyRouter,
  platformMoneyRouter,
} = await import("../src/facilitated-money.js");
const {
  USAGE_COUNTING_VERSION,
  backfillUsageRollups,
  compareUsageRollups,
  organizationBudgetStatus,
  organizationUsageSummary,
  recordUsageEvent,
  releaseUsageReservation,
  repairUsageRollups,
  reserveUsage,
} = await import("../src/usage.js");
const { default: accessAdminRouter } = await import("../src/access-admin.js");
const {
  identityAdminRouter,
  setEnterpriseIdentityTestHooks,
} = await import("../src/enterprise-identity.js");
const { governanceRouter } = await import("../src/governance.js");
const { scimAdminRouter } = await import("../src/scim.js");
const { default: serviceAccountsRouter } = await import("../src/service-accounts.js");
const { completeNpmProvisioningWork } = await import("../src/npm-seats.js");
const { default: selfServiceRouter } = await import("../src/self-service.js");
const {
  dataLifecycleRouter,
  platformDataLifecycleRouter,
  processDueDataLifecycleRequests,
} = await import("../src/data-lifecycle.js");
const {
  setTrialPackageDownloadTestHooks,
} = await import("../src/trial-package-downloads.js");
const { default: vendorAdminRouter } = await import("../src/vendor-admin.js");
const {
  adminRouter: workAdminRouter,
  personalRouter: personalWorkRouter,
} = await import("../src/work-admin.js");
const {
  evaluateVendorEligibility,
  evaluateVendorWorkAccess,
} = await import("../src/vendor-eligibility.js");
const {
  app: consoleApp,
  importHedgelingState,
  setGeminiTestClient,
} = await import("../src/server.js");

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function authorize(userId, project, permission, auth = null, options = {}, query = {}) {
  const req = {
    auth: auth || { principalType: "user", user: { id: userId, platformStaff: false } },
    query: { project, ...query },
    params: {},
    body: {},
  };
  const res = response();
  let allowed = false;
  let forwardedError = null;
  await requireProjectPermission(permission, options)(req, res, (error) => {
    forwardedError = error || null;
    allowed = !error;
  });
  if (forwardedError) throw forwardedError;
  return { allowed, status: res.statusCode, body: res.body, project: req.authorizedProject };
}

async function authenticateWithCognito(accessToken = "test-access-token") {
  const req = {
    method: "GET",
    path: "/api/me",
    get(name) {
      if (name.toLowerCase() === "authorization") return `Bearer ${accessToken}`;
      return "";
    },
    accepts() { return false; },
  };
  const res = response();
  return new Promise((resolve, reject) => {
    requireAuthentication(req, res, (error) => error ? reject(error) : resolve(req.auth));
  });
}

function useCognitoTestAuthentication(payload, hooks = {}) {
  setAuthenticationTestHooks({
    ...hooks,
    verify: async () => payload,
  });
}

async function authorizeOrganization(userId, organizationId, permission) {
  const req = {
    auth: { principalType: "user", user: { id: userId, platformStaff: false } },
    params: { organizationId },
    query: {},
  };
  const res = response();
  let allowed = false;
  await requireOrganizationPermission(permission)(req, res, (error) => {
    if (error) throw error;
    allowed = true;
  });
  return { allowed, status: res.statusCode, permissions: req.organizationPermissions };
}

async function scalar(text, params = []) {
  const result = await pool.query(text, params);
  return Object.values(result.rows[0])[0];
}

async function rejectsConstraint(queryPromise, constraint) {
  await assert.rejects(queryPromise, (error) => {
    assert.equal(error.code, "23514");
    assert.equal(error.constraint, constraint);
    return true;
  });
}

async function withAccessApi(userId, callback, auth = null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = auth || { principalType: "user", user: { id: userId, platformStaff: false } };
    next();
  });
  app.use("/api/access", accessAdminRouter);
  app.use("/api/access", identityAdminRouter);
  app.use("/api/access", scimAdminRouter);
  app.use("/api/access", serviceAccountsRouter);
  app.use("/api/access", governanceRouter);
  app.use("/api/access", vendorAdminRouter);
  app.use("/api/access", workAdminRouter);
  app.use("/api/access", organizationPaymentsRouter);
  app.use("/api/access", organizationMoneyRouter);
  app.use("/api/access", dataLifecycleRouter);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({
    error: error.message,
    code: error.code,
    details: error.details,
  }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}/api/access`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function withPlatformPaymentsApi(auth, callback) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = auth;
    next();
  });
  app.use("/api/platform", platformPaymentsRouter);
  app.use("/api/platform", platformMoneyRouter);
  app.use("/api/platform", platformDataLifecycleRouter);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({
    error: error.message,
    code: error.code,
    details: error.details,
  }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}/api/platform`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function withPersonalWorkApi(userId, callback) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { principalType: "user", user: { id: userId, platformStaff: false } };
    next();
  });
  app.use("/api/work", personalWorkRouter);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({
    error: error.message,
    code: error.code,
    details: error.details,
  }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}/api/work`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function withConsoleApi(callback) {
  const server = await new Promise((resolve) => {
    const listening = consoleApp.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function withSelfServiceApi(user, callback) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = {
      principalType: "user",
      principalId: user.id,
      user: { ...user, platformStaff: false },
    };
    next();
  });
  app.use("/api/onboarding", selfServiceRouter);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({
    error: error.message,
    code: error.code,
  }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}/api/onboarding`);
  } finally {
    await new Promise((resolve, reject) => server.close(
      (error) => error ? reject(error) : resolve(),
    ));
  }
}

try {
  const sql = await fs.readFile(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8");
  await pool.query(sql);
  const seededRoleCount = await scalar("select count(*)::int from roles");
  const seededPermissionCount = await scalar("select count(*)::int from permissions");
  const seededGrantCount = await scalar("select count(*)::int from role_permissions");
  const seededBillingAccountCount = await scalar("select count(*)::int from billing_accounts");
  const seededSubscriptionCount = await scalar("select count(*)::int from subscriptions");
  await pool.query(sql);
  assert.equal(await scalar("select count(*)::int from roles"), seededRoleCount);
  assert.equal(await scalar("select count(*)::int from permissions"), seededPermissionCount);
  assert.equal(await scalar("select count(*)::int from role_permissions"), seededGrantCount);
  assert.equal(await scalar("select count(*)::int from billing_accounts"), seededBillingAccountCount);
  assert.equal(await scalar("select count(*)::int from subscriptions"), seededSubscriptionCount);
  process.env.NODE_ENV = "production";
  await assert.rejects(
    migrateDatabase(),
    /Production schema baseline is missing/,
  );
  process.env.NODE_ENV = "test";
  const migrationBaseline = await migrateDatabase();
  assert.equal(migrationBaseline.baseline, "ordered-migrations-v1-baseline");
  assert.deepEqual(
    migrationBaseline.applied,
    [
      "202607251500_usage_rollup_pending_queue.sql",
      "202607301200_self_service_onboarding.sql",
      "202607301600_self_service_commercial_model.sql",
      "202607301700_trial_package_downloads.sql",
      "202607311200_billing_meter_late_adjustments.sql",
      "202608091200_customer_content_lifecycle.sql",
      "202609211200_review_workflow_provenance.sql",
      "202610051200_project_sync_status.sql",
      "202610161200_dynamic_review_triage.sql",
      "202610241200_agent_console.sql",
      "202610241300_workspace_management.sql",
      "202610241500_console_commercial_foundation.sql",
    ],
  );
  assert.equal(
    await scalar(
      `select count(*)::int
       from information_schema.tables
       where table_schema = current_schema()
         and table_name = 'billing_meter_period_adjustments'`,
    ),
    1,
  );
  await assert.rejects(
    pool.query(
      `update ai_credit_rate_cards
       set name = 'Mutated published rate'
       where key = 'managed-gemini' and version = 1`,
    ),
    (error) => (
      error.code === "23514"
      && error.constraint === "ai_credit_rate_card_immutable"
    ),
  );
  await assert.rejects(
    pool.query(
      `update ai_credit_rates
       set output_credits_per_million = output_credits_per_million + 1
       where provider = 'gemini' and model = 'gemini-3.5-flash-lite'`,
    ),
    (error) => (
      error.code === "23514"
      && error.constraint === "ai_credit_rate_immutable"
    ),
  );
  assert.equal(
    await scalar(
      `select count(*)::int
       from schema_migrations
       where key = 'ordered-migrations-v1-baseline'`,
    ),
    1,
  );
  const repeatedMigration = await migrateDatabase();
  assert.deepEqual(repeatedMigration.applied, []);
  assert.equal(
    await scalar(
      `select count(*)::int
       from schema_migrations
       where key = '2026-07-vendor-tenant-integrity'`,
    ),
    1,
  );
  assert.equal(
    await scalar(
      `select count(*)::int
       from schema_migrations
       where key = '2026-07-rate-card-tenant-integrity'`,
    ),
    1,
  );

  const customerA = await scalar(
    `insert into organizations(slug, name) values('customer-a', 'Customer A') returning id`,
  );
  const customerB = await scalar(
    `insert into organizations(slug, name) values('customer-b', 'Customer B') returning id`,
  );
  await pool.query(sql);
  assert.equal(
    await scalar(
      `select unit
       from usage_metric_definitions
       where key = 'ai_credits'`,
    ),
    "credit",
  );
  assert.equal(
    await scalar(
      `select entitlement.limits #>> '{usage,ai_credits,limit}'
       from plan_entitlements entitlement
       join product_plans plan on plan.id = entitlement.plan_id
       where plan.key = 'self-service-trial-v1'
         and entitlement.entitlement_key = 'ai_revision'`,
    ),
    "25000",
  );
  assert.equal(
    await scalar(
      `select count(*)::int
       from billing_accounts
       where organization_id in ($1, $2)`,
      [customerA, customerB],
    ),
    0,
  );
  assert.equal(
    await scalar(
      `select count(*)::int
       from schema_migrations
       where key = '2026-07-legacy-billing-backfill'`,
    ),
    1,
  );
  const legacyPlan = await scalar("select id from product_plans where key = 'legacy-v1'");
  const customerABillingAccount = await scalar(
    `insert into billing_accounts(organization_id, status)
     values($1, 'active') returning id`,
    [customerA],
  );
  const customerASubscription = await scalar(
    `insert into subscriptions(billing_account_id, plan_id, state, current_period_start)
     values($1, $2, 'active', now()) returning id`,
    [customerABillingAccount, legacyPlan],
  );
  await pool.query(
    `insert into billing_prices(
       key, plan_id, provider, provider_price_id, currency, billing_interval
     ) values
       ('legacy-monthly-test', $1, 'stripe', 'price_legacy_monthly', 'USD', 'month'),
       ('legacy-yearly-test', $1, 'stripe', 'price_legacy_yearly', 'USD', 'year')`,
    [legacyPlan],
  );
  await assert.rejects(
    pool.query(
      `update billing_prices
       set unit_amount_minor = 1
       where key = 'legacy-monthly-test'`,
    ),
    (error) => (
      error.code === "23514"
      && error.constraint === "billing_price_immutable"
    ),
  );
  const meterOrganization = await scalar(
    `insert into organizations(slug, name)
     values('meter-restaging', 'Meter Restaging') returning id`,
  );
  const meterAccount = await scalar(
    `insert into billing_accounts(
       organization_id, provider, provider_customer_id, status
     ) values($1, 'stripe', 'cus_meter_restaging', 'active') returning id`,
    [meterOrganization],
  );
  const meterPlan = await scalar(
    `insert into product_plans(key, name, status)
     values('meter-restaging-test', 'Meter Restaging Test', 'draft')
     returning id`,
  );
  const meterSubscription = await scalar(
    `insert into subscriptions(
       billing_account_id, plan_id, provider, provider_subscription_id,
       state, current_period_start
     ) values($1, $2, 'stripe', 'sub_meter_restaging', 'active', now())
     returning id`,
    [meterAccount, meterPlan],
  );
  await pool.query(
    `insert into billing_prices(
       key, plan_id, provider, provider_price_id, currency,
       billing_interval, unit_amount_minor, component, meter_event_name,
       included_quantity, billing_block_size
     ) values(
       'legacy-ai-meter-test', $1, 'stripe', 'price_legacy_ai_meter',
       'USD', 'month', 1000, 'ai_credit_overage', 'hedgeling_ai_credits',
       10, 10
     )`,
    [meterPlan],
  );
  const meterPeriodStart = "2026-06-01T00:00:00.000Z";
  const meterPeriodEnd = "2026-07-01T00:00:00.000Z";
  await pool.query(
    `insert into subscription_items(
       subscription_id, billing_price_key, provider,
       provider_subscription_item_id, component, current_period_start,
       current_period_end, status
     ) values(
       $1, 'legacy-ai-meter-test', 'stripe', 'si_meter_restaging',
       'ai_credit_overage', $2, $3, 'active'
     )`,
    [meterSubscription, meterPeriodStart, meterPeriodEnd],
  );
  await pool.query(
    `insert into usage_period_rollups(
       organization_id, scope_type, scope_id, metric_key,
       counting_version, period_type, period_start, period_end,
       quantity, event_count
     ) values($1, 'organization', $1, 'ai_credits', 'test-v1',
       'subscription', $2, $3, 25, 1)`,
    [meterOrganization, meterPeriodStart, meterPeriodEnd],
  );
  const meterStageInput = {
    organizationId: meterOrganization,
    billingAccountId: meterAccount,
    subscriptionId: meterSubscription,
    planId: meterPlan,
    periodStart: meterPeriodStart,
    periodEnd: meterPeriodEnd,
  };
  await withTransaction(
    (client) => stageClosedBillingPeriod(client, meterStageInput),
  );
  await pool.query(
    `update usage_period_rollups set quantity = 45, updated_at = now()
     where organization_id = $1 and metric_key = 'ai_credits'
       and period_type = 'subscription' and period_start = $2`,
    [meterOrganization, meterPeriodStart],
  );
  const restagedMeters = await withTransaction(
    (client) => stageClosedBillingPeriod(client, meterStageInput),
  );
  assert.deepEqual(restagedMeters, [{
    meterKey: "ai_credits",
    observedQuantity: "45",
    providerEventQuantity: "4",
    adjustmentProviderEventQuantity: "2",
  }]);
  assert.equal(
    await scalar(
      `select provider_event_quantity::text
       from billing_meter_period_summaries
       where subscription_id = $1 and billing_price_key = 'legacy-ai-meter-test'`,
      [meterSubscription],
    ),
    "4",
  );
  assert.deepEqual(
    await pool.query(
      `select source_type as "sourceType", quantity::text
       from billing_meter_outbox
       where organization_id = $1 order by created_at, source_type`,
      [meterOrganization],
    ).then((result) => result.rows),
    [
      { sourceType: "period_summary", quantity: "2" },
      { sourceType: "period_adjustment", quantity: "2" },
    ],
  );
  const buA = await scalar(
    `insert into business_units(organization_id, slug, name) values($1, 'default', 'Default') returning id`,
    [customerA],
  );
  const buB = await scalar(
    `insert into business_units(organization_id, slug, name) values($1, 'default', 'Default') returning id`,
    [customerB],
  );
  const projectA = await scalar(
    `insert into projects(business_unit_id, slug, name) values($1, 'project-a', 'Project A') returning id`,
    [buA],
  );
  const projectB = await scalar(
    `insert into projects(business_unit_id, slug, name) values($1, 'project-b', 'Project B') returning id`,
    [buB],
  );
  const projectA2 = await scalar(
    `insert into projects(business_unit_id, slug, name) values($1, 'project-a-2', 'Project A 2') returning id`,
    [buA],
  );

  const directUser = await scalar(
    `insert into users(email) values('direct@example.com') returning id`,
  );
  const teamUser = await scalar(
    `insert into users(email) values('team@example.com') returning id`,
  );
  const foreignUser = await scalar(
    `insert into users(email) values('foreign@example.com') returning id`,
  );
  const directMembership = await scalar(
    `insert into organization_memberships(organization_id, user_id, status) values($1, $2, 'active') returning id`,
    [customerA, directUser],
  );
  const teamMembership = await scalar(
    `insert into organization_memberships(organization_id, user_id, status) values($1, $2, 'active') returning id`,
    [customerA, teamUser],
  );
  await pool.query(
    `insert into organization_memberships(organization_id, user_id, status) values($1, $2, 'active')`,
    [customerB, foreignUser],
  );

  process.env.HEDGELING_AUTH_MODE = "cognito";
  process.env.COGNITO_USER_POOL_ID = "test-pool";
  process.env.COGNITO_APP_CLIENT_ID = "test-client";
  process.env.COGNITO_USERINFO_URL = "https://cognito.example.test/oauth2/userInfo";
  process.env.HEDGELING_COGNITO_SUPER_ADMIN_GROUP = "platform-admins";
  await pool.query(
    `insert into user_identities(
       user_id, provider, provider_subject, email_verified, last_authenticated_at
     ) values($1, 'cognito:test-pool', 'existing-subject', true, now())`,
    [directUser],
  );
  useCognitoTestAuthentication({
    sub: "existing-subject",
    "cognito:groups": ["platform-admins"],
  }, {
    userInfo: async () => {
      throw new Error("UserInfo must not be called for an existing identity");
    },
  });
  const identityTimestamp = await scalar(
    "select last_authenticated_at from user_identities where provider_subject = 'existing-subject'",
  );
  assert.equal((await authenticateWithCognito()).user.platformStaff, true);
  assert.equal(await scalar("select platform_staff from users where id = $1", [directUser]), true);
  useCognitoTestAuthentication({
    sub: "existing-subject",
    "cognito:groups": [],
  }, {
    userInfo: async () => {
      throw new Error("UserInfo must not be called for an existing identity");
    },
  });
  assert.equal((await authenticateWithCognito()).user.platformStaff, false);
  assert.equal(await scalar("select platform_staff from users where id = $1", [directUser]), false);
  assert.equal(
    new Date(await scalar("select last_authenticated_at from user_identities where provider_subject = 'existing-subject'")).getTime(),
    new Date(identityTimestamp).getTime(),
  );
  assert.equal(
    await scalar("select count(*)::int from audit_events where action = 'identity.platform_access_synced' and actor_id = $1", [directUser]),
    2,
  );

  useCognitoTestAuthentication({
    sub: "unverified-subject",
    "cognito:groups": [],
  }, {
    userInfo: async () => ({
      sub: "unverified-subject",
      email: "unverified@example.com",
      email_verified: false,
    }),
  });
  await assert.rejects(authenticateWithCognito(), (error) => error.status === 403);
  assert.equal(await scalar("select count(*)::int from users where lower(email) = 'unverified@example.com'"), 0);

  useCognitoTestAuthentication({
    sub: "new-subject",
    "cognito:groups": [],
  }, {
    userInfo: async () => ({
      sub: "new-subject",
      email: "new-user@example.com",
      email_verified: true,
      name: "New User",
    }),
  });
  const newAuth = await authenticateWithCognito();
  assert.equal(newAuth.user.email, "new-user@example.com");
  assert.equal(
    await scalar("select count(*)::int from user_identities where provider_subject = 'new-subject'"),
    1,
  );

  useCognitoTestAuthentication({
    sub: "password-login-subject",
    scope: "aws.cognito.signin.user.admin",
    "cognito:groups": [],
  }, {
    getUser: async () => ({
      Username: "password-user@example.com",
      UserAttributes: [
        { Name: "sub", Value: "password-login-subject" },
        { Name: "email", Value: "password-user@example.com" },
        { Name: "email_verified", Value: "true" },
        { Name: "name", Value: "Password User" },
      ],
    }),
  });
  const passwordAuth = await authenticateWithCognito();
  assert.equal(passwordAuth.user.email, "password-user@example.com");
  assert.equal(
    await scalar("select count(*)::int from user_identities where provider_subject = 'password-login-subject'"),
    1,
  );

  await pool.query("update users set status = 'suspended' where id = $1", [newAuth.user.id]);
  useCognitoTestAuthentication({
    sub: "new-subject",
    "cognito:groups": [],
  }, {
    userInfo: async () => {
      throw new Error("UserInfo must not be called for an existing identity");
    },
  });
  await assert.rejects(authenticateWithCognito(), (error) => error.status === 403);
  setAuthenticationTestHooks({});

  const viewerRole = await scalar(
    `select id from roles where organization_id is null and key = 'viewer'`,
  );
  const developerRole = await scalar(
    `select id from roles where organization_id is null and key = 'developer'`,
  );
  const organizationAdminRole = await scalar(
    `select id from roles where organization_id is null and key = 'organization_admin'`,
  );
  const translatorRole = await scalar(
    `select id from roles where organization_id is null and key = 'translator'`,
  );
  const billingAdminRole = await scalar(
    `select id from roles where organization_id is null and key = 'billing_admin'`,
  );
  const agencyLinguistRole = await scalar(
    `select id from roles where organization_id is null and key = 'agency_linguist'`,
  );

  assert.equal(
    (await effectiveOrganizationAccess(customerA, "ai_revision")).allowed,
    true,
  );
  await pool.query(
    `update subscriptions set state = 'past_due', grace_ends_at = now() + interval '1 day'
     where id = $1`,
    [customerASubscription],
  );
  assert.equal(
    (await effectiveOrganizationAccess(customerA, "ai_revision")).allowed,
    true,
  );
  await pool.query(
    `update subscriptions set grace_ends_at = now() - interval '1 minute' where id = $1`,
    [customerASubscription],
  );
  assert.equal(
    (await effectiveOrganizationAccess(customerA, "ai_revision")).reason,
    "subscription_past_due",
  );
  await pool.query(
    "update subscriptions set state = 'paused', grace_ends_at = null where id = $1",
    [customerASubscription],
  );
  assert.equal(
    (await effectiveOrganizationAccess(customerA, "verified_exports")).allowed,
    true,
  );
  assert.equal(
    (await effectiveOrganizationAccess(customerA, "ai_revision")).allowed,
    false,
  );
  await pool.query(
    "update subscriptions set state = 'canceled' where id = $1",
    [customerASubscription],
  );
  assert.equal(
    (await effectiveOrganizationAccess(customerA, "ai_revision")).reason,
    "subscription_canceled",
  );
  await pool.query(
    "update subscriptions set state = 'unpaid' where id = $1",
    [customerASubscription],
  );
  const complimentaryOverride = await scalar(
    `insert into organization_entitlement_overrides(
       organization_id, entitlement_key, enabled, reason
     ) values($1, 'ai_revision', true, 'Contractual complimentary access')
     returning id`,
    [customerA],
  );
  assert.equal(
    (await effectiveOrganizationAccess(customerA, "ai_revision")).entitlementSource,
    "organization_override",
  );
  assert.equal(
    (await effectiveOrganizationAccess(customerA, "ai_revision")).allowed,
    true,
  );
  await pool.query(
    "update organization_entitlement_overrides set superseded_at = now() where id = $1",
    [complimentaryOverride],
  );
  const disabledFeature = await scalar(
    `insert into organization_feature_flag_overrides(
       organization_id, feature_key, enabled, reason
     ) values($1, 'ai_revision', false, 'Controlled rollout')
     returning id`,
    [customerA],
  );
  await pool.query(
    "update subscriptions set state = 'active' where id = $1",
    [customerASubscription],
  );
  assert.equal(
    (await effectiveOrganizationAccess(customerA, "ai_revision")).reason,
    "feature_disabled",
  );
  await pool.query(
    "update organization_feature_flag_overrides set superseded_at = now() where id = $1",
    [disabledFeature],
  );
  assert.equal(
    (await effectiveOrganizationAccess(customerB, "ai_revision")).reason,
    "subscription_missing",
  );

  const migrationUser = await scalar(
    `insert into users(email) values('migration-grants@example.com') returning id`,
  );
  await pool.query("drop index idx_role_assignments_active_unique");
  await pool.query(
    `insert into role_assignments(
       principal_type, principal_id, role_id, scope_type, scope_id, inherit_to_children, conditions
     ) values
       ('user', $1, $2, 'project', $3, false, '{"locales":["fr-CA"]}'),
       ('user', $1, $2, 'project', $3, false, '{"locales":["de-DE"]}'),
       ('user', $1, $2, 'project', $3, true,  '{"locales":["fr-CA"]}'),
       ('user', $1, $2, 'project', $3, false, '{"locales":["fr-CA"]}'),
       ('user', $1, $2, 'project', $3, false, '{"locales":["fr-CA","de-DE"]}'),
       ('user', $1, $2, 'project', $3, false, '{"locales":["de-DE","fr-CA"]}')`,
    [migrationUser, translatorRole, projectA],
  );
  await pool.query(sql);
  assert.equal(
    await scalar(
      "select count(*)::int from role_assignments where principal_id = $1 and revoked_at is null",
      [migrationUser],
    ),
    4,
  );
  assert.equal(
    await scalar(
      "select count(*)::int from role_assignments where principal_id = $1 and revoked_at is not null",
      [migrationUser],
    ),
    2,
  );
  assert.equal(
    await scalar(
      `select count(*)::int from audit_events
       where action = 'migration.role_assignment_duplicate_revoked'
         and organization_id = $1 and resource_id in (
           select id from role_assignments where principal_id = $2
         )`,
      [customerA, migrationUser],
    ),
    2,
  );
  await pool.query(sql);
  assert.equal(
    await scalar(
      `select count(*)::int from audit_events
       where action = 'migration.role_assignment_duplicate_revoked'
         and resource_id in (
           select id from role_assignments where principal_id = $1
         )`,
      [migrationUser],
    ),
    2,
  );

  await pool.query(
    `insert into role_assignments(principal_type, principal_id, role_id, scope_type, scope_id)
     values('user', $1, $2, 'project', $3)`,
    [directUser, viewerRole, projectA],
  );

  assert.equal((await authorize(directUser, "project-a", "strings.view")).allowed, true);
  assert.equal((await authorize(directUser, "project-a", "translations.edit")).status, 403);
  assert.equal((await authorize(directUser, "project-b", "strings.view")).status, 403);
  assert.equal((await authorize(foreignUser, "project-a", "strings.view")).status, 403);

  await pool.query(
    `insert into role_assignments(
       principal_type, principal_id, role_id, scope_type, scope_id, inherit_to_children
     ) values('user', $1, $2, 'organization', $3, true)`,
    [directUser, organizationAdminRole, customerA],
  );
  assert.equal((await authorizeOrganization(directUser, customerA, "members.manage")).allowed, true);
  assert.equal((await authorizeOrganization(directUser, customerB, "members.manage")).status, 403);
  assert.ok((await organizationPermissions(
    { user: { id: directUser, platformStaff: false } },
    customerA,
  )).includes("roles.assign"));

  await pool.query(
    `insert into role_assignments(
       principal_type, principal_id, role_id, scope_type, scope_id
     ) values('user', $1, $2, 'organization', $3)`,
    [teamUser, billingAdminRole, customerA],
  );
  const usageSource = await scalar(
    `insert into source_strings(project_id, source_hash, source_text)
     values($1, 'usage-source', 'Three source words') returning id`,
    [projectA],
  );
  const usageEventInput = {
    organizationId: customerA,
    businessUnitId: buA,
    projectId: projectA,
    actor: {
      actorType: "user",
      actorUserId: teamUser,
      actorServiceAccountId: null,
    },
    operation: "state_import",
    idempotencyKey: "state_import:integration-usage",
    idempotencyFingerprint: "a".repeat(64),
    measurements: {
      source_words_processed: 3,
      source_characters_processed: 18,
    },
    items: [{
      sourceStringId: usageSource,
      sourceWords: 3,
      sourceCharacters: 18,
    }],
  };
  assert.deepEqual(await recordUsageEvent(usageEventInput).then(({ duplicate }) => ({ duplicate })), {
    duplicate: false,
  });
  assert.deepEqual(await recordUsageEvent(usageEventInput).then(({ duplicate }) => ({ duplicate })), {
    duplicate: true,
  });
  const legacyReplay = await reserveUsage({
    organizationId: customerA,
    businessUnitId: buA,
    projectId: projectA,
    operation: usageEventInput.operation,
    idempotencyKey: usageEventInput.idempotencyKey,
    idempotencyFingerprint: usageEventInput.idempotencyFingerprint,
    measurements: usageEventInput.measurements,
    relevantMetrics: Object.keys(usageEventInput.measurements),
  });
  assert.equal(legacyReplay.duplicate, true);
  assert.equal(legacyReplay.replay.outcome, "succeeded");
  assert.equal(legacyReplay.replay.responseBody, null);
  await assert.rejects(
    recordUsageEvent({
      ...usageEventInput,
      idempotencyFingerprint: "b".repeat(64),
    }),
    (error) => error.status === 409,
  );
  await assert.rejects(
    recordUsageEvent({
      ...usageEventInput,
      organizationId: customerB,
      actor: { actorType: "platform" },
      idempotencyKey: "state_import:cross-tenant",
      idempotencyFingerprint: "d".repeat(64),
    }),
    (error) => error.code === "23503",
  );
  await recordUsageEvent({
    ...usageEventInput,
    operation: "ai_translation_revision",
    idempotencyKey: "ai_translation_revision:integration-usage",
    idempotencyFingerprint: "c".repeat(64),
    provider: "gemini",
    model: "gemini-test",
    measurements: {
      source_words_processed: 3,
      source_characters_processed: 18,
      ai_output_words: 4,
      ai_output_characters: 24,
      llm_input_tokens: 20,
      llm_output_tokens: 8,
      llm_total_tokens: 28,
    },
    items: [{
      sourceStringId: usageSource,
      targetLocale: "fr-CA",
      sourceWords: 3,
      sourceCharacters: 18,
      outputWords: 4,
      outputCharacters: 24,
    }],
  });
  assert.equal(
    await scalar(
      "select count(*)::int from usage_events where organization_id = $1",
      [customerA],
    ),
    2,
  );
  const rollupEvent = await recordUsageEvent({
    organizationId: customerB,
    businessUnitId: buB,
    projectId: projectB,
    actor: { actorType: "platform" },
    operation: "readiness_rollup_test",
    idempotencyKey: "readiness-rollup-live",
    idempotencyFingerprint: "7".repeat(64),
    measurements: { source_words_processed: 5 },
  });
  assert.equal(
    await scalar(
      `select count(*)::int
       from usage_rollup_pending_events
       where usage_event_id = $1`,
      [rollupEvent.id],
    ),
    0,
  );
  assert.equal(
    await scalar(
      `select count(*)::int from usage_period_rollups
       where organization_id = $1 and metric_key = 'source_words_processed'`,
      [customerB],
    ),
    6,
  );
  assert.equal(
    await scalar(
      `select period.period_source
       from usage_event_billing_periods period
       where period.usage_event_id = $1`,
      [rollupEvent.id],
    ),
    "calendar_fallback",
  );
  await assert.rejects(
    pool.query(
      `update usage_event_billing_periods
       set period_end = period_end + interval '1 day'
       where usage_event_id = $1`,
      [rollupEvent.id],
    ),
    (error) => error.code === "23514",
  );
  assert.equal((await compareUsageRollups({ organizationId: customerB })).exact, true);
  await pool.query(
    `update usage_rollup_queue_state
     set legacy_seed_complete = false, updated_at = now()
     where singleton = true`,
  );
  const legacyUsageEvent = await scalar(
    `insert into usage_events(
       organization_id, business_unit_id, project_id, actor_type, operation,
       idempotency_key, idempotency_fingerprint, counting_version
     ) values($1, $2, $3, 'platform', 'readiness_rollup_legacy',
              'readiness-rollup-legacy', $4, $5)
     returning id`,
    [customerB, buB, projectB, "8".repeat(64), USAGE_COUNTING_VERSION],
  );
  await pool.query(
    `insert into usage_event_measurements(usage_event_id, metric_key, quantity)
     values($1, 'source_words_processed', 2)`,
    [legacyUsageEvent],
  );
  assert.equal(
    await scalar(
      `select count(*)::int
       from usage_rollup_pending_events
       where usage_event_id = $1`,
      [legacyUsageEvent],
    ),
    1,
  );
  await assert.rejects(
    pool.query(
      `insert into usage_rollup_applied_events(usage_event_id) values($1)`,
      [legacyUsageEvent],
    ),
    (error) => error.code === "23514",
  );
  await assert.rejects(
    reserveUsage({
      organizationId: customerB,
      businessUnitId: buB,
      projectId: projectB,
      operation: "readiness_rollup_legacy_limit",
      idempotencyKey: "readiness-rollup-legacy-limit",
      idempotencyFingerprint: "9".repeat(64),
      measurements: { source_words_processed: 1 },
      relevantMetrics: ["source_words_processed"],
      planLimits: { usage: { source_words_processed: 7 } },
    }),
    (error) => error.code === "usage_limit_exceeded",
  );
  const beforeBackfill = await compareUsageRollups({ organizationId: customerB });
  assert.equal(beforeBackfill.exact, false);
  assert.equal(beforeBackfill.unappliedEvents, 1);
  const backfill = await backfillUsageRollups({ batchSize: 1, maxBatches: 10 });
  assert.equal(backfill.complete, true);
  assert.equal(backfill.appliedEvents, 1);
  assert.equal(backfill.queueSeedComplete, true);
  assert.equal(
    await scalar(
      `select count(*)::int
       from usage_rollup_pending_events
       where usage_event_id = $1`,
      [legacyUsageEvent],
    ),
    0,
  );
  assert.equal(
    await scalar(
      `select count(*)::int from usage_event_billing_periods
       where usage_event_id = $1`,
      [legacyUsageEvent],
    ),
    1,
  );
  assert.equal((await compareUsageRollups({ organizationId: customerB })).exact, true);
  await pool.query(
    `update usage_period_rollups set quantity = quantity + 1
     where organization_id = $1 and scope_type = 'organization'
       and metric_key = 'source_words_processed'
       and period_type = 'subscription'`,
    [customerB],
  );
  assert.equal((await compareUsageRollups({ organizationId: customerB })).exact, false);
  const repair = await repairUsageRollups({ organizationId: customerB });
  assert.equal(repair.organizationId, customerB);
  assert.equal((await compareUsageRollups({ organizationId: customerB })).exact, true);
  assert.equal(
    await scalar(
      `select sum(quantity)::int from usage_period_rollups
       where organization_id = $1 and scope_type = 'organization'
         and metric_key = 'source_words_processed'
         and period_type = 'subscription'`,
      [customerB],
    ),
    7,
  );
  assert.ok(rollupEvent.id);

  await withAccessApi(directUser, async (baseUrl) => {
    const headers = { "content-type": "application/json" };
    let organizationListQueries = 0;
    setDatabaseTestHooks({ onQuery: () => { organizationListQueries += 1; } });
    const organizationsResponse = await fetch(`${baseUrl}/organizations`)
      .finally(() => setDatabaseTestHooks({}));
    assert.equal(organizationsResponse.status, 200);
    // Organization lifecycle filtering is one set-based query regardless of
    // how many visible organizations are returned.
    assert.equal(organizationListQueries, 3);
    const organizationsBody = await organizationsResponse.json();
    assert.ok(organizationsBody.organizations.some((organization) => organization.id === customerA));
    assert.ok(!organizationsBody.organizations.some((organization) => organization.id === customerB));

    const invalidOrganization = await fetch(`${baseUrl}/organizations/not-a-uuid`);
    assert.equal(invalidOrganization.status, 400);

    const unauthorizedBilling = await fetch(
      `${baseUrl}/organizations/${customerA}/billing-access`,
    );
    assert.equal(unauthorizedBilling.status, 403);
    const unauthorizedUsage = await fetch(
      `${baseUrl}/organizations/${customerA}/usage`,
    );
    assert.equal(unauthorizedUsage.status, 403);
    const unauthorizedBudgets = await fetch(
      `${baseUrl}/organizations/${customerA}/budgets`,
    );
    assert.equal(unauthorizedBudgets.status, 403);
    const unauthorizedCheckout = await fetch(
      `${baseUrl}/organizations/${customerA}/billing/checkout`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ priceKey: "legacy-monthly-test" }),
      },
    );
    assert.equal(unauthorizedCheckout.status, 403);

    const invalidExpiry = await fetch(`${baseUrl}/organizations/${customerA}/members/${directMembership}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ membershipType: "internal", status: "active", expiresAt: "not-a-date" }),
    });
    assert.equal(invalidExpiry.status, 400);

    const pastExpiry = await fetch(`${baseUrl}/organizations/${customerA}/members/${directMembership}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        membershipType: "internal",
        status: "active",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    });
    assert.equal(pastExpiry.status, 400);

    const createBusinessUnit = await fetch(`${baseUrl}/organizations/${customerA}/business-units`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Legal" }),
    });
    assert.equal(createBusinessUnit.status, 201);
    assert.equal((await createBusinessUnit.json()).businessUnit.slug, "legal");

    const inviteResponse = await fetch(`${baseUrl}/organizations/${customerA}/invitations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "invitee@example.com", membershipType: "external" }),
    });
    assert.equal(inviteResponse.status, 201);
    const inviteBody = await inviteResponse.json();
    // This immediate read intentionally uses the pool after the HTTP response:
    // a 2xx mutation response must not arrive before its transaction commits.
    const inviteeUser = await scalar("select id from users where lower(email) = 'invitee@example.com'");
    await withAccessApi(inviteeUser, async (inviteeBaseUrl) => {
      const acceptResponse = await fetch(`${inviteeBaseUrl}/invitations/accept`, {
        method: "POST",
        headers,
        body: JSON.stringify({ token: inviteBody.onboardingToken }),
      });
      assert.equal(acceptResponse.status, 200);
    });
    assert.equal(
      await scalar("select status from organization_memberships where organization_id = $1 and user_id = $2", [customerA, inviteeUser]),
      "active",
    );
    assert.equal(await scalar("select status from users where id = $1", [inviteeUser]), "active");

    const crossTenantAssignment = await fetch(`${baseUrl}/organizations/${customerA}/role-assignments`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        principalType: "user",
        principalId: foreignUser,
        roleId: viewerRole,
        scopeType: "organization",
        scopeId: customerA,
      }),
    });
    assert.equal(crossTenantAssignment.status, 400);

    const duplicateAssignment = await fetch(`${baseUrl}/organizations/${customerA}/role-assignments`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        principalType: "user",
        principalId: directUser,
        roleId: organizationAdminRole,
        scopeType: "organization",
        scopeId: customerA,
        inheritToChildren: true,
      }),
    });
    assert.equal(duplicateAssignment.status, 409);

    const frenchAssignment = await fetch(`${baseUrl}/organizations/${customerA}/role-assignments`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        principalType: "user",
        principalId: directUser,
        roleId: translatorRole,
        scopeType: "project",
        scopeId: projectA,
        conditions: { locales: ["fr-CA"] },
      }),
    });
    assert.equal(frenchAssignment.status, 201);
    const germanAssignment = await fetch(`${baseUrl}/organizations/${customerA}/role-assignments`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        principalType: "user",
        principalId: directUser,
        roleId: translatorRole,
        scopeType: "project",
        scopeId: projectA,
        conditions: { locales: ["de-DE"] },
      }),
    });
    assert.equal(germanAssignment.status, 201);
    const duplicateFrenchAssignment = await fetch(`${baseUrl}/organizations/${customerA}/role-assignments`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        principalType: "user",
        principalId: directUser,
        roleId: translatorRole,
        scopeType: "project",
        scopeId: projectA,
        conditions: { locales: ["fr-CA"] },
      }),
    });
    assert.equal(duplicateFrenchAssignment.status, 409);

    const auditResponse = await fetch(`${baseUrl}/organizations/${customerA}/audit`);
    assert.equal(auditResponse.status, 200);
    const auditBody = await auditResponse.json();
    assert.ok(auditBody.events.some((event) => event.action === "business_unit.created"));
  });

  let agencyId;
  let vendorRelationshipId;
  let agencyOwnerUser;
  let agencyOwnerToken;
  await withAccessApi(directUser, async (baseUrl) => {
    const headers = { "content-type": "application/json" };
    const createResponse = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          agencyName: "Polyglot Partners",
          agencySlug: "polyglot-partners",
          ownerEmail: "owner@polyglot.example",
        }),
      },
    );
    const createBody = await createResponse.json();
    assert.equal(createResponse.status, 201, JSON.stringify(createBody));
    assert.equal(createBody.vendorRelationship.status, "invited");
    assert.equal(createBody.vendorRelationship.paymentTermsDays, 30);
    assert.equal(createBody.vendorRelationship.requiresLinguistApproval, true);
    assert.equal(createBody.vendorRelationship.agencyMayAssignLinguists, false);
    assert.equal(createBody.vendorRelationship.maximumSubcontractingDepth, 0);
    agencyId = createBody.vendorRelationship.agencyOrganizationId;
    vendorRelationshipId = createBody.vendorRelationship.id;
    agencyOwnerToken = createBody.onboardingToken;

    // Like member invitations, relationship creation must be committed before
    // the 201 response makes the new tenant visible on another pool connection.
    agencyOwnerUser = await scalar(
      "select id from users where lower(email) = 'owner@polyglot.example'",
    );
    assert.equal(
      await scalar("select organization_type from organizations where id = $1", [agencyId]),
      "agency",
    );

    const prematureActivation = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/transitions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ status: "active" }),
      },
    );
    assert.equal(prematureActivation.status, 409);

    const foreignScope = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/scopes`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          scopes: [{ scopeType: "business_unit", scopeId: buB }],
        }),
      },
    );
    assert.equal(foreignScope.status, 400);
  });

  await withAccessApi(agencyOwnerUser, async (baseUrl) => {
    const acceptInvitation = await fetch(`${baseUrl}/invitations/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: agencyOwnerToken }),
    });
    assert.equal(acceptInvitation.status, 200);

    const relationshipList = await fetch(
      `${baseUrl}/organizations/${agencyId}/vendor-relationships`,
    );
    assert.equal(relationshipList.status, 200);
    assert.equal((await relationshipList.json()).vendorRelationships.length, 1);

    const acceptRelationship = await fetch(
      `${baseUrl}/organizations/${agencyId}/vendor-relationships/${vendorRelationshipId}/transitions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "onboarding" }),
      },
    );
    assert.equal(acceptRelationship.status, 200);

    const agencyCannotChangeCustomerSettings = await fetch(
      `${baseUrl}/organizations/${agencyId}/vendor-relationships/${vendorRelationshipId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentTermsDays: 45 }),
      },
    );
    assert.equal(agencyCannotChangeCustomerSettings.status, 403);
  });

  process.env.HEDGELING_FACILITATED_PAYMENTS_ENABLED = "true";
  process.env.HEDGELING_FACILITATED_PAYMENTS_MODE = "test";
  process.env.STRIPE_CONNECT_SECRET_KEY = "sk_test_phase7b";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_phase7b";
  process.env.STRIPE_CONNECT_ONBOARDING_RETURN_URL = "http://localhost:4173/";
  process.env.STRIPE_CONNECT_ONBOARDING_REFRESH_URL = "http://localhost:4173/";
  const connectCalls = {
    accountCreate: null,
    accountCreateOptions: null,
    accountLinks: [],
    dashboardAccounts: [],
  };
  let providerAccount = null;
  let beforeProviderAccountRetrieve = null;
  setFacilitatedPaymentsTestClient({
    accounts: {
      async create(params, options) {
        connectCalls.accountCreate = params;
        connectCalls.accountCreateOptions = options;
        providerAccount = {
          id: "acct_Phase7B01",
          metadata: params.metadata,
          capabilities: { transfers: "pending" },
          payouts_enabled: false,
          details_submitted: false,
          requirements: {
            currently_due: ["business_profile.url"],
            eventually_due: ["external_account"],
            past_due: [],
            pending_verification: [],
            disabled_reason: null,
            current_deadline: null,
          },
          future_requirements: {
            currently_due: [],
            eventually_due: ["company.tax_id"],
            past_due: [],
          },
        };
        return providerAccount;
      },
      async retrieve(accountId) {
        assert.equal(accountId, providerAccount.id);
        if (beforeProviderAccountRetrieve) await beforeProviderAccountRetrieve();
        return providerAccount;
      },
      async createLoginLink(accountId) {
        connectCalls.dashboardAccounts.push(accountId);
        return {
          url: "https://connect.stripe.test/express/dashboard",
          created: 1_800_000_020,
        };
      },
    },
    accountLinks: {
      async create(params, options) {
        connectCalls.accountLinks.push({ params, options });
        return {
          url: "https://connect.stripe.test/onboarding/session",
          created: 1_800_000_000,
          expires_at: 1_800_003_600,
        };
      },
    },
  });
  const platformHuman = {
    principalType: "user",
    platformAdmin: true,
    user: { id: directUser, platformStaff: true },
  };
  const programPayload = {
    status: "approved",
    perPaymentCapMinor: "1000000",
    rollingCapMinor: "2500000",
    rollingPeriodDays: 30,
    termsVersion: "connect-us-v1",
    policyVersion: "payments-us-v1",
    acceptanceReference: "contract-phase-7b",
    featureEnabled: true,
    reason: "Approved for the Phase 7B readiness pilot",
  };
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const bodyless = await fetch(
      `${baseUrl}/facilitated-payments/organizations/${customerA}/program`,
      { method: "PUT" },
    );
    const bodylessBody = await bodyless.json();
    assert.equal(bodyless.status, 400, JSON.stringify(bodylessBody));
    assert.match(bodylessBody.error, /Enrollment status is invalid/);

    for (const organizationId of [customerA, agencyId]) {
      const response = await fetch(
        `${baseUrl}/facilitated-payments/organizations/${organizationId}/program`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(programPayload),
        },
      );
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.enrollment.status, "approved");
      assert.equal(body.feature.enabled, true);
      assert.equal(body.configuration.collectionEnabled, false);
      assert.equal(body.configuration.transfersEnabled, false);
      assert.deepEqual(
        body.enrollment.paymentMethods,
        organizationId === customerA ? ["card", "us_bank_account"] : [],
      );
    }
    assert.equal(
      await scalar(
        `select count(*)::int from facilitated_payment_program_enrollments
         where organization_id = $1 and superseded_at is null`,
        [agencyId],
      ),
      1,
    );
  });
  await withPlatformPaymentsApi(
    { principalType: "user", user: { id: agencyOwnerUser, platformStaff: false } },
    async (baseUrl) => {
      const denied = await fetch(
        `${baseUrl}/facilitated-payments/organizations/${agencyId}/program`,
      );
      assert.equal(denied.status, 403);
    },
  );
  let connectedAccountId;
  await withAccessApi(agencyOwnerUser, async (baseUrl) => {
    const onboarding = await fetch(
      `${baseUrl}/organizations/${agencyId}/payout-account/onboarding`,
      { method: "POST" },
    );
    const onboardingBody = await onboarding.json();
    assert.equal(onboarding.status, 201, JSON.stringify(onboardingBody));
    assert.equal(
      onboardingBody.onboarding.url,
      "https://connect.stripe.test/onboarding/session",
    );
    connectedAccountId = onboardingBody.connectedAccount.id;
    assert.equal(onboardingBody.connectedAccount.onboardingState, "pending");
    assert.deepEqual(connectCalls.accountCreate.controller, {
      fees: { payer: "application" },
      losses: { payments: "application" },
      stripe_dashboard: { type: "express" },
    });
    assert.deepEqual(connectCalls.accountCreate.capabilities, {
      transfers: { requested: true },
    });
    assert.equal(
      connectCalls.accountCreateOptions.idempotencyKey,
      `hedgeling-connect-account-${connectedAccountId}`,
    );
    assert.equal(connectCalls.accountLinks.length, 1);
    assert.deepEqual(connectCalls.accountLinks[0].params.collection_options, {
      fields: "eventually_due",
      future_requirements: "include",
    });
    const returnUrl = new URL(connectCalls.accountLinks[0].params.return_url);
    assert.equal(returnUrl.searchParams.get("connect"), "return");
    assert.equal(returnUrl.searchParams.get("organizationId"), agencyId);
    assert.equal(
      connectCalls.accountLinks[0].options.idempotencyKey.startsWith(
        "hedgeling-connect-onboarding-",
      ),
      true,
    );

    const statusResponse = await fetch(
      `${baseUrl}/organizations/${agencyId}/payout-account`,
    );
    const statusBody = await statusResponse.json();
    assert.equal(statusResponse.status, 200, JSON.stringify(statusBody));
    assert.equal(statusBody.canManage, true);
    assert.equal(statusBody.ready, false);
    assert.deepEqual(statusBody.connectedAccount.requirementsDue, ["business_profile.url"]);

    providerAccount = {
      ...providerAccount,
      capabilities: { transfers: "active" },
      payouts_enabled: true,
      details_submitted: true,
      requirements: {
        currently_due: [],
        eventually_due: [],
        past_due: [],
        pending_verification: [],
        disabled_reason: null,
        current_deadline: null,
      },
      future_requirements: {
        currently_due: [],
        eventually_due: [],
        past_due: [],
      },
    };
    const refreshed = await fetch(
      `${baseUrl}/organizations/${agencyId}/payout-account/refresh`,
      { method: "POST" },
    );
    const refreshedBody = await refreshed.json();
    assert.equal(refreshed.status, 200, JSON.stringify(refreshedBody));
    assert.equal(refreshedBody.connectedAccount.onboardingState, "ready");

    const dashboard = await fetch(
      `${baseUrl}/organizations/${agencyId}/payout-account/dashboard`,
      { method: "POST" },
    );
    assert.equal(dashboard.status, 201);
    assert.equal((await dashboard.json()).url, "https://connect.stripe.test/express/dashboard");
    assert.deepEqual(connectCalls.dashboardAccounts, ["acct_Phase7B01"]);
  });
  await withAccessApi(directUser, async (baseUrl) => {
    const noAgencyMembership = await fetch(
      `${baseUrl}/organizations/${agencyId}/payout-account/refresh`,
      { method: "POST" },
    );
    assert.equal(noAgencyMembership.status, 403);
  }, platformHuman);

  const connectEventTime = Math.floor(Date.now() / 1000) + 600;
  const restrictedAccount = {
    ...providerAccount,
    capabilities: { transfers: "pending" },
    payouts_enabled: false,
    requirements: {
      currently_due: ["external_account"],
      eventually_due: [],
      past_due: ["external_account"],
      pending_verification: [],
      disabled_reason: "requirements.past_due",
      current_deadline: connectEventTime + 3_600,
    },
  };
  const restrictedEvent = {
    id: "evt_phase7b_restricted",
    type: "account.updated",
    account: providerAccount.id,
    livemode: false,
    created: connectEventTime,
    data: { object: restrictedAccount },
  };
  assert.deepEqual(await handleFacilitatedPaymentEvent(restrictedEvent), {
    duplicate: false,
    status: "processed",
  });
  assert.equal(
    await scalar(
      "select onboarding_state from agency_connected_accounts where id = $1",
      [connectedAccountId],
    ),
    "restricted",
  );
  assert.deepEqual(await handleFacilitatedPaymentEvent(restrictedEvent), {
    duplicate: true,
    status: "processed",
  });
  assert.deepEqual(await handleFacilitatedPaymentEvent({
    id: "evt_phase7b_stale_ready",
    type: "account.updated",
    account: providerAccount.id,
    livemode: false,
    created: connectEventTime - 60,
    data: { object: providerAccount },
  }), {
    duplicate: false,
    status: "processed",
  });
  assert.equal(
    await scalar(
      "select onboarding_state from agency_connected_accounts where id = $1",
      [connectedAccountId],
    ),
    "restricted",
  );

  // Reconciliation reads the provider outside its write transaction. Simulate
  // a webhook advancing the locked row after the route took its caller
  // snapshot: the projection must use the row read FOR UPDATE, not that stale
  // snapshot, so a ready account cannot regress silently to pending.
  const readyProviderAccount = providerAccount;
  providerAccount = {
    ...providerAccount,
    capabilities: { transfers: "pending" },
    payouts_enabled: false,
    requirements: {
      currently_due: ["external_account"],
      eventually_due: [],
      past_due: [],
      pending_verification: [],
      disabled_reason: null,
      current_deadline: null,
    },
  };
  await pool.query(
    `update agency_connected_accounts
     set onboarding_state = 'pending', disabled_reason = null,
         provider_state_updated_at = now() - interval '1 minute'
     where id = $1`,
    [connectedAccountId],
  );
  beforeProviderAccountRetrieve = async () => {
    await pool.query(
      `update agency_connected_accounts
       set onboarding_state = 'ready', updated_at = now()
       where id = $1`,
      [connectedAccountId],
    );
    beforeProviderAccountRetrieve = null;
  };
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const reconciled = await fetch(
      `${baseUrl}/facilitated-payments/accounts/${connectedAccountId}/reconcile`,
      { method: "POST" },
    );
    const reconciledBody = await reconciled.json();
    assert.equal(reconciled.status, 200, JSON.stringify(reconciledBody));
    assert.equal(reconciledBody.stale, false);
    assert.equal(reconciledBody.connectedAccount.onboardingState, "restricted");
  });
  assert.equal(
    await scalar(
      "select onboarding_state from agency_connected_accounts where id = $1",
      [connectedAccountId],
    ),
    "restricted",
  );
  providerAccount = readyProviderAccount;

  await assert.rejects(
    handleFacilitatedPaymentEvent({
      id: "evt_phase7b_wrong_owner",
      type: "account.updated",
      account: providerAccount.id,
      livemode: false,
      created: connectEventTime + 60,
      data: {
        object: {
          ...providerAccount,
          metadata: {
            ...providerAccount.metadata,
            hedgeling_organization_id: customerA,
          },
        },
      },
    }),
    /metadata does not match/,
  );
  assert.equal(
    await scalar(
      `select status from facilitated_payment_provider_events
       where provider_event_id = 'evt_phase7b_wrong_owner'`,
    ),
    "failed",
  );

  const deauthorizedEvent = {
    id: "evt_phase7b_deauthorized",
    type: "account.application.deauthorized",
    account: providerAccount.id,
    livemode: false,
    created: connectEventTime + 80,
    data: { object: { id: providerAccount.id } },
  };
  assert.deepEqual(await handleFacilitatedPaymentEvent(deauthorizedEvent), {
    duplicate: false,
    status: "processed",
  });
  assert.deepEqual(
    await pool.query(
      `select onboarding_state as "onboardingState", disabled_reason as "disabledReason"
       from agency_connected_accounts where id = $1`,
      [connectedAccountId],
    ).then((result) => result.rows[0]),
    {
      onboardingState: "disabled",
      disabledReason: "provider_application_deauthorized",
    },
  );
  assert.deepEqual(await handleFacilitatedPaymentEvent({
    id: "evt_phase7b_post_deauth_update",
    type: "account.updated",
    account: providerAccount.id,
    livemode: false,
    created: connectEventTime + 90,
    data: { object: providerAccount },
  }), {
    duplicate: false,
    status: "processed",
  });
  assert.deepEqual(
    await pool.query(
      `select onboarding_state as "onboardingState", disabled_reason as "disabledReason"
       from agency_connected_accounts where id = $1`,
      [connectedAccountId],
    ).then((result) => result.rows[0]),
    {
      onboardingState: "disabled",
      disabledReason: "provider_application_deauthorized",
    },
  );

  const replayEvent = {
    id: "evt_phase7b_replay",
    type: "phase7b.transient_test",
    livemode: false,
    created: connectEventTime + 100,
    data: { object: { id: "obj_phase7b_replay" } },
  };
  await pool.query(
    `insert into facilitated_payment_provider_events(
       provider_event_id, event_type, provider_created_at, status, attempts,
       payload, last_error
     ) values($1, $2, to_timestamp($3), 'failed', 1, $4, 'transient test failure')`,
    [replayEvent.id, replayEvent.type, replayEvent.created, JSON.stringify(replayEvent)],
  );
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const listed = await fetch(
      `${baseUrl}/facilitated-payments/provider-events?status=failed`,
    );
    const listedBody = await listed.json();
    assert.equal(listed.status, 200, JSON.stringify(listedBody));
    assert.equal(
      listedBody.events.some((event) => (
        event.providerEventId === replayEvent.id
        && event.status === "failed"
        && event.attempts === 1
        && !Object.hasOwn(event, "payload")
      )),
      true,
    );

    await pool.query(
      `update facilitated_payment_provider_events
       set replay_status = 'processing', replay_started_at = now()
       where provider_event_id = $1`,
      [replayEvent.id],
    );
    const concurrentReplay = await fetch(
      `${baseUrl}/facilitated-payments/provider-events/${replayEvent.id}/replay`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmEventId: replayEvent.id,
          reason: "Confirm parallel replay is rejected",
        }),
      },
    );
    const concurrentReplayBody = await concurrentReplay.json();
    assert.equal(concurrentReplay.status, 409, JSON.stringify(concurrentReplayBody));
    assert.equal(concurrentReplayBody.code, "provider_event_replay_in_progress");
    await pool.query(
      `update facilitated_payment_provider_events
       set replay_status = 'not_requested', replay_started_at = null
       where provider_event_id = $1`,
      [replayEvent.id],
    );

    const replayed = await fetch(
      `${baseUrl}/facilitated-payments/provider-events/${replayEvent.id}/replay`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": "phase7b-replay-correlation",
        },
        body: JSON.stringify({
          confirmEventId: replayEvent.id,
          reason: "Retry after the transient test failure was corrected",
        }),
      },
    );
    const replayedBody = await replayed.json();
    assert.equal(replayed.status, 200, JSON.stringify(replayedBody));
    assert.equal(replayedBody.duplicate, false);
    assert.equal(replayedBody.status, "ignored");
    assert.equal(replayedBody.replayed, true);
    assert.equal(replayedBody.correlationId, "phase7b-replay-correlation");
  });
  assert.deepEqual(
    await pool.query(
      `select status, attempts, last_error as "lastError",
              replay_status as "replayStatus",
              last_replay_correlation_id as "correlationId"
       from facilitated_payment_provider_events where provider_event_id = $1`,
      [replayEvent.id],
    ).then((result) => result.rows[0]),
    {
      status: "ignored",
      attempts: 2,
      lastError: null,
      replayStatus: "succeeded",
      correlationId: "phase7b-replay-correlation",
    },
  );

  // Phase 7B intentionally has no self-service re-enable path. This fixture
  // represents the reviewed operator action required before later payment
  // scenarios can reuse the test agency.
  await pool.query(
    `update agency_connected_accounts
     set onboarding_state = 'restricted',
         disabled_reason = 'operator_reenable_required',
         provider_state_updated_at = to_timestamp($2)
     where id = $1`,
    [connectedAccountId, connectEventTime + 100],
  );

  await rejectsConstraint(
    pool.query(
      `insert into agency_connected_accounts(
         agency_organization_id, provider_mode, created_by_user_id
       ) values($1, 'test', $2)`,
      [customerB, foreignUser],
    ),
    "agency_connected_account_owner",
  );
  await rejectsConstraint(
    pool.query(
      `insert into facilitated_payment_program_enrollments(
         organization_id, program_version, party_type, provider_mode, status,
         payment_methods, per_payment_cap_minor, rolling_cap_minor,
         terms_version, policy_version, acceptance_evidence, status_reason,
         approved_by_user_id, approved_at, changed_by_user_id
       ) values(
         $1, 'us-usd-v1', 'agency', 'test', 'approved', '{}'::text[],
         100, 1000, 'terms', 'policy', '{"reference":"test"}'::jsonb,
         'wrong party', $2, now(), $2
       )`,
      [customerB, foreignUser],
    ),
    "facilitated_enrollment_organization_type",
  );
  setFacilitatedPaymentsTestClient(null);

  await withAccessApi(directUser, async (baseUrl) => {
    const headers = { "content-type": "application/json" };
    const saveScopes = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/scopes`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          scopes: [
            { scopeType: "business_unit", scopeId: buA },
            { scopeType: "locale", scopeValue: "fr-CA" },
          ],
        }),
      },
    );
    assert.equal(saveScopes.status, 200);

    const activate = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/transitions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ status: "active" }),
      },
    );
    const activateBody = await activate.json();
    assert.equal(activate.status, 200, JSON.stringify(activateBody));
    assert.equal(activateBody.vendorRelationship.status, "active");
  });

  let firstApprovedRateCardId;
  await withAccessApi(agencyOwnerUser, async (baseUrl) => {
    const headers = { "content-type": "application/json" };
    const rateCardPath = `${baseUrl}/organizations/${agencyId}/vendor-relationships/${vendorRelationshipId}/rate-cards`;
    const foreignLine = await fetch(rateCardPath, {
      method: "POST",
      headers,
      body: JSON.stringify({
        currency: "USD",
        lines: [{
          serviceType: "translation",
          unitType: "source_word",
          unitRate: "0.12",
          businessUnitId: buB,
        }],
      }),
    });
    assert.equal(foreignLine.status, 400);

    const created = await fetch(rateCardPath, {
      method: "POST",
      headers,
      body: JSON.stringify({
        currency: "USD",
        paymentTermsDays: 30,
        lines: [{
          serviceType: "translation",
          unitType: "source_word",
          unitRate: "0.12000000",
          sourceLocale: "en-US",
          targetLocale: "fr-CA",
          businessUnitId: buA,
          projectId: projectA,
        }],
      }),
    });
    const createdBody = await created.json();
    assert.equal(created.status, 201, JSON.stringify(createdBody));
    assert.equal(createdBody.rateCard.status, "draft");
    assert.equal(createdBody.rateCard.version, 1);
    assert.equal(createdBody.rateCard.lines[0].unitRate, "0.12000000");
    firstApprovedRateCardId = createdBody.rateCard.id;

    const duplicateOpen = await fetch(rateCardPath, {
      method: "POST",
      headers,
      body: JSON.stringify({ lines: [] }),
    });
    assert.equal(duplicateOpen.status, 409);

    const submitted = await fetch(`${rateCardPath}/${firstApprovedRateCardId}/transitions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ status: "submitted" }),
    });
    assert.equal(submitted.status, 200);
    assert.equal((await submitted.json()).rateCard.status, "submitted");

    const agencyCannotApprove = await fetch(
      `${rateCardPath}/${firstApprovedRateCardId}/transitions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ status: "approved" }),
      },
    );
    assert.equal(agencyCannotApprove.status, 403);
  });

  await withAccessApi(directUser, async (baseUrl) => {
    const headers = { "content-type": "application/json" };
    const customerRateCardPath = `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/rate-cards`;
    const list = await fetch(customerRateCardPath);
    const listBody = await list.json();
    assert.equal(list.status, 200, JSON.stringify(listBody));
    assert.equal(listBody.rateCards.length, 1);
    assert.equal(listBody.rateCards[0].lines.length, 1);

    const customerCannotEdit = await fetch(
      `${customerRateCardPath}/${firstApprovedRateCardId}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ lines: [] }),
      },
    );
    assert.equal(customerCannotEdit.status, 403);

    const approved = await fetch(
      `${customerRateCardPath}/${firstApprovedRateCardId}/transitions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ status: "approved" }),
      },
    );
    const approvedBody = await approved.json();
    assert.equal(approved.status, 200, JSON.stringify(approvedBody));
    assert.equal(approvedBody.rateCard.status, "approved");
  });

  await withAccessApi(agencyOwnerUser, async (baseUrl) => {
    const headers = { "content-type": "application/json" };
    const rateCardPath = `${baseUrl}/organizations/${agencyId}/vendor-relationships/${vendorRelationshipId}/rate-cards`;
    const immutableEdit = await fetch(`${rateCardPath}/${firstApprovedRateCardId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        currency: "EUR",
        lines: [{
          serviceType: "translation",
          unitType: "source_word",
          unitRate: "0.15",
        }],
      }),
    });
    assert.equal(immutableEdit.status, 409);

    const rejectedDraft = await fetch(rateCardPath, {
      method: "POST",
      headers,
      body: JSON.stringify({
        lines: [{
          serviceType: "editing",
          unitType: "hour",
          unitRate: "75",
        }],
      }),
    });
    const rejectedDraftBody = await rejectedDraft.json();
    assert.equal(rejectedDraft.status, 201, JSON.stringify(rejectedDraftBody));
    const rejectedRateCardId = rejectedDraftBody.rateCard.id;
    assert.equal(rejectedDraftBody.rateCard.version, 2);
    const submitRejected = await fetch(`${rateCardPath}/${rejectedRateCardId}/transitions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ status: "submitted" }),
    });
    assert.equal(submitRejected.status, 200);
  });

  let rejectedRateCardId = await scalar(
    `select id from rate_cards
     where vendor_relationship_id = $1 and version = 2`,
    [vendorRelationshipId],
  );
  await withAccessApi(directUser, async (baseUrl) => {
    const rejected = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/rate-cards/${rejectedRateCardId}/transitions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "rejected", reason: "Please revise the hourly rate" }),
      },
    );
    const rejectedBody = await rejected.json();
    assert.equal(rejected.status, 200, JSON.stringify(rejectedBody));
    assert.equal(rejectedBody.rateCard.status, "rejected");
    assert.equal(rejectedBody.rateCard.rejectionReason, "Please revise the hourly rate");
  });

  let replacementRateCardId;
  await withAccessApi(agencyOwnerUser, async (baseUrl) => {
    const headers = { "content-type": "application/json" };
    const rateCardPath = `${baseUrl}/organizations/${agencyId}/vendor-relationships/${vendorRelationshipId}/rate-cards`;
    const replacement = await fetch(rateCardPath, {
      method: "POST",
      headers,
      body: JSON.stringify({
        lines: [{
          serviceType: "editing",
          unitType: "hour",
          unitRate: "70",
        }],
      }),
    });
    const replacementBody = await replacement.json();
    assert.equal(replacement.status, 201, JSON.stringify(replacementBody));
    replacementRateCardId = replacementBody.rateCard.id;
    assert.equal(replacementBody.rateCard.version, 3);
    const submitted = await fetch(`${rateCardPath}/${replacementRateCardId}/transitions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ status: "submitted" }),
    });
    assert.equal(submitted.status, 200);
  });

  await withAccessApi(directUser, async (baseUrl) => {
    const approved = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/rate-cards/${replacementRateCardId}/transitions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      },
    );
    assert.equal(approved.status, 200);
    assert.equal(
      await scalar("select status from rate_cards where id = $1", [firstApprovedRateCardId]),
      "superseded",
    );
    assert.equal(
      await scalar(
        `select count(*)::int from audit_events
         where resource_id = $1 and action = 'rate_card.approved'`,
        [replacementRateCardId],
      ),
      2,
    );
  });

  let agencyLinguistUser;
  let agencyLinguistMembership;
  let approvedLinguistId;
  await withAccessApi(agencyOwnerUser, async (baseUrl) => {
    const headers = { "content-type": "application/json" };
    const inviteLinguist = await fetch(`${baseUrl}/organizations/${agencyId}/invitations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: "linguist@polyglot.example",
        membershipType: "internal",
      }),
    });
    const inviteLinguistBody = await inviteLinguist.json();
    assert.equal(inviteLinguist.status, 201, JSON.stringify(inviteLinguistBody));
    agencyLinguistUser = await scalar(
      "select id from users where lower(email) = 'linguist@polyglot.example'",
    );
    agencyLinguistMembership = inviteLinguistBody.membership.id;

    await withAccessApi(agencyLinguistUser, async (linguistBaseUrl) => {
      const acceptLinguist = await fetch(`${linguistBaseUrl}/invitations/accept`, {
        method: "POST",
        headers,
        body: JSON.stringify({ token: inviteLinguistBody.onboardingToken }),
      });
      assert.equal(acceptLinguist.status, 200);
    });

    const assignLinguistRole = await fetch(
      `${baseUrl}/organizations/${agencyId}/role-assignments`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          principalType: "user",
          principalId: agencyLinguistUser,
          roleId: agencyLinguistRole,
          scopeType: "organization",
          scopeId: agencyId,
          inheritToChildren: true,
        }),
      },
    );
    assert.equal(assignLinguistRole.status, 201);
    const linguistOrganizationPermissions = await organizationPermissions(
      { user: { id: agencyLinguistUser, platformStaff: false } },
      agencyId,
    );
    assert.equal(linguistOrganizationPermissions.includes("vendors.view"), false);
    assert.equal(linguistOrganizationPermissions.includes("work_orders.view"), false);

    const outOfScopeNomination = await fetch(
      `${baseUrl}/organizations/${agencyId}/vendor-relationships/${vendorRelationshipId}/linguists`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          agencyMembershipId: agencyLinguistMembership,
          conditions: { locales: ["de-DE"] },
        }),
      },
    );
    assert.equal(outOfScopeNomination.status, 400);

    const nominate = await fetch(
      `${baseUrl}/organizations/${agencyId}/vendor-relationships/${vendorRelationshipId}/linguists`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          agencyMembershipId: agencyLinguistMembership,
          conditions: { locales: ["fr-CA"] },
        }),
      },
    );
    const nominateBody = await nominate.json();
    assert.equal(nominate.status, 201, JSON.stringify(nominateBody));
    assert.equal(nominateBody.linguist.status, "pending");
    approvedLinguistId = nominateBody.linguist.id;

    const agencyCannotApprove = await fetch(
      `${baseUrl}/organizations/${agencyId}/vendor-relationships/${vendorRelationshipId}/linguists/${approvedLinguistId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "approved" }),
      },
    );
    assert.equal(agencyCannotApprove.status, 403);
  });

  await withAccessApi(directUser, async (baseUrl) => {
    const headers = { "content-type": "application/json" };
    const approve = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/linguists/${approvedLinguistId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "approved" }),
      },
    );
    const approveBody = await approve.json();
    assert.equal(approve.status, 200, JSON.stringify(approveBody));
    assert.equal(approveBody.linguist.status, "approved");

    const relationshipDetail = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}`,
    );
    const relationshipBody = await relationshipDetail.json();
    assert.equal(relationshipDetail.status, 200, JSON.stringify(relationshipBody));
    assert.equal(relationshipBody.scopes.length, 2);
    assert.equal(relationshipBody.linguists[0].status, "approved");
    assert.equal(relationshipBody.eligibleProjects.length, 2);

    const disableApproval = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ requiresLinguistApproval: false }),
      },
    );
    const disableApprovalBody = await disableApproval.json();
    assert.equal(disableApproval.status, 200, JSON.stringify(disableApprovalBody));
    const agencyOwnerMembership = await scalar(
      `select id from organization_memberships
       where organization_id = $1 and user_id = $2`,
      [agencyId, agencyOwnerUser],
    );
    const autoApprovedLinguist = await scalar(
      `insert into vendor_approved_linguists(
         vendor_relationship_id, agency_membership_id, status, approved_at
       ) values($1, $2, 'approved', now()) returning id`,
      [vendorRelationshipId, agencyOwnerMembership],
    );
    const enableApproval = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ requiresLinguistApproval: true }),
      },
    );
    assert.equal(enableApproval.status, 200);
    assert.equal(
      await scalar(
        "select status from vendor_approved_linguists where id = $1",
        [autoApprovedLinguist],
      ),
      "pending",
    );
    assert.equal(
      await scalar(
        "select status from vendor_approved_linguists where id = $1",
        [approvedLinguistId],
      ),
      "approved",
    );
    assert.equal(
      await scalar(
        `select count(*)::int from audit_events
         where action = 'vendor_linguist.auto_approval_reset'
           and resource_id = $1`,
        [autoApprovedLinguist],
      ),
      2,
    );

    await rejectsConstraint(
      pool.query(
        `insert into vendor_relationships(
           customer_organization_id, agency_organization_id
         ) values($1, $2)`,
        [customerA, customerB],
      ),
      "vendor_relationship_party_types",
    );
    await rejectsConstraint(
      pool.query(
        `insert into vendor_relationship_scopes(
           vendor_relationship_id, scope_type, scope_id
         ) values($1, 'locale', $2)`,
        [vendorRelationshipId, buA],
      ),
      "vendor_relationship_scopes_shape",
    );
    await rejectsConstraint(
      pool.query(
        `insert into vendor_relationship_scopes(
           vendor_relationship_id, scope_type, scope_id
         ) values($1, 'business_unit', $2)`,
        [vendorRelationshipId, buB],
      ),
      "vendor_relationship_scope_customer_owner",
    );
    await rejectsConstraint(
      pool.query(
        `insert into vendor_approved_linguists(
           vendor_relationship_id, agency_membership_id
         ) values($1, $2)`,
        [vendorRelationshipId, directMembership],
      ),
      "vendor_approved_linguist_agency_owner",
    );
    const directDraftRateCard = await scalar(
      `insert into rate_cards(vendor_relationship_id, version, currency)
       values($1, 4, 'USD') returning id`,
      [vendorRelationshipId],
    );
    await rejectsConstraint(
      pool.query(
        `insert into rate_card_lines(
           rate_card_id, service_type, unit_type, unit_rate, business_unit_id
         ) values($1, 'translation', 'source_word', 0.10, $2)`,
        [directDraftRateCard, buB],
      ),
      "rate_card_line_customer_owner",
    );
    await rejectsConstraint(
      pool.query(
        "update rate_cards set currency = 'EUR' where id = $1",
        [replacementRateCardId],
      ),
      "rate_card_immutable",
    );
    await rejectsConstraint(
      pool.query(
        "update rate_card_lines set unit_rate = 0.20 where rate_card_id = $1",
        [replacementRateCardId],
      ),
      "rate_card_immutable",
    );
    await pool.query("delete from rate_cards where id = $1", [directDraftRateCard]);
    await rejectsConstraint(
      pool.query(
        "update organizations set organization_type = 'individual_vendor' where id = $1",
        [agencyId],
      ),
      "vendor_relationship_party_types",
    );
    await rejectsConstraint(
      pool.query(
        "update business_units set organization_id = $2 where id = $1",
        [buA, customerB],
      ),
      "vendor_relationship_scope_customer_owner",
    );
    await rejectsConstraint(
      pool.query(
        "update organization_memberships set organization_id = $2 where id = $1",
        [agencyLinguistMembership, customerA],
      ),
      "vendor_approved_linguist_agency_owner",
    );
    await rejectsConstraint(
      pool.query(
        "update vendor_relationships set customer_organization_id = $2 where id = $1",
        [vendorRelationshipId, customerB],
      ),
      "rate_card_party_immutable",
    );
    await pool.query(
      `insert into vendor_relationship_scopes(
         vendor_relationship_id, scope_type, scope_id
       ) values($1, 'project', $2)`,
      [vendorRelationshipId, projectA],
    );
    await rejectsConstraint(
      pool.query(
        "update projects set business_unit_id = $2 where id = $1",
        [projectA, buB],
      ),
      "vendor_relationship_scope_customer_owner",
    );
    await pool.query(
      `delete from vendor_relationship_scopes
       where vendor_relationship_id = $1
         and scope_type = 'project'
         and scope_id = $2`,
      [vendorRelationshipId, projectA],
    );

    const eligibleResponse = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/eligibility-check`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          agencyMembershipId: agencyLinguistMembership,
          projectId: projectA,
          locale: "fr-CA",
        }),
      },
    );
    const eligibleBody = await eligibleResponse.json();
    assert.equal(eligibleResponse.status, 200, JSON.stringify(eligibleBody));
    assert.equal(eligibleBody.eligibility.eligibleForAssignment, true);
    assert.equal(eligibleBody.eligibility.contentAccess.allowed, false);
    assert.equal(eligibleBody.eligibility.contentAccess.code, "work_assignment_missing");

    const wrongLocaleResponse = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/eligibility-check`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          agencyMembershipId: agencyLinguistMembership,
          projectId: projectA,
          locale: "de-DE",
        }),
      },
    );
    const wrongLocaleBody = await wrongLocaleResponse.json();
    assert.equal(wrongLocaleResponse.status, 200);
    assert.equal(wrongLocaleBody.eligibility.eligibleForAssignment, false);
    assert.ok(wrongLocaleBody.eligibility.denialReasons.some(
      (reason) => reason.code === "locale_out_of_scope",
    ));
    assert.ok(wrongLocaleBody.eligibility.denialReasons.some(
      (reason) => reason.code === "linguist_locale_out_of_scope",
    ));

    const foreignProjectResponse = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/eligibility-check`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          agencyMembershipId: agencyLinguistMembership,
          projectId: await scalar(
            "select id from projects where business_unit_id = $1 limit 1",
            [buB],
          ),
          locale: "fr-CA",
        }),
      },
    );
    assert.equal(foreignProjectResponse.status, 400);

    const undisclosedAgencyUser = await scalar(
      `insert into users(email) values('undisclosed@polyglot.example') returning id`,
    );
    const undisclosedMembershipId = await scalar(
      `insert into organization_memberships(organization_id, user_id, status)
       values($1, $2, 'active') returning id`,
      [agencyId, undisclosedAgencyUser],
    );
    const undisclosedLinguistResponse = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/eligibility-check`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          agencyMembershipId: undisclosedMembershipId,
          projectId: projectA,
          locale: "fr-CA",
        }),
      },
    );
    assert.equal(undisclosedLinguistResponse.status, 404);
  });

  const eligibilityCodes = async (overrides = {}) => (
    await evaluateVendorEligibility({
      vendorRelationshipId,
      agencyMembershipId: agencyLinguistMembership,
      projectId: projectA,
      locale: "fr-CA",
      ...overrides,
    })
  ).denialReasons.map((reason) => reason.code);

  await pool.query(
    "update vendor_relationships set status = 'suspended' where id = $1",
    [vendorRelationshipId],
  );
  assert.ok((await eligibilityCodes()).includes("relationship_not_active"));
  await pool.query(
    "update vendor_relationships set status = 'active' where id = $1",
    [vendorRelationshipId],
  );

  await pool.query(
    `update vendor_relationships
     set effective_from = current_date + 1, effective_to = null where id = $1`,
    [vendorRelationshipId],
  );
  assert.ok((await eligibilityCodes()).includes("relationship_not_started"));
  await pool.query(
    `update vendor_relationships
     set effective_from = current_date - 2, effective_to = current_date - 1 where id = $1`,
    [vendorRelationshipId],
  );
  assert.ok((await eligibilityCodes()).includes("relationship_expired"));
  await pool.query(
    `update vendor_relationships
     set effective_from = current_date, effective_to = null where id = $1`,
    [vendorRelationshipId],
  );

  await pool.query(
    "update organization_memberships set status = 'suspended' where id = $1",
    [agencyLinguistMembership],
  );
  assert.ok((await eligibilityCodes()).includes("agency_membership_inactive"));
  await pool.query(
    "update organization_memberships set status = 'active' where id = $1",
    [agencyLinguistMembership],
  );

  await pool.query(
    "update vendor_approved_linguists set expires_at = now() - interval '1 minute' where id = $1",
    [approvedLinguistId],
  );
  assert.ok((await eligibilityCodes()).includes("linguist_approval_expired"));
  await pool.query(
    "update vendor_approved_linguists set expires_at = null where id = $1",
    [approvedLinguistId],
  );

  for (const approvalStatus of ["pending", "rejected", "revoked"]) {
    await pool.query(
      "update vendor_approved_linguists set status = $2 where id = $1",
      [approvedLinguistId, approvalStatus],
    );
    assert.ok((await eligibilityCodes()).includes(`linguist_approval_${approvalStatus}`));
  }
  await pool.query(
    "update vendor_approved_linguists set status = 'approved' where id = $1",
    [approvedLinguistId],
  );

  const agencyLinguistAssignment = await scalar(
    `select ra.id
     from role_assignments ra join roles r on r.id = ra.role_id
     where ra.principal_type = 'user' and ra.principal_id = $1
       and r.key = 'agency_linguist' and ra.revoked_at is null`,
    [agencyLinguistUser],
  );
  await pool.query(
    "update role_assignments set revoked_at = now() where id = $1",
    [agencyLinguistAssignment],
  );
  assert.ok((await eligibilityCodes()).includes("agency_linguist_role_missing"));
  await pool.query(
    "update role_assignments set revoked_at = null where id = $1",
    [agencyLinguistAssignment],
  );

  await pool.query(
    `insert into vendor_relationship_scopes(vendor_relationship_id, scope_type, scope_value)
     values($1, 'service_type', 'translation')`,
    [vendorRelationshipId],
  );
  assert.ok((await eligibilityCodes()).includes("service_type_required"));
  assert.ok((await eligibilityCodes({ serviceType: "review" })).includes("service_type_out_of_scope"));
  assert.deepEqual(await eligibilityCodes({ serviceType: "translation" }), []);
  await pool.query(
    `delete from vendor_relationship_scopes
     where vendor_relationship_id = $1 and scope_type = 'service_type'`,
    [vendorRelationshipId],
  );

  await pool.query(
    "update organizations set status = 'suspended' where id = $1",
    [agencyId],
  );
  assert.ok((await eligibilityCodes()).includes("agency_organization_inactive"));
  await pool.query(
    "update organizations set status = 'active' where id = $1",
    [agencyId],
  );

  await pool.query(
    "update users set status = 'suspended' where id = $1",
    [agencyLinguistUser],
  );
  assert.ok((await eligibilityCodes()).includes("user_inactive"));
  await pool.query(
    "update users set status = 'active' where id = $1",
    [agencyLinguistUser],
  );

  await pool.query(
    "update organizations set status = 'suspended' where id = $1",
    [customerA],
  );
  assert.ok((await eligibilityCodes()).includes("customer_organization_inactive"));
  await pool.query(
    "update organizations set status = 'active' where id = $1",
    [customerA],
  );

  // Phase 4 approval is eligibility metadata, not a customer content grant.
  assert.equal(
    (await authorize(agencyLinguistUser, "project-a", "strings.view")).status,
    403,
  );
  assert.equal(
    (await listAccessibleProjects({
      user: { id: agencyLinguistUser, platformStaff: false },
    })).some((project) => project.slug === "project-a"),
    false,
  );
  assert.equal(
    await scalar(
      `select count(*)::int from audit_events
       where action = 'vendor_linguist.approved'
         and organization_id in ($1, $2)`,
      [customerA, agencyId],
    ),
    2,
  );
  assert.ok((await organizationPermissions(
    { user: { id: agencyOwnerUser, platformStaff: false } },
    agencyId,
  )).includes("vendors.manage"));
  await pool.query("update organizations set status = 'suspended' where id = $1", [agencyId]);
  assert.deepEqual(
    await organizationPermissions(
      { user: { id: agencyOwnerUser, platformStaff: false } },
      agencyId,
    ),
    [],
  );
  await pool.query("update organizations set status = 'active' where id = $1", [agencyId]);

  const disputeViewerUser = await scalar(
    "insert into users(email) values('dispute-viewer@example.com') returning id",
  );
  await pool.query(
    `insert into organization_memberships(organization_id, user_id, status)
     values($1, $2, 'active')`,
    [agencyId, disputeViewerUser],
  );
  const disputeViewerRole = await scalar(
    `insert into roles(organization_id, key, name)
     values($1, 'payables_viewer_test', 'Payables viewer test') returning id`,
    [agencyId],
  );
  await pool.query(
    `insert into role_permissions(role_id, permission_id)
     select $1, id from permissions
     where key in ('organization.view', 'vendors.view', 'work_orders.view', 'payables.view')`,
    [disputeViewerRole],
  );
  await pool.query(
    `insert into role_assignments(
       principal_type, principal_id, role_id, scope_type, scope_id
     ) values('user', $1, $2, 'organization', $3)`,
    [disputeViewerUser, disputeViewerRole, agencyId],
  );
  const disputeViewerPermissions = await organizationPermissions(
    { user: { id: disputeViewerUser, platformStaff: false } },
    agencyId,
  );
  assert.ok(disputeViewerPermissions.includes("payables.view"));
  assert.equal(disputeViewerPermissions.includes("disputes.open"), false);

  const phase5ReviewerUser = await scalar(
    "insert into users(email) values('phase5-reviewer@example.com') returning id",
  );
  await pool.query(
    `insert into organization_memberships(organization_id, user_id, status)
     values($1, $2, 'active')`,
    [customerA, phase5ReviewerUser],
  );
  const leadReviewerRole = await scalar(
    "select id from roles where organization_id is null and key = 'lead_reviewer'",
  );
  await pool.query(
    `insert into role_assignments(
       principal_type, principal_id, role_id, scope_type, scope_id
     ) values('user', $1, $2, 'project', $3)`,
    [phase5ReviewerUser, leadReviewerRole, projectA],
  );

  const phase5UnassignedSource = await scalar(
    `insert into source_strings(project_id, source_hash, source_text)
     values($1, 'phase5-unassigned', 'This source is outside the work order') returning id`,
    [projectA],
  );
  let phase5WorkOrderId;
  let boundedWorkOrderListQueries;
  let boundedStatementListQueries;
  await withAccessApi(directUser, async (baseUrl) => {
    const headers = { "content-type": "application/json" };
    const workOrderPath = `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/work-orders`;
    const created = await fetch(workOrderPath, {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectId: projectA,
        title: "French UI editing",
        serviceType: "editing",
        unitType: "hour",
        sourceLocale: "en-US",
        targetLocale: "fr-CA",
        estimatedUnits: "2",
        sourceStringIds: [usageSource],
      }),
    });
    const createdBody = await created.json();
    assert.equal(created.status, 201, JSON.stringify(createdBody));
    phase5WorkOrderId = createdBody.workOrder.id;
    assert.equal(createdBody.workOrder.status, "draft");
    assert.equal(createdBody.workOrder.items.length, 1);

    const offered = await fetch(`${workOrderPath}/${phase5WorkOrderId}/transitions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "offer" }),
    });
    const offeredBody = await offered.json();
    assert.equal(offered.status, 200, JSON.stringify(offeredBody));
    assert.equal(offeredBody.workOrder.status, "offered");
    assert.equal(offeredBody.workOrder.rateCardId, replacementRateCardId);
    assert.equal(offeredBody.workOrder.snapshotUnitRate, "70.00000000");
  });

  await withAccessApi(agencyOwnerUser, async (baseUrl) => {
    const headers = { "content-type": "application/json" };
    const workOrderPath = `${baseUrl}/organizations/${agencyId}/vendor-relationships/${vendorRelationshipId}/work-orders/${phase5WorkOrderId}`;
    const accepted = await fetch(`${workOrderPath}/transitions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "accept" }),
    });
    assert.equal(accepted.status, 200, JSON.stringify(await accepted.json()));

    const agencyAssignment = await fetch(`${workOrderPath}/assignments`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        agencyMembershipId: agencyLinguistMembership,
        assignmentRole: "translator",
      }),
    });
    assert.equal(agencyAssignment.status, 403);
  });

  await withAccessApi(agencyLinguistUser, async (baseUrl) => {
    const organizationWorkOrders = await fetch(
      `${baseUrl}/organizations/${agencyId}/vendor-relationships/${vendorRelationshipId}/work-orders`,
    );
    assert.equal(organizationWorkOrders.status, 403);
  });

  let phase5AssignmentId;
  await withAccessApi(directUser, async (baseUrl) => {
    const assignment = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/work-orders/${phase5WorkOrderId}/assignments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agencyMembershipId: agencyLinguistMembership,
          assignmentRole: "translator",
        }),
      },
    );
    const assignmentBody = await assignment.json();
    assert.equal(assignment.status, 201, JSON.stringify(assignmentBody));
    phase5AssignmentId = assignmentBody.assignment.id;
  });

  assert.equal(
    (await evaluateVendorWorkAccess({
      assignmentId: phase5AssignmentId,
      userId: agencyLinguistUser,
      sourceStringId: usageSource,
      mode: "edit",
    })).contentAccess.allowed,
    true,
  );
  assert.equal(
    (await evaluateVendorWorkAccess({
      assignmentId: phase5AssignmentId,
      userId: agencyLinguistUser,
      sourceStringId: phase5UnassignedSource,
      mode: "edit",
    })).contentAccess.code,
    "work_order_content_item_missing",
  );

  await withPersonalWorkApi(agencyLinguistUser, async (baseUrl) => {
    const headers = { "content-type": "application/json" };
    let assignmentListQueries = 0;
    setDatabaseTestHooks({ onQuery: () => { assignmentListQueries += 1; } });
    const assignments = await fetch(`${baseUrl}/assignments`)
      .finally(() => setDatabaseTestHooks({}));
    const assignmentsBody = await assignments.json();
    assert.equal(assignments.status, 200, JSON.stringify(assignmentsBody));
    assert.equal(assignmentListQueries, 1);
    assert.ok(assignmentsBody.assignments.some(
      (assignment) => assignment.id === phase5AssignmentId,
    ));

    const content = await fetch(`${baseUrl}/assignments/${phase5AssignmentId}/content`);
    const contentBody = await content.json();
    assert.equal(content.status, 200, JSON.stringify(contentBody));
    assert.deepEqual(contentBody.items.map((item) => item.id), [usageSource]);

    const denied = await fetch(
      `${baseUrl}/assignments/${phase5AssignmentId}/content/${phase5UnassignedSource}/translations/fr-CA`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ text: "Contenu interdit" }),
      },
    );
    const deniedBody = await denied.json();
    assert.equal(denied.status, 403, JSON.stringify(deniedBody));
    assert.equal(deniedBody.code, "work_order_content_item_missing");

    const started = await fetch(`${baseUrl}/assignments/${phase5AssignmentId}/start`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(started.status, 200, JSON.stringify(await started.json()));

    await pool.query(
      `insert into translations(
         source_string_id, locale, text, mt_status, human_status, source
       ) values($1, 'fr-CA', 'Traduction client vérifiée', 'ready', 'verified', 'human')
       on conflict(source_string_id, locale) do update set
         text = excluded.text, mt_status = excluded.mt_status,
         human_status = excluded.human_status, source = excluded.source,
         updated_at = now()`,
      [usageSource],
    );
    const protectedEdit = await fetch(
      `${baseUrl}/assignments/${phase5AssignmentId}/content/${usageSource}/translations/fr-CA`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ text: "Une modification non autorisée" }),
      },
    );
    const protectedEditBody = await protectedEdit.json();
    assert.equal(protectedEdit.status, 409, JSON.stringify(protectedEditBody));
    assert.equal(protectedEditBody.code, "verified_translation_protected");
    assert.equal(protectedEditBody.details.previousHumanStatus, "verified");
    assert.equal(
      await scalar(
        `select text from translations
         where source_string_id = $1 and locale = 'fr-CA'`,
        [usageSource],
      ),
      "Traduction client vérifiée",
    );
    await pool.query(
      `update translations set human_status = 'pending'
       where source_string_id = $1 and locale = 'fr-CA'`,
      [usageSource],
    );

    const translated = await fetch(
      `${baseUrl}/assignments/${phase5AssignmentId}/content/${usageSource}/translations/fr-CA`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ text: "Trois mots sources" }),
      },
    );
    const translatedBody = await translated.json();
    assert.equal(translated.status, 200, JSON.stringify(translatedBody));
    assert.equal(translatedBody.previousHumanStatus, "pending");

    const firstSubmission = await fetch(`${baseUrl}/assignments/${phase5AssignmentId}/submit`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        deliveredUnits: "2",
        notes: "Initial delivery",
        idempotencyKey: "phase5-delivery-1",
      }),
    });
    assert.equal(firstSubmission.status, 201, JSON.stringify(await firstSubmission.json()));
    const replay = await fetch(`${baseUrl}/assignments/${phase5AssignmentId}/submit`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        deliveredUnits: "2",
        notes: "Initial delivery",
        idempotencyKey: "phase5-delivery-1",
      }),
    });
    assert.equal(replay.status, 200, JSON.stringify(await replay.json()));
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    const mismatch = await fetch(`${baseUrl}/assignments/${phase5AssignmentId}/submit`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        deliveredUnits: "3",
        notes: "Different delivery",
        idempotencyKey: "phase5-delivery-1",
      }),
    });
    assert.equal(mismatch.status, 409);
  });

  await withPersonalWorkApi(foreignUser, async (baseUrl) => {
    const unauthorizedReplay = await fetch(
      `${baseUrl}/assignments/${phase5AssignmentId}/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deliveredUnits: "2",
          notes: "Initial delivery",
          idempotencyKey: "phase5-delivery-1",
        }),
      },
    );
    assert.equal(unauthorizedReplay.status, 404);
  });

  await withAccessApi(phase5ReviewerUser, async (baseUrl) => {
    let workOrderListQueries = 0;
    setDatabaseTestHooks({ onQuery: () => { workOrderListQueries += 1; } });
    const listed = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/work-orders`,
    ).finally(() => setDatabaseTestHooks({}));
    boundedWorkOrderListQueries = workOrderListQueries;
    const listedBody = await listed.json();
    assert.equal(listed.status, 200, JSON.stringify(listedBody));
    assert.deepEqual(listedBody.page, {
      limit: 250,
      hasMore: false,
      nextBeforeWorkOrderNumber: null,
    });
    const listedWorkOrder = listedBody.workOrders.find(
      (workOrder) => workOrder.id === phase5WorkOrderId,
    );
    assert.ok(listedWorkOrder);
    assert.equal(Object.hasOwn(listedWorkOrder, "ledger"), false);
    assert.equal(Object.hasOwn(listedWorkOrder, "disputes"), false);

    const rejected = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/work-orders/${phase5WorkOrderId}/transitions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "quality_reject",
          reason: "Please complete the final terminology pass",
        }),
      },
    );
    const rejectedBody = await rejected.json();
    assert.equal(rejected.status, 200, JSON.stringify(rejectedBody));
    assert.equal(rejectedBody.workOrder.status, "in_progress");
  });

  await withPersonalWorkApi(agencyLinguistUser, async (baseUrl) => {
    const submitted = await fetch(`${baseUrl}/assignments/${phase5AssignmentId}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deliveredUnits: "2.5",
        notes: "Terminology pass complete",
        idempotencyKey: "phase5-delivery-2",
      }),
    });
    assert.equal(submitted.status, 201, JSON.stringify(await submitted.json()));
  });

  let phase5DisputeId;
  await withAccessApi(phase5ReviewerUser, async (baseUrl) => {
    const workOrderPath = `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/work-orders/${phase5WorkOrderId}`;
    const pendingReview = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/work-orders`,
    );
    const pendingReviewBody = await pendingReview.json();
    assert.equal(pendingReview.status, 200, JSON.stringify(pendingReviewBody));
    const pendingWorkOrder = pendingReviewBody.workOrders.find(
      (workOrder) => workOrder.id === phase5WorkOrderId,
    );
    assert.equal(pendingWorkOrder.deliveryReview.computedSourceWords, 3);
    assert.equal(
      pendingWorkOrder.deliveryReview.warning.code,
      "delivered_estimate_variance",
    );
    assert.equal(pendingWorkOrder.deliveryReview.warning.expectedUnits, "2");
    assert.equal(pendingWorkOrder.deliveryReview.warning.deliveredUnits, "2.5");

    const approved = await fetch(`${workOrderPath}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "quality_approve" }),
    });
    const approvedBody = await approved.json();
    assert.equal(approved.status, 200, JSON.stringify(approvedBody));
    assert.equal(approvedBody.workOrder.status, "quality_approved");
    assert.equal(Object.hasOwn(approvedBody.workOrder, "payableTotalMinor"), false);
    assert.equal(Object.hasOwn(approvedBody.workOrder, "disputes"), false);
    assert.equal(approvedBody.workOrder.assignments[0].status, "completed");
  });

  assert.equal(
    await scalar(
      "select coalesce(sum(amount_minor), 0)::bigint from work_ledger_entries where work_order_id = $1",
      [phase5WorkOrderId],
    ),
    "17500",
  );

  await withAccessApi(directUser, async (baseUrl) => {
    const workOrderPath = `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/work-orders/${phase5WorkOrderId}`;
    const adjustment = await fetch(`${workOrderPath}/adjustments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        amountMinor: 500,
        reason: "Rush delivery premium",
        idempotencyKey: "phase5-adjustment-1",
      }),
    });
    assert.equal(adjustment.status, 201, JSON.stringify(await adjustment.json()));
    const adjustmentReplay = await fetch(`${workOrderPath}/adjustments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        amountMinor: 500,
        reason: "Rush delivery premium",
        idempotencyKey: "phase5-adjustment-1",
      }),
    });
    assert.equal(adjustmentReplay.status, 200, JSON.stringify(await adjustmentReplay.json()));
    assert.equal(adjustmentReplay.headers.get("idempotency-replayed"), "true");
    const adjustmentMismatch = await fetch(`${workOrderPath}/adjustments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        amountMinor: 600,
        reason: "Different premium",
        idempotencyKey: "phase5-adjustment-1",
      }),
    });
    assert.equal(adjustmentMismatch.status, 409);
  });

  await withAccessApi(disputeViewerUser, async (baseUrl) => {
    const denied = await fetch(
      `${baseUrl}/organizations/${agencyId}/vendor-relationships/${vendorRelationshipId}/work-orders/${phase5WorkOrderId}/disputes`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "A viewer must not freeze payables" }),
      },
    );
    assert.equal(denied.status, 403, JSON.stringify(await denied.json()));
  });

  await withAccessApi(agencyOwnerUser, async (baseUrl) => {
    const opened = await fetch(
      `${baseUrl}/organizations/${agencyId}/vendor-relationships/${vendorRelationshipId}/work-orders/${phase5WorkOrderId}/disputes`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Please confirm the rush premium" }),
      },
    );
    const openedBody = await opened.json();
    assert.equal(opened.status, 201, JSON.stringify(openedBody));
    phase5DisputeId = openedBody.dispute.id;
  });

  let phase5StatementId;
  await withAccessApi(directUser, async (baseUrl) => {
    const headers = { "content-type": "application/json" };
    const workOrderPath = `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/work-orders/${phase5WorkOrderId}`;
    const blocked = await fetch(`${workOrderPath}/transitions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "payable_approve" }),
    });
    assert.equal(blocked.status, 409);

    const resolved = await fetch(`${workOrderPath}/disputes/${phase5DisputeId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        status: "resolved",
        resolution: "Rush premium confirmed against the statement of work",
      }),
    });
    assert.equal(resolved.status, 200, JSON.stringify(await resolved.json()));

    const payable = await fetch(`${workOrderPath}/transitions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "payable_approve" }),
    });
    assert.equal(payable.status, 200, JSON.stringify(await payable.json()));

    const statementPath = `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/payable-statements`;
    const statement = await fetch(statementPath, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workOrderIds: [phase5WorkOrderId],
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
      }),
    });
    const statementBody = await statement.json();
    assert.equal(statement.status, 201, JSON.stringify(statementBody));
    phase5StatementId = statementBody.statement.id;
    assert.equal(statementBody.statement.items[0].amountMinor, "18000");
    let statementListQueries = 0;
    setDatabaseTestHooks({ onQuery: () => { statementListQueries += 1; } });
    const statementList = await fetch(statementPath)
      .finally(() => setDatabaseTestHooks({}));
    assert.equal(statementList.status, 200);
    assert.deepEqual((await statementList.json()).page, {
      limit: 250,
      hasMore: false,
      nextBeforeStatementNumber: null,
    });
    boundedStatementListQueries = statementListQueries;

    const competingStatementId = await scalar(
      `insert into payable_statements(
         vendor_relationship_id, statement_number, currency, period_start,
         period_end
       ) values($1, 999, 'USD', '2026-07-01', '2026-07-31') returning id`,
      [vendorRelationshipId],
    );
    await rejectsConstraint(
      pool.query(
        `insert into payable_statement_items(
           payable_statement_id, work_order_id, amount_minor
         ) values($1, $2, 18000)`,
        [competingStatementId, phase5WorkOrderId],
      ),
      "payable_statement_item_current_unique",
    );

    const finalized = await fetch(`${statementPath}/${phase5StatementId}/transitions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "finalize" }),
    });
    const finalizedBody = await finalized.json();
    assert.equal(finalized.status, 200, JSON.stringify(finalizedBody));
    assert.equal(finalizedBody.statement.status, "finalized");
    assert.equal(finalizedBody.statement.subtotalMinor, "18000");
  });

  let phase5PaymentId;
  const paidAt = new Date(Date.now() - 60_000).toISOString();
  await withAccessApi(agencyOwnerUser, async (baseUrl) => {
    const paymentPath = `${baseUrl}/organizations/${agencyId}/vendor-relationships/${vendorRelationshipId}/payable-statements/${phase5StatementId}/payments`;
    const body = {
      amountMinor: 18000,
      paymentMethod: "wire",
      externalReference: "WIRE-PHASE5-001",
      paidAt,
      idempotencyKey: "phase5-payment-1",
    };
    const reported = await fetch(paymentPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const reportedBody = await reported.json();
    assert.equal(reported.status, 201, JSON.stringify(reportedBody));
    phase5PaymentId = reportedBody.payment.id;
    assert.equal(reportedBody.payment.status, "reported");

    const replayed = await fetch(paymentPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(replayed.status, 200, JSON.stringify(await replayed.json()));
    assert.equal(replayed.headers.get("idempotency-replayed"), "true");

    const mismatch = await fetch(paymentPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, amountMinor: 17000 }),
    });
    assert.equal(mismatch.status, 409);
  });

  await withAccessApi(directUser, async (baseUrl) => {
    const decided = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/payable-statements/${phase5StatementId}/payments/${phase5PaymentId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "confirmed" }),
      },
    );
    const decidedBody = await decided.json();
    assert.equal(decided.status, 200, JSON.stringify(decidedBody));
    assert.equal(decidedBody.statement.status, "paid");
    assert.equal(
      await scalar("select status from work_orders where id = $1", [phase5WorkOrderId]),
      "paid",
    );
  });

  await withAccessApi(agencyOwnerUser, async (baseUrl) => {
    const replayedAfterSettlement = await fetch(
      `${baseUrl}/organizations/${agencyId}/vendor-relationships/${vendorRelationshipId}/payable-statements/${phase5StatementId}/payments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amountMinor: 18000,
          paymentMethod: "wire",
          externalReference: "WIRE-PHASE5-001",
          paidAt,
          idempotencyKey: "phase5-payment-1",
        }),
      },
    );
    const replayBody = await replayedAfterSettlement.json();
    assert.equal(replayedAfterSettlement.status, 200, JSON.stringify(replayBody));
    assert.equal(replayedAfterSettlement.headers.get("idempotency-replayed"), "true");
    assert.equal(replayBody.statement.status, "paid");
  });

  await pool.query(
    `update payment_records
     set reported_by_user_id = null, confirmed_by_user_id = null
     where id = $1`,
    [phase5PaymentId],
  );

  assert.equal(
    await scalar(
      `select count(*)::int from audit_events
       where resource_id = $1
         and action = 'work_order.created'
         and organization_id in ($2, $3)`,
      [phase5WorkOrderId, customerA, agencyId],
    ),
    2,
  );
  assert.equal(
    await scalar(
      `select count(*)::int from audit_events
       where resource_id = $1
         and action = 'payable_statement.paid'
         and organization_id in ($2, $3)`,
      [phase5StatementId, customerA, agencyId],
    ),
    2,
  );
  await rejectsConstraint(
    pool.query(
      `insert into work_assignments(
         work_order_id, agency_membership_id, assigned_by_party
       ) values($1, $2, 'customer')`,
      [phase5WorkOrderId, directMembership],
    ),
    "work_assignment_agency_owner",
  );
  const phase5LedgerId = await scalar(
    "select id from work_ledger_entries where work_order_id = $1 limit 1",
    [phase5WorkOrderId],
  );
  await pool.query(
    "update work_ledger_entries set created_by_user_id = null where id = $1",
    [phase5LedgerId],
  );
  await rejectsConstraint(
    pool.query("update work_ledger_entries set amount_minor = 1 where id = $1", [phase5LedgerId]),
    "work_ledger_append_only",
  );
  await rejectsConstraint(
    pool.query("update work_orders set title = 'Changed' where id = $1", [phase5WorkOrderId]),
    "work_order_immutable",
  );

  // Phase 7C-7F: create a fresh payable, collect it through platform Checkout,
  // reconcile availability, release and partially reverse its transfer, then
  // record a provider-confirmed partial refund and late payout failure.
  process.env.HEDGELING_FACILITATED_COLLECTION_ENABLED = "true";
  process.env.HEDGELING_FACILITATED_TRANSFERS_ENABLED = "true";
  process.env.HEDGELING_FACILITATED_REFUNDS_ENABLED = "true";
  process.env.HEDGELING_ACH_TRANSFER_HOLD_DAYS = "7";
  process.env.STRIPE_VENDOR_PAYMENT_SUCCESS_URL = "http://localhost:4173/";
  process.env.STRIPE_VENDOR_PAYMENT_CANCEL_URL = "http://localhost:4173/";
  const phase7Calls = {
    customers: [],
    checkout: [],
    transfers: [],
    transferLists: [],
    reversals: [],
    refunds: [],
    payoutLists: [],
    payoutRetrievals: [],
  };
  let phase7Session = null;
  let phase7RetrievedSession = null;
  let phase7Intent = null;
  let failNextPhase7Reversal = false;
  let phase7TransferInFlightConflicts = 0;
  let phase7ReversalInFlightConflicts = 0;
  let phase7ConcurrentReversal = null;
  let phase7TransferGate = null;
  let phase7ListedTransfers = [];
  let phase7PayoutPages = [];
  let phase7PayoutsById = new Map();
  let failNextPhase7PayoutList = false;
  let phase7PayoutListGate = null;
  const phase7InFlightError = () => Object.assign(
    new Error("There is currently another in-progress request using this Idempotency Key"),
    {
      type: "StripeIdempotencyError",
      code: "idempotency_key_in_use",
      statusCode: 409,
    },
  );
  setFacilitatedPaymentsTestClient({
    customers: {
      async create(params, options) {
        phase7Calls.customers.push({ params, options });
        return { id: "cus_Phase7Customer" };
      },
    },
    checkout: {
      sessions: {
        async create(params, options) {
          phase7Calls.checkout.push({ params, options });
          const sessionNumber = phase7Calls.checkout.length;
          phase7Session = {
            id: `cs_test_phase7_${sessionNumber}`,
            object: "checkout.session",
            url: "https://checkout.stripe.test/phase7",
            created: 1_800_010_000,
            expires_at: 1_800_013_600,
            status: "open",
            payment_status: "unpaid",
            payment_intent: null,
            amount_total: params.line_items[0].price_data.unit_amount,
            currency: "usd",
            client_reference_id: params.client_reference_id,
            metadata: params.metadata,
            payment_method_types: params.payment_method_types,
          };
          return phase7Session;
        },
        async retrieve(sessionId) {
          assert.equal(sessionId, phase7Session.id);
          return phase7RetrievedSession || phase7Session;
        },
        async expire() {},
      },
    },
    paymentIntents: {
      async retrieve(intentId) {
        assert.equal(intentId, phase7Intent.id);
        const chargeId = typeof phase7Intent.latest_charge === "string"
          ? phase7Intent.latest_charge
          : phase7Intent.latest_charge?.id || "ch_phase7";
        const method = phase7Intent.payment_method_types?.[0] || "card";
        return {
          ...phase7Intent,
          latest_charge: {
            id: chargeId,
            payment_method_details: { type: method },
            balance_transaction: {
              id: `txn_${chargeId}`,
              status: "available",
              available_on: Math.floor(Date.now() / 1000) - 60,
            },
          },
        };
      },
    },
    transfers: {
      async create(params, options) {
        phase7Calls.transfers.push({ params, options });
        if (phase7TransferInFlightConflicts > 0) {
          phase7TransferInFlightConflicts -= 1;
          throw phase7InFlightError();
        }
        if (phase7TransferGate) {
          const gate = phase7TransferGate;
          gate.calls += 1;
          gate.entered();
          await gate.ready;
          if (gate.error) throw gate.error;
        }
        return {
          id: `tr_phase7_${params.metadata.hedgeling_transfer_instruction_id.replaceAll("-", "")}`,
        };
      },
      async list(params) {
        phase7Calls.transferLists.push(params);
        return {
          object: "list",
          data: phase7ListedTransfers,
          has_more: false,
        };
      },
      async createReversal(transferId, params, options) {
        phase7Calls.reversals.push({ transferId, params, options });
        if (failNextPhase7Reversal) {
          failNextPhase7Reversal = false;
          throw new Error("Simulated provider reversal failure");
        }
        if (phase7ReversalInFlightConflicts > 0) {
          phase7ReversalInFlightConflicts -= 1;
          throw phase7InFlightError();
        }
        if (phase7ConcurrentReversal) {
          phase7ConcurrentReversal.calls += 1;
          if (phase7ConcurrentReversal.calls === 2) {
            phase7ConcurrentReversal.release();
          }
          await phase7ConcurrentReversal.ready;
          return { id: phase7ConcurrentReversal.providerId };
        }
        return { id: `trr_phase7_${phase7Calls.reversals.length}` };
      },
    },
    refunds: {
      async create(params, options) {
        phase7Calls.refunds.push({ params, options });
        return {
          id: "re_phase7",
          object: "refund",
          status: "succeeded",
          amount: params.amount,
          currency: "usd",
          charge: params.charge,
          metadata: params.metadata,
        };
      },
    },
    payouts: {
      async list(params, options) {
        phase7Calls.payoutLists.push({ params, options });
        if (phase7PayoutListGate) {
          const gate = phase7PayoutListGate;
          gate.entered();
          await gate.ready;
        }
        if (failNextPhase7PayoutList) {
          failNextPhase7PayoutList = false;
          throw new Error("Simulated Stripe payout-list outage");
        }
        return phase7PayoutPages.shift() || {
          object: "list",
          data: [],
          has_more: false,
          lastResponse: { requestId: `req_payout_${phase7Calls.payoutLists.length}` },
        };
      },
      async retrieve(payoutId, params, options) {
        phase7Calls.payoutRetrievals.push({ payoutId, params, options });
        const payout = phase7PayoutsById.get(payoutId);
        if (!payout) throw new Error(`No test payout fixture for ${payoutId}`);
        return {
          ...payout,
          lastResponse: { requestId: `req_retrieve_${payoutId}` },
        };
      },
    },
  });

  let productionReadinessFixtureNumber = 0;
  async function createProductionReadinessAttempt({
    suffix,
    amountMinor,
    paymentMethodType = "card",
  }) {
    productionReadinessFixtureNumber += 1;
    const providerCreated = 1_800_020_000 + productionReadinessFixtureNumber * 100;
    const fixtureClient = await pool.connect();
    let statement;
    let attempt;
    try {
      await fixtureClient.query("begin");
      const workOrder = await fixtureClient.query(
        `insert into work_orders(
           vendor_relationship_id, work_order_number, project_id, title,
           description, service_type, source_locale, target_locale,
           content_classification, match_band, unit_type, estimated_units,
           due_at, created_by_user_id
         )
         select source.vendor_relationship_id,
                (
                  select coalesce(max(existing.work_order_number), 0) + 1
                  from work_orders existing
                  where existing.vendor_relationship_id = source.vendor_relationship_id
                ),
                source.project_id, $2, source.description,
                source.service_type, source.source_locale, source.target_locale,
                source.content_classification, source.match_band,
                source.unit_type, source.estimated_units, source.due_at, $3
         from work_orders source where source.id = $1
         returning id`,
        [
          phase7WorkOrderId,
          `Production readiness ${suffix}`,
          directUser,
        ],
      ).then((result) => result.rows[0]);
      await fixtureClient.query(
        `update work_orders target
         set status = 'offered', rate_card_id = source.rate_card_id,
             rate_card_line_id = source.rate_card_line_id,
             snapshot_currency = source.snapshot_currency,
             snapshot_currency_exponent = source.snapshot_currency_exponent,
             snapshot_unit_rate = source.snapshot_unit_rate,
             snapshot_minimum_units = source.snapshot_minimum_units,
             snapshot_minimum_charge_minor = source.snapshot_minimum_charge_minor,
             snapshot_payment_terms_days = source.snapshot_payment_terms_days,
             offered_by_user_id = $3, offered_at = now(), updated_at = now()
         from work_orders source
         where target.id = $1 and source.id = $2`,
        [workOrder.id, phase7WorkOrderId, directUser],
      );
      await fixtureClient.query(
        `update work_orders
         set status = 'accepted', accepted_by_user_id = $2,
             accepted_at = now(), updated_at = now()
         where id = $1`,
        [workOrder.id, agencyOwnerUser],
      );
      await fixtureClient.query(
        `update work_orders
         set status = 'submitted', submitted_at = now(), updated_at = now()
         where id = $1`,
        [workOrder.id],
      );
      await fixtureClient.query(
        `update work_orders
         set status = 'quality_approved', quality_approved_by_user_id = $2,
             quality_approved_at = now(), updated_at = now()
         where id = $1`,
        [workOrder.id, phase5ReviewerUser],
      );
      await fixtureClient.query(
        `update work_orders
         set status = 'payable_approved', payable_approved_by_user_id = $2,
             payable_approved_at = now(), updated_at = now()
         where id = $1`,
        [workOrder.id, directUser],
      );
      statement = await fixtureClient.query(
        `insert into payable_statements(
           vendor_relationship_id, statement_number, currency, period_start,
           period_end, created_by_user_id
         )
         select $1, coalesce(max(statement_number), 0) + 1, 'USD',
                date '2026-09-01', date '2026-09-30', $2
         from payable_statements where vendor_relationship_id = $1
         returning id`,
        [vendorRelationshipId, directUser],
      ).then((result) => result.rows[0]);
      await fixtureClient.query(
        `insert into payable_statement_items(
           payable_statement_id, work_order_id, amount_minor
         ) values($1, $2, $3)`,
        [statement.id, workOrder.id, amountMinor],
      );
      await fixtureClient.query(
        `update payable_statements
         set status = 'finalized', subtotal_minor = $2,
             due_date = date '2026-10-30', finalized_by_user_id = $3,
             finalized_at = now(), updated_at = now()
         where id = $1`,
        [statement.id, amountMinor, directUser],
      );
      await fixtureClient.query(
        `update work_orders
         set status = 'included_in_statement', updated_at = now()
         where id = $1`,
        [workOrder.id],
      );
      attempt = await fixtureClient.query(
        `insert into facilitated_payment_attempts(
           payable_statement_id, vendor_relationship_id,
           customer_organization_id, agency_organization_id,
           connected_account_id, provider_mode, attempt_number, amount_minor,
           currency, state, checkout_status, provider_session_id,
           provider_session_url, provider_session_expires_at,
           provider_payment_intent_id, payment_method_type,
           provider_state_updated_at, idempotency_key, request_fingerprint,
           created_by_user_id
         ) values(
           $1,$2,$3,$4,$5,'test',1,$6,'USD','processing','complete',$7,
           $8,to_timestamp($9),$10,$11,to_timestamp($12),$13,$14,$15
         ) returning id`,
        [
          statement.id,
          vendorRelationshipId,
          customerA,
          agencyId,
          connectedAccountId,
          amountMinor,
          `cs_test_readiness_${suffix}`,
          `https://checkout.stripe.test/readiness/${suffix}`,
          providerCreated + 3600,
          `pi_readiness_${suffix}`,
          paymentMethodType,
          providerCreated - 1,
          `readiness-${suffix}`,
          "a".repeat(64),
          directUser,
        ],
      ).then((result) => result.rows[0]);
      await fixtureClient.query("commit");
    } catch (error) {
      await fixtureClient.query("rollback");
      throw error;
    } finally {
      fixtureClient.release();
    }
    const metadata = {
      hedgeling_payment_attempt_id: attempt.id,
      hedgeling_statement_id: statement.id,
      hedgeling_customer_organization_id: customerA,
      hedgeling_agency_organization_id: agencyId,
      hedgeling_connected_account_id: connectedAccountId,
      hedgeling_provider_mode: "test",
    };
    return {
      suffix,
      amountMinor: String(amountMinor),
      paymentMethodType,
      providerCreated,
      statementId: statement.id,
      attemptId: attempt.id,
      session: {
        id: `cs_test_readiness_${suffix}`,
        object: "checkout.session",
        status: "complete",
        payment_status: "paid",
        created: providerCreated - 10,
        amount_total: Number(amountMinor),
        currency: "usd",
        payment_intent: `pi_readiness_${suffix}`,
        metadata,
      },
      intent: {
        id: `pi_readiness_${suffix}`,
        object: "payment_intent",
        status: "succeeded",
        amount: Number(amountMinor),
        currency: "usd",
        created: providerCreated,
        latest_charge: `ch_readiness_${suffix}`,
        payment_method_types: [paymentMethodType],
        metadata,
      },
    };
  }

  async function succeedProductionReadinessAttempt(fixture) {
    const event = {
      id: `evt_readiness_${fixture.suffix}_succeeded`,
      type: "payment_intent.succeeded",
      livemode: false,
      created: fixture.providerCreated,
      data: { object: fixture.intent },
    };
    const outcome = await handleFacilitatedPaymentEvent(event);
    const paymentId = await scalar(
      "select id from facilitated_payments where payment_attempt_id = $1",
      [fixture.attemptId],
    );
    const transferId = await scalar(
      `select id from facilitated_transfer_instructions
       where facilitated_payment_id = $1`,
      [paymentId],
    );
    return { event, outcome, paymentId, transferId };
  }

  // Restore the agency account after the earlier regression-webhook test.
  providerAccount = {
    ...providerAccount,
    capabilities: { transfers: "active" },
    payouts_enabled: true,
    details_submitted: true,
    requirements: {
      currently_due: [],
      eventually_due: [],
      past_due: [],
      pending_verification: [],
      disabled_reason: null,
      current_deadline: null,
    },
  };
  await handleFacilitatedPaymentEvent({
    id: "evt_phase7_account_ready",
    type: "account.updated",
    account: providerAccount.id,
    livemode: false,
    created: connectEventTime + 120,
    data: { object: providerAccount },
  });

  let phase7WorkOrderId;
  await withAccessApi(directUser, async (baseUrl) => {
    const workOrderPath = `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/work-orders`;
    const created = await fetch(workOrderPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: projectA,
        title: "Phase 7 payment certification",
        serviceType: "editing",
        unitType: "hour",
        sourceLocale: "en-US",
        targetLocale: "fr-CA",
        estimatedUnits: "1",
        sourceStringIds: [phase5UnassignedSource],
      }),
    });
    const body = await created.json();
    assert.equal(created.status, 201, JSON.stringify(body));
    phase7WorkOrderId = body.workOrder.id;
    const offered = await fetch(`${workOrderPath}/${phase7WorkOrderId}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "offer" }),
    });
    assert.equal(offered.status, 200, JSON.stringify(await offered.json()));
  });
  let phase7AssignmentId;
  await withAccessApi(agencyOwnerUser, async (baseUrl) => {
    const path = `${baseUrl}/organizations/${agencyId}/vendor-relationships/${vendorRelationshipId}/work-orders/${phase7WorkOrderId}`;
    const accepted = await fetch(`${path}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "accept" }),
    });
    assert.equal(accepted.status, 200, JSON.stringify(await accepted.json()));
  });
  await withAccessApi(directUser, async (baseUrl) => {
    const assignment = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/work-orders/${phase7WorkOrderId}/assignments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agencyMembershipId: agencyLinguistMembership,
          assignmentRole: "translator",
        }),
      },
    );
    const body = await assignment.json();
    assert.equal(assignment.status, 201, JSON.stringify(body));
    phase7AssignmentId = body.assignment.id;
  });
  await withPersonalWorkApi(agencyLinguistUser, async (baseUrl) => {
    for (const [suffix, body] of [
      ["start", {}],
      ["submit", {
        deliveredUnits: "1",
        notes: "Phase 7 certification delivery",
        idempotencyKey: "phase7-delivery",
      }],
    ]) {
      const response = await fetch(`${baseUrl}/assignments/${phase7AssignmentId}/${suffix}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.ok([200, 201].includes(response.status), JSON.stringify(await response.json()));
    }
  });
  await withAccessApi(phase5ReviewerUser, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/work-orders/${phase7WorkOrderId}/transitions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "quality_approve" }),
      },
    );
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  });
  let phase7StatementId;
  await withAccessApi(directUser, async (baseUrl) => {
    const workPath = `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/work-orders/${phase7WorkOrderId}`;
    const payable = await fetch(`${workPath}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "payable_approve" }),
    });
    assert.equal(payable.status, 200, JSON.stringify(await payable.json()));
    const statementPath = `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/payable-statements`;
    const statement = await fetch(statementPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workOrderIds: [phase7WorkOrderId],
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
      }),
    });
    const statementBody = await statement.json();
    assert.equal(statement.status, 201, JSON.stringify(statementBody));
    phase7StatementId = statementBody.statement.id;
    const finalized = await fetch(`${statementPath}/${phase7StatementId}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "finalize" }),
    });
    assert.equal(finalized.status, 200, JSON.stringify(await finalized.json()));
  });
  await withAccessApi(phase5ReviewerUser, async (baseUrl) => {
    let queryCount = 0;
    setDatabaseTestHooks({ onQuery: () => { queryCount += 1; } });
    const response = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/work-orders`,
    ).finally(() => setDatabaseTestHooks({}));
    assert.equal(response.status, 200);
    assert.equal(queryCount, boundedWorkOrderListQueries);
  });
  await withAccessApi(directUser, async (baseUrl) => {
    let queryCount = 0;
    setDatabaseTestHooks({ onQuery: () => { queryCount += 1; } });
    const response = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/payable-statements`,
    ).finally(() => setDatabaseTestHooks({}));
    assert.equal(response.status, 200);
    assert.equal(queryCount, boundedStatementListQueries);
  });

  let phase7AttemptId;
  await withAccessApi(directUser, async (baseUrl) => {
    const paymentPath = `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/payable-statements/${phase7StatementId}`;
    const session = await fetch(`${paymentPath}/payment-session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "phase7-checkout",
      },
      body: "{}",
    });
    const sessionBody = await session.json();
    assert.equal(session.status, 201, JSON.stringify(sessionBody));
    phase7AttemptId = sessionBody.attempt.id;
    assert.equal(sessionBody.attempt.url, "https://checkout.stripe.test/phase7");
    const replay = await fetch(`${paymentPath}/payment-session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "phase7-checkout",
      },
      body: "{}",
    });
    assert.equal(replay.status, 200, JSON.stringify(await replay.json()));
  });

  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const openReconciliation = await fetch(
      `${baseUrl}/facilitated-payments/attempts/${phase7AttemptId}/reconcile`,
      { method: "POST" },
    );
    const openBody = await openReconciliation.json();
    assert.equal(openReconciliation.status, 200, JSON.stringify(openBody));
    assert.equal(openBody.attempt.state, "requires_action");
    assert.equal(openBody.attempt.checkoutStatus, "open");

    const generalReconciliation = await fetch(
      `${baseUrl}/facilitated-payments/reconcile`,
      { method: "POST" },
    );
    const generalBody = await generalReconciliation.json();
    assert.equal(generalReconciliation.status, 200, JSON.stringify(generalBody));
    assert.equal(
      generalBody.outcomes.some((outcome) => (
        outcome.id === phase7AttemptId
        && outcome.resourceType === "facilitated_payment_attempt"
        && outcome.status === "reconciled"
      )),
      true,
    );
  });
  const expiredAttemptId = phase7AttemptId;
  const abandonedIntent = {
    id: "pi_phase7_abandoned",
    object: "payment_intent",
    status: "canceled",
    amount: phase7Session.amount_total,
    currency: "usd",
    created: phase7Session.created + 60,
    payment_method_types: ["card"],
    cancellation_reason: "abandoned",
    metadata: phase7Session.metadata,
  };
  await handleFacilitatedPaymentEvent({
    id: "evt_phase7_intent_canceled_before_expiry",
    type: "payment_intent.canceled",
    livemode: false,
    created: abandonedIntent.created,
    data: { object: abandonedIntent },
  });
  const terminalBeforeExpiry = await pool.query(
    `select state, checkout_status as "checkoutStatus",
            completed_at::text as "completedAt"
     from facilitated_payment_attempts where id = $1`,
    [expiredAttemptId],
  ).then((result) => result.rows[0]);
  assert.equal(terminalBeforeExpiry.state, "canceled");
  assert.equal(terminalBeforeExpiry.checkoutStatus, "open");

  assert.deepEqual(await handleFacilitatedPaymentEvent({
    id: "evt_phase7_checkout_expired",
    type: "checkout.session.expired",
    livemode: false,
    created: phase7Session.expires_at,
    data: {
      object: {
        ...phase7Session,
        status: "expired",
        payment_intent: abandonedIntent.id,
      },
    },
  }), {
    duplicate: false,
    status: "processed",
  });
  assert.deepEqual(
    await pool.query(
      `select state, checkout_status as "checkoutStatus",
              completed_at::text as "completedAt"
       from facilitated_payment_attempts where id = $1`,
      [expiredAttemptId],
    ).then((result) => result.rows[0]),
    {
      state: "canceled",
      checkoutStatus: "expired",
      completedAt: terminalBeforeExpiry.completedAt,
    },
  );

  // A terminal attempt retains history but no longer blocks external
  // settlement or voiding. Verify both database guards without changing the
  // shared statement fixture.
  const terminalGuardClient = await pool.connect();
  try {
    try {
      await terminalGuardClient.query("begin");
      await terminalGuardClient.query(
        `insert into payment_records(
           payable_statement_id, amount_minor, currency, status, payment_method,
           external_reference, paid_at, reported_by_party, reported_by_user_id,
           idempotency_key
         ) values($1, 1, 'USD', 'reported', 'wire', 'TERMINAL-ATTEMPT-ALLOWED',
                  now(), 'agency', $2, 'terminal-attempt-external')`,
        [phase7StatementId, agencyOwnerUser],
      );
    } finally {
      await terminalGuardClient.query("rollback");
    }

    try {
      await terminalGuardClient.query("begin");
      await terminalGuardClient.query(
        `update payable_statements
         set status = 'void', voided_by_user_id = $2, voided_at = now(),
             void_reason = 'Terminal attempt no longer blocks voiding',
             updated_at = now()
         where id = $1`,
        [phase7StatementId, directUser],
      );
    } finally {
      await terminalGuardClient.query("rollback");
    }
  } finally {
    terminalGuardClient.release();
  }

  await withAccessApi(directUser, async (baseUrl) => {
    const paymentPath = `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/payable-statements/${phase7StatementId}`;
    const replacement = await fetch(`${paymentPath}/payment-session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "phase7-checkout-replacement",
      },
      body: "{}",
    });
    const replacementBody = await replacement.json();
    assert.equal(replacement.status, 201, JSON.stringify(replacementBody));
    phase7AttemptId = replacementBody.attempt.id;
    assert.notEqual(phase7AttemptId, expiredAttemptId);
  });

  const activeCheckout = phase7Calls.checkout.at(-1);
  assert.deepEqual(activeCheckout.params.payment_method_types, [
    "card",
    "us_bank_account",
  ]);
  assert.equal(activeCheckout.params.payment_intent_data.transfer_data, undefined);
  assert.equal(
    activeCheckout.options.idempotencyKey,
    `hedgeling-checkout-${phase7AttemptId}`,
  );

  phase7Intent = {
    id: "pi_phase7",
    object: "payment_intent",
    status: "succeeded",
    amount: phase7Session.amount_total,
    currency: "usd",
    created: Math.floor(Date.now() / 1000) - 120,
    latest_charge: "ch_phase7",
    payment_method_types: ["card"],
    metadata: phase7Session.metadata,
  };
  phase7RetrievedSession = {
    ...phase7Session,
    status: "complete",
    payment_status: "paid",
    payment_intent: phase7Intent.id,
  };
  await handleFacilitatedPaymentEvent({
    id: "evt_phase7_checkout_complete",
    type: "checkout.session.completed",
    livemode: false,
    created: phase7Intent.created - 2,
    data: {
      object: {
        ...phase7Session,
        status: "complete",
        payment_status: "paid",
        payment_intent: phase7Intent.id,
      },
    },
  });
  await handleFacilitatedPaymentEvent({
    id: "evt_phase7_payment_succeeded",
    type: "payment_intent.succeeded",
    livemode: false,
    created: phase7Intent.created,
    data: { object: phase7Intent },
  });
  assert.equal(
    await scalar("select status from payable_statements where id = $1", [phase7StatementId]),
    "paid",
  );
  assert.equal(
    await scalar(
      `select record_source from payment_records where payable_statement_id = $1`,
      [phase7StatementId],
    ),
    "facilitated",
  );
  await withAccessApi(directUser, async (baseUrl) => {
    const external = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/payable-statements/${phase7StatementId}/payments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amountMinor: phase7Session.amount_total,
          paymentMethod: "wire",
          externalReference: "MIXED-RAIL-DENIED",
          paidAt,
          idempotencyKey: "phase7-mixed-rail",
        }),
      },
    );
    assert.equal(external.status, 409);
  });

  let phase7TransferId;
  let phase7RefundId;
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const reconciliation = await fetch(
      `${baseUrl}/facilitated-payments/attempts/${phase7AttemptId}/reconcile`,
      { method: "POST" },
    );
    assert.equal(reconciliation.status, 200, JSON.stringify(await reconciliation.json()));
    phase7TransferId = await scalar(
      `select transfer.id from facilitated_transfer_instructions transfer
       join facilitated_payments payment on payment.id = transfer.facilitated_payment_id
       where payment.payable_statement_id = $1`,
      [phase7StatementId],
    );
  });

  const disputeBase = {
    id: "dp_phase7_card",
    object: "dispute",
    amount: phase7Session.amount_total,
    currency: "usd",
    charge: "ch_phase7",
    payment_intent: phase7Intent.id,
    payment_method_details: { type: "card" },
    reason: "fraudulent",
    created: phase7Intent.created + 10,
    evidence_details: { due_by: phase7Intent.created + 86_400 },
  };
  const warningDispute = { ...disputeBase, id: "dp_phase7_card_warning" };
  await handleFacilitatedPaymentEvent({
    id: "evt_phase7_dispute_warning",
    type: "charge.dispute.created",
    livemode: false,
    created: warningDispute.created,
    data: { object: { ...warningDispute, status: "warning_needs_response" } },
  });
  await handleFacilitatedPaymentEvent({
    id: "evt_phase7_dispute_warning_closed",
    type: "charge.dispute.closed",
    livemode: false,
    created: warningDispute.created + 30,
    data: { object: { ...warningDispute, status: "warning_closed" } },
  });
  assert.equal(
    await scalar(
      "select status from facilitated_provider_disputes where provider_dispute_id = $1",
      [warningDispute.id],
    ),
    "warning_closed",
  );
  assert.equal(
    await scalar(
      `select fact_type from facilitated_funding_facts
       where provider_object_id = $1 and fact_type = 'dispute_warning_closed'`,
      [warningDispute.id],
    ),
    "dispute_warning_closed",
  );
  assert.deepEqual(await handleFacilitatedPaymentEvent({
    id: "evt_phase7_dispute_created",
    type: "charge.dispute.created",
    livemode: false,
    created: disputeBase.created,
    data: { object: { ...disputeBase, status: "needs_response" } },
  }), {
    duplicate: false,
    status: "processed",
  });
  assert.equal(
    await scalar(
      "select status from facilitated_provider_disputes where provider_dispute_id = $1",
      [disputeBase.id],
    ),
    "needs_response",
  );
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const blocked = await fetch(
      `${baseUrl}/facilitated-payments/transfers/${phase7TransferId}/release`,
      { method: "POST" },
    );
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 409, JSON.stringify(blockedBody));
    assert.ok(blockedBody.details.reasons.includes("funding_exception"));
    assert.equal(phase7Calls.transfers.length, 0);
  });
  assert.deepEqual(await handleFacilitatedPaymentEvent({
    id: "evt_phase7_dispute_won",
    type: "charge.dispute.closed",
    livemode: false,
    created: disputeBase.created + 60,
    data: { object: { ...disputeBase, status: "won" } },
  }), {
    duplicate: false,
    status: "processed",
  });

  // Simulate a process exit after the release claim commits but before the
  // stable Stripe call/local finalization. General reconciliation must resume
  // that already-approved submission without creating a second transfer.
  await pool.query(
    `update facilitated_transfer_instructions
     set state = 'submitting', released_by_user_id = $2,
         release_claimed_at = now() - interval '10 minutes',
         updated_at = now() - interval '10 minutes'
     where id = $1`,
    [phase7TransferId, directUser],
  );
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    phase7TransferInFlightConflicts = 1;
    const inFlight = await fetch(
      `${baseUrl}/facilitated-payments/transfers/${phase7TransferId}/release`,
      { method: "POST" },
    );
    const inFlightBody = await inFlight.json();
    assert.equal(inFlight.status, 409, JSON.stringify(inFlightBody));
    assert.equal(inFlightBody.code, "provider_request_in_flight");
    assert.equal(
      await scalar(
        "select state from facilitated_transfer_instructions where id = $1",
        [phase7TransferId],
      ),
      "submitting",
    );

    const reconciliation = await fetch(
      `${baseUrl}/facilitated-payments/reconcile`,
      { method: "POST" },
    );
    const reconciliationBody = await reconciliation.json();
    assert.equal(reconciliation.status, 200, JSON.stringify(reconciliationBody));
    assert.equal(
      reconciliationBody.outcomes.some((outcome) => (
        outcome.id === phase7TransferId
        && outcome.resourceType === "facilitated_transfer_instruction"
        && outcome.status === "reconciled"
      )),
      true,
    );
    const released = await fetch(
      `${baseUrl}/facilitated-payments/transfers/${phase7TransferId}/release`,
      { method: "POST" },
    );
    assert.equal(released.status, 200, JSON.stringify(await released.json()));
    assert.equal(phase7Calls.transfers[0].params.destination, providerAccount.id);
    assert.equal(phase7Calls.transfers[0].params.source_transaction, "ch_phase7");
    assert.equal(phase7Calls.transfers.length, 2);
    assert.equal(
      phase7Calls.transfers[0].options.idempotencyKey,
      phase7Calls.transfers[1].options.idempotencyKey,
    );
  });

  await withAccessApi(directUser, async (baseUrl) => {
    const refund = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/payable-statements/${phase7StatementId}/refund-requests`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "phase7-refund",
        },
        body: JSON.stringify({
          amountMinor: "1000",
          reason: "Customer-approved service credit",
          reference: "CREDIT-PHASE7",
        }),
      },
    );
    const body = await refund.json();
    assert.equal(refund.status, 201, JSON.stringify(body));
    phase7RefundId = body.refund.id;
  });
  const phase7PaymentId = await scalar(
    "select id from facilitated_payments where payable_statement_id = $1",
    [phase7StatementId],
  );
  await withPlatformPaymentsApi({
    principalType: "service_account",
    platformAdmin: true,
    serviceAccount: { id: "phase7-service-account" },
  }, async (baseUrl) => {
    const denied = await fetch(
      `${baseUrl}/facilitated-payments/payments/${phase7PaymentId}/refunds`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "phase7-service-refund",
        },
        body: JSON.stringify({
          amountMinor: "1",
          reason: "Service accounts cannot decide money movement",
          reference: "SERVICE-DENIED",
        }),
      },
    );
    assert.equal(denied.status, 403, JSON.stringify(await denied.json()));
  });
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const overRefund = await fetch(
      `${baseUrl}/facilitated-payments/payments/${phase7PaymentId}/refunds`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "phase7-over-refund",
        },
        body: JSON.stringify({
          amountMinor: String(phase7Session.amount_total),
          reason: "This would exceed the original collection",
          reference: "OVER-REFUND-DENIED",
        }),
      },
    );
    const overRefundBody = await overRefund.json();
    assert.equal(overRefund.status, 409, JSON.stringify(overRefundBody));
    assert.match(overRefundBody.error, /cannot exceed the payment amount/);

    const approved = await fetch(
      `${baseUrl}/facilitated-payments/refunds/${phase7RefundId}/approve`,
      { method: "POST" },
    );
    assert.equal(approved.status, 200, JSON.stringify(await approved.json()));
    const transferAmount = BigInt(await scalar(
      "select amount_minor from facilitated_transfer_instructions where id = $1",
      [phase7TransferId],
    ));
    const reversalAmount = String((transferAmount * 3n) / 4n);
    assert.ok(BigInt(reversalAmount) > 0n);

    failNextPhase7Reversal = true;
    const failedReversal = await fetch(
      `${baseUrl}/facilitated-payments/transfers/${phase7TransferId}/reversals`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "phase7-reversal-failed",
        },
        body: JSON.stringify({
          amountMinor: reversalAmount,
          reason: "First provider reversal fails",
          reference: "REVERSAL-FAILED",
        }),
      },
    );
    assert.equal(failedReversal.status, 502, JSON.stringify(await failedReversal.json()));

    const successfulReversal = await fetch(
      `${baseUrl}/facilitated-payments/transfers/${phase7TransferId}/reversals`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "phase7-reversal-success",
        },
        body: JSON.stringify({
          amountMinor: reversalAmount,
          reason: "Second reversal succeeds",
          reference: "REVERSAL-SUCCESS",
        }),
      },
    );
    assert.equal(
      successfulReversal.status,
      200,
      JSON.stringify(await successfulReversal.json()),
    );

    const overRetry = await fetch(
      `${baseUrl}/facilitated-payments/transfers/${phase7TransferId}/reversals`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "phase7-reversal-failed",
        },
        body: JSON.stringify({
          amountMinor: reversalAmount,
          reason: "First provider reversal fails",
          reference: "REVERSAL-FAILED",
        }),
      },
    );
    const overRetryBody = await overRetry.json();
    assert.equal(overRetry.status, 409, JSON.stringify(overRetryBody));
    assert.match(overRetryBody.error, /cannot exceed the transferred amount/);
    assert.equal(phase7Calls.reversals.length, 2);

    phase7ReversalInFlightConflicts = 1;
    const inFlightOptions = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "phase7-reversal-inflight",
      },
      body: JSON.stringify({
        amountMinor: "1",
        reason: "Provider is still processing the same reversal",
        reference: "REVERSAL-INFLIGHT",
      }),
    };
    const inFlight = await fetch(
      `${baseUrl}/facilitated-payments/transfers/${phase7TransferId}/reversals`,
      inFlightOptions,
    );
    const inFlightBody = await inFlight.json();
    assert.equal(inFlight.status, 409, JSON.stringify(inFlightBody));
    assert.equal(inFlightBody.code, "provider_request_in_flight");
    assert.equal(
      await scalar(
        `select status from facilitated_transfer_reversals
         where transfer_instruction_id = $1
           and idempotency_key = 'phase7-reversal-inflight'`,
        [phase7TransferId],
      ),
      "submitting",
    );
    const resumed = await fetch(
      `${baseUrl}/facilitated-payments/transfers/${phase7TransferId}/reversals`,
      inFlightOptions,
    );
    const resumedBody = await resumed.json();
    assert.equal(resumed.status, 200, JSON.stringify(resumedBody));
    assert.equal(resumedBody.replayed, true);

    let releaseConcurrentReversals;
    const concurrentReady = new Promise((resolve) => {
      releaseConcurrentReversals = resolve;
    });
    phase7ConcurrentReversal = {
      calls: 0,
      providerId: "trr_phase7_concurrent",
      ready: concurrentReady,
      release: releaseConcurrentReversals,
    };
    const concurrentOptions = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "phase7-reversal-concurrent",
      },
      body: JSON.stringify({
        amountMinor: "1",
        reason: "Concurrent exact retry",
        reference: "REVERSAL-CONCURRENT",
      }),
    };
    const concurrentPath = `${baseUrl}/facilitated-payments/transfers/${phase7TransferId}/reversals`;
    const concurrentResponses = await Promise.all([
      fetch(concurrentPath, concurrentOptions),
      fetch(concurrentPath, concurrentOptions),
    ]);
    const concurrentBodies = await Promise.all(
      concurrentResponses.map((response) => response.json()),
    );
    phase7ConcurrentReversal = null;
    assert.deepEqual(
      concurrentResponses.map((response) => response.status),
      [200, 200],
      JSON.stringify(concurrentBodies),
    );
    assert.equal(concurrentBodies.every(
      (body) => body.reversal.provider_reversal_id === "trr_phase7_concurrent",
    ), true);
    assert.equal(concurrentBodies.some((body) => body.replayed === true), true);
    assert.equal(
      await scalar(
        `select count(*)::int from facilitated_transfer_reversals
         where transfer_instruction_id = $1
           and idempotency_key = 'phase7-reversal-concurrent'
           and status = 'succeeded'
           and provider_reversal_id = 'trr_phase7_concurrent'`,
        [phase7TransferId],
      ),
      1,
    );
  });
  await handleFacilitatedPaymentEvent({
    id: "evt_phase7_refund_succeeded",
    type: "refund.updated",
    livemode: false,
    created: phase7Intent.created + 60,
    data: {
      object: {
        id: "re_phase7",
        object: "refund",
        status: "succeeded",
        amount: 1000,
        currency: "usd",
        charge: "ch_phase7",
      },
    },
  });
  assert.equal(
    await scalar(
      "select state from facilitated_transfer_instructions where id = $1",
      [phase7TransferId],
    ),
    "partially_reversed",
  );
  const payoutBase = {
    id: "po_phase7",
    object: "payout",
    amount: 5000,
    currency: "usd",
    arrival_date: Math.floor(Date.now() / 1000),
  };
  await handleFacilitatedPaymentEvent({
    id: "evt_phase7_payout_paid",
    type: "payout.paid",
    account: providerAccount.id,
    livemode: false,
    created: phase7Intent.created + 120,
    data: { object: { ...payoutBase, status: "paid" } },
  });
  await handleFacilitatedPaymentEvent({
    id: "evt_phase7_payout_failed_late",
    type: "payout.failed",
    account: providerAccount.id,
    livemode: false,
    created: phase7Intent.created + 180,
    data: {
      object: {
        ...payoutBase,
        status: "failed",
        failure_code: "account_closed",
        failure_message: "The destination account was closed",
      },
    },
  });
  assert.equal(
    await scalar(
      `select count(*)::int from facilitated_recovery_cases
       where payout_id = (
         select id from facilitated_payouts where provider_payout_id = 'po_phase7'
       ) and case_type = 'payout_failure'`,
    ),
    1,
  );

  // Production-readiness PR3: provider-side payout scans are account-scoped,
  // paginated, checkpointed, idempotent, and able to discover a late failure
  // after an earlier paid observation.
  const pr3PendingPayout = {
    id: "po_pr3_pending",
    object: "payout",
    amount: 6100,
    currency: "usd",
    status: "pending",
    arrival_date: Math.floor(Date.now() / 1000) + 3600,
  };
  const pr3PaidPayout = {
    id: "po_pr3_paid",
    object: "payout",
    amount: 7200,
    currency: "usd",
    status: "paid",
    arrival_date: Math.floor(Date.now() / 1000),
  };
  phase7PayoutsById = new Map([
    [pr3PendingPayout.id, pr3PendingPayout],
    [pr3PaidPayout.id, pr3PaidPayout],
  ]);
  phase7PayoutPages = [
    {
      object: "list",
      data: [pr3PendingPayout],
      has_more: true,
      lastResponse: { requestId: "req_pr3_page_1" },
    },
    {
      object: "list",
      data: [pr3PaidPayout],
      has_more: false,
      lastResponse: { requestId: "req_pr3_page_2" },
    },
  ];
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/facilitated-payments/accounts/${connectedAccountId}/payouts/reconcile`,
      { method: "POST" },
    );
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.status, "succeeded");
    assert.deepEqual(body.counts, { observed: 2, changed: 2, unchanged: 0 });
  });
  const firstPayoutListCalls = phase7Calls.payoutLists.slice(-2);
  assert.equal(firstPayoutListCalls[0].options.stripeAccount, providerAccount.id);
  assert.equal(firstPayoutListCalls[1].params.starting_after, pr3PendingPayout.id);
  assert.equal(firstPayoutListCalls[1].options.stripeAccount, providerAccount.id);
  assert.equal(
    await scalar(
      "select count(*)::int from facilitated_payouts where provider_payout_id in ($1, $2)",
      [pr3PendingPayout.id, pr3PaidPayout.id],
    ),
    2,
  );

  // A second observation reaches the same transition function but produces no
  // duplicate payout-status audit or notification.
  phase7PayoutPages = [{
    object: "list",
    data: [pr3PendingPayout, pr3PaidPayout],
    has_more: false,
    lastResponse: { requestId: "req_pr3_duplicate" },
  }];
  const paidAuditCountBeforeDuplicate = await scalar(
    `select count(*)::int from audit_events
     where action = 'facilitated_payout.paid'
       and resource_id = (
         select id from facilitated_payouts where provider_payout_id = $1
       )`,
    [pr3PaidPayout.id],
  );
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/facilitated-payments/accounts/${connectedAccountId}/payouts/reconcile`,
      { method: "POST" },
    );
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  });
  assert.equal(
    await scalar(
      `select count(*)::int from audit_events
       where action = 'facilitated_payout.paid'
         and resource_id = (
           select id from facilitated_payouts where provider_payout_id = $1
         )`,
      [pr3PaidPayout.id],
    ),
    paidAuditCountBeforeDuplicate,
  );
  const newerPendingPayoutState = await scalar(
    `update facilitated_payouts
     set provider_state_updated_at = now() + interval '1 day',
         last_reconciled_at = null
     where provider_payout_id = $1
     returning provider_state_updated_at::text`,
    [pr3PendingPayout.id],
  );
  phase7PayoutPages = [{
    object: "list",
    data: [pr3PendingPayout],
    has_more: false,
    lastResponse: { requestId: "req_pr3_stale_observation" },
  }];
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/facilitated-payments/accounts/${connectedAccountId}/payouts/reconcile`,
      { method: "POST" },
    );
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  });
  assert.equal(
    await scalar(
      `select last_reconciled_at is not null
       from facilitated_payouts where provider_payout_id = $1`,
      [pr3PendingPayout.id],
    ),
    true,
  );
  assert.equal(
    await scalar(
      `select provider_state_updated_at::text
       from facilitated_payouts where provider_payout_id = $1`,
      [pr3PendingPayout.id],
    ),
    newerPendingPayoutState,
  );

  const pr3FailedPayout = {
    ...pr3PaidPayout,
    status: "failed",
    failure_code: "bank_account_closed",
    failure_message: "The receiving bank returned the payout",
  };
  phase7PayoutsById.set(pr3PaidPayout.id, pr3FailedPayout);
  phase7PayoutPages = [{
    object: "list",
    data: [],
    has_more: false,
    lastResponse: { requestId: "req_pr3_late_failure" },
  }];
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/facilitated-payments/accounts/${connectedAccountId}/payouts/reconcile`,
      { method: "POST" },
    );
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  });
  assert.equal(
    await scalar(
      "select status from facilitated_payouts where provider_payout_id = $1",
      [pr3PaidPayout.id],
    ),
    "failed",
  );
  assert.equal(
    await scalar(
      `select count(*)::int from facilitated_recovery_cases
       where payout_id = (
         select id from facilitated_payouts where provider_payout_id = $1
       ) and case_type = 'payout_failure'`,
      [pr3PaidPayout.id],
    ),
    1,
  );
  await handleFacilitatedPaymentEvent({
    id: "evt_pr3_older_paid",
    type: "payout.paid",
    account: providerAccount.id,
    livemode: false,
    created: 1_700_000_000,
    data: { object: pr3PaidPayout },
  });
  assert.equal(
    await scalar(
      "select status from facilitated_payouts where provider_payout_id = $1",
      [pr3PaidPayout.id],
    ),
    "failed",
  );

  // A failed page retains its scan and cursor. The next run resumes that same
  // scan rather than skipping the unprocessed page.
  phase7PayoutPages = [];
  failNextPhase7PayoutList = true;
  let failedCheckpointScanId;
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const failed = await fetch(
      `${baseUrl}/facilitated-payments/accounts/${connectedAccountId}/payouts/reconcile`,
      { method: "POST" },
    );
    assert.equal(failed.status, 502, JSON.stringify(await failed.json()));
  });
  failedCheckpointScanId = await scalar(
    `select scan_id from facilitated_payout_reconciliation_checkpoints
     where connected_account_id = $1 and scan_status = 'failed'`,
    [connectedAccountId],
  );
  phase7PayoutPages = [{
    object: "list",
    data: [],
    has_more: false,
    lastResponse: { requestId: "req_pr3_recovered" },
  }];
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const resumed = await fetch(
      `${baseUrl}/facilitated-payments/accounts/${connectedAccountId}/payouts/reconcile`,
      { method: "POST" },
    );
    const body = await resumed.json();
    assert.equal(resumed.status, 200, JSON.stringify(body));
    assert.equal(body.resumed, true);
    assert.equal(body.checkpoint.scanId, failedCheckpointScanId);
  });

  // The running lease serializes scans for one connected account.
  let releasePayoutList;
  let markPayoutListEntered;
  const payoutListEntered = new Promise((resolve) => { markPayoutListEntered = resolve; });
  const payoutListMayFinish = new Promise((resolve) => { releasePayoutList = resolve; });
  phase7PayoutListGate = {
    entered: markPayoutListEntered,
    ready: payoutListMayFinish,
  };
  phase7PayoutPages = [{
    object: "list",
    data: [],
    has_more: false,
    lastResponse: { requestId: "req_pr3_concurrent" },
  }];
  try {
    await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
      const first = fetch(
        `${baseUrl}/facilitated-payments/accounts/${connectedAccountId}/payouts/reconcile`,
        { method: "POST" },
      );
      await payoutListEntered;
      const second = await fetch(
        `${baseUrl}/facilitated-payments/accounts/${connectedAccountId}/payouts/reconcile`,
        { method: "POST" },
      );
      const secondBody = await second.json();
      assert.equal(second.status, 409, JSON.stringify(secondBody));
      assert.equal(secondBody.code, "payout_reconciliation_in_progress");
      releasePayoutList();
      const firstResponse = await first;
      assert.equal(firstResponse.status, 200, JSON.stringify(await firstResponse.json()));
    });
  } finally {
    phase7PayoutListGate = null;
    releasePayoutList?.();
  }

  const readOnlyPaymentOperator = {
    principalType: "user",
    user: { id: phase5ReviewerUser, platformStaff: false },
    cognito: { groups: ["hedgeling-payment-operations-view"] },
  };
  await withPlatformPaymentsApi(readOnlyPaymentOperator, async (baseUrl) => {
    const list = await fetch(`${baseUrl}/facilitated-payments/payout-reconciliation`);
    assert.equal(list.status, 200, JSON.stringify(await list.json()));
    const mutation = await fetch(
      `${baseUrl}/facilitated-payments/accounts/${connectedAccountId}/payouts/reconcile`,
      { method: "POST" },
    );
    assert.equal(mutation.status, 403);
  });
  await withPlatformPaymentsApi({
    ...readOnlyPaymentOperator,
    cognito: { groups: ["hedgeling-payment-operations-manage"] },
  }, async (baseUrl) => {
    const certification = await fetch(
      `${baseUrl}/facilitated-payments/certification/support_runbook`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "passed", evidence: {} }),
      },
    );
    assert.equal(certification.status, 403);
  });
  await withPlatformPaymentsApi({
    principalType: "service_account",
    serviceAccount: { id: directUser },
  }, async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/facilitated-payments/payout-reconciliation`);
    assert.equal(denied.status, 403);
  });

  // PR1/A1: a signed success that arrives after the relationship becomes
  // ineligible is retained as an unapplied payment and cannot create a
  // payable record or transfer.
  const lateSuccess = await createProductionReadinessAttempt({
    suffix: "late_success",
    amountMinor: "2100",
  });
  await pool.query(
    "update vendor_relationships set status = 'suspended' where id = $1",
    [vendorRelationshipId],
  );
  const lateSuccessEvent = {
    id: "evt_readiness_late_success_succeeded",
    type: "payment_intent.succeeded",
    livemode: false,
    created: lateSuccess.providerCreated,
    data: { object: lateSuccess.intent },
  };
  let lateSuccessOutcome;
  try {
    lateSuccessOutcome = await handleFacilitatedPaymentEvent(lateSuccessEvent);
  } finally {
    await pool.query(
      "update vendor_relationships set status = 'active' where id = $1",
      [vendorRelationshipId],
    );
  }
  assert.deepEqual(lateSuccessOutcome, { duplicate: false, status: "processed" });
  const latePayment = await pool.query(
    `select id, application_state as "applicationState",
            unapplied_reason as "unappliedReason"
     from facilitated_payments where payment_attempt_id = $1`,
    [lateSuccess.attemptId],
  ).then((result) => result.rows[0]);
  assert.equal(latePayment.applicationState, "unapplied");
  assert.match(latePayment.unappliedReason, /relationship_not_active/);
  assert.equal(
    await scalar(
      "select count(*)::int from payment_records where payable_statement_id = $1",
      [lateSuccess.statementId],
    ),
    0,
  );
  assert.equal(
    await scalar(
      "select count(*)::int from facilitated_transfer_instructions where facilitated_payment_id = $1",
      [latePayment.id],
    ),
    0,
  );
  assert.equal(
    await scalar(
      `select count(*)::int from facilitated_payment_exceptions
       where exception_type = 'payment_succeeded_ineligible'
         and resource_id = $1 and status = 'open'`,
      [latePayment.id],
    ),
    1,
  );
  assert.equal(
    await scalar(
      `select count(*)::int from audit_events
       where action = 'facilitated_payment.unapplied'
         and resource_id = $1
         and organization_id in ($2, $3)`,
      [latePayment.id, customerA, agencyId],
    ),
    2,
  );
  assert.deepEqual(await handleFacilitatedPaymentEvent(lateSuccessEvent), {
    duplicate: true,
    status: "processed",
  });
  assert.deepEqual(await handleFacilitatedPaymentEvent({
    id: "evt_readiness_late_success_checkout_out_of_order",
    type: "checkout.session.completed",
    livemode: false,
    created: lateSuccess.providerCreated - 10,
    data: { object: lateSuccess.session },
  }), {
    duplicate: false,
    status: "processed",
  });
  assert.equal(
    await scalar(
      `select count(*)::int from facilitated_funding_facts
       where facilitated_payment_id = $1 and fact_type = 'payment_succeeded'`,
      [latePayment.id],
    ),
    1,
  );

  // PR1/A2: reconcile an ACH payment through balance availability, then
  // process a true bank return as a compensating fact rather than a card
  // dispute or deletion of the historical payment.
  const achHeld = await createProductionReadinessAttempt({
    suffix: "ach_held_return",
    amountMinor: "2200",
    paymentMethodType: "us_bank_account",
  });
  const achHeldResult = await succeedProductionReadinessAttempt(achHeld);
  assert.deepEqual(achHeldResult.outcome, { duplicate: false, status: "processed" });
  phase7Session = achHeld.session;
  phase7RetrievedSession = achHeld.session;
  phase7Intent = achHeld.intent;
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const reconciled = await fetch(
      `${baseUrl}/facilitated-payments/attempts/${achHeld.attemptId}/reconcile`,
      { method: "POST" },
    );
    const body = await reconciled.json();
    assert.equal(reconciled.status, 200, JSON.stringify(body));
    assert.equal(body.attempt.paymentMethodType, "us_bank_account");
    assert.ok(body.attempt.fundsAvailableAt);
    assert.ok(
      new Date(body.attempt.transferReleasableAt).getTime()
        > new Date(body.attempt.fundsAvailableAt).getTime(),
    );
  });
  const achReturn = {
    id: "dp_readiness_ach_held",
    object: "dispute",
    amount: Number(achHeld.amountMinor),
    currency: "usd",
    charge: achHeld.intent.latest_charge,
    payment_intent: achHeld.intent.id,
    payment_method_details: { type: "us_bank_account" },
    reason: "insufficient_funds",
    status: "lost",
    created: achHeld.providerCreated + 200,
  };
  const achReturnEvent = {
    id: "evt_readiness_ach_held_returned",
    type: "charge.dispute.closed",
    livemode: false,
    created: achReturn.created,
    data: { object: achReturn },
  };
  assert.deepEqual(await handleFacilitatedPaymentEvent(achReturnEvent), {
    duplicate: false,
    status: "processed",
  });
  assert.equal(
    await scalar(
      `select fact_type from facilitated_funding_facts
       where facilitated_payment_id = $1 and provider_object_id = $2`,
      [achHeldResult.paymentId, achReturn.id],
    ),
    "return_recorded",
  );
  await withAccessApi(directUser, async (baseUrl) => {
    const summary = await fetch(
      `${baseUrl}/organizations/${customerA}/vendor-relationships/${vendorRelationshipId}/payable-statements/${achHeld.statementId}/facilitated-payment`,
    );
    const body = await summary.json();
    assert.equal(summary.status, 200, JSON.stringify(body));
    assert.equal(body.payment.fundingState, "returned");
    assert.equal(body.payment.transferState, "held");
  });
  const transfersBeforeReturnedRelease = phase7Calls.transfers.length;
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const blocked = await fetch(
      `${baseUrl}/facilitated-payments/transfers/${achHeldResult.transferId}/release`,
      { method: "POST" },
    );
    const body = await blocked.json();
    assert.equal(blocked.status, 409, JSON.stringify(body));
    assert.ok(body.details.reasons.includes("funding_exception"));
  });
  assert.equal(phase7Calls.transfers.length, transfersBeforeReturnedRelease);
  assert.deepEqual(await handleFacilitatedPaymentEvent(achReturnEvent), {
    duplicate: true,
    status: "processed",
  });

  for (const [suffix, changes] of [
    ["amount_mismatch", { amount: Number(achHeld.amountMinor) + 1 }],
    ["currency_mismatch", { currency: "eur" }],
  ]) {
    const mismatched = {
      ...achReturn,
      ...changes,
      id: `dp_readiness_ach_${suffix}`,
      created: achReturn.created + productionReadinessFixtureNumber,
    };
    await assert.rejects(
      handleFacilitatedPaymentEvent({
        id: `evt_readiness_ach_${suffix}`,
        type: "charge.dispute.closed",
        livemode: false,
        created: mismatched.created,
        data: { object: mismatched },
      }),
      /does not match its Hedgeling payment/,
    );
  }
  await assert.rejects(
    handleFacilitatedPaymentEvent({
      id: "evt_readiness_ach_mode_mismatch",
      type: "charge.dispute.closed",
      livemode: true,
      created: achReturn.created + 3,
      data: {
        object: {
          ...achReturn,
          id: "dp_readiness_ach_mode_mismatch",
          created: achReturn.created + 3,
        },
      },
    }),
    /does not match its Hedgeling payment/,
  );
  await assert.rejects(
    handleFacilitatedPaymentEvent({
      id: "evt_readiness_ach_owner_mismatch",
      type: "charge.dispute.closed",
      livemode: false,
      created: achReturn.created + 4,
      data: {
        object: {
          ...achReturn,
          id: "dp_readiness_ach_owner_mismatch",
          payment_intent: lateSuccess.intent.id,
          created: achReturn.created + 4,
        },
      },
    }),
    /references conflicting Hedgeling payments/,
  );

  const achTransferred = await createProductionReadinessAttempt({
    suffix: "ach_return_after_transfer",
    amountMinor: "2300",
    paymentMethodType: "us_bank_account",
  });
  const achTransferredResult = await succeedProductionReadinessAttempt(achTransferred);
  await pool.query(
    `update facilitated_payment_attempts
     set funds_available_at = now() - interval '2 days',
         transfer_releasable_at = now() - interval '1 day'
     where id = $1`,
    [achTransferred.attemptId],
  );
  await pool.query(
    `update facilitated_transfer_instructions
     set funds_available_at = now() - interval '2 days',
         transfer_releasable_at = now() - interval '1 day'
     where id = $1`,
    [achTransferredResult.transferId],
  );
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const released = await fetch(
      `${baseUrl}/facilitated-payments/transfers/${achTransferredResult.transferId}/release`,
      { method: "POST" },
    );
    assert.equal(released.status, 200, JSON.stringify(await released.json()));
  });
  const transferredReturn = {
    id: "dp_readiness_ach_transferred",
    object: "dispute",
    amount: Number(achTransferred.amountMinor),
    currency: "usd",
    charge: achTransferred.intent.latest_charge,
    payment_intent: achTransferred.intent.id,
    payment_method_details: { type: "us_bank_account" },
    reason: "unauthorized",
    status: "lost",
    created: achTransferred.providerCreated + 200,
  };
  await handleFacilitatedPaymentEvent({
    id: "evt_readiness_ach_transferred_returned",
    type: "charge.dispute.closed",
    livemode: false,
    created: transferredReturn.created,
    data: { object: transferredReturn },
  });
  assert.deepEqual(
    await pool.query(
      `select case_type as "caseType", exposure_minor::text as "exposureMinor",
              status
       from facilitated_recovery_cases
       where facilitated_payment_id = $1`,
      [achTransferredResult.paymentId],
    ).then((result) => result.rows[0]),
    {
      caseType: "return_after_transfer",
      exposureMinor: achTransferred.amountMinor,
      status: "open",
    },
  );

  // PR1/A3: the first claim consumes the rolling cap while its provider call
  // is in flight. The concurrent loser remains held, and the first claim's
  // provider failure releases capacity for a later claim.
  const capAmountMinor = "2400";
  const capFirst = await createProductionReadinessAttempt({
    suffix: "rolling_cap_first",
    amountMinor: capAmountMinor,
  });
  const capSecond = await createProductionReadinessAttempt({
    suffix: "rolling_cap_second",
    amountMinor: capAmountMinor,
  });
  const capFirstResult = await succeedProductionReadinessAttempt(capFirst);
  const capSecondResult = await succeedProductionReadinessAttempt(capSecond);
  await pool.query(
    `update facilitated_payment_attempts
     set funds_available_at = now() - interval '2 days',
         transfer_releasable_at = now() - interval '1 day'
     where id in ($1, $2)`,
    [capFirst.attemptId, capSecond.attemptId],
  );
  await pool.query(
    `update facilitated_transfer_instructions
     set funds_available_at = now() - interval '2 days',
         transfer_releasable_at = now() - interval '1 day'
     where id in ($1, $2)`,
    [capFirstResult.transferId, capSecondResult.transferId],
  );
  const enrollmentCaps = await pool.query(
    `select organization_id as "organizationId",
            per_payment_cap_minor::text as "perPaymentCapMinor",
            rolling_cap_minor::text as "rollingCapMinor"
     from facilitated_payment_program_enrollments
     where organization_id in ($1, $2) and provider_mode = 'test'
       and superseded_at is null`,
    [customerA, agencyId],
  ).then((result) => result.rows);
  const rollingUsageBeforeClaims = BigInt(await scalar(
    `select coalesce(sum(instruction.amount_minor), 0)::text
     from facilitated_transfer_instructions instruction
     join facilitated_payments payment
       on payment.id = instruction.facilitated_payment_id
     where payment.customer_organization_id = $1
       and instruction.state in (
         'submitting','transferred','partially_reversed','reversed'
       )
       and instruction.release_claimed_at >= now() - interval '30 days'`,
    [customerA],
  ));
  const contentionCap = rollingUsageBeforeClaims + BigInt(capAmountMinor);
  const customerContentionCap = contentionCap + BigInt(capAmountMinor);
  await pool.query(
    `update facilitated_payment_program_enrollments
     set per_payment_cap_minor = $3,
         rolling_cap_minor = case
           when organization_id = $1 then $4::bigint
           else $5::bigint
         end
     where organization_id in ($1, $2) and provider_mode = 'test'
       and superseded_at is null`,
    [
      customerA,
      agencyId,
      capAmountMinor,
      String(customerContentionCap),
      String(contentionCap),
    ],
  );
  let releaseProviderCall;
  let markProviderEntered;
  const providerEntered = new Promise((resolve) => {
    markProviderEntered = resolve;
  });
  const providerMayFinish = new Promise((resolve) => {
    releaseProviderCall = resolve;
  });
  phase7TransferGate = {
    calls: 0,
    entered: markProviderEntered,
    ready: providerMayFinish,
    error: new Error("Simulated transfer failure after the cap claim"),
  };
  const transferCallsBeforeContention = phase7Calls.transfers.length;
  try {
    await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
      const firstRelease = fetch(
        `${baseUrl}/facilitated-payments/transfers/${capFirstResult.transferId}/release`,
        { method: "POST" },
      );
      await providerEntered;
      assert.equal(
        await scalar(
          "select state from facilitated_transfer_instructions where id = $1",
          [capFirstResult.transferId],
        ),
        "submitting",
      );
      const concurrentRelease = await fetch(
        `${baseUrl}/facilitated-payments/transfers/${capSecondResult.transferId}/release`,
        { method: "POST" },
      );
      const concurrentBody = await concurrentRelease.json();
      assert.equal(concurrentRelease.status, 409, JSON.stringify(concurrentBody));
      assert.equal(concurrentBody.code, "rolling_cap_exceeded");
      assert.match(concurrentBody.error, /agency rolling transfer cap/);
      assert.equal(
        await scalar(
          "select state from facilitated_transfer_instructions where id = $1",
          [capSecondResult.transferId],
        ),
        "held",
      );
      assert.equal(
        phase7Calls.transfers.length,
        transferCallsBeforeContention + 1,
      );

      releaseProviderCall();
      const failedResponse = await firstRelease;
      assert.equal(failedResponse.status, 502, JSON.stringify(await failedResponse.json()));
      assert.equal(
        await scalar(
          "select state from facilitated_transfer_instructions where id = $1",
          [capFirstResult.transferId],
        ),
        "failed",
      );
      phase7TransferGate = null;

      const releasedAfterFailure = await fetch(
        `${baseUrl}/facilitated-payments/transfers/${capSecondResult.transferId}/release`,
        { method: "POST" },
      );
      assert.equal(
        releasedAfterFailure.status,
        200,
        JSON.stringify(await releasedAfterFailure.json()),
      );
      const transferCallsAfterSuccess = phase7Calls.transfers.length;
      const replayed = await fetch(
        `${baseUrl}/facilitated-payments/transfers/${capSecondResult.transferId}/release`,
        { method: "POST" },
      );
      const replayedBody = await replayed.json();
      assert.equal(replayed.status, 200, JSON.stringify(replayedBody));
      assert.equal(replayedBody.replayed, true);
      assert.equal(phase7Calls.transfers.length, transferCallsAfterSuccess);
    });
    assert.equal(
      BigInt(await scalar(
        `select coalesce(sum(instruction.amount_minor), 0)::text
         from facilitated_transfer_instructions instruction
         join facilitated_payments payment
           on payment.id = instruction.facilitated_payment_id
         where payment.customer_organization_id = $1
           and instruction.state in (
             'submitting','transferred','partially_reversed','reversed'
           )
           and instruction.release_claimed_at >= now() - interval '30 days'`,
        [customerA],
      )),
      contentionCap,
    );
  } finally {
    releaseProviderCall();
    phase7TransferGate = null;
    for (const enrollment of enrollmentCaps) {
      await pool.query(
        `update facilitated_payment_program_enrollments
         set per_payment_cap_minor = $2, rolling_cap_minor = $3
         where organization_id = $1 and provider_mode = 'test'
           and superseded_at is null`,
        [
          enrollment.organizationId,
          enrollment.perPaymentCapMinor,
          enrollment.rollingCapMinor,
        ],
      );
    }
  }

  // PR1/A4: after Stripe may have pruned a v1 idempotency key, retry is
  // blocked until a fresh provider lookup and explicit absence confirmation.
  await pool.query(
    `update facilitated_transfer_instructions
     set release_claimed_at = now() - interval '25 hours',
         updated_at = now() - interval '25 hours'
     where id = $1`,
    [capFirstResult.transferId],
  );
  phase7ListedTransfers = [];
  const transferCallsBeforeExpiredRetry = phase7Calls.transfers.length;
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const blocked = await fetch(
      `${baseUrl}/facilitated-payments/transfers/${capFirstResult.transferId}/retry`,
      { method: "POST" },
    );
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 409, JSON.stringify(blockedBody));
    assert.equal(blockedBody.code, "provider_transfer_outcome_unknown");
    assert.equal(phase7Calls.transfers.length, transferCallsBeforeExpiredRetry);
    assert.equal(
      await scalar(
        "select state from facilitated_transfer_instructions where id = $1",
        [capFirstResult.transferId],
      ),
      "failed",
    );

    const missingEvidence = await fetch(
      `${baseUrl}/facilitated-payments/transfers/${capFirstResult.transferId}/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerAbsenceConfirmed: true,
          providerAbsenceReason: "The provider lookup returned no object.",
        }),
      },
    );
    assert.equal(
      missingEvidence.status,
      400,
      JSON.stringify(await missingEvidence.json()),
    );
    assert.equal(phase7Calls.transfers.length, transferCallsBeforeExpiredRetry);

    const confirmed = await fetch(
      `${baseUrl}/facilitated-payments/transfers/${capFirstResult.transferId}/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerAbsenceConfirmed: true,
          providerAbsenceReason: "Stripe transfer-group lookup returned no provider object.",
          providerAbsenceEvidence: "stripe-test://transfers/readiness-cap-first",
        }),
      },
    );
    assert.equal(confirmed.status, 200, JSON.stringify(await confirmed.json()));
  });
  assert.equal(phase7Calls.transfers.length, transferCallsBeforeExpiredRetry + 1);
  assert.equal(
    await scalar(
      `select count(*)::int from audit_events
       where action = 'facilitated_transfer.provider_absence_confirmed'
         and resource_id = $1
         and organization_id in ($2, $3)`,
      [capFirstResult.transferId, customerA, agencyId],
    ),
    2,
  );
  assert.equal(
    await scalar(
      `select status from facilitated_payment_exceptions
       where exception_type = 'provider_transfer_outcome_unknown'
         and resource_id = $1 order by created_at desc limit 1`,
      [capFirstResult.transferId],
    ),
    "resolved",
  );

  // A confirmed-absence retry from an old submitting claim must still honor
  // the transfer kill switch before it can create a provider transfer.
  const disabledRetry = await createProductionReadinessAttempt({
    suffix: "disabled_exceptional_retry",
    amountMinor: "2450",
  });
  const disabledRetryResult = await succeedProductionReadinessAttempt(disabledRetry);
  await pool.query(
    `update facilitated_transfer_instructions
     set funds_available_at = now() - interval '2 days',
         transfer_releasable_at = now() - interval '1 day',
         state = 'submitting', released_by_user_id = $2,
         release_claimed_at = now() - interval '25 hours',
         updated_at = now() - interval '25 hours'
     where id = $1`,
    [disabledRetryResult.transferId, directUser],
  );
  phase7ListedTransfers = [];
  const transferCallsBeforeDisabledRetry = phase7Calls.transfers.length;
  process.env.HEDGELING_FACILITATED_TRANSFERS_ENABLED = "false";
  try {
    await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
      const disabled = await fetch(
        `${baseUrl}/facilitated-payments/transfers/${disabledRetryResult.transferId}/retry`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            providerAbsenceConfirmed: true,
            providerAbsenceReason: "Stripe transfer-group lookup returned no provider object.",
            providerAbsenceEvidence: "stripe-test://transfers/disabled-exceptional-retry",
          }),
        },
      );
      const body = await disabled.json();
      assert.equal(disabled.status, 503, JSON.stringify(body));
      assert.equal(body.code, "operation_disabled");
    });
  } finally {
    process.env.HEDGELING_FACILITATED_TRANSFERS_ENABLED = "true";
  }
  assert.equal(phase7Calls.transfers.length, transferCallsBeforeDisabledRetry);
  assert.equal(
    await scalar(
      "select state from facilitated_transfer_instructions where id = $1",
      [disabledRetryResult.transferId],
    ),
    "submitting",
  );
  assert.equal(
    await scalar(
      `select count(*)::int from audit_events
       where action = 'facilitated_transfer.provider_absence_confirmed'
         and resource_id = $1`,
      [disabledRetryResult.transferId],
    ),
    0,
  );

  const providerRecovered = await createProductionReadinessAttempt({
    suffix: "provider_recovered_transfer",
    amountMinor: "2500",
  });
  const providerRecoveredResult = await succeedProductionReadinessAttempt(providerRecovered);
  await pool.query(
    `update facilitated_payment_attempts
     set funds_available_at = now() - interval '2 days',
         transfer_releasable_at = now() - interval '1 day'
     where id = $1`,
    [providerRecovered.attemptId],
  );
  await pool.query(
    `update facilitated_transfer_instructions
     set funds_available_at = now() - interval '2 days',
         transfer_releasable_at = now() - interval '1 day',
         state = 'submitting', released_by_user_id = $2,
         release_claimed_at = now() - interval '25 hours'
     where id = $1`,
    [providerRecoveredResult.transferId, directUser],
  );
  await pool.query(
    `update facilitated_transfer_instructions
     set state = 'failed', failure_code = 'simulated_local_timeout',
         failure_message = 'Provider result was not committed locally',
         updated_at = now() - interval '25 hours'
     where id = $1`,
    [providerRecoveredResult.transferId],
  );
  const recoveredTransferGroup = await scalar(
    "select transfer_group from facilitated_transfer_instructions where id = $1",
    [providerRecoveredResult.transferId],
  );
  phase7ListedTransfers = [{
    id: "tr_readiness_provider_recovered",
    object: "transfer",
    amount: Number(providerRecovered.amountMinor),
    currency: "usd",
    destination: providerAccount.id,
    transfer_group: recoveredTransferGroup,
    livemode: false,
    metadata: {
      hedgeling_transfer_instruction_id: providerRecoveredResult.transferId,
      hedgeling_payment_id: providerRecoveredResult.paymentId,
      hedgeling_statement_id: providerRecovered.statementId,
      hedgeling_provider_mode: "test",
    },
  }];
  const transferCallsBeforeConvergence = phase7Calls.transfers.length;
  await withPlatformPaymentsApi(platformHuman, async (baseUrl) => {
    const reconciled = await fetch(
      `${baseUrl}/facilitated-payments/transfers/${providerRecoveredResult.transferId}/retry`,
      { method: "POST" },
    );
    const body = await reconciled.json();
    assert.equal(reconciled.status, 200, JSON.stringify(body));
    assert.equal(body.replayed, true);
    assert.equal(body.transfer.provider_transfer_id, "tr_readiness_provider_recovered");
  });
  assert.equal(phase7Calls.transfers.length, transferCallsBeforeConvergence);
  assert.equal(
    await scalar(
      "select state from facilitated_transfer_instructions where id = $1",
      [providerRecoveredResult.transferId],
    ),
    "transferred",
  );
  setFacilitatedPaymentsTestClient(null);

  process.env.HEDGELING_STRIPE_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_test_integration";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_integration";
  process.env.STRIPE_CHECKOUT_SUCCESS_URL = "https://console.example.test/billing/success";
  process.env.STRIPE_CHECKOUT_CANCEL_URL = "https://console.example.test/billing";
  process.env.STRIPE_PORTAL_RETURN_URL = "https://console.example.test/billing";
  const stripeCalls = {
    customers: [],
    checkout: [],
    checkoutExpired: [],
    portal: [],
  };
  setStripeTestClient({
    customers: {
      create: async (parameters, options) => {
        stripeCalls.customers.push({ parameters, options });
        return {
          id: parameters.metadata.hedgeling_organization_id === customerB
            ? "cus_customer_b"
            : "cus_customer_a",
        };
      },
    },
    checkout: {
      sessions: {
        create: async (parameters, options) => {
          stripeCalls.checkout.push({ parameters, options });
          if (parameters.metadata.hedgeling_organization_id === customerB) {
            return {
              id: "cs_test_collision",
              url: "https://checkout.stripe.test/orphan",
              expires_at: 1_900_000_000,
            };
          }
          const customerACallCount = stripeCalls.checkout.filter(
            (call) => call.parameters.metadata.hedgeling_organization_id === customerA,
          ).length;
          if (customerACallCount > 2) {
            return {
              id: "cs_test_collision",
              url: "https://checkout.stripe.test/replacement-collision",
              expires_at: 1_900_000_000,
            };
          }
          const suffix = customerACallCount === 1 ? "" : "_yearly";
          return {
            id: `cs_test_customer_a${suffix}`,
            url: `https://checkout.stripe.test/session${suffix}`,
            expires_at: 1_900_000_000,
          };
        },
        expire: async (sessionId) => {
          stripeCalls.checkoutExpired.push(sessionId);
          return { id: sessionId, status: "expired" };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (parameters) => {
          stripeCalls.portal.push(parameters);
          return {
            id: "bps_test_customer_a",
            url: "https://billing.stripe.test/portal",
          };
        },
      },
    },
    webhooks: {
      constructEvent(rawBody, signature, secret) {
        assert.equal(Buffer.isBuffer(rawBody), true);
        assert.equal(signature, "test-signature");
        assert.equal(secret, "whsec_integration");
        return JSON.parse(rawBody.toString("utf8"));
      },
    },
  });
  await withAccessApi(teamUser, async (baseUrl) => {
    const headers = { "content-type": "application/json" };
    const usageFrom = encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    const usageResponse = await fetch(
      `${baseUrl}/organizations/${customerA}/usage?from=${usageFrom}`,
    );
    assert.equal(usageResponse.status, 200);
    const usageBody = await usageResponse.json();
    assert.deepEqual(
      Object.fromEntries(usageBody.totals.map((measurement) => [
        measurement.metricKey,
        measurement.quantity,
      ])),
      {
        ai_output_characters: "24",
        ai_output_words: "4",
        llm_input_tokens: "20",
        llm_output_tokens: "8",
        llm_total_tokens: "28",
        source_characters_processed: "36",
        source_words_processed: "6",
      },
    );
    assert.equal(usageBody.recentEvents.length, 2);
    assert.equal(usageBody.projects[0].id, projectA);
    const invalidUsageWindow = await fetch(
      `${baseUrl}/organizations/${customerA}/usage?from=not-a-date`,
    );
    assert.equal(invalidUsageWindow.status, 400);

    const crossTenantBudgetResponse = await fetch(
      `${baseUrl}/organizations/${customerA}/budgets`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          scopeType: "business_unit",
          scopeId: buB,
          metricKey: "source_words_processed",
          limitQuantity: "7",
          reason: "Must stay tenant scoped",
        }),
      },
    );
    assert.equal(crossTenantBudgetResponse.status, 404);

    const createBudgetResponse = await fetch(
      `${baseUrl}/organizations/${customerA}/budgets`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          scopeType: "organization",
          metricKey: "source_words_processed",
          limitQuantity: "7",
          warningPercent: 80,
          enforcement: "block",
          period: "subscription",
          reason: "Integration limit",
        }),
      },
    );
    assert.equal(createBudgetResponse.status, 201);
    const budgetId = (await createBudgetResponse.json()).budget.id;
    let budgetResponse = await fetch(`${baseUrl}/organizations/${customerA}/budgets`);
    const initialBudgetBody = await budgetResponse.json();
    assert.equal(budgetResponse.status, 200, JSON.stringify(initialBudgetBody));
    let budgetBody = initialBudgetBody;
    assert.equal(budgetBody.budgets[0].usedQuantity, "6");
    assert.equal(budgetBody.budgets[0].state, "warning");
    assert.ok(budgetBody.metrics.some((metric) => metric.key === "llm_total_tokens"));

    await assert.rejects(
      reserveUsage({
        organizationId: customerA,
        businessUnitId: buA,
        projectId: projectA,
        operation: "state_import",
        idempotencyKey: "state_import:budget-blocked",
        idempotencyFingerprint: "e".repeat(64),
        measurements: { source_words_processed: 2 },
        relevantMetrics: ["source_words_processed"],
      }),
      (error) => (
        error.status === 402
        && error.code === "usage_limit_exceeded"
        && error.details.type === "budget"
      ),
    );
    budgetBody = await fetch(`${baseUrl}/organizations/${customerA}/budgets`).then((response) => response.json());
    assert.ok(budgetBody.alerts.some((alert) => alert.threshold === "blocked"));

    const heldReservation = await reserveUsage({
      organizationId: customerA,
      businessUnitId: buA,
      projectId: projectA,
      operation: "state_import",
      idempotencyKey: "state_import:budget-held",
      idempotencyFingerprint: "f".repeat(64),
      measurements: { source_words_processed: 1 },
      relevantMetrics: ["source_words_processed"],
    });
    assert.equal(heldReservation.duplicate, false);
    assert.ok(heldReservation.warnings.some((warning) => warning.type === "budget"));
    assert.equal(
      (await organizationBudgetStatus(customerA))[0].heldQuantity,
      "1",
    );
    const duplicateHeldReservation = await reserveUsage({
        organizationId: customerA,
        businessUnitId: buA,
        projectId: projectA,
        operation: "state_import",
        idempotencyKey: "state_import:budget-held",
        idempotencyFingerprint: "f".repeat(64),
        measurements: { source_words_processed: 1 },
        relevantMetrics: ["source_words_processed"],
      });
    assert.equal(duplicateHeldReservation.duplicate, true);
    assert.equal(duplicateHeldReservation.pending, true);
    const unrelatedBudgetId = await scalar(
      `insert into usage_budgets(
         organization_id, scope_type, metric_key, limit_quantity, enforcement
       ) values($1, 'organization', 'llm_total_tokens', 10, 'observe')
       returning id`,
      [customerA],
    );
    await recordUsageEvent({
      ...usageEventInput,
      idempotencyKey: "state_import:budget-held",
      idempotencyFingerprint: "f".repeat(64),
      reservationId: heldReservation.id,
      measurements: { source_words_processed: 1 },
      items: [],
    });
    assert.equal(
      await scalar(
        "select count(*)::int from usage_budget_alerts where budget_id = $1",
        [unrelatedBudgetId],
      ),
      0,
    );
    await pool.query(
      "update usage_budgets set superseded_at = now() where id = $1",
      [unrelatedBudgetId],
    );
    let status = (await organizationBudgetStatus(customerA))[0];
    assert.equal(status.usedQuantity, "7");
    assert.equal(status.heldQuantity, "0");
    assert.equal(status.state, "exceeded");

    budgetBody = await fetch(`${baseUrl}/organizations/${customerA}/budgets`).then((response) => response.json());
    const exceededAlert = budgetBody.alerts.find((alert) => alert.threshold === "exceeded");
    assert.ok(exceededAlert);
    const acknowledgeResponse = await fetch(
      `${baseUrl}/organizations/${customerA}/budget-alerts/${exceededAlert.id}/acknowledge`,
      { method: "POST" },
    );
    assert.equal(acknowledgeResponse.status, 200);
    assert.ok((await acknowledgeResponse.json()).alert.acknowledgedAt);

    const replaceBudgetResponse = await fetch(
      `${baseUrl}/organizations/${customerA}/budgets`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          scopeType: "organization",
          metricKey: "source_words_processed",
          limitQuantity: "100",
          warningPercent: 75,
          enforcement: "warn",
          period: "subscription",
          reason: "Integration replacement",
        }),
      },
    );
    assert.equal(replaceBudgetResponse.status, 201);
    assert.equal(
      await scalar(
        `select count(*)::int from usage_budgets
         where organization_id = $1 and metric_key = 'source_words_processed'
           and superseded_at is null`,
        [customerA],
      ),
      1,
    );
    assert.equal(
      await scalar("select superseded_at is not null from usage_budgets where id = $1", [budgetId]),
      true,
    );

    await assert.rejects(
      reserveUsage({
        organizationId: customerA,
        businessUnitId: buA,
        projectId: projectA,
        operation: "state_import",
        idempotencyKey: "state_import:plan-blocked",
        idempotencyFingerprint: "2".repeat(64),
        measurements: { source_words_processed: 1 },
        relevantMetrics: ["source_words_processed"],
        planLimits: {
          usage: {
            source_words_processed: {
              limit: 7,
              warningPercent: 80,
              enforcement: "block",
            },
          },
        },
      }),
      (error) => error.status === 402 && error.details.type === "plan_limit",
    );

    const planHeld = await reserveUsage({
      organizationId: customerA,
      businessUnitId: buA,
      projectId: projectA,
      operation: "state_import",
      idempotencyKey: "state_import:plan-held",
      idempotencyFingerprint: "3".repeat(64),
      measurements: { source_words_processed: 1 },
      relevantMetrics: ["source_words_processed"],
      planLimits: { usage: { source_words_processed: 8 } },
    });
    await assert.rejects(
      reserveUsage({
        organizationId: customerA,
        businessUnitId: buA,
        projectId: projectA,
        operation: "state_import",
        idempotencyKey: "state_import:plan-concurrent-blocked",
        idempotencyFingerprint: "4".repeat(64),
        measurements: { source_words_processed: 1 },
        relevantMetrics: ["source_words_processed"],
        planLimits: { usage: { source_words_processed: 8 } },
      }),
      (error) => error.status === 402 && error.details.type === "plan_limit",
    );
    await releaseUsageReservation(planHeld.id);

    const unknownTokenHold = await reserveUsage({
      organizationId: customerA,
      businessUnitId: buA,
      projectId: projectA,
      operation: "ai_translation_revision",
      idempotencyKey: "ai_translation_revision:unknown-token-held",
      idempotencyFingerprint: "5".repeat(64),
      measurements: {},
      relevantMetrics: ["llm_total_tokens"],
      planLimits: { usage: { llm_total_tokens: 29 } },
    });
    await assert.rejects(
      reserveUsage({
        organizationId: customerA,
        businessUnitId: buA,
        projectId: projectA,
        operation: "ai_translation_revision",
        idempotencyKey: "ai_translation_revision:unknown-token-concurrent",
        idempotencyFingerprint: "6".repeat(64),
        measurements: {},
        relevantMetrics: ["llm_total_tokens"],
        planLimits: { usage: { llm_total_tokens: 29 } },
      }),
      (error) => error.status === 402 && error.details.metricKey === "llm_total_tokens",
    );
    await releaseUsageReservation(unknownTokenHold.id);

    const billingResponse = await fetch(
      `${baseUrl}/organizations/${customerA}/billing-access`,
    );
    assert.equal(billingResponse.status, 200);
    const billingBody = await billingResponse.json();
    assert.equal(billingBody.account.subscriptionState, "active");
    assert.ok(billingBody.entitlements.every((entitlement) => entitlement.allowed));

    const checkoutResponse = await fetch(
      `${baseUrl}/organizations/${customerA}/billing/checkout`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ priceKey: "legacy-monthly-test" }),
      },
    );
    assert.equal(checkoutResponse.status, 201);
    assert.equal((await checkoutResponse.json()).url, "https://checkout.stripe.test/session");
    assert.equal(stripeCalls.customers.length, 1);
    assert.equal(stripeCalls.checkout[0].parameters.mode, "subscription");
    assert.equal(
      stripeCalls.checkout[0].parameters.metadata.hedgeling_organization_id,
      customerA,
    );
    assert.match(stripeCalls.checkout[0].options.idempotencyKey, /^hedgeling-checkout-/);
    const reusedCheckoutResponse = await fetch(
      `${baseUrl}/organizations/${customerA}/billing/checkout`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ priceKey: "legacy-monthly-test" }),
      },
    );
    assert.equal(reusedCheckoutResponse.status, 200);
    assert.equal((await reusedCheckoutResponse.json()).reused, true);
    assert.equal(stripeCalls.checkout.length, 1);

    const changedCheckoutResponse = await fetch(
      `${baseUrl}/organizations/${customerA}/billing/checkout`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ priceKey: "legacy-yearly-test" }),
      },
    );
    assert.equal(changedCheckoutResponse.status, 201);
    assert.equal(
      (await changedCheckoutResponse.json()).url,
      "https://checkout.stripe.test/session_yearly",
    );
    assert.deepEqual(stripeCalls.checkoutExpired, ["cs_test_customer_a"]);
    assert.equal(stripeCalls.checkout.length, 2);
    assert.equal(
      await scalar(
        "select status from billing_checkout_sessions where provider_session_id = 'cs_test_customer_a'",
      ),
      "expired",
    );
    assert.equal(
      await scalar(
        "select price_key from billing_checkout_sessions where provider_session_id = 'cs_test_customer_a_yearly'",
      ),
      "legacy-yearly-test",
    );
    const reusedChangedCheckoutResponse = await fetch(
      `${baseUrl}/organizations/${customerA}/billing/checkout`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ priceKey: "legacy-yearly-test" }),
      },
    );
    assert.equal(reusedChangedCheckoutResponse.status, 200);
    assert.equal((await reusedChangedCheckoutResponse.json()).reused, true);
    assert.equal(stripeCalls.checkout.length, 2);

    await pool.query(
      `insert into billing_checkout_sessions(
         billing_account_id, price_key, provider, provider_session_id, status, url, expires_at
       ) values($1, 'legacy-monthly-test', 'stripe', 'cs_test_collision',
         'expired', 'https://checkout.stripe.test/collision', now() - interval '1 minute')`,
      [customerABillingAccount],
    );
    await assert.rejects(
      createStripeCheckoutSession(
        {
          body: { priceKey: "legacy-monthly-test" },
          authorizedOrganizationId: customerB,
          auth: { user: { id: teamUser } },
        },
        response(),
      ),
      (error) => error.code === "23505",
    );
    assert.deepEqual(
      stripeCalls.checkoutExpired,
      ["cs_test_customer_a", "cs_test_collision"],
    );
    assert.equal(
      await scalar(
        "select count(*)::int from billing_checkout_sessions where billing_account_id = (select id from billing_accounts where organization_id = $1)",
        [customerB],
      ),
      0,
    );

    await assert.rejects(
      createStripeCheckoutSession(
        {
          body: { priceKey: "legacy-monthly-test" },
          authorizedOrganizationId: customerA,
          auth: { user: { id: teamUser } },
        },
        response(),
      ),
      (error) => error.code === "23505",
    );
    assert.deepEqual(
      stripeCalls.checkoutExpired,
      [
        "cs_test_customer_a",
        "cs_test_collision",
        "cs_test_customer_a_yearly",
        "cs_test_collision",
      ],
    );
    assert.equal(
      await scalar(
        "select count(*)::int from billing_checkout_sessions where billing_account_id = $1 and status = 'open'",
        [customerABillingAccount],
      ),
      0,
    );

    const portalResponse = await fetch(
      `${baseUrl}/organizations/${customerA}/billing/portal`,
      { method: "POST", headers },
    );
    assert.equal(portalResponse.status, 201);
    assert.equal((await portalResponse.json()).url, "https://billing.stripe.test/portal");
    assert.equal(stripeCalls.portal[0].customer, "cus_customer_a");
  });
  const importUsageContext = {
    organizationId: customerA,
    businessUnitId: buA,
    projectId: projectA2,
    actor: {
      actorType: "user",
      actorUserId: teamUser,
      actorServiceAccountId: null,
    },
    idempotencyKey: "state_import:instrumentation-test",
    idempotencyFingerprint: "e".repeat(64),
  };
  const importedCounts = await importHedgelingState({
    state: {
      sourceLocale: "en-US",
      files: {
        "first.json": {
          entries: {
            "import-usage-first": { sourceText: "Metered import string" },
          },
        },
      },
    },
    projectSlug: "project-a-2",
    projectName: "Project A 2",
    usageContext: importUsageContext,
  });
  assert.equal(importedCounts.sourceStrings, 1);
  assert.equal(importedCounts.meteredSourceStrings, 1);
  const importedUsageEvent = await scalar(
    "select id from usage_events where idempotency_key = 'state_import:instrumentation-test'",
  );
  assert.equal(
    await scalar(
      `select measurement.quantity::int
       from usage_event_measurements measurement
       where measurement.usage_event_id = $1
         and measurement.metric_key = 'source_words_processed'`,
      [importedUsageEvent],
    ),
    3,
  );
  assert.ok(await scalar(
    "select source_string_id from usage_event_items where usage_event_id = $1",
    [importedUsageEvent],
  ));
  await assert.rejects(
    importHedgelingState({
      state: {
        sourceLocale: "en-US",
        files: {
          "prune-conflict.json": {
            entries: {
              "prune-conflict-kept": { sourceText: "A replacement source string" },
            },
          },
        },
      },
      projectSlug: "project-a",
      projectName: "Project A",
      pruneMissing: true,
    }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "import_prune_work_order_conflict");
      assert.ok(error.details.blockingWorkOrders.some(
        (workOrder) => workOrder.id === phase5WorkOrderId
          && workOrder.sourceStrings.some(
            (sourceString) => sourceString.id === usageSource,
          ),
      ));
      return true;
    },
  );
  assert.equal(
    await scalar(
      "select count(*)::int from source_strings where project_id = $1 and source_hash = 'usage-source'",
      [projectA],
    ),
    1,
  );
  assert.equal(
    await scalar(
      `select count(*)::int from source_strings
       where project_id = $1 and source_hash = 'prune-conflict-kept'`,
      [projectA],
    ),
    0,
  );
  const unchangedImportCounts = await importHedgelingState({
    state: {
      sourceLocale: "en-US",
      files: {
        "first.json": {
          entries: {
            "import-usage-first": { sourceText: "Metered import string" },
          },
        },
      },
    },
    projectSlug: "project-a-2",
    projectName: "Project A 2",
    usageContext: {
      ...importUsageContext,
      idempotencyKey: "state_import:instrumentation-unchanged-test",
      idempotencyFingerprint: "1".repeat(64),
    },
  });
  assert.equal(unchangedImportCounts.sourceStrings, 1);
  assert.equal(unchangedImportCounts.meteredSourceStrings, 0);
  assert.equal(
    await scalar(
      `select count(*)::int
       from usage_event_measurements measurement
       join usage_events event on event.id = measurement.usage_event_id
       where event.idempotency_key = 'state_import:instrumentation-unchanged-test'`,
    ),
    0,
  );
  await importHedgelingState({
    state: {
      sourceLocale: "en-US",
      files: {
        "second.json": {
          entries: {
            "import-usage-second": { sourceText: "Replacement source" },
          },
        },
      },
    },
    projectSlug: "project-a-2",
    projectName: "Project A 2",
    pruneMissing: true,
    usageContext: {
      ...importUsageContext,
      idempotencyKey: "state_import:instrumentation-prune-test",
      idempotencyFingerprint: "f".repeat(64),
    },
  });
  assert.equal(
    await scalar(
      "select source_string_id is null from usage_event_items where usage_event_id = $1",
      [importedUsageEvent],
    ),
    true,
  );
  await withConsoleApi(async (baseUrl) => {
    const webhookResponse = await fetch(`${baseUrl}/api/billing/stripe/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "test-signature",
      },
      body: JSON.stringify({
        id: "evt_raw_webhook",
        type: "invoice.created",
        created: 1_800_000_000,
        data: { object: { id: "in_raw_webhook" } },
      }),
    });
    assert.equal(webhookResponse.status, 200);
    assert.deepEqual(await webhookResponse.json(), {
      received: true,
      duplicate: false,
      status: "ignored",
    });
  });

  const noInheritance = await scalar(
    `insert into role_assignments(principal_type, principal_id, role_id, scope_type, scope_id, inherit_to_children)
     values('user', $1, $2, 'business_unit', $3, false) returning id`,
    [directUser, developerRole, buA],
  );
  assert.equal((await authorize(directUser, "project-a-2", "imports.run")).status, 403);
  await pool.query(`update role_assignments set inherit_to_children = true where id = $1`, [noInheritance]);
  assert.equal((await authorize(directUser, "project-a-2", "imports.run")).allowed, true);

  const team = await scalar(
    `insert into teams(organization_id, slug, name) values($1, 'reviewers', 'Reviewers') returning id`,
    [customerA],
  );
  await pool.query(`insert into team_memberships(team_id, organization_membership_id) values($1, $2)`, [team, teamMembership]);
  const teamGrant = await scalar(
    `insert into role_assignments(principal_type, principal_id, role_id, scope_type, scope_id)
     values('team', $1, $2, 'project', $3) returning id`,
    [team, viewerRole, projectA],
  );
  assert.equal((await authorize(teamUser, "project-a", "strings.view")).allowed, true);

  await pool.query(`update role_assignments set expires_at = now() - interval '1 minute' where id = $1`, [teamGrant]);
  assert.equal((await authorize(teamUser, "project-a", "strings.view")).status, 403);
  await pool.query(`update role_assignments set expires_at = null, revoked_at = now() where id = $1`, [teamGrant]);
  assert.equal((await authorize(teamUser, "project-a", "strings.view")).status, 403);

  const localeGrant = await scalar(
    `insert into role_assignments(
       principal_type, principal_id, role_id, scope_type, scope_id, conditions
     ) values('user', $1, $2, 'project', $3, '{"locales":["fr-CA"]}') returning id`,
    [teamUser, translatorRole, projectA],
  );
  const project = { id: projectA, organizationId: customerA, businessUnitId: buA };
  assert.ok((await projectPermissions(
    { user: { id: teamUser, platformStaff: false } },
    project,
    { locale: "fr-CA" },
  )).includes("translations.edit"));
  assert.ok(!(await projectPermissions(
    { user: { id: teamUser, platformStaff: false } },
    project,
    { locale: "es-ES" },
  )).includes("translations.edit"));
  await pool.query("update role_assignments set revoked_at = now() where id = $1", [localeGrant]);

  const exportGrant = await scalar(
    `insert into role_assignments(
       principal_type, principal_id, role_id, scope_type, scope_id, conditions
     ) values('user', $1, $2, 'project', $3, '{"locales":["fr-CA"]}') returning id`,
    [teamUser, developerRole, projectA],
  );
  const exportSource = await scalar(
    `insert into source_strings(project_id, source_hash, source_text)
     values($1, 'export-source', 'Export source') returning id`,
    [projectA],
  );
  await pool.query(
    `insert into translations(source_string_id, locale, text, human_status, source)
     values($1, 'fr-CA', 'Français', 'verified', 'human'),
           ($1, 'es-ES', 'Español', 'verified', 'human')`,
    [exportSource],
  );
  // A console-approved MACHINE translation (verified, source stays 'mt') must
  // export like any other verified row, and an unapproved MT row must not.
  const exportMtSource = await scalar(
    `insert into source_strings(project_id, source_hash, source_text)
     values($1, 'export-source-mt', 'Export MT source') returning id`,
    [projectA],
  );
  const exportPendingSource = await scalar(
    `insert into source_strings(project_id, source_hash, source_text)
     values($1, 'export-source-pending', 'Export pending source') returning id`,
    [projectA],
  );
  await pool.query(
    `insert into translations(source_string_id, locale, text, human_status, source)
     values($1, 'fr-CA', 'Français (MT approuvé)', 'verified', 'mt'),
           ($2, 'fr-CA', 'Français (MT en attente)', 'pending', 'mt')`,
    [exportMtSource, exportPendingSource],
  );
  assert.equal((await authorize(
    teamUser,
    "project-a",
    "exports.run",
    null,
    { localeListQuery: "locales" },
    { locales: "fr-CA" },
  )).allowed, true);
  assert.equal((await authorize(
    teamUser,
    "project-a",
    "exports.run",
    null,
    { localeListQuery: "locales" },
    { locales: "fr-CA,es-ES" },
  )).status, 403);
  assert.equal((await authorize(
    teamUser,
    "project-a",
    "exports.run",
    null,
    { localeListQuery: "locales" },
  )).status, 403);
  assert.equal((await authorize(teamUser, "project-a", "exports.run")).status, 403);
  await pool.query(
    `insert into user_identities(user_id, provider, provider_subject, email_verified)
     values($1, 'cognito:test-pool', 'export-subject', true)`,
    [teamUser],
  );
  const revisionGrant = await scalar(
    `insert into role_assignments(
       principal_type, principal_id, role_id, scope_type, scope_id, conditions
     ) values('user', $1, $2, 'project', $3, '{"locales":["fr-CA"]}') returning id`,
    [teamUser, translatorRole, projectA],
  );
  useCognitoTestAuthentication({
    sub: "export-subject",
    "cognito:groups": [],
  }, {
    userInfo: async () => {
      throw new Error("UserInfo must not be called for an existing export identity");
    },
  });
  let retryableInvalidResponses = 0;
  let geminiRequestCount = 0;
  let expectedProviderKey = null;
  setGeminiTestClient(async ({ user, apiKey }) => {
    assert.equal(apiKey, expectedProviderKey);
    geminiRequestCount += 1;
    const retryable = user.includes("Retry with the same key");
    if (retryable) retryableInvalidResponses += 1;
    const invalid = user.includes("Force invalid usage test");
    const shouldReject = invalid || (retryable && retryableInvalidResponses <= 2);
    return {
      text: shouldReject ? "[fr-CA] Invalid" : "Traduction révisée",
      model: "gemini-metering-test",
      apiVersion: "v1",
      raw: {
        responseId: shouldReject ? "gemini-response-invalid" : "gemini-response-metering",
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: shouldReject ? {
          promptTokenCount: 10,
          candidatesTokenCount: 2,
          totalTokenCount: 12,
        } : {
          promptTokenCount: 101,
          candidatesTokenCount: 12,
          cachedContentTokenCount: 20,
          thoughtsTokenCount: 7,
          totalTokenCount: 120,
        },
      },
    };
  });
  await withConsoleApi(async (baseUrl) => {
    const headers = { authorization: "Bearer export-test-token" };
    await pool.query(
      "update subscriptions set state = 'unpaid' where id = $1",
      [customerASubscription],
    );
    const commerciallyDenied = await fetch(
      `${baseUrl}/api/export-verified?project=project-a&locales=fr-CA`,
      { headers },
    );
    assert.equal(commerciallyDenied.status, 402);
    assert.equal((await commerciallyDenied.json()).code, "entitlement_required");
    await pool.query(
      "update subscriptions set state = 'active' where id = $1",
      [customerASubscription],
    );

    const allLocales = await fetch(`${baseUrl}/api/export-verified?project=project-a`, { headers });
    assert.equal(allLocales.status, 403);

    const frenchOnly = await fetch(
      `${baseUrl}/api/export-verified?project=project-a&locales=fr-CA`,
      { headers },
    );
    assert.equal(frenchOnly.status, 200);
    const frenchBody = await frenchOnly.json();
    // Both verified fr-CA rows export — the human one AND the approved MT one
    // (status is the contract, provenance rides in `source` for the CLI).
    // The pending fr-CA MT row never exports.
    assert.deepEqual(
      frenchBody.translations.map(({ sourceHash, locale, source }) => ({ sourceHash, locale, source })),
      [
        { sourceHash: "export-source", locale: "fr-CA", source: "human" },
        { sourceHash: "export-source-mt", locale: "fr-CA", source: "mt" },
      ],
    );

    const mixedLocales = await fetch(
      `${baseUrl}/api/export-verified?project=project-a&locales=fr-CA,es-ES`,
      { headers },
    );
    assert.equal(mixedLocales.status, 403);

    const revisionResponse = await fetch(
      `${baseUrl}/api/translations/${exportSource}/fr-CA/revise`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": "ai-metering-test",
        },
        body: JSON.stringify({ instruction: "Make it concise" }),
      },
    );
    assert.equal(revisionResponse.status, 200);
    const revisionBody = await revisionResponse.json();
    assert.equal(revisionBody.translation.text, "Traduction révisée");
    const geminiRequestsAfterSuccess = geminiRequestCount;
    const replayedRevision = await fetch(
      `${baseUrl}/api/translations/${exportSource}/fr-CA/revise`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": "ai-metering-test",
        },
        body: JSON.stringify({ instruction: "Make it concise" }),
      },
    );
    assert.equal(replayedRevision.status, 200);
    assert.equal(replayedRevision.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(await replayedRevision.json(), revisionBody);
    assert.equal(geminiRequestCount, geminiRequestsAfterSuccess);
    const meteredRevisionEvent = await scalar(
      `select id from usage_events
       where organization_id = $1
         and idempotency_key = 'ai_translation_revision:ai-metering-test'`,
      [customerA],
    );
    assert.ok(meteredRevisionEvent);
    assert.equal(
      await scalar(
        `select quantity::int from usage_event_measurements
         where usage_event_id = $1 and metric_key = 'llm_total_tokens'`,
        [meteredRevisionEvent],
      ),
      120,
    );
    assert.equal(
      await scalar(
        `select quantity::int from usage_event_measurements
         where usage_event_id = $1 and metric_key = 'ai_generation_actions'`,
        [meteredRevisionEvent],
      ),
      1,
    );
    assert.ok(await scalar(
      `select translation_revision_id
       from usage_event_items
       where usage_event_id = $1`,
      [meteredRevisionEvent],
    ));

    const rejectedRevisionResponse = await fetch(
      `${baseUrl}/api/translations/${exportSource}/fr-CA/revise`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": "ai-metering-rejected-test",
        },
        body: JSON.stringify({ instruction: "Force invalid usage test" }),
      },
    );
    assert.equal(rejectedRevisionResponse.status, 502);
    const rejectedUsageEvent = await scalar(
      `select id from usage_events
       where idempotency_key = 'ai_translation_revision:ai-metering-rejected-test'
         and outcome = 'failed'`,
    );
    assert.ok(rejectedUsageEvent);
    assert.equal(
      await scalar(
        `select quantity::int from usage_event_measurements
         where usage_event_id = $1 and metric_key = 'llm_total_tokens'`,
        [rejectedUsageEvent],
      ),
      24,
    );
    assert.equal(
      await scalar(
        `select translation_revision_id is null
         from usage_event_items where usage_event_id = $1`,
        [rejectedUsageEvent],
      ),
      true,
    );
    assert.equal(
      await scalar(
        `select count(*)::int from usage_event_measurements
         where usage_event_id = $1 and metric_key = 'ai_generation_actions'`,
        [rejectedUsageEvent],
      ),
      0,
    );

    const retryableHeaders = {
      ...headers,
      "content-type": "application/json",
      "idempotency-key": "ai-metering-retry-test",
    };
    const retryableBody = JSON.stringify({ instruction: "Retry with the same key" });
    const firstRetryableAttempt = await fetch(
      `${baseUrl}/api/translations/${exportSource}/fr-CA/revise`,
      { method: "POST", headers: retryableHeaders, body: retryableBody },
    );
    assert.equal(firstRetryableAttempt.status, 502);
    const secondRetryableAttempt = await fetch(
      `${baseUrl}/api/translations/${exportSource}/fr-CA/revise`,
      { method: "POST", headers: retryableHeaders, body: retryableBody },
    );
    assert.equal(secondRetryableAttempt.status, 200);
    const successfulRetryBody = await secondRetryableAttempt.json();
    assert.deepEqual(
      await pool.query(
        `select attempt_number as "attemptNumber", outcome
         from usage_events
         where organization_id = $1
           and idempotency_key = 'ai_translation_revision:ai-metering-retry-test'
         order by attempt_number`,
        [customerA],
      ).then((result) => result.rows),
      [
        { attemptNumber: 1, outcome: "failed" },
        { attemptNumber: 2, outcome: "succeeded" },
      ],
    );
    const geminiRequestsAfterRetry = geminiRequestCount;
    const replayedRetry = await fetch(
      `${baseUrl}/api/translations/${exportSource}/fr-CA/revise`,
      { method: "POST", headers: retryableHeaders, body: retryableBody },
    );
    assert.equal(replayedRetry.status, 200);
    assert.equal(replayedRetry.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(await replayedRetry.json(), successfulRetryBody);
    assert.equal(geminiRequestCount, geminiRequestsAfterRetry);

    // Organization-funded inference consumes no managed translation credits.
    // An unavailable key must fail before dispatch, never use our managed key.
    const { encryptSecret } = await import("../src/secret-vault.js");
    process.env.HEDGELING_AI_KEY_ID = "integration";
    process.env.HEDGELING_AI_KEYRING = JSON.stringify({ integration: crypto.randomBytes(32).toString("base64") });
    expectedProviderKey = "synthetic-organization-Gemini-test-key";
    await pool.query("insert into organization_entitlement_overrides(organization_id,entitlement_key,enabled,reason) values($1,'ai_byok',true,'Integration test')", [customerA]);
    await pool.query("insert into organization_ai_settings(organization_id,translation_mode) values($1,'byok')", [customerA]);
    await pool.query("insert into organization_ai_credentials(organization_id,provider,encrypted_secret,last_four) values($1,'gemini',$2,'-key')", [customerA, encryptSecret(expectedProviderKey, customerA)]);
    const ownKeyHeaders = { ...headers, "content-type": "application/json", "idempotency-key": "byok-revision" };
    const ownKeyResult = await fetch(`${baseUrl}/api/translations/${exportSource}/fr-CA/revise`, { method: "POST", headers: ownKeyHeaders, body: JSON.stringify({ instruction: "Use my organization's key" }) });
    assert.equal(ownKeyResult.status, 200, await ownKeyResult.clone().text());
    assert.equal((await ownKeyResult.json()).aiCredits, 0);
    assert.equal(await scalar(`select coalesce(sum(m.quantity),0)::int from usage_events e join usage_event_measurements m on m.usage_event_id=e.id where e.organization_id=$1 and e.idempotency_key='ai_translation_revision:byok-revision' and m.metric_key='ai_credits'`, [customerA]), 0);
    const byokRequests = geminiRequestCount;
    const replayedOwnKey = await fetch(`${baseUrl}/api/translations/${exportSource}/fr-CA/revise`, { method: "POST", headers: ownKeyHeaders, body: JSON.stringify({ instruction: "Use my organization's key" }) });
    assert.equal(replayedOwnKey.status, 200); assert.equal(geminiRequestCount, byokRequests);
    await pool.query("delete from organization_ai_credentials where organization_id=$1", [customerA]);
    const missingKey = await fetch(`${baseUrl}/api/translations/${exportSource}/fr-CA/revise`, { method: "POST", headers: { ...ownKeyHeaders, "idempotency-key": "missing-byok-key" }, body: JSON.stringify({ instruction: "Must not fall back" }) });
    assert.equal(missingKey.status, 409); assert.equal(geminiRequestCount, byokRequests);
    await pool.query("delete from organization_ai_settings where organization_id=$1", [customerA]);
    await pool.query("delete from organization_entitlement_overrides where organization_id=$1 and entitlement_key='ai_byok'", [customerA]);
    delete process.env.HEDGELING_AI_KEYRING; delete process.env.HEDGELING_AI_KEY_ID;
    expectedProviderKey = null;

  });
  setGeminiTestClient(null);
  await pool.query("update role_assignments set revoked_at = now() where id = $1", [revisionGrant]);
  setAuthenticationTestHooks({});
  await assert.rejects(
    pool.query(
      `insert into role_assignments(
         principal_type, principal_id, role_id, scope_type, scope_id, conditions
       ) values('user', $1, $2, 'project', $3, '{"locales":["fr-CA"]}')`,
      [teamUser, developerRole, projectA],
    ),
    (error) => error.code === "23505",
  );
  await pool.query("update role_assignments set revoked_at = now() where id = $1", [exportGrant]);

  await pool.query(
    `update organization_memberships set expires_at = now() - interval '1 minute' where id = $1`,
    [directMembership],
  );
  assert.equal((await authorize(directUser, "project-a", "strings.view")).status, 403);

  const directProjects = await listAccessibleProjects({ user: { id: directUser, platformStaff: false } });
  assert.equal(directProjects.length, 0);
  const platformProjects = await listAccessibleProjects({ platformAdmin: true });
  assert.ok(platformProjects.some((project) => project.slug === "project-a"));
  assert.ok(platformProjects.some((project) => project.slug === "project-b"));
  assert.equal(isPlatformAdmin({ user: { platformStaff: true } }), true);

  // Phase 6: enterprise identity, SCIM, machine credentials, and governance
  // share the same tenant and role-assignment boundaries.
  await pool.query(
    "update organization_memberships set expires_at = null where id = $1",
    [directMembership],
  );
  await pool.query(
    `update users set email = case id
       when $1 then 'direct@customer-a.example'
       when $2 then 'team@customer-a.example'
       else email
     end
     where id in ($1, $2)`,
    [directUser, teamUser],
  );
  let serviceCredential;
  let serviceAccountId;
  let scimCredential;
  let scimUserId;
  let identityConnectionId;
  await withAccessApi(directUser, async (baseUrl) => {
    const serviceCreated = await fetch(`${baseUrl}/organizations/${customerA}/service-accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Phase 6 CI" }),
    });
    assert.equal(serviceCreated.status, 201);
    const serviceBody = await serviceCreated.json();
    serviceCredential = serviceBody.credential.token;
    serviceAccountId = serviceBody.serviceAccount.id;
    assert.match(serviceCredential, /^hdlg_sa_/);
    assert.equal(
      await scalar(
        `select count(*)::int from service_account_credentials
         where token_digest = $1`,
        [crypto.createHash('sha256').update(serviceCredential).digest('hex')],
      ),
      1,
    );
    assert.equal(
      await scalar(
        `select count(*)::int from service_account_credentials
         where token_digest = $1`,
        [serviceCredential],
      ),
      0,
    );

    const serviceGrant = await fetch(`${baseUrl}/organizations/${customerA}/role-assignments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principalType: "service_account",
        principalId: serviceAccountId,
        roleId: viewerRole,
        scopeType: "project",
        scopeId: projectA,
      }),
    });
    assert.equal(serviceGrant.status, 201);
    const ownerRole = await scalar("select id from roles where key = 'organization_owner' and organization_id is null");
    const unsafeGrant = await fetch(`${baseUrl}/organizations/${customerA}/role-assignments`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalType: "service_account", principalId: serviceAccountId,
        roleId: ownerRole, scopeType: "organization", scopeId: customerA, inheritToChildren: true }),
    });
    assert.equal(unsafeGrant.status, 403, JSON.stringify(await unsafeGrant.json()));
    await withConsoleApi(async (consoleUrl) => {
      const invoke = (action, input) => fetch(`${consoleUrl}/api/actions/${action}`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${serviceCredential}` },
        body: JSON.stringify(input),
      });
      const projects = await invoke("projects.list", {}).then((response) => response.json());
      assert.deepEqual(projects.result.projects.map((project) => project.slug), ["project-a"]);
      const allowed = await invoke("project.sync.status", { projectSlug: "project-a" });
      assert.equal(allowed.status, 200, JSON.stringify(await allowed.json()));
      assert.equal((await invoke("project.sync.status", { projectSlug: "project-b" })).status, 403);
      // Simulate an old overprivileged grant. Runtime checks must still deny
      // machine access administration, even though ordinary RBAC would allow it.
      const legacyGrant = await scalar(
        `insert into role_assignments(principal_type, principal_id, role_id, scope_type, scope_id, inherit_to_children)
         values('service_account', $1, $2, 'organization', $3, true) returning id`,
        [serviceAccountId, ownerRole, customerA],
      );
      try {
        const denied = await fetch(`${consoleUrl}/api/access/organizations/${customerA}/role-assignments`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${serviceCredential}` },
          body: "{}",
        });
        assert.equal(denied.status, 403);
        assert.equal((await denied.json()).code, "human_decision_required");
      } finally { await pool.query("delete from role_assignments where id = $1", [legacyGrant]); }
    });
    const scimCreated = await fetch(`${baseUrl}/organizations/${customerA}/scim-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Phase 6 directory" }),
    });
    assert.equal(scimCreated.status, 201);
    const scimBody = await scimCreated.json();
    scimCredential = scimBody.scimToken.token;
    assert.match(scimCredential, /^hdlg_scim_/);

    const domainClaim = await fetch(`${baseUrl}/organizations/${customerA}/identity/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "customer-a.example" }),
    });
    assert.equal(domainClaim.status, 201);
    const domainBody = await domainClaim.json();
    const verificationValue = domainBody.dns.value;
    setEnterpriseIdentityTestHooks({
      resolveTxt: async () => [[verificationValue]],
    });
    const verified = await fetch(
      `${baseUrl}/organizations/${customerA}/identity/domains/${domainBody.domain.id}/verify`,
      { method: "POST" },
    );
    assert.equal(verified.status, 200);

    const connectionCreated = await fetch(
      `${baseUrl}/organizations/${customerA}/identity/connections`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionType: "saml",
          displayName: "Customer A SSO",
          cognitoProviderName: "CustomerA-SAML",
        }),
      },
    );
    assert.equal(connectionCreated.status, 201);
    identityConnectionId = (await connectionCreated.json()).connection.id;
    const activated = await fetch(
      `${baseUrl}/organizations/${customerA}/identity/connections/${identityConnectionId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      },
    );
    assert.equal(activated.status, 200);
    const recovery = await fetch(
      `${baseUrl}/organizations/${customerA}/identity/recovery-grants`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: directUser,
          reason: "Phase 6 test recovery",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      },
    );
    assert.equal(recovery.status, 201);
    const duplicateRecovery = await fetch(
      `${baseUrl}/organizations/${customerA}/identity/recovery-grants`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: directUser,
          reason: "Duplicate recovery must conflict",
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        }),
      },
    );
    assert.equal(duplicateRecovery.status, 409);
    assert.equal((await duplicateRecovery.json()).code, "identity_recovery_conflict");
    const policy = await fetch(`${baseUrl}/organizations/${customerA}/identity/policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ssoRequired: true,
        passwordLoginEnabled: false,
        jitMembershipEnabled: false,
        jitMembershipType: "internal",
      }),
    });
    assert.equal(policy.status, 200);
  });

  await withAccessApi(directUser, async (baseUrl) => {
    const conflictingDomain = await fetch(
      `${baseUrl}/organizations/${customerB}/identity/domains`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: "customer-a.example" }),
      },
    );
    assert.equal(conflictingDomain.status, 409);
    assert.equal((await conflictingDomain.json()).code, "identity_domain_conflict");
  }, {
    principalType: "user",
    user: { id: directUser, platformStaff: true },
  });

  process.env.COGNITO_DOMAIN = "cognito.example.test";
  process.env.COGNITO_SSO_REDIRECT_URI = "https://console.example.test/api/auth/sso/callback";
  process.env.HEDGELING_SESSION_SIGNING_SECRET = "phase-6-integration-signing-secret";
  const cookieHeader = (response) => {
    const values = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    return values.map((value) => value.split(";")[0]).join("; ");
  };
  setEnterpriseIdentityTestHooks({
    exchangeCode: async () => ({
      access_token: "wrong-provider-access-token",
      id_token: "wrong-provider-id-token",
      refresh_token: "wrong-provider-refresh-token",
      expires_in: 3600,
    }),
  });
  let expectedIdentityNonce = "intentionally-wrong-nonce";
  useCognitoTestAuthentication({
    sub: "wrong-provider-subject",
    username: "CognitoUsers_wrong-provider-subject",
    scope: "openid email profile",
    "cognito:groups": [],
  }, {
    verifyIdToken: async () => ({
      sub: "wrong-provider-subject",
      nonce: expectedIdentityNonce,
    }),
    userInfo: async () => assert.fail("Wrong-provider callback must fail before profile linking"),
  });
  await withConsoleApi(async (baseUrl) => {
    const grantedDiscovery = await fetch(`${baseUrl}/api/auth/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "direct@customer-a.example" }),
    });
    const grantedBody = await grantedDiscovery.json();
    const ordinaryDiscovery = await fetch(`${baseUrl}/api/auth/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "team@customer-a.example" }),
    });
    const ordinaryBody = await ordinaryDiscovery.json();
    assert.equal(grantedBody.method, "sso");
    assert.equal(ordinaryBody.method, "sso");
    assert.equal(Object.hasOwn(grantedBody, "recoveryAccess"), false);
    assert.equal(Object.hasOwn(ordinaryBody, "recoveryAccess"), false);

    for (const email of ["direct@customer-a.example", "team@customer-a.example"]) {
      const requestedRecovery = await fetch(`${baseUrl}/api/auth/discover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, recovery: true }),
      });
      assert.deepEqual(await requestedRecovery.json(), {
        method: "password",
        passwordLoginEnabled: true,
      });
    }

    const state = new URL(grantedBody.url).searchParams.get("state");
    const nonce = new URL(grantedBody.url).searchParams.get("nonce");
    assert.ok(nonce);
    const invalidNonceCallback = await fetch(
      `${baseUrl}/api/auth/sso/callback?state=${encodeURIComponent(state)}&code=wrong-nonce-code`,
      {
        headers: { cookie: cookieHeader(grantedDiscovery) },
        redirect: "manual",
      },
    );
    assert.equal(invalidNonceCallback.status, 403);
    assert.match(
      (await invalidNonceCallback.json()).error,
      /identity token nonce is invalid/,
    );
    expectedIdentityNonce = nonce;
    const callback = await fetch(
      `${baseUrl}/api/auth/sso/callback?state=${encodeURIComponent(state)}&code=wrong-provider-code`,
      {
        headers: { cookie: cookieHeader(grantedDiscovery) },
        redirect: "manual",
      },
    );
    assert.equal(callback.status, 403);
    assert.match(
      (await callback.json()).error,
      /did not originate from the selected identity provider/,
    );
    assert.equal(
      await scalar(
        "select count(*)::int from user_identities where provider_subject = 'wrong-provider-subject'",
      ),
      0,
    );
  });
  setEnterpriseIdentityTestHooks({});
  setAuthenticationTestHooks({});

  await withConsoleApi(async (baseUrl) => {
    const projectsResponse = await fetch(`${baseUrl}/api/projects`, {
      headers: { authorization: `Bearer ${serviceCredential}` },
    });
    assert.equal(projectsResponse.status, 200);
    const serviceProjects = (await projectsResponse.json()).projects;
    assert.deepEqual(serviceProjects.map((project) => project.slug), ["project-a"]);
    await pool.query(
      `insert into role_assignments(
         principal_type, principal_id, role_id, scope_type, scope_id,
         inherit_to_children
       ) values('service_account', $1, $2, 'organization', $3, true)`,
      [serviceAccountId, organizationAdminRole, customerA],
    );
    const serviceIdentityMutation = await fetch(
      `${baseUrl}/api/access/organizations/${customerA}/identity/policy`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${serviceCredential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jitMembershipEnabled: true }),
      },
    );
    assert.equal(serviceIdentityMutation.status, 403);
    assert.match(
      (await serviceIdentityMutation.json()).error,
      /requires a human user/,
    );

    const scimUserResponse = await fetch(`${baseUrl}/scim/v2/${customerA}/Users`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${scimCredential}`,
        "content-type": "application/scim+json",
      },
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        externalId: "directory-user-1",
        userName: "provisioned@customer-a.example",
        displayName: "Provisioned User",
        active: true,
      }),
    });
    assert.equal(scimUserResponse.status, 201);
    scimUserId = (await scimUserResponse.json()).id;

    const crossTenantClaim = await fetch(`${baseUrl}/scim/v2/${customerA}/Users`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${scimCredential}`,
        "content-type": "application/scim+json",
      },
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        externalId: "cross-tenant-claim",
        userName: "foreign@example.com",
        displayName: "Cross-tenant overwrite",
        active: true,
      }),
    });
    assert.equal(crossTenantClaim.status, 409);
    assert.equal((await crossTenantClaim.json()).scimType, "uniqueness");
    assert.equal(
      await scalar("select display_name from users where id = $1", [foreignUser]),
      null,
    );

    const secondScimUserResponse = await fetch(`${baseUrl}/scim/v2/${customerA}/Users`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${scimCredential}`,
        "content-type": "application/scim+json",
      },
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        externalId: "directory-user-2",
        userName: "second-provisioned@customer-a.example",
        displayName: "Second Provisioned User",
        active: "True",
      }),
    });
    assert.equal(secondScimUserResponse.status, 201);
    const secondScimUserId = (await secondScimUserResponse.json()).id;
    await pool.query(
      `insert into organization_memberships(
         organization_id, user_id, membership_type, status, activated_at
       ) values($1, $2, 'external', 'active', now())`,
      [customerB, secondScimUserId],
    );
    const sharedDisplayNameUpdate = await fetch(
      `${baseUrl}/scim/v2/${customerA}/Users/${secondScimUserId}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${scimCredential}`,
          "content-type": "application/scim+json",
        },
        body: JSON.stringify({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{
            op: "replace",
            path: "displayName",
            value: "Cross-tenant overwrite",
          }],
        }),
      },
    );
    assert.equal(sharedDisplayNameUpdate.status, 409);
    assert.equal((await sharedDisplayNameUpdate.json()).scimType, "mutability");
    assert.equal(
      await scalar("select display_name from users where id = $1", [secondScimUserId]),
      "Second Provisioned User",
    );

    const scimGroupResponse = await fetch(`${baseUrl}/scim/v2/${customerA}/Groups`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${scimCredential}`,
        "content-type": "application/scim+json",
      },
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        externalId: "directory-group-1",
        displayName: "Localization Engineers",
        members: [{ value: scimUserId }, { value: secondScimUserId }],
      }),
    });
    assert.equal(scimGroupResponse.status, 201);
    const groupId = (await scimGroupResponse.json()).id;
    assert.equal(
      await scalar("select count(*)::int from team_memberships where team_id = $1", [groupId]),
      2,
    );

    const selectiveRemoval = await fetch(
      `${baseUrl}/scim/v2/${customerA}/Groups/${groupId}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${scimCredential}`,
          "content-type": "application/scim+json",
        },
        body: JSON.stringify({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{
            op: "remove",
            path: "members",
            value: [{ value: scimUserId }],
          }],
        }),
      },
    );
    assert.equal(selectiveRemoval.status, 200);
    assert.deepEqual(
      (await selectiveRemoval.json()).members.map((member) => member.value),
      [secondScimUserId],
    );

    const bareMemberAdd = await fetch(
      `${baseUrl}/scim/v2/${customerA}/Groups/${groupId}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${scimCredential}`,
          "content-type": "application/scim+json",
        },
        body: JSON.stringify({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "add", path: "members", value: [scimUserId] }],
        }),
      },
    );
    assert.equal(bareMemberAdd.status, 200);
    assert.deepEqual(
      new Set((await bareMemberAdd.json()).members.map((member) => member.value)),
      new Set([scimUserId, secondScimUserId]),
    );
    const bareMemberRemove = await fetch(
      `${baseUrl}/scim/v2/${customerA}/Groups/${groupId}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${scimCredential}`,
          "content-type": "application/scim+json",
        },
        body: JSON.stringify({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "remove", path: "members", value: [scimUserId] }],
        }),
      },
    );
    assert.equal(bareMemberRemove.status, 200);
    assert.deepEqual(
      (await bareMemberRemove.json()).members.map((member) => member.value),
      [secondScimUserId],
    );

    const deprovision = await fetch(`${baseUrl}/scim/v2/${customerA}/Users/${secondScimUserId}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${scimCredential}`,
        "content-type": "application/scim+json",
      },
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: "False" }],
      }),
    });
    assert.equal(deprovision.status, 200);
    assert.equal(
      await scalar(
        `select status from organization_memberships
         where organization_id = $1 and user_id = $2`,
        [customerA, secondScimUserId],
      ),
      "suspended",
    );
    assert.equal(
      await scalar("select count(*)::int from team_memberships where team_id = $1", [groupId]),
      0,
    );

    const reactivate = await fetch(
      `${baseUrl}/scim/v2/${customerA}/Users/${secondScimUserId}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${scimCredential}`,
          "content-type": "application/scim+json",
        },
        body: JSON.stringify({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: "True" }],
        }),
      },
    );
    assert.equal(reactivate.status, 200);
    assert.equal((await reactivate.json()).active, true);
    assert.equal(
      await scalar("select count(*)::int from team_memberships where team_id = $1", [groupId]),
      0,
    );
  });

  assert.equal(
    await organizationIdentityAllows(
      { user: { id: teamUser, platformStaff: false } },
      customerA,
    ),
    false,
  );
  assert.equal(
    await organizationIdentityAllows(
      {
        user: { id: teamUser, platformStaff: false },
        identityConnectionId,
      },
      customerA,
    ),
    true,
  );
  assert.equal(
    await organizationIdentityAllows(
      { user: { id: directUser, platformStaff: false } },
      customerA,
    ),
    true,
  );

  await pool.query(
    `update organization_memberships
     set status = 'active', updated_at = now()
     where organization_id = $1 and user_id = $2`,
    [customerA, scimUserId],
  );
  let phase6AccessRequestId;
  await withAccessApi(scimUserId, async (baseUrl) => {
    const requested = await fetch(`${baseUrl}/organizations/${customerA}/access-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roleId: viewerRole,
        scopeType: "project",
        scopeId: projectA,
        reason: "Needs project context for localization QA",
      }),
    });
    assert.equal(requested.status, 201);
    phase6AccessRequestId = (await requested.json()).accessRequest.id;
  }, {
    user: { id: scimUserId, platformStaff: false },
    identityConnectionId,
  });
  await withAccessApi(directUser, async (baseUrl) => {
    const approved = await fetch(
      `${baseUrl}/organizations/${customerA}/access-requests/${phase6AccessRequestId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approved", reason: "Approved for Phase 6 test" }),
      },
    );
    assert.equal(approved.status, 200);
    const campaign = await fetch(`${baseUrl}/organizations/${customerA}/access-reviews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Phase 6 certification",
        reviewerUserId: directUser,
        dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }),
    });
    assert.equal(campaign.status, 201);
    const campaignBody = await campaign.json();
    assert.ok(campaignBody.campaign.itemCount > 0);
    const opened = await fetch(
      `${baseUrl}/organizations/${customerA}/access-reviews/${campaignBody.campaign.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transition: "open" }),
      },
    );
    assert.equal(opened.status, 200);
    const report = await fetch(`${baseUrl}/organizations/${customerA}/governance-report`);
    assert.equal(report.status, 200);
    const reportBody = await report.json();
    assert.ok(reportBody.members.some((member) => member.userId === scimUserId));
    assert.ok(reportBody.serviceAccounts.some((account) => account.id === serviceAccountId));
  });
  assert.equal(
    await scalar(
      `select count(*)::int from audit_events
       where organization_id = $1 and action like 'scim.%'
         and actor_type = 'system_agent'`,
      [customerA],
    ) >= 3,
    true,
  );

  const checkoutEvent = {
    id: "evt_checkout_completed",
    type: "checkout.session.completed",
    api_version: "2026-06-24.dahlia",
    livemode: false,
    created: 1_800_000_000,
    data: {
      object: {
        id: "cs_test_customer_a",
        customer: "cus_customer_a",
        client_reference_id: customerA,
        metadata: { hedgeling_organization_id: customerA },
      },
    },
  };
  assert.deepEqual(await handleStripeEvent(checkoutEvent), {
    duplicate: false,
    status: "processed",
  });
  assert.equal(
    await scalar(
      "select status from billing_checkout_sessions where provider_session_id = 'cs_test_customer_a'",
    ),
    "completed",
  );

  const stripeSubscription = {
    id: "sub_customer_a",
    customer: "cus_customer_a",
    status: "active",
    cancel_at_period_end: false,
    items: {
      data: [{
        id: "si_legacy_monthly",
        price: { id: "price_legacy_monthly" },
        current_period_start: 1_800_000_000,
        current_period_end: 1_802_592_000,
      }],
    },
  };
  const subscriptionCreatedEvent = {
    id: "evt_subscription_created",
    type: "customer.subscription.created",
    api_version: "2026-06-24.dahlia",
    livemode: false,
    created: 1_800_000_010,
    data: { object: stripeSubscription },
  };
  assert.deepEqual(await handleStripeEvent(subscriptionCreatedEvent), {
    duplicate: false,
    status: "processed",
  });
  assert.equal(
    await scalar(
      "select state from subscriptions where provider = 'stripe' and provider_subscription_id = 'sub_customer_a'",
    ),
    "active",
  );
  assert.equal(
    await scalar("select state from subscriptions where id = $1", [customerASubscription]),
    "canceled",
  );
  assert.deepEqual(await handleStripeEvent(subscriptionCreatedEvent), {
    duplicate: true,
    status: "processed",
  });
  assert.equal(
    await scalar(
      `select count(*)::int from audit_events
       where action = 'billing.subscription_synchronized'
         and metadata->>'providerEventId' = 'evt_subscription_created'`,
    ),
    1,
  );

  await handleStripeEvent({
    ...subscriptionCreatedEvent,
    id: "evt_subscription_older",
    type: "customer.subscription.updated",
    created: 1_799_999_000,
    data: { object: { ...stripeSubscription, status: "unpaid" } },
  });
  assert.equal(
    await scalar(
      "select state from subscriptions where provider_subscription_id = 'sub_customer_a'",
    ),
    "active",
  );

  const pastDueEvent = {
    ...subscriptionCreatedEvent,
    id: "evt_subscription_past_due",
    type: "customer.subscription.updated",
    created: 1_800_000_020,
    data: { object: { ...stripeSubscription, status: "past_due" } },
  };
  await handleStripeEvent(pastDueEvent);
  const firstGraceEnd = await scalar(
    "select grace_ends_at from subscriptions where provider_subscription_id = 'sub_customer_a'",
  );
  assert.equal(
    new Date(firstGraceEnd).getTime(),
    (pastDueEvent.created + 7 * 24 * 60 * 60) * 1000,
  );
  assert.deepEqual(await handleStripeEvent(pastDueEvent), {
    duplicate: true,
    status: "processed",
  });
  assert.equal(
    new Date(await scalar(
      "select grace_ends_at from subscriptions where provider_subscription_id = 'sub_customer_a'",
    )).getTime(),
    new Date(firstGraceEnd).getTime(),
  );

  await assert.rejects(
    handleStripeEvent({
      ...subscriptionCreatedEvent,
      id: "evt_subscription_unknown_price",
      created: 1_800_000_030,
      data: {
        object: {
          ...stripeSubscription,
          id: "sub_unknown_price",
          items: {
            data: [{
              id: "si_unknown",
              price: { id: "price_unmapped" },
              current_period_start: 1_800_000_000,
              current_period_end: 1_802_592_000,
            }],
          },
        },
      },
    }),
    /unmapped customer or price/,
  );
  assert.equal(
    await scalar(
      "select status from billing_provider_events where provider_event_id = 'evt_subscription_unknown_price'",
    ),
    "failed",
  );
  await pool.query(
    `insert into billing_prices(
       key, plan_id, provider, provider_price_id, currency, billing_interval,
       active
     ) values(
       'replay-test', $1, 'stripe', 'price_unmapped', 'USD', 'month', false
     )`,
    [legacyPlan],
  );
  assert.deepEqual(
    await replayFailedStripeEvent("evt_subscription_unknown_price"),
    { duplicate: false, status: "processed" },
  );
  assert.deepEqual(
    await pool.query(
      `select status, attempts
       from billing_provider_events
       where provider_event_id = 'evt_subscription_unknown_price'`,
    ).then((result) => result.rows[0]),
    { status: "processed", attempts: 2 },
  );
  await assert.rejects(
    handleStripeEvent({
      ...subscriptionCreatedEvent,
      id: "evt_subscription_multiple_items",
      created: 1_800_000_035,
      data: {
        object: {
          ...stripeSubscription,
          id: "sub_multiple_items",
          items: {
            data: [
              ...stripeSubscription.items.data,
              {
                id: "si_legacy_yearly",
                price: { id: "price_legacy_yearly" },
                current_period_start: 1_800_000_000,
                current_period_end: 1_831_536_000,
              },
            ],
          },
        },
      },
    }),
    /exactly one base price/,
  );
  assert.equal(
    await scalar(
      "select status from billing_provider_events where provider_event_id = 'evt_subscription_multiple_items'",
    ),
    "failed",
  );
  assert.deepEqual(await handleStripeEvent({
    id: "evt_ignored",
    type: "invoice.created",
    created: 1_800_000_040,
    data: { object: { id: "in_ignored" } },
  }), {
    duplicate: false,
    status: "ignored",
  });
  setStripeTestClient(null);

  const selfServiceUser = await pool.query(
    `insert into users(email, display_name, status)
     values('owner@new-customer.example', 'New Customer', 'active')
     returning id, email, display_name as "displayName"`,
  ).then((result) => result.rows[0]);
  process.env.HEDGELING_SELF_SERVICE_SIGNUP_ENABLED = "true";
  process.env.HEDGELING_SELF_SERVICE_TRIAL_DAYS = "14";
  process.env.HEDGELING_TERMS_VERSION = "integration-terms-v1";
  process.env.HEDGELING_PRIVACY_VERSION = "integration-privacy-v1";
  process.env.HEDGELING_TRIAL_PACKAGE_DOWNLOAD_ENABLED = "true";
  process.env.AWS_REGION = "us-east-1";
  process.env.HEDGELING_TRIAL_PACKAGE_BUCKET = "integration-private-artifacts";
  process.env.HEDGELING_TRIAL_PACKAGE_KEY = "trial/i18n/0.1.0/package.tgz";
  process.env.HEDGELING_TRIAL_PACKAGE_VERSION = "0.1.0";
  process.env.HEDGELING_TRIAL_PACKAGE_FILENAME = "hedgeling-i18n-0.1.0.tgz";
  process.env.HEDGELING_TRIAL_PACKAGE_SHA256 = "b".repeat(64);
  setTrialPackageDownloadTestHooks({
    signUrl: async ({ config, expiresIn }) => {
      assert.equal(config.bucket, "integration-private-artifacts");
      assert.ok(expiresIn > 0 && expiresIn <= 600);
      return "https://downloads.example.test/signed-package";
    },
  });
  await withSelfServiceApi(selfServiceUser, async (baseUrl) => {
    const before = await fetch(`${baseUrl}/status`);
    assert.equal(before.status, 200);
    assert.equal((await before.json()).needsWorkspace, true);

    const createBody = {
      organizationName: "New Customer Studio",
      projectName: "Main application",
      sourceLocale: "en-US",
      targetLocales: ["fr-FR", "de-DE"],
      workflowPresetKey: "ai_human_review",
      acceptedTerms: true,
      acceptedPrivacy: true,
      termsVersion: "integration-terms-v1",
      privacyVersion: "integration-privacy-v1",
    };
    const created = await fetch(`${baseUrl}/workspace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createBody),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.match(createdBody.credential.token, /^hdlg_sa_/);
    assert.equal(createdBody.workspace.subscriptionState, "trialing");
    assert.deepEqual(createdBody.workspace.targetLocales, ["fr-FR", "de-DE"]);
    assert.equal(
      await scalar(
        `select count(*)::int
         from subscriptions subscription
         join billing_accounts account on account.id = subscription.billing_account_id
         where account.organization_id = $1
           and subscription.state = 'trialing'
           and subscription.provider is null
           and subscription.current_period_end
             = subscription.current_period_start + interval '14 days'`,
        [createdBody.workspace.organizationId],
      ),
      1,
    );
    assert.equal(
      await scalar(
        `select count(*)::int
         from role_assignments assignment
         join roles role on role.id = assignment.role_id
         where assignment.principal_type = 'user'
           and assignment.principal_id = $1
           and assignment.scope_id = $2
           and role.key = 'organization_owner'`,
        [selfServiceUser.id, createdBody.workspace.organizationId],
      ),
      1,
    );
    assert.equal(
      await scalar(
        `select count(*)::int
         from service_account_credentials
         where token_digest = $1`,
        [crypto.createHash('sha256').update(createdBody.credential.token).digest('hex')],
      ),
      1,
    );
    assert.equal(
      await scalar(
        `select count(*)::int from user_legal_acceptances
         where user_id = $1`,
        [selfServiceUser.id],
      ),
      2,
    );

    const packageDownload = await fetch(`${baseUrl}/trial-package-download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(packageDownload.status, 201);
    assert.equal(packageDownload.headers.get("cache-control"), "no-store");
    const packageBody = await packageDownload.json();
    assert.equal(
      packageBody.download.url,
      "https://downloads.example.test/signed-package",
    );
    assert.equal(packageBody.download.sha256, "b".repeat(64));
    assert.equal(
      await scalar(
        `select count(*)::int
         from trial_package_download_issuances
         where organization_id = $1
           and user_id = $2
           and status = 'issued'
           and artifact_version = '0.1.0'`,
        [createdBody.workspace.organizationId, selfServiceUser.id],
      ),
      1,
    );
    assert.equal(
      await scalar(
        `select count(*)::int
         from audit_events
         where organization_id = $1
           and actor_id = $2
           and action = 'trial_package_download.issued'`,
        [createdBody.workspace.organizationId, selfServiceUser.id],
      ),
      1,
    );

    const replay = await fetch(`${baseUrl}/workspace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createBody),
    });
    assert.equal(replay.status, 200);
    const replayBody = await replay.json();
    assert.equal(replayBody.created, false);
    assert.equal(replayBody.credential, null);
    assert.equal(
      replayBody.workspace.organizationId,
      createdBody.workspace.organizationId,
    );
    assert.equal(
      await scalar(
        "select count(*)::int from self_service_trial_claims where owner_user_id = $1",
        [selfServiceUser.id],
      ),
      1,
    );

    await pool.query(
      `update subscriptions subscription
       set current_period_end = now() - interval '1 minute'
       from billing_accounts account
       where subscription.billing_account_id = account.id
         and account.organization_id = $1
         and subscription.state = 'trialing'`,
      [createdBody.workspace.organizationId],
    );
    const expiredDownload = await fetch(`${baseUrl}/trial-package-download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(expiredDownload.status, 402);
    assert.equal(
      (await expiredDownload.json()).code,
      "trial_package_expired",
    );
    const source = await pool.query(
      `insert into source_strings(project_id, source_hash, source_text)
       values($1, 'lifecycle-source', 'Customer translation content')
       returning id`,
      [createdBody.workspace.projectId],
    ).then((result) => result.rows[0]);
    await pool.query(
      `insert into translations(
         source_string_id, locale, text, human_status, source
       ) values($1, 'fr-FR', 'Contenu traduit', 'verified', 'human')`,
      [source.id],
    );
    const lifecycleNpmSeat = await pool.query(
      `insert into npm_seat_assignments(
         organization_id, npm_username, status, provider_state
       ) values($1, 'lifecycle-owner', 'active', '{"providerMember":true}'::jsonb)
       returning id`,
      [createdBody.workspace.organizationId],
    ).then((result) => result.rows[0]);
    await pool.query(
      `insert into npm_provisioning_outbox(
         seat_assignment_id, operation, idempotency_key, status,
         completed_at, metadata
       ) values($1, 'invite', $2, 'succeeded', now(), $3)`,
      [
        lifecycleNpmSeat.id,
        `npm-seat:${lifecycleNpmSeat.id}:invite`,
        JSON.stringify({ npmUsername: "lifecycle-owner" }),
      ],
    );

    await withAccessApi(selfServiceUser.id, async (accessUrl) => {
      const scheduledProject = await fetch(
        `${accessUrl}/organizations/${createdBody.workspace.organizationId}/data-lifecycle`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            targetType: "project",
            projectId: createdBody.workspace.projectId,
            reason: "Integration-test project lifecycle",
            confirmation: createdBody.workspace.projectName,
          }),
        },
      );
      assert.equal(scheduledProject.status, 201);
      const projectLifecycle = await scheduledProject.json();
      assert.equal(projectLifecycle.request.targetType, "project");
      assert.equal(projectLifecycle.request.retryAt, null);
      assert.equal(
        (await authorize(
          selfServiceUser.id,
          createdBody.workspace.projectSlug,
          "translations.edit",
        )).status,
        403,
      );
      assert.equal(
        (await authorize(
          selfServiceUser.id,
          createdBody.workspace.projectSlug,
          "exports.run",
        )).status,
        200,
      );
      const lifecyclePackageDownload = await fetch(
        `${baseUrl}/trial-package-download`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      assert.equal(lifecyclePackageDownload.status, 409);
      assert.equal(
        (await lifecyclePackageDownload.json()).code,
        "trial_package_data_lifecycle_restricted",
      );
      await pool.query(
        `update subscriptions subscription
         set state = 'canceled'
         from billing_accounts account
         where subscription.billing_account_id = account.id
           and account.organization_id = $1`,
        [createdBody.workspace.organizationId],
      );
      const lifecycleExportFeatureOverride = await scalar(
        `insert into organization_feature_flag_overrides(
           organization_id, feature_key, enabled, reason
         ) values($1, 'verified_exports', false, 'Lifecycle portability test')
         returning id`,
        [createdBody.workspace.organizationId],
      );
      const entitlementRequest = {
        auth: { user: { id: selfServiceUser.id, platformStaff: false } },
        authorizedProject: {
          id: createdBody.workspace.projectId,
          organizationId: createdBody.workspace.organizationId,
        },
      };
      const entitlementResponse = response();
      let entitlementAllowed = false;
      await requireProjectEntitlement("verified_exports")(
        entitlementRequest,
        entitlementResponse,
        (error) => {
          if (error) throw error;
          entitlementAllowed = true;
        },
      );
      assert.equal(entitlementAllowed, true);
      assert.equal(
        entitlementRequest.commercialAccess.reason,
        "data_lifecycle_export_window",
      );
      assert.equal(
        entitlementRequest.commercialAccess.featureSource,
        "data_lifecycle_portability_override",
      );
      await pool.query(
        `update organization_feature_flag_overrides
         set superseded_at = now() where id = $1`,
        [lifecycleExportFeatureOverride],
      );

      const canceledProject = await fetch(
        `${accessUrl}/organizations/${createdBody.workspace.organizationId}`
          + `/data-lifecycle/${projectLifecycle.request.id}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "Keep the project" }),
        },
      );
      assert.equal(canceledProject.status, 200);
      assert.equal((await canceledProject.json()).request.state, "canceled");
      assert.equal(
        (await authorize(
          selfServiceUser.id,
          createdBody.workspace.projectSlug,
          "translations.edit",
        )).status,
        200,
      );

      const rescheduledProject = await fetch(
        `${accessUrl}/organizations/${createdBody.workspace.organizationId}/data-lifecycle`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            targetType: "project",
            projectId: createdBody.workspace.projectId,
            reason: "Integration-test completed project deletion",
            confirmation: createdBody.workspace.projectName,
          }),
        },
      );
      assert.equal(rescheduledProject.status, 201);
      const rescheduledProjectLifecycle = await rescheduledProject.json();
      await pool.query(
        `update data_lifecycle_requests
         set export_available_until = now() - interval '1 minute',
             purge_after = now() - interval '1 minute'
         where id = $1`,
        [rescheduledProjectLifecycle.request.id],
      );
      const projectPurge = await processDueDataLifecycleRequests({ limit: 5 });
      assert.equal(projectPurge.claimed, 1);
      assert.equal(projectPurge.outcomes[0].status, "purged");
      assert.equal(
        await scalar(
          "select count(*)::int from organization_onboarding where organization_id = $1",
          [createdBody.workspace.organizationId],
        ),
        1,
      );
      const postPurgePackageDownload = await fetch(
        `${baseUrl}/trial-package-download`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      assert.equal(postPurgePackageDownload.status, 409);
      assert.equal(
        (await postPurgePackageDownload.json()).code,
        "trial_package_data_lifecycle_restricted",
      );

      const scheduledOrganization = await fetch(
        `${accessUrl}/organizations/${createdBody.workspace.organizationId}/data-lifecycle`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            targetType: "organization",
            reason: "Integration-test account termination",
            confirmation: createdBody.workspace.organizationName,
          }),
        },
      );
      assert.equal(scheduledOrganization.status, 201);
      const organizationLifecycle = await scheduledOrganization.json();
      assert.equal(organizationLifecycle.request.targetType, "organization");
      await withPlatformPaymentsApi(
        { user: { id: directUser, platformStaff: true }, platformAdmin: true },
        async (platformUrl) => {
          const held = await fetch(
            `${platformUrl}/data-lifecycle/${organizationLifecycle.request.id}/hold`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ reason: "Integration legal hold" }),
            },
          );
          assert.equal(held.status, 200);
          assert.ok((await held.json()).request.legalHoldAt);
        },
      );
      const heldCancellation = await fetch(
        `${accessUrl}/organizations/${createdBody.workspace.organizationId}`
          + `/data-lifecycle/${organizationLifecycle.request.id}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "Attempt to override legal hold" }),
        },
      );
      assert.equal(heldCancellation.status, 409);
      assert.equal((await heldCancellation.json()).code, "legal_hold_active");
      await pool.query(
        `update data_lifecycle_requests
         set export_available_until = now() - interval '1 minute',
             purge_after = now() - interval '1 minute', retry_at = now()
         where id = $1`,
        [organizationLifecycle.request.id],
      );

      assert.equal((await processDueDataLifecycleRequests({ limit: 5 })).claimed, 0);
      await withPlatformPaymentsApi(
        { user: { id: directUser, platformStaff: true }, platformAdmin: true },
        async (platformUrl) => {
          const released = await fetch(
            `${platformUrl}/data-lifecycle/${organizationLifecycle.request.id}/release-hold`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ reason: "Integration hold released" }),
            },
          );
          assert.equal(released.status, 200);
          assert.equal((await released.json()).request.legalHoldAt, null);
        },
      );

      await pool.query(
        `update subscriptions subscription
         set state = 'active', provider = 'stripe',
             provider_subscription_id = 'sub_lifecycle_reactivated'
         from billing_accounts account
         where subscription.billing_account_id = account.id
           and account.organization_id = $1`,
        [createdBody.workspace.organizationId],
      );
      await pool.query(
        `update data_lifecycle_requests set attempt_count = 23 where id = $1`,
        [organizationLifecycle.request.id],
      );
      const reactivatedFailure = await processDueDataLifecycleRequests({ limit: 5 });
      assert.equal(reactivatedFailure.claimed, 1);
      assert.equal(reactivatedFailure.outcomes[0].status, "failed");
      const circuitBroken = await pool.query(
        `select state, attempt_count as "attemptCount", retry_at as "retryAt", last_error as "lastError"
         from data_lifecycle_requests where id = $1`,
        [organizationLifecycle.request.id],
      ).then((result) => result.rows[0]);
      assert.equal(circuitBroken.state, "failed");
      assert.equal(circuitBroken.attemptCount, 24);
      assert.equal(circuitBroken.retryAt, null);
      assert.match(circuitBroken.lastError, /Cancel the provider subscription/);
      assert.equal((await processDueDataLifecycleRequests({ limit: 5 })).claimed, 0);
      assert.equal(
        await scalar("select status from organizations where id = $1", [
          createdBody.workspace.organizationId,
        ]),
        "active",
      );
      await pool.query(
        `update subscriptions subscription
         set state = 'canceled'
         from billing_accounts account
         where subscription.billing_account_id = account.id
           and account.organization_id = $1`,
        [createdBody.workspace.organizationId],
      );
      await withPlatformPaymentsApi(
        { user: { id: directUser, platformStaff: true }, platformAdmin: true },
        async (platformUrl) => {
          const retried = await fetch(
            `${platformUrl}/data-lifecycle/${organizationLifecycle.request.id}/retry`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ reason: "Subscription is canceled again" }),
            },
          );
          assert.equal(retried.status, 200);
          assert.ok((await retried.json()).request.retryAt);
        },
      );

      const processed = await processDueDataLifecycleRequests({ limit: 5 });
      assert.equal(processed.claimed, 1);
      assert.equal(
        processed.outcomes[0].status,
        "purged",
        JSON.stringify(processed.outcomes[0]),
      );
      assert.equal(
        await scalar(
          "select state from data_lifecycle_requests where id = $1",
          [organizationLifecycle.request.id],
        ),
        "purged",
      );
      assert.equal(
        await scalar("select status from organizations where id = $1", [
          createdBody.workspace.organizationId,
        ]),
        "closed",
      );
      assert.equal(
        await scalar("select count(*)::int from translations where source_string_id = $1", [
          source.id,
        ]),
        0,
      );
      assert.equal(
        await scalar("select source_text from source_strings where id = $1", [source.id]),
        "[customer content purged]",
      );
      assert.equal(
        await scalar("select status from service_accounts where id = $1", [
          createdBody.workspace.serviceAccountId,
        ]),
        "revoked",
      );
      const lifecycleRevoke = await pool.query(
        `select id, metadata
         from npm_provisioning_outbox
         where seat_assignment_id = $1 and operation = 'revoke'`,
        [lifecycleNpmSeat.id],
      ).then((result) => result.rows[0]);
      assert.equal(lifecycleRevoke.metadata.dataLifecyclePurge, true);
      assert.equal(
        await scalar(
          `select metadata->>'customerProfilePurged'
           from npm_provisioning_outbox
           where seat_assignment_id = $1 and operation = 'invite'`,
          [lifecycleNpmSeat.id],
        ),
        "true",
      );
      const npmWorkerId = "00000000-0000-4000-8000-000000000099";
      await pool.query(
        `update npm_provisioning_outbox
         set status = 'processing', lease_id = $2,
             lease_expires_at = now() + interval '5 minutes'
         where id = $1`,
        [lifecycleRevoke.id, npmWorkerId],
      );
      await completeNpmProvisioningWork(
        lifecycleRevoke.id,
        npmWorkerId,
        { providerMember: false },
      );
      const scrubbedSeat = await pool.query(
        `select status, npm_username as "npmUsername", provider_state as "providerState"
         from npm_seat_assignments where id = $1`,
        [lifecycleNpmSeat.id],
      ).then((result) => result.rows[0]);
      assert.equal(scrubbedSeat.status, "revoked");
      assert.match(scrubbedSeat.npmUsername, /^deleted-/);
      assert.deepEqual(scrubbedSeat.providerState, {});

      const receipt = await fetch(
        `${accessUrl}/organizations/${createdBody.workspace.organizationId}/data-lifecycle`,
      );
      assert.equal(receipt.status, 200);
      const receiptBody = await receipt.json();
      assert.equal(receiptBody.receiptOnly, true);
      assert.ok(
        receiptBody.requests.some((request) => (
          request.id === organizationLifecycle.request.id
          && request.state === "purged"
          && request.purgeSummary.policyVersion === "customer-content-v1"
        )),
      );
    });
  });
  setTrialPackageDownloadTestHooks({});
  delete process.env.HEDGELING_SELF_SERVICE_SIGNUP_ENABLED;
  delete process.env.HEDGELING_SELF_SERVICE_TRIAL_DAYS;
  delete process.env.HEDGELING_TERMS_VERSION;
  delete process.env.HEDGELING_PRIVACY_VERSION;
  delete process.env.HEDGELING_TRIAL_PACKAGE_DOWNLOAD_ENABLED;
  delete process.env.HEDGELING_TRIAL_PACKAGE_BUCKET;
  delete process.env.HEDGELING_TRIAL_PACKAGE_KEY;
  delete process.env.HEDGELING_TRIAL_PACKAGE_VERSION;
  delete process.env.HEDGELING_TRIAL_PACKAGE_FILENAME;
  delete process.env.HEDGELING_TRIAL_PACKAGE_SHA256;

  console.log("Authorization integration tests passed.");
} finally {
  setTrialPackageDownloadTestHooks({});
  setFacilitatedPaymentsTestClient(null);
  await pool.end().catch(() => {});
  await adminPool.query(`drop schema if exists ${schemaName} cascade`);
  await adminPool.end();
}
