import test from "node:test";
import assert from "node:assert/strict";
import {
  billingMeterQuantity,
  billingMeterRestagingDecision,
} from "../src/billing-meters.js";

test("billing meters charge only usage above the included allowance", () => {
  assert.deepEqual(
    billingMeterQuantity({
      observedQuantity: 120_001,
      includedQuantity: 100_000,
      billingBlockSize: 10_000,
    }),
    {
      billableQuantity: 20_001n,
      providerEventQuantity: 3n,
    },
  );
  assert.deepEqual(
    billingMeterQuantity({
      observedQuantity: 100_000,
      includedQuantity: 100_000,
      billingBlockSize: 10_000,
    }),
    {
      billableQuantity: 0n,
      providerEventQuantity: 0n,
    },
  );
});

test("billing meters reject invalid quantities and block sizes", () => {
  assert.throws(
    () => billingMeterQuantity({
      observedQuantity: -1,
      includedQuantity: 0,
      billingBlockSize: 1,
    }),
    /cannot be negative/,
  );
  assert.throws(
    () => billingMeterQuantity({
      observedQuantity: 1,
      includedQuantity: 0,
      billingBlockSize: 0,
    }),
    /must be positive/,
  );
});

test("closed-period restaging emits only the positive late-usage delta", () => {
  assert.deepEqual(
    billingMeterRestagingDecision({
      previousProviderEventQuantity: 3,
      targetProviderEventQuantity: 5,
    }),
    {
      previousProviderEventQuantity: 3n,
      targetProviderEventQuantity: 5n,
      adjustmentProviderEventQuantity: 2n,
    },
  );
  assert.equal(
    billingMeterRestagingDecision({
      previousProviderEventQuantity: 5,
      targetProviderEventQuantity: 5,
    }).adjustmentProviderEventQuantity,
    0n,
  );
});

test("closed-period downward corrections require manual reconciliation", () => {
  assert.throws(
    () => billingMeterRestagingDecision({
      previousProviderEventQuantity: 5,
      targetProviderEventQuantity: 4,
    }),
    (error) => (
      error.code === "billing_meter_downward_correction_required"
      && /manual reconciliation/.test(error.message)
    ),
  );
});
