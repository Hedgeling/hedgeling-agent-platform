import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import {
  setStripeTestClient,
  stripeBillingConfiguration,
  stripeWebhook,
  validateStripeConfiguration,
} from "../src/stripe-billing.js";
import {
  createPinnedStripeClient,
  stripeApiVersion,
  stripeNodeSdkVersion,
} from "../src/stripe-client.js";

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

test("Stripe SDK and API versions are explicit certification inputs", () => {
  assert.equal(stripeNodeSdkVersion, "22.3.2");
  assert.equal(stripeNodeSdkVersion, Stripe.PACKAGE_VERSION);
  assert.equal(stripeApiVersion, "2026-06-24.dahlia");
  assert.equal(
    createPinnedStripeClient("sk_test_version_check").getApiField("version"),
    stripeApiVersion,
  );
});

test("Stripe configuration is explicit and validates production callback URLs", () => {
  withEnv({
    HEDGELING_STRIPE_ENABLED: null,
    HEDGELING_STRIPE_PAST_DUE_GRACE_DAYS: "5",
  }, () => {
    assert.equal(validateStripeConfiguration(), true);
    assert.deepEqual(stripeBillingConfiguration(), {
      enabled: false,
      automaticTax: false,
      pastDueGraceDays: 5,
    });
  });

  withEnv({
    NODE_ENV: "production",
    HEDGELING_STRIPE_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_example",
    STRIPE_WEBHOOK_SECRET: "whsec_example",
    STRIPE_CHECKOUT_SUCCESS_URL: "http://example.com/billing/success",
    STRIPE_CHECKOUT_CANCEL_URL: "https://example.com/billing",
    STRIPE_PORTAL_RETURN_URL: "https://example.com/billing",
  }, () => assert.throws(validateStripeConfiguration, /must use HTTPS/));
});

test("Stripe configuration rejects missing secrets and invalid grace periods", () => {
  withEnv({
    HEDGELING_STRIPE_ENABLED: "true",
    STRIPE_SECRET_KEY: null,
    STRIPE_WEBHOOK_SECRET: null,
    HEDGELING_STRIPE_PAST_DUE_GRACE_DAYS: "7",
  }, () => assert.throws(validateStripeConfiguration, /STRIPE_SECRET_KEY/));

  withEnv({
    HEDGELING_STRIPE_ENABLED: null,
    HEDGELING_STRIPE_PAST_DUE_GRACE_DAYS: "91",
  }, () => assert.throws(validateStripeConfiguration, /integer from 0 to 90/));
});

test("Stripe webhook rejects an invalid signature before processing", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  setStripeTestClient({
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
    await stripeWebhook(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /signature verification failed/);
  } finally {
    setStripeTestClient(null);
    if (previousNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
