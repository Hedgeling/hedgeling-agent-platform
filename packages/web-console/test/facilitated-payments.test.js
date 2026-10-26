import assert from "node:assert/strict";
import test from "node:test";
import {
  connectedAccountProjection,
  facilitatedPaymentsConfiguration,
  facilitatedPaymentsWebhook,
  setFacilitatedPaymentsTestClient,
  validateFacilitatedPaymentsConfiguration,
} from "../src/facilitated-payments.js";

function withEnv(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("facilitated payments are independently disabled and expose no movement capability", () => {
  withEnv({
    HEDGELING_FACILITATED_PAYMENTS_ENABLED: null,
    HEDGELING_FACILITATED_PAYMENTS_MODE: null,
  }, () => {
    assert.equal(validateFacilitatedPaymentsConfiguration(), true);
    assert.deepEqual(facilitatedPaymentsConfiguration(), {
      enabled: false,
      provider: "stripe",
      providerMode: "test",
      programVersion: "us-usd-v1",
      providerEventReplayLeaseMinutes: 15,
      collectionEnabled: false,
      transfersEnabled: false,
      refundsEnabled: false,
      liveApproved: false,
      achTransferHoldDays: 7,
      payoutReconciliationReturnRiskDays: 14,
      payoutReconciliationMaxPages: 5,
      payoutReconciliationPageSize: 100,
      payoutReconciliationMaxLagMinutes: 60,
      payoutReconciliationLeaseMinutes: 15,
      stripeApiVersion: "2026-06-24.dahlia",
      stripeNodeSdkVersion: "22.3.2",
    });
  });
});

test("facilitated payment configuration rejects secret-mode and callback mismatches", () => {
  const configured = {
    HEDGELING_FACILITATED_PAYMENTS_ENABLED: "true",
    STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect",
    STRIPE_CONNECT_ONBOARDING_RETURN_URL: "https://console.example/connect-return",
    STRIPE_CONNECT_ONBOARDING_REFRESH_URL: "https://console.example/connect-refresh",
  };
  withEnv({
    ...configured,
    HEDGELING_FACILITATED_PAYMENTS_MODE: "live",
    STRIPE_CONNECT_SECRET_KEY: "sk_test_wrong_mode",
  }, () => assert.throws(
    validateFacilitatedPaymentsConfiguration,
    /live Stripe Connect secret key/,
  ));
  withEnv({
    ...configured,
    NODE_ENV: "production",
    HEDGELING_FACILITATED_PAYMENTS_MODE: "test",
    STRIPE_CONNECT_SECRET_KEY: "sk_test_example",
    STRIPE_CONNECT_ONBOARDING_RETURN_URL: "http://console.example/connect-return",
  }, () => assert.throws(
    validateFacilitatedPaymentsConfiguration,
    /must use HTTPS/,
  ));
});

test("provider-event replay lease is bounded and explicit", () => {
  withEnv({
    HEDGELING_PROVIDER_EVENT_REPLAY_LEASE_MINUTES: "0",
  }, () => assert.throws(
    validateFacilitatedPaymentsConfiguration,
    /integer from 1 to 1440/,
  ));
  withEnv({
    HEDGELING_PROVIDER_EVENT_REPLAY_LEASE_MINUTES: "45",
  }, () => assert.equal(
    facilitatedPaymentsConfiguration().providerEventReplayLeaseMinutes,
    45,
  ));
});

test("connected account readiness is derived from transfer, payout, and requirement state", () => {
  const pending = connectedAccountProjection({
    capabilities: { transfers: "pending" },
    requirements: {
      currently_due: ["business_profile.url"],
      pending_verification: [],
      past_due: [],
    },
    future_requirements: { eventually_due: ["company.tax_id"] },
    payouts_enabled: false,
    details_submitted: false,
  });
  assert.equal(pending.onboardingState, "pending");
  assert.deepEqual(pending.requirementsDue, ["business_profile.url"]);

  const ready = connectedAccountProjection({
    capabilities: { transfers: "active" },
    requirements: {
      currently_due: [],
      pending_verification: [],
      past_due: [],
      disabled_reason: null,
    },
    future_requirements: { eventually_due: [] },
    payouts_enabled: true,
    details_submitted: true,
  }, "pending");
  assert.equal(ready.onboardingState, "ready");
  assert.equal(ready.disabledReason, null);

  const regressed = connectedAccountProjection({
    capabilities: { transfers: "inactive" },
    requirements: {
      currently_due: ["company.tax_id"],
      pending_verification: [],
      past_due: [],
      disabled_reason: null,
    },
    future_requirements: { eventually_due: [] },
    payouts_enabled: false,
    details_submitted: true,
  }, "ready");
  assert.equal(regressed.onboardingState, "restricted");
  assert.equal(regressed.disabledReason, "requirements_due");

  const stillRestricted = connectedAccountProjection({
    capabilities: { transfers: "pending" },
    requirements: {
      currently_due: [],
      pending_verification: ["individual.verification.document"],
      past_due: [],
      disabled_reason: null,
    },
    future_requirements: { eventually_due: [] },
    payouts_enabled: false,
    details_submitted: true,
  }, "restricted");
  assert.equal(stillRestricted.onboardingState, "restricted");

  const stillDisabled = connectedAccountProjection({
    capabilities: { transfers: "active" },
    requirements: {
      currently_due: [],
      pending_verification: [],
      past_due: [],
      disabled_reason: null,
    },
    future_requirements: { eventually_due: [] },
    payouts_enabled: true,
    details_submitted: true,
  }, "disabled", "provider_application_deauthorized");
  assert.equal(stillDisabled.onboardingState, "disabled");
  assert.equal(stillDisabled.disabledReason, "provider_application_deauthorized");

  assert.equal(connectedAccountProjection({ deleted: true }, "ready").onboardingState, "disabled");
});

test("Connect webhook rejects a parsed body before provider verification", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  setFacilitatedPaymentsTestClient({
    webhooks: {
      constructEvent() {
        assert.fail("provider verification must not receive a parsed webhook body");
      },
    },
  });
  try {
    const req = {
      body: {},
      get() {
        return "test-signature";
      },
    };
    const res = response();
    await facilitatedPaymentsWebhook(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /unmodified raw request body/);
  } finally {
    setFacilitatedPaymentsTestClient(null);
    if (previousNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("Connect webhook rejects invalid signatures before event processing", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  setFacilitatedPaymentsTestClient({
    webhooks: {
      constructEvent() {
        throw new Error("Invalid signature");
      },
    },
  });
  try {
    const req = {
      body: Buffer.from("{}"),
      get(name) {
        return name.toLowerCase() === "stripe-signature" ? "bad-signature" : "";
      },
    };
    const res = response();
    await facilitatedPaymentsWebhook(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /signature verification failed/);
  } finally {
    setFacilitatedPaymentsTestClient(null);
    if (previousNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("Connect configuration failures are not masked as signature failures", async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    enabled: process.env.HEDGELING_FACILITATED_PAYMENTS_ENABLED,
    secret: process.env.STRIPE_CONNECT_SECRET_KEY,
  };
  process.env.NODE_ENV = "test";
  process.env.HEDGELING_FACILITATED_PAYMENTS_ENABLED = "true";
  delete process.env.STRIPE_CONNECT_SECRET_KEY;
  setFacilitatedPaymentsTestClient(null);
  try {
    const req = {
      body: Buffer.from("{}"),
      get() {
        return "test-signature";
      },
    };
    await assert.rejects(
      facilitatedPaymentsWebhook(req, response()),
      (error) => error.status === 503 && error.code === "connect_not_configured",
    );
  } finally {
    setFacilitatedPaymentsTestClient(null);
    if (previous.NODE_ENV == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.NODE_ENV;
    if (previous.enabled == null) delete process.env.HEDGELING_FACILITATED_PAYMENTS_ENABLED;
    else process.env.HEDGELING_FACILITATED_PAYMENTS_ENABLED = previous.enabled;
    if (previous.secret == null) delete process.env.STRIPE_CONNECT_SECRET_KEY;
    else process.env.STRIPE_CONNECT_SECRET_KEY = previous.secret;
  }
});
