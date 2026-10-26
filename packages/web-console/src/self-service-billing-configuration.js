import { withTransaction } from "./db.js";
import { createPinnedStripeClient } from "./stripe-client.js";

export const SELF_SERVICE_STRIPE_COMPONENTS = Object.freeze([
  {
    key: "starter-base-monthly-v1",
    planKey: "starter-v1",
    component: "base",
    interval: "month",
    unitAmountMinor: 4900,
    priceEnvironment: "STRIPE_PRICE_STARTER_BASE_MONTHLY",
  },
  {
    key: "starter-npm-seat-monthly-v1",
    planKey: "starter-v1",
    component: "npm_seat",
    interval: "month",
    unitAmountMinor: 1500,
    includedQuantity: 1,
    billingBlockSize: 1,
    priceEnvironment: "STRIPE_PRICE_STARTER_NPM_SEAT_MONTHLY",
    meterEnvironment: "STRIPE_METER_NPM_SEAT_EVENT_NAME",
  },
  {
    key: "business-base-annual-v1",
    planKey: "business-v1",
    component: "base",
    interval: "year",
    unitAmountMinor: 358800,
    priceEnvironment: "STRIPE_PRICE_BUSINESS_BASE_ANNUAL",
  },
  {
    key: "business-ai-credit-monthly-v1",
    planKey: "business-v1",
    component: "ai_credit_overage",
    interval: "month",
    unitAmountMinor: 1000,
    includedQuantity: 100000,
    billingBlockSize: 10000,
    priceEnvironment: "STRIPE_PRICE_BUSINESS_AI_CREDIT_MONTHLY",
    meterEnvironment: "STRIPE_METER_AI_CREDIT_EVENT_NAME",
  },
  {
    key: "business-managed-string-monthly-v1",
    planKey: "business-v1",
    component: "managed_string_overage",
    interval: "month",
    unitAmountMinor: 1500,
    includedQuantity: 15000,
    billingBlockSize: 1000,
    priceEnvironment: "STRIPE_PRICE_BUSINESS_MANAGED_STRING_MONTHLY",
    meterEnvironment: "STRIPE_METER_MANAGED_STRING_EVENT_NAME",
  },
  {
    key: "business-npm-seat-monthly-v1",
    planKey: "business-v1",
    component: "npm_seat",
    interval: "month",
    unitAmountMinor: 1500,
    includedQuantity: 5,
    billingBlockSize: 1,
    priceEnvironment: "STRIPE_PRICE_BUSINESS_NPM_SEAT_MONTHLY",
    meterEnvironment: "STRIPE_METER_NPM_SEAT_EVENT_NAME",
  },
]);

function requiredEnvironment(environment, name) {
  const value = String(environment[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function configuredSelfServiceStripeComponents(environment = process.env) {
  return SELF_SERVICE_STRIPE_COMPONENTS.map((definition) => ({
    ...definition,
    providerPriceId: requiredEnvironment(
      environment,
      definition.priceEnvironment,
    ),
    meterEventName: definition.meterEnvironment
      ? requiredEnvironment(environment, definition.meterEnvironment)
      : null,
  }));
}

export function validateStripePrice(component, price) {
  if (!price?.id || price.active !== true) {
    throw new Error(`${component.providerPriceId} is not an active Stripe Price`);
  }
  if (String(price.currency || "").toUpperCase() !== "USD") {
    throw new Error(`${price.id} must use USD`);
  }
  if (Number(price.unit_amount) !== component.unitAmountMinor) {
    throw new Error(
      `${price.id} must charge ${component.unitAmountMinor} minor units`,
    );
  }
  if (price.recurring?.interval !== component.interval) {
    throw new Error(`${price.id} must recur every ${component.interval}`);
  }
  const usageType = price.recurring?.usage_type;
  if (component.component === "base" && usageType === "metered") {
    throw new Error(`${price.id} base pricing cannot be metered`);
  }
  if (component.component !== "base" && usageType !== "metered") {
    throw new Error(`${price.id} overage pricing must be metered`);
  }
  return true;
}

export async function configureSelfServiceStripeBilling({
  environment = process.env,
  provider,
} = {}) {
  const components = configuredSelfServiceStripeComponents(environment);
  const stripe = provider || createPinnedStripeClient(
    requiredEnvironment(environment, "STRIPE_SECRET_KEY"),
  );
  const verified = [];
  for (const component of components) {
    const price = await stripe.prices.retrieve(component.providerPriceId);
    validateStripePrice(component, price);
    verified.push({ component, price });
  }
  return withTransaction(async (client) => {
    const configured = [];
    for (const { component, price } of verified) {
      const plan = await client.query(
        `select id from product_plans
         where key = $1 and status = 'active' for share`,
        [component.planKey],
      ).then((result) => result.rows[0]);
      if (!plan) throw new Error(`Active plan ${component.planKey} is missing`);
      const existing = await client.query(
        `select
           plan_id, provider, provider_price_id, currency, billing_interval,
           unit_amount_minor, component, meter_event_name,
           included_quantity, billing_block_size
         from billing_prices where key = $1 for update`,
        [component.key],
      ).then((result) => result.rows[0]);
      if (existing) {
        const sameMapping = (
          existing.plan_id === plan.id
          && existing.provider === "stripe"
          && existing.provider_price_id === component.providerPriceId
          && existing.currency === "USD"
          && existing.billing_interval === component.interval
          && Number(existing.unit_amount_minor) === component.unitAmountMinor
          && existing.component === component.component
          && (existing.meter_event_name || null) === component.meterEventName
          && (
            existing.included_quantity == null
              ? component.includedQuantity == null
              : Number(existing.included_quantity) === component.includedQuantity
          )
          && (
            existing.billing_block_size == null
              ? component.billingBlockSize == null
              : Number(existing.billing_block_size) === component.billingBlockSize
          )
        );
        if (!sameMapping) {
          throw new Error(
            `Immutable billing key ${component.key} already has different economic fields; `
            + "create a new versioned key instead",
          );
        }
      }
      await client.query(
        `update billing_prices
         set active = false
         where plan_id = $1 and component = $2
           and currency = 'USD' and billing_interval = $3
           and key <> $4 and active = true`,
        [
          plan.id,
          component.component,
          component.interval,
          component.key,
        ],
      );
      await client.query(
        `insert into billing_prices(
           key, plan_id, provider, provider_price_id, currency,
           billing_interval, unit_amount_minor, active, metadata, component,
           meter_event_name, included_quantity, billing_block_size
         ) values(
           $1, $2, 'stripe', $3, 'USD', $4, $5, true, $6,
           $7, $8, $9, $10
         )
         on conflict(key) do update
         set active = true,
             metadata = billing_prices.metadata || excluded.metadata
         returning key`,
        [
          component.key,
          plan.id,
          component.providerPriceId,
          component.interval,
          component.unitAmountMinor,
          JSON.stringify({
            configuredBy: "configure-self-service-billing",
            stripeProductId:
              typeof price.product === "string" ? price.product : price.product?.id,
          }),
          component.component,
          component.meterEventName,
          component.includedQuantity ?? null,
          component.billingBlockSize ?? null,
        ],
      );
      configured.push(component.key);
    }
    return configured;
  });
}
