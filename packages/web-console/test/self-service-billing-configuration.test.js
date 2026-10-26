import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredSelfServiceStripeComponents,
  validateStripePrice,
} from "../src/self-service-billing-configuration.js";

const environment = {
  STRIPE_PRICE_STARTER_BASE_MONTHLY: "price_starter_base",
  STRIPE_PRICE_STARTER_NPM_SEAT_MONTHLY: "price_starter_npm",
  STRIPE_PRICE_BUSINESS_BASE_ANNUAL: "price_business_base",
  STRIPE_PRICE_BUSINESS_AI_CREDIT_MONTHLY: "price_business_ai",
  STRIPE_PRICE_BUSINESS_MANAGED_STRING_MONTHLY: "price_business_strings",
  STRIPE_PRICE_BUSINESS_NPM_SEAT_MONTHLY: "price_business_npm",
  STRIPE_METER_NPM_SEAT_EVENT_NAME: "hedgeling_npm_seats",
  STRIPE_METER_AI_CREDIT_EVENT_NAME: "hedgeling_ai_credits",
  STRIPE_METER_MANAGED_STRING_EVENT_NAME: "hedgeling_managed_strings",
};

test("self-service Stripe configuration pins every commercial component", () => {
  const components = configuredSelfServiceStripeComponents(environment);
  assert.equal(components.length, 6);
  assert.deepEqual(
    components.map((component) => component.key),
    [
      "starter-base-monthly-v1",
      "starter-npm-seat-monthly-v1",
      "business-base-annual-v1",
      "business-ai-credit-monthly-v1",
      "business-managed-string-monthly-v1",
      "business-npm-seat-monthly-v1",
    ],
  );
});

test("Stripe price verification separates fixed bases from monthly meters", () => {
  assert.equal(validateStripePrice(
    {
      providerPriceId: "price_base",
      component: "base",
      interval: "year",
      unitAmountMinor: 358800,
    },
    {
      id: "price_base",
      active: true,
      currency: "usd",
      unit_amount: 358800,
      recurring: { interval: "year", usage_type: "licensed" },
    },
  ), true);
  assert.throws(
    () => validateStripePrice(
      {
        providerPriceId: "price_meter",
        component: "ai_credit_overage",
        interval: "month",
        unitAmountMinor: 1000,
      },
      {
        id: "price_meter",
        active: true,
        currency: "usd",
        unit_amount: 1000,
        recurring: { interval: "month", usage_type: "licensed" },
      },
    ),
    /must be metered/,
  );
});
