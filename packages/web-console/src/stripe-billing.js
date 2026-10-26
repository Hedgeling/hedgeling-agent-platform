import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import { auditRequest } from "./audit.js";
import { createPinnedStripeClient } from "./stripe-client.js";
import { isUuid } from "./validation.js";
import { stageClosedBillingPeriod } from "./billing-meters.js";
import { queueOrganizationNpmSeatRevocations } from "./npm-seats.js";
import { seedOrganizationResourceHighWaterPeriod } from "./commercial-resources.js";

let stripeClientOverride = null;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function requiredUrl(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required when Stripe billing is enabled`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  return url.toString();
}

function stripeEnabled() {
  return process.env.HEDGELING_STRIPE_ENABLED === "true";
}

function stripeClient() {
  if (stripeClientOverride) return stripeClientOverride;
  if (!stripeEnabled()) throw httpError(503, "Stripe billing is not enabled");
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw httpError(503, "Stripe billing is not configured");
  return createPinnedStripeClient(secretKey);
}

async function callStripe(operation, publicMessage) {
  try {
    return await operation();
  } catch (cause) {
    throw Object.assign(new Error(publicMessage), { status: 502, cause });
  }
}

function objectId(value) {
  return typeof value === "string" ? value : value?.id || "";
}

function stripeTimestamp(value) {
  return Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

function addDays(timestamp, days) {
  return new Date(new Date(timestamp).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function subscriptionPeriod(subscription) {
  const items = subscription.items?.data || [];
  const starts = items.map((item) => item.current_period_start).filter(Number.isFinite);
  const ends = items.map((item) => item.current_period_end).filter(Number.isFinite);
  return {
    start: stripeTimestamp(starts.length ? Math.min(...starts) : subscription.current_period_start),
    end: stripeTimestamp(ends.length ? Math.max(...ends) : subscription.current_period_end),
  };
}

function itemPeriod(item) {
  return {
    start: stripeTimestamp(item?.current_period_start),
    end: stripeTimestamp(item?.current_period_end),
  };
}

function localSubscriptionState(stripeStatus) {
  if (["trialing", "active", "past_due", "paused", "unpaid", "canceled"].includes(stripeStatus)) {
    return stripeStatus;
  }
  if (stripeStatus === "incomplete_expired") return "canceled";
  if (stripeStatus === "incomplete") return "unpaid";
  throw new Error(`Unsupported Stripe subscription status: ${stripeStatus}`);
}

function pastDueGraceDays() {
  const value = Number(process.env.HEDGELING_STRIPE_PAST_DUE_GRACE_DAYS || 7);
  if (!Number.isInteger(value) || value < 0 || value > 90) {
    throw new Error("HEDGELING_STRIPE_PAST_DUE_GRACE_DAYS must be an integer from 0 to 90");
  }
  return value;
}

async function recordBillingAudit(req, action, resourceType, resourceId, metadata) {
  await auditRequest({ query }, req, {
    action,
    resourceType,
    resourceId,
    metadata,
  });
}

async function ensureStripeCustomer(organizationId) {
  const accountResult = await query(
    `insert into billing_accounts(organization_id, status, currency)
     select id, 'active', default_currency from organizations where id = $1
     on conflict(organization_id) do update set updated_at = billing_accounts.updated_at
     returning id, organization_id as "organizationId", provider,
               provider_customer_id as "providerCustomerId", billing_email as "billingEmail"`,
    [organizationId],
  );
  const account = accountResult.rows[0];
  if (!account) throw httpError(404, "Organization not found");
  if (account.provider && account.provider !== "stripe") {
    throw httpError(409, "The billing account is linked to another payment provider");
  }
  if (account.providerCustomerId) return account;

  const organizationResult = await query(
    "select name from organizations where id = $1",
    [organizationId],
  );
  const customer = await callStripe(
    () => stripeClient().customers.create(
      {
        name: organizationResult.rows[0]?.name,
        email: account.billingEmail || undefined,
        metadata: { hedgeling_organization_id: organizationId },
      },
      { idempotencyKey: `hedgeling-customer-${account.id}` },
    ),
    "Stripe could not create the billing customer",
  );
  const linked = await query(
    `update billing_accounts
     set provider = 'stripe', provider_customer_id = $2, updated_at = now()
     where id = $1
       and (provider is null or provider = 'stripe')
       and (provider_customer_id is null or provider_customer_id = $2)
     returning id, organization_id as "organizationId", provider,
               provider_customer_id as "providerCustomerId"`,
    [account.id, customer.id],
  );
  if (!linked.rows[0]) {
    throw httpError(409, "The billing account was linked concurrently; retry the operation");
  }
  return linked.rows[0];
}

export function stripeBillingConfiguration() {
  return {
    enabled: stripeEnabled(),
    automaticTax: process.env.HEDGELING_STRIPE_AUTOMATIC_TAX === "true",
    pastDueGraceDays: pastDueGraceDays(),
  };
}

export function validateStripeConfiguration() {
  pastDueGraceDays();
  if (!stripeEnabled()) return true;
  if (process.env.HEDGELING_AUTH_MODE === "local" && !/^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY || "")) {
    throw new Error("Local troubleshooting accepts only Stripe test keys");
  }
  for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) {
    if (!String(process.env[name] || "").trim()) {
      throw new Error(`${name} is required when Stripe billing is enabled`);
    }
  }
  requiredUrl("STRIPE_CHECKOUT_SUCCESS_URL");
  requiredUrl("STRIPE_CHECKOUT_CANCEL_URL");
  requiredUrl("STRIPE_PORTAL_RETURN_URL");
  return true;
}

export function setStripeTestClient(client) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Stripe test client is only available in NODE_ENV=test");
  }
  stripeClientOverride = client;
}

export async function createStripeCheckoutSession(req, res) {
  const priceKey = String(req.body?.priceKey || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,99}$/.test(priceKey)) {
    return res.status(400).json({ error: "A valid billing price key is required" });
  }
  const priceResult = await query(
    `select price.key, price.provider_price_id as "providerPriceId",
            price.component, price.currency,
            price.billing_interval as "billingInterval",
            plan.id as "planId", plan.key as "planKey"
     from billing_prices price
     join product_plans plan on plan.id = price.plan_id
     where price.key = $1 and price.provider = 'stripe' and price.active = true
       and plan.status = 'active'`,
    [priceKey],
  );
  const price = priceResult.rows[0];
  if (!price) return res.status(404).json({ error: "Billing price not found" });
  if (price.component !== "base") {
    return res.status(400).json({
      error: "Checkout must begin with a base plan price",
      code: "base_price_required",
    });
  }
  const planPrices = await query(
    `select key, provider_price_id as "providerPriceId", component,
            billing_interval as "billingInterval"
     from billing_prices
     where plan_id = $1 and provider = 'stripe' and active = true
       and provider_price_id is not null
       and currency = $3
       and (key = $2 or component <> 'base')
     order by (component = 'base') desc, component`,
    [price.planId, price.key, price.currency],
  ).then((result) => result.rows);
  if (!planPrices.length) {
    return res.status(503).json({ error: "The selected plan has no active Stripe prices" });
  }
  const checkoutMode = new Set(
    planPrices.map((item) => item.billingInterval),
  ).size > 1
    ? "setup"
    : "subscription";

  const existing = await query(
    `select subscription.id
     from subscriptions subscription
     join billing_accounts account on account.id = subscription.billing_account_id
     where account.organization_id = $1
       and subscription.provider = 'stripe'
       and subscription.state <> 'canceled'`,
    [req.authorizedOrganizationId],
  );
  if (existing.rows[0]) {
    return res.status(409).json({
      error: "An active Stripe subscription already exists; use the billing portal",
    });
  }
  const pendingProvisioning = await query(
    `select id, status
     from billing_subscription_provisioning
     where organization_id = $1
       and status in ('pending', 'processing', 'succeeded', 'requires_action')
     order by created_at desc limit 1`,
    [req.authorizedOrganizationId],
  );
  if (pendingProvisioning.rows[0]) {
    return res.status(409).json({
      error: "A subscription upgrade is already being provisioned",
      code: "subscription_provisioning_in_progress",
      provisioningStatus: pendingProvisioning.rows[0].status,
    });
  }

  const account = await ensureStripeCustomer(req.authorizedOrganizationId);
  const metadata = {
    hedgeling_organization_id: req.authorizedOrganizationId,
    hedgeling_plan_key: price.planKey,
    hedgeling_price_key: price.key,
    hedgeling_checkout_mode: checkoutMode,
  };
  let replacedSessionId = null;
  let checkout;
  try {
    // Stripe calls intentionally remain inside this transaction so the per-org
    // advisory lock serializes Checkout creation at the current scale. If
    // checkout volume grows, move provider calls outside the transaction and
    // use create-then-record reconciliation without holding a pool connection.
    checkout = await withTransaction(async (client) => {
      await client.query(
        "select pg_advisory_xact_lock(hashtext($1))",
        [`stripe-checkout:${req.authorizedOrganizationId}`],
      );
      await client.query(
        `update billing_checkout_sessions
         set status = 'expired'
         where billing_account_id = $1 and status = 'open' and expires_at <= now()`,
        [account.id],
      );
      const existingSession = await client.query(
        `select provider_session_id as id, price_key as "priceKey", url,
                checkout_mode as "checkoutMode"
         from billing_checkout_sessions
         where billing_account_id = $1 and status = 'open' and expires_at > now()
         limit 1`,
        [account.id],
      );
      if (existingSession.rows[0]?.priceKey === priceKey) {
        return {
          id: existingSession.rows[0].id,
          url: existingSession.rows[0].url,
          checkoutMode: existingSession.rows[0].checkoutMode,
          reused: true,
        };
      }
      if (existingSession.rows[0]) {
        await callStripe(
          () => stripeClient().checkout.sessions.expire(existingSession.rows[0].id),
          "Stripe could not replace the existing Checkout Session",
        );
        replacedSessionId = existingSession.rows[0].id;
        await client.query(
          `update billing_checkout_sessions
           set status = 'expired'
           where provider = 'stripe' and provider_session_id = $1 and status = 'open'`,
          [replacedSessionId],
        );
      }

      const session = await callStripe(
        () => stripeClient().checkout.sessions.create(
          checkoutMode === "setup" ? {
            mode: "setup",
            customer: account.providerCustomerId,
            client_reference_id: req.authorizedOrganizationId,
            success_url: requiredUrl("STRIPE_CHECKOUT_SUCCESS_URL"),
            cancel_url: requiredUrl("STRIPE_CHECKOUT_CANCEL_URL"),
            metadata,
            setup_intent_data: {
              metadata,
            },
          } : {
            mode: "subscription",
            customer: account.providerCustomerId,
            client_reference_id: req.authorizedOrganizationId,
            line_items: planPrices.map((item) => ({
              price: item.providerPriceId,
            })),
            success_url: requiredUrl("STRIPE_CHECKOUT_SUCCESS_URL"),
            cancel_url: requiredUrl("STRIPE_CHECKOUT_CANCEL_URL"),
            automatic_tax: {
              enabled: process.env.HEDGELING_STRIPE_AUTOMATIC_TAX === "true",
            },
            allow_promotion_codes: process.env.HEDGELING_STRIPE_ALLOW_PROMOTION_CODES === "true",
            metadata,
            subscription_data: {
              metadata,
              billing_mode: { type: "flexible" },
            },
          },
          { idempotencyKey: `hedgeling-checkout-${account.id}-${crypto.randomUUID()}` },
        ),
        "Stripe could not create the Checkout Session",
      );
      const expiresAt = stripeTimestamp(session.expires_at);
      if (!session.id || !session.url || !expiresAt) {
        if (session.id) {
          await stripeClient().checkout.sessions.expire(session.id).catch(() => {});
        }
        throw new Error("Stripe Checkout did not return a usable session");
      }
      try {
        await client.query(
          `insert into billing_checkout_sessions(
             billing_account_id, price_key, provider, provider_session_id,
             status, url, expires_at, created_by_user_id, checkout_mode, metadata
           ) values($1, $2, 'stripe', $3, 'open', $4, $5, $6, $7, $8)`,
          [
            account.id,
            priceKey,
            session.id,
            session.url,
            expiresAt,
            req.auth?.user?.id || null,
            checkoutMode,
            JSON.stringify({
              planKey: price.planKey,
              planPriceKeys: planPrices.map((item) => item.key),
            }),
          ],
        );
      } catch (error) {
        try {
          await stripeClient().checkout.sessions.expire(session.id);
        } catch (cleanupError) {
          error.cleanupError = cleanupError;
        }
        throw error;
      }
      return {
        id: session.id,
        url: session.url,
        reused: false,
        checkoutMode,
      };
    });
  } catch (error) {
    if (replacedSessionId) {
      try {
        await query(
          `update billing_checkout_sessions
           set status = 'expired'
           where provider = 'stripe' and provider_session_id = $1 and status = 'open'`,
          [replacedSessionId],
        );
      } catch (reconciliationError) {
        error.reconciliationError = reconciliationError;
      }
    }
    throw error;
  }
  if (!checkout.reused) {
    await recordBillingAudit(
      req,
      "billing.checkout_session_created",
      "billing_account",
      account.id,
      { checkoutSessionId: checkout.id, priceKey },
    );
  }
  return res.status(checkout.reused ? 200 : 201).json(checkout);
}

export async function createStripePortalSession(req, res) {
  const account = await ensureStripeCustomer(req.authorizedOrganizationId);
  const session = await callStripe(
    () => stripeClient().billingPortal.sessions.create({
      customer: account.providerCustomerId,
      return_url: requiredUrl("STRIPE_PORTAL_RETURN_URL"),
    }),
    "Stripe could not create the billing portal session",
  );
  await recordBillingAudit(
    req,
    "billing.portal_session_created",
    "billing_account",
    account.id,
    { portalSessionId: session.id },
  );
  return res.status(201).json({ id: session.id, url: session.url });
}

async function linkCheckoutCustomer(client, session) {
  const organizationId = String(
    session.metadata?.hedgeling_organization_id || session.client_reference_id || "",
  );
  const customerId = objectId(session.customer);
  if (!isUuid(organizationId) || !customerId) {
    throw new Error("Stripe Checkout Session is missing Hedgeling organization metadata");
  }
  const linked = await client.query(
    `update billing_accounts
     set provider = 'stripe', provider_customer_id = $2, updated_at = now()
     where organization_id = $1
       and (provider is null or provider = 'stripe')
       and (provider_customer_id is null or provider_customer_id = $2)
     returning id`,
    [organizationId, customerId],
  );
  if (!linked.rows[0]) throw new Error("Stripe Checkout customer does not match a billing account");
  const checkout = await client.query(
    `update billing_checkout_sessions
     set status = 'completed', completed_at = coalesce(completed_at, now())
     where provider = 'stripe' and provider_session_id = $1
     returning id, billing_account_id, price_key, checkout_mode`,
    [session.id],
  ).then((result) => result.rows[0]);
  const checkoutMode = String(
    session.metadata?.hedgeling_checkout_mode
    || checkout?.checkout_mode
    || "subscription",
  );
  if (checkoutMode === "setup") {
    if (!checkout) {
      throw new Error("Stripe setup Checkout Session is not linked locally");
    }
    const setupIntentId = objectId(session.setup_intent);
    if (!setupIntentId) {
      throw new Error("Stripe setup Checkout Session is missing its SetupIntent");
    }
    const plan = await client.query(
      `select price.plan_id, account.organization_id
       from billing_prices price
       join billing_accounts account on account.id = $2
       where price.key = $1 and price.component = 'base'`,
      [checkout.price_key, checkout.billing_account_id],
    ).then((result) => result.rows[0]);
    if (!plan) throw new Error("Stripe setup Checkout price is no longer configured");
    await client.query(
      `insert into billing_subscription_provisioning(
         organization_id, billing_account_id, plan_id, base_price_key,
         checkout_session_id, provider_setup_intent_id, idempotency_key,
         metadata
       ) values($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict(provider, checkout_session_id) do nothing`,
      [
        plan.organization_id,
        checkout.billing_account_id,
        plan.plan_id,
        checkout.price_key,
        checkout.id,
        setupIntentId,
        `stripe-subscription:${checkout.id}`,
        JSON.stringify({
          providerCheckoutSessionId: session.id,
          source: "mixed_interval_setup_checkout",
        }),
      ],
    );
  }
}

async function expireCheckoutSession(client, session) {
  await client.query(
    `update billing_checkout_sessions
     set status = 'expired'
     where provider = 'stripe' and provider_session_id = $1 and status = 'open'`,
    [session.id],
  );
}

async function reconcileSubscription(client, subscription, event) {
  const customerId = objectId(subscription.customer);
  const subscriptionItems = subscription.items?.data;
  if (!Array.isArray(subscriptionItems) || subscriptionItems.length < 1) {
    throw new Error("Stripe subscription is missing its items");
  }
  const providerItems = subscriptionItems.map((item) => ({
    id: objectId(item),
    priceId: objectId(item?.price) || objectId(item?.plan),
    period: itemPeriod(item),
  }));
  if (
    !customerId
    || providerItems.some((item) => !item.id || !item.priceId)
    || new Set(providerItems.map((item) => item.id)).size !== providerItems.length
  ) {
    throw new Error("Stripe subscription has an invalid customer, item, or price");
  }
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [customerId]);

  const priceResult = await client.query(
    `select
       price.key as billing_price_key,
       price.provider_price_id,
       price.component,
       price.plan_id,
       plan.key as plan_key,
       plan.metadata as plan_metadata,
       account.id as billing_account_id,
       account.organization_id
     from billing_prices price
     join product_plans plan on plan.id = price.plan_id
     join billing_accounts account
       on account.provider = 'stripe' and account.provider_customer_id = $2
     where price.provider = 'stripe'
       and price.provider_price_id = any($1::text[])`,
    [providerItems.map((item) => item.priceId), customerId],
  );
  const mappingByPrice = new Map(
    priceResult.rows.map((row) => [row.provider_price_id, row]),
  );
  if (mappingByPrice.size !== new Set(providerItems.map((item) => item.priceId)).size) {
    throw new Error(
      `Stripe subscription references an unmapped customer or price: ${customerId}`,
    );
  }
  const mappedItems = providerItems.map((item) => ({
    ...item,
    ...mappingByPrice.get(item.priceId),
  }));
  const planIds = new Set(mappedItems.map((item) => item.plan_id));
  const baseItems = mappedItems.filter((item) => item.component === "base");
  if (planIds.size !== 1 || baseItems.length !== 1) {
    throw new Error(
      "Stripe subscription items must map to one Hedgeling plan and exactly one base price",
    );
  }
  const mapping = baseItems[0];
  const expectedComponents = await client.query(
    `select component
     from billing_prices
     where plan_id = $1 and provider = 'stripe' and active = true
       and provider_price_id is not null`,
    [mapping.plan_id],
  );
  const actualComponents = new Set(mappedItems.map((item) => item.component));
  const missingComponents = expectedComponents.rows
    .map((row) => row.component)
    .filter((component) => !actualComponents.has(component));
  if (missingComponents.length) {
    throw new Error(
      `Stripe subscription is missing required plan components: ${missingComponents.join(", ")}`,
    );
  }
  const usageItems = mappedItems.filter((item) => item.component !== "base");
  const usagePeriods = new Set(
    usageItems.map((item) => `${item.period.start || ""}/${item.period.end || ""}`),
  );
  if (
    usageItems.some((item) => !item.period.start || !item.period.end)
    || usagePeriods.size > 1
  ) {
    throw new Error(
      "Stripe usage subscription items must share one complete billing period",
    );
  }

  const localState = localSubscriptionState(subscription.status);
  const eventTime = stripeTimestamp(event.created);
  if (!eventTime) throw new Error("Stripe subscription event is missing its provider timestamp");
  const existingResult = await client.query(
    `select * from subscriptions
     where provider = 'stripe' and provider_subscription_id = $1
     for update`,
    [subscription.id],
  );
  const before = existingResult.rows[0] || null;
  if (
    before?.provider_state_updated_at
    && new Date(before.provider_state_updated_at).getTime() > new Date(eventTime).getTime()
  ) {
    return;
  }
  const nextUsagePeriod = usageItems[0]?.period || { start: null, end: null };
  if (
    before?.usage_period_start
    && before?.usage_period_end
    && (
      new Date(before.usage_period_start).getTime()
        !== new Date(nextUsagePeriod.start || 0).getTime()
      || new Date(before.usage_period_end).getTime()
        !== new Date(nextUsagePeriod.end || 0).getTime()
    )
  ) {
    await stageClosedBillingPeriod(client, {
      organizationId: mapping.organization_id,
      billingAccountId: mapping.billing_account_id,
      subscriptionId: before.id,
      planId: before.plan_id,
      periodStart: before.usage_period_start,
      periodEnd: before.usage_period_end,
    });
  }

  await client.query(
    `update subscriptions
     set state = 'canceled', updated_at = now()
     where billing_account_id = $1 and state <> 'canceled'
       and (
         provider is distinct from 'stripe'
         or provider_subscription_id is distinct from $2
       )`,
    [mapping.billing_account_id, subscription.id],
  );

  const period = mapping.period.start && mapping.period.end
    ? mapping.period
    : subscriptionPeriod(subscription);
  const usagePeriod = nextUsagePeriod;
  const configuredGraceDays = Number(
    mapping.plan_metadata?.paymentFailureGraceDays ?? pastDueGraceDays(),
  );
  if (
    !Number.isInteger(configuredGraceDays)
    || configuredGraceDays < 0
    || configuredGraceDays > 90
  ) {
    throw new Error("The plan payment-failure grace period is invalid");
  }
  const graceEndsAt = localState === "past_due"
    ? before?.state === "past_due" && before.grace_ends_at
      ? before.grace_ends_at
      : addDays(eventTime, configuredGraceDays)
    : null;
  await client.query(
    `insert into subscriptions(
       billing_account_id, plan_id, provider, provider_subscription_id, state,
       current_period_start, current_period_end, grace_ends_at,
       cancel_at_period_end, provider_state_updated_at, metadata,
       usage_period_start, usage_period_end
     ) values($1, $2, 'stripe', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict do nothing`,
    [
      mapping.billing_account_id,
      mapping.plan_id,
      subscription.id,
      localState,
      period.start,
      period.end,
      graceEndsAt,
      subscription.cancel_at_period_end === true,
      eventTime,
      JSON.stringify({
        stripePriceId: mapping.priceId,
        stripePriceIds: mappedItems.map((item) => item.priceId),
      }),
      usagePeriod.start,
      usagePeriod.end,
    ],
  );
  const updated = await client.query(
    `update subscriptions
     set plan_id = $2, state = $3, current_period_start = $4,
         current_period_end = $5, grace_ends_at = $6,
         cancel_at_period_end = $7, provider_state_updated_at = $8,
         metadata = metadata || $9::jsonb,
         usage_period_start = $10, usage_period_end = $11,
         updated_at = now()
     where provider = 'stripe' and provider_subscription_id = $1
     returning *`,
    [
      subscription.id,
      mapping.plan_id,
      localState,
      period.start,
      period.end,
      graceEndsAt,
      subscription.cancel_at_period_end === true,
      eventTime,
      JSON.stringify({
        stripePriceId: mapping.priceId,
        stripePriceIds: mappedItems.map((item) => item.priceId),
      }),
      usagePeriod.start,
      usagePeriod.end,
    ],
  );
  const after = updated.rows[0];
  if (!after) throw new Error("Stripe subscription could not be persisted");
  for (const item of mappedItems) {
    await client.query(
      `insert into subscription_items(
         subscription_id, billing_price_key, provider,
         provider_subscription_item_id, component, current_period_start,
         current_period_end, status, provider_state_updated_at, metadata
       ) values($1, $2, 'stripe', $3, $4, $5, $6, 'active', $7, $8)
       on conflict(subscription_id, billing_price_key) do update
       set provider = excluded.provider,
           provider_subscription_item_id = excluded.provider_subscription_item_id,
           component = excluded.component,
           current_period_start = excluded.current_period_start,
           current_period_end = excluded.current_period_end,
           status = 'active',
           provider_state_updated_at = excluded.provider_state_updated_at,
           metadata = subscription_items.metadata || excluded.metadata,
           updated_at = now()`,
      [
        after.id,
        item.billing_price_key,
        item.id,
        item.component,
        item.period.start,
        item.period.end,
        eventTime,
        JSON.stringify({ stripePriceId: item.priceId }),
      ],
    );
  }
  await client.query(
    `update subscription_items
     set status = 'removed', provider_state_updated_at = $2, updated_at = now()
     where subscription_id = $1 and provider = 'stripe'
       and not (provider_subscription_item_id = any($3::text[]))`,
    [after.id, eventTime, mappedItems.map((item) => item.id)],
  );
  if (usagePeriod.start && usagePeriod.end) {
    await seedOrganizationResourceHighWaterPeriod(client, {
      organizationId: mapping.organization_id,
      periodStart: usagePeriod.start,
      periodEnd: usagePeriod.end,
      planKey: mapping.plan_key,
    });
  }
  const npmSeatsQueuedForRevocation = localState === "canceled"
    ? await queueOrganizationNpmSeatRevocations(
      client,
      mapping.organization_id,
      { reason: "stripe_subscription_canceled" },
    )
    : 0;
  await client.query(
    `insert into audit_events(
       organization_id, actor_type, action, resource_type, resource_id,
       before_state, after_state, metadata
     ) values($1, 'platform', 'billing.subscription_synchronized',
       'subscription', $2, $3, $4, $5)`,
    [
      mapping.organization_id,
      after.id,
      before ? JSON.stringify(before) : null,
      JSON.stringify(after),
      JSON.stringify({
        provider: "stripe",
        providerEventId: event.id,
        npmSeatsQueuedForRevocation,
      }),
    ],
  );
}

async function processStripeEventInTransaction(client, event) {
  switch (event.type) {
    case "checkout.session.completed":
      await linkCheckoutCustomer(client, event.data.object);
      return "processed";
    case "checkout.session.expired":
      await expireCheckoutSession(client, event.data.object);
      return "processed";
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      await reconcileSubscription(client, event.data.object, event);
      return "processed";
    default:
      return "ignored";
  }
}

export async function handleStripeEvent(event) {
  if (!event?.id || !event?.type || !event?.data?.object) {
    throw new Error("Stripe event payload is incomplete");
  }
  const payload = JSON.stringify(event);
  try {
    return await withTransaction(async (client) => {
      const inserted = await client.query(
        `insert into billing_provider_events(
           provider, provider_event_id, event_type, api_version, livemode,
           provider_created_at, status, attempts, payload
         ) values('stripe', $1, $2, $3, $4, $5, 'processing', 1, $6)
         on conflict(provider, provider_event_id) do nothing
         returning id`,
        [
          event.id,
          event.type,
          event.api_version || null,
          event.livemode === true,
          stripeTimestamp(event.created),
          payload,
        ],
      );
      const eventRow = await client.query(
        `select id, status from billing_provider_events
         where provider = 'stripe' and provider_event_id = $1
         for update`,
        [event.id],
      );
      if (!inserted.rows[0] && ["processed", "ignored"].includes(eventRow.rows[0]?.status)) {
        return { duplicate: true, status: eventRow.rows[0].status };
      }
      if (!inserted.rows[0]) {
        await client.query(
          `update billing_provider_events
           set status = 'processing', attempts = attempts + 1, last_error = null
           where id = $1`,
          [eventRow.rows[0].id],
        );
      }
      const status = await processStripeEventInTransaction(client, event);
      await client.query(
        `update billing_provider_events
         set status = $2, processed_at = now(), last_error = null
         where provider = 'stripe' and provider_event_id = $1`,
        [event.id, status],
      );
      return { duplicate: false, status };
    });
  } catch (error) {
    await query(
      `insert into billing_provider_events(
         provider, provider_event_id, event_type, api_version, livemode,
         provider_created_at, status, attempts, payload, last_error
       ) values('stripe', $1, $2, $3, $4, $5, 'failed', 1, $6, $7)
       on conflict(provider, provider_event_id) do update set
         status = 'failed',
         attempts = billing_provider_events.attempts + 1,
         payload = excluded.payload,
         last_error = excluded.last_error`,
      [
        event.id,
        event.type,
        event.api_version || null,
        event.livemode === true,
        stripeTimestamp(event.created),
        payload,
        String(error.message || error).slice(0, 2000),
      ],
    );
    throw error;
  }
}

export async function replayFailedStripeEvent(eventId) {
  if (!/^evt_[A-Za-z0-9_]+$/.test(String(eventId || ""))) {
    throw new Error("A valid Stripe event ID is required");
  }
  const result = await query(
    `select payload
     from billing_provider_events
     where provider = 'stripe' and provider_event_id = $1 and status = 'failed'`,
    [eventId],
  );
  if (!result.rows[0]) {
    throw new Error(`No failed Stripe event found for ${eventId}`);
  }
  return handleStripeEvent(result.rows[0].payload);
}

export async function stripeWebhook(req, res) {
  if (!stripeEnabled() && !stripeClientOverride) {
    return res.status(503).json({ error: "Stripe billing is not enabled" });
  }
  if (!Buffer.isBuffer(req.body)) {
    return res.status(400).json({ error: "Stripe webhook requires an unmodified raw request body" });
  }
  const signature = req.get("stripe-signature");
  if (!signature) return res.status(400).json({ error: "Stripe signature is required" });
  let event;
  try {
    event = stripeClient().webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    return res.status(400).json({ error: "Stripe webhook signature verification failed" });
  }
  const result = await handleStripeEvent(event);
  return res.json({ received: true, ...result });
}
