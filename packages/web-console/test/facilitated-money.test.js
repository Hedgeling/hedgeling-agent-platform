import assert from "node:assert/strict";
import test from "node:test";
import {
  facilitatedMoneyConfiguration,
  fundingProjection,
  providerDisputeClassification,
  providerDisputeStatus,
  requiredCertificationChecks,
  stripeIdempotencyRequestInFlight,
  transferClaimPastIdempotencyWindow,
  validateFacilitatedMoneyConfiguration,
} from "../src/facilitated-money.js";

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

test("money movement switches are independent and ACH holds are bounded", () => {
  withEnv({
    HEDGELING_FACILITATED_COLLECTION_ENABLED: "true",
    HEDGELING_FACILITATED_TRANSFERS_ENABLED: null,
    HEDGELING_FACILITATED_REFUNDS_ENABLED: "true",
    HEDGELING_FACILITATED_LIVE_APPROVED: null,
    HEDGELING_ACH_TRANSFER_HOLD_DAYS: "9",
  }, () => assert.deepEqual(facilitatedMoneyConfiguration(), {
    collectionEnabled: true,
    transfersEnabled: false,
    refundsEnabled: true,
    liveApproved: false,
    achTransferHoldDays: 9,
    payoutReconciliationReturnRiskDays: 14,
    payoutReconciliationMaxPages: 5,
    payoutReconciliationPageSize: 100,
    payoutReconciliationMaxLagMinutes: 60,
    payoutReconciliationLeaseMinutes: 15,
    stripeApiVersion: "2026-06-24.dahlia",
    stripeNodeSdkVersion: "22.3.2",
  }));
  withEnv({
    HEDGELING_ACH_TRANSFER_HOLD_DAYS: "91",
  }, () => assert.throws(facilitatedMoneyConfiguration, /integer from 0 to 90/));
});

test("live money movement requires explicit approval", () => {
  withEnv({
    HEDGELING_FACILITATED_PAYMENTS_ENABLED: "true",
    HEDGELING_FACILITATED_PAYMENTS_MODE: "live",
    HEDGELING_FACILITATED_COLLECTION_ENABLED: "true",
    HEDGELING_FACILITATED_LIVE_APPROVED: null,
    STRIPE_VENDOR_PAYMENT_SUCCESS_URL: "https://console.example/success",
    STRIPE_VENDOR_PAYMENT_CANCEL_URL: "https://console.example/cancel",
  }, () => assert.throws(
    validateFacilitatedMoneyConfiguration,
    /explicit live approval/,
  ));
});

test("money operations cannot be enabled while the Connect foundation is off", () => {
  withEnv({
    HEDGELING_FACILITATED_PAYMENTS_ENABLED: null,
    HEDGELING_FACILITATED_COLLECTION_ENABLED: "true",
    HEDGELING_FACILITATED_TRANSFERS_ENABLED: null,
    HEDGELING_FACILITATED_REFUNDS_ENABLED: null,
  }, () => assert.throws(
    validateFacilitatedMoneyConfiguration,
    /require HEDGELING_FACILITATED_PAYMENTS_ENABLED/,
  ));
});

test("funding projection distinguishes returns, disputes, and refunds", () => {
  assert.equal(fundingProjection({ amountMinor: "10000" }), "funded");
  assert.equal(fundingProjection({
    amountMinor: "10000",
    refundedMinor: "2500",
  }), "partially_refunded");
  assert.equal(fundingProjection({
    amountMinor: "10000",
    refundedMinor: "10000",
  }), "funding_reversed");
  assert.equal(fundingProjection({
    amountMinor: "10000",
    activeReturnMinor: "10000",
  }), "returned");
  assert.equal(fundingProjection({
    amountMinor: "10000",
    activeDisputeMinor: "10000",
  }), "disputed");
});

test("ACH dispute-shaped events are classified as returns", () => {
  assert.equal(providerDisputeClassification("us_bank_account"), "return");
  assert.equal(providerDisputeClassification("card"), "dispute");
  assert.equal(providerDisputeClassification(null), null);
});

test("Stripe warning and card-dispute statuses remain losslessly normalized", () => {
  for (const status of [
    "warning_needs_response",
    "warning_under_review",
    "warning_closed",
    "needs_response",
    "under_review",
    "won",
    "lost",
  ]) {
    assert.equal(providerDisputeStatus(status), status);
  }
  assert.equal(providerDisputeStatus("unknown"), null);
});

test("only Stripe idempotency requests still in flight remain resumable", () => {
  const inFlight = Object.assign(
    new Error("There is currently another in-progress request using this Idempotency Key"),
    {
      type: "StripeIdempotencyError",
      code: "idempotency_key_in_use",
    },
  );
  const wrapped = Object.assign(new Error("Stripe request failed"), { cause: inFlight });
  assert.equal(stripeIdempotencyRequestInFlight(wrapped), true);
  assert.equal(stripeIdempotencyRequestInFlight({
    type: "idempotency_error",
    message: "The idempotency key is currently in use by another request",
  }), true);
  assert.equal(stripeIdempotencyRequestInFlight({
    type: "StripeIdempotencyError",
    message: "Keys can only be reused with the same parameters",
  }), false);
  assert.equal(stripeIdempotencyRequestInFlight(new Error("Connection reset")), false);
});

test("transfer retries fail closed once Stripe can prune the idempotency key", () => {
  const now = Date.parse("2026-07-25T12:00:00.000Z");
  assert.equal(
    transferClaimPastIdempotencyWindow("2026-07-24T12:00:00.001Z", now),
    false,
  );
  assert.equal(
    transferClaimPastIdempotencyWindow("2026-07-24T12:00:00.000Z", now),
    true,
  );
  assert.equal(transferClaimPastIdempotencyWindow(null, now), false);
  assert.equal(transferClaimPastIdempotencyWindow("not-a-date", now), false);
});

test("certification contract covers delayed payment and late payout failures", () => {
  assert.equal(new Set(requiredCertificationChecks).size, requiredCertificationChecks.length);
  for (const key of [
    "ach_return",
    "late_success_quarantine",
    "rolling_cap_contention",
    "idempotency_retention",
    "payout_late_failure",
    "event_replay",
    "reconciliation",
    "legal_finance_risk_approval",
  ]) {
    assert.ok(requiredCertificationChecks.includes(key));
  }
});
