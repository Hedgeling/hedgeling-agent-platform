import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import { createPinnedStripeClient } from "./stripe-client.js";

function stripeClient() {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is required");
  return createPinnedStripeClient(secretKey);
}

export async function claimSubscriptionProvisioning({
  workerId = crypto.randomUUID(),
  limit = 10,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Subscription provisioning batch size must be from 1 to 100");
  }
  return withTransaction(async (client) => {
    const result = await client.query(
      `with candidates as (
         select id
         from billing_subscription_provisioning
         where (
             status in ('pending', 'failed')
             and next_attempt_at <= now()
           )
           or (
             status = 'processing'
             and lease_expires_at <= now()
           )
         order by created_at
         for update skip locked
         limit $1
       )
       update billing_subscription_provisioning work
       set status = 'processing', lease_id = $2,
           lease_expires_at = now() + interval '15 minutes',
           attempts = attempts + 1, updated_at = now()
       from candidates
       where work.id = candidates.id
       returning work.*`,
      [limit, workerId],
    );
    return { workerId, work: result.rows };
  });
}

async function provisioningContext(workId, workerId) {
  const result = await query(
    `select
       work.*,
       account.provider_customer_id as "providerCustomerId",
       coalesce(
         json_agg(
           json_build_object(
             'key', price.key,
             'component', price.component,
             'providerPriceId', price.provider_price_id,
             'billingInterval', price.billing_interval
           )
           order by (price.component = 'base') desc, price.component
         ) filter (where price.key is not null),
         '[]'
       ) as prices
     from billing_subscription_provisioning work
     join billing_accounts account on account.id = work.billing_account_id
     left join billing_prices price
       on price.plan_id = work.plan_id
      and price.provider = 'stripe'
      and price.active = true
      and price.provider_price_id is not null
     where work.id = $1 and work.status = 'processing' and work.lease_id = $2
     group by work.id, account.provider_customer_id`,
    [workId, workerId],
  );
  const context = result.rows[0];
  if (!context) throw new Error("Subscription provisioning lease was lost");
  if (!context.providerCustomerId || !context.provider_setup_intent_id) {
    throw new Error("Subscription provisioning is missing provider identities");
  }
  if (
    !Array.isArray(context.prices)
    || !context.prices.length
    || !context.prices.some((price) => price.component === "base")
  ) {
    throw new Error("Subscription provisioning has no active base price");
  }
  if (new Set(context.prices.map((price) => price.billingInterval)).size < 2) {
    throw new Error("Setup provisioning is reserved for mixed-interval plans");
  }
  return context;
}

export async function provisionMixedIntervalSubscription(
  workId,
  workerId,
  provider = stripeClient(),
) {
  const context = await provisioningContext(workId, workerId);
  const setupIntent = await provider.setupIntents.retrieve(
    context.provider_setup_intent_id,
  );
  const paymentMethodId = typeof setupIntent.payment_method === "string"
    ? setupIntent.payment_method
    : setupIntent.payment_method?.id;
  if (setupIntent.status !== "succeeded" || !paymentMethodId) {
    await query(
      `update billing_subscription_provisioning
       set status = 'requires_action',
           last_error = 'The saved payment method requires customer action',
           lease_id = null, lease_expires_at = null, updated_at = now()
       where id = $1 and status = 'processing' and lease_id = $2`,
      [workId, workerId],
    );
    return { status: "requires_action", providerSubscriptionId: null };
  }
  await provider.customers.update(context.providerCustomerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
  const metadata = {
    hedgeling_organization_id: context.organization_id,
    hedgeling_plan_id: context.plan_id,
    hedgeling_base_price_key: context.base_price_key,
    hedgeling_provisioning_id: context.id,
  };
  const subscription = await provider.subscriptions.create(
    {
      customer: context.providerCustomerId,
      items: context.prices.map((price) => ({
        price: price.providerPriceId,
      })),
      default_payment_method: paymentMethodId,
      billing_mode: { type: "flexible" },
      payment_behavior: "default_incomplete",
      payment_settings: {
        save_default_payment_method: "on_subscription",
      },
      metadata,
      expand: ["latest_invoice.payment_intent"],
    },
    { idempotencyKey: context.idempotency_key },
  );
  if (!subscription.id) throw new Error("Stripe did not create a subscription");
  const updated = await query(
    `update billing_subscription_provisioning
     set status = 'succeeded', provider_subscription_id = $3,
         last_error = null, lease_id = null, lease_expires_at = null,
         metadata = metadata || $4::jsonb, updated_at = now()
     where id = $1 and status = 'processing' and lease_id = $2
     returning id`,
    [
      workId,
      workerId,
      subscription.id,
      JSON.stringify({
        providerSubscriptionStatus: subscription.status,
        providerPaymentIntentStatus:
          subscription.latest_invoice?.payment_intent?.status || null,
      }),
    ],
  );
  if (!updated.rows[0]) {
    const error = new Error(
      "Stripe subscription was created but its local provisioning lease was lost",
    );
    error.code = "subscription_provider_local_commit_failed";
    error.providerSubscriptionId = subscription.id;
    throw error;
  }
  return {
    status: "succeeded",
    providerSubscriptionId: subscription.id,
    providerSubscriptionStatus: subscription.status,
  };
}

export async function failSubscriptionProvisioning(workId, workerId, error) {
  const message = String(error?.message || error || "Provisioning failed")
    .slice(0, 2000);
  return query(
    `update billing_subscription_provisioning
     set status = 'failed', last_error = $3,
         next_attempt_at = now() + least(
           interval '1 hour',
           interval '30 seconds' * power(2, least(attempts, 7))
         ),
         lease_id = null, lease_expires_at = null, updated_at = now()
     where id = $1 and status = 'processing' and lease_id = $2
     returning id`,
    [workId, workerId, message],
  ).then((result) => result.rows[0] || null);
}
