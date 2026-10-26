import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import { createPinnedStripeClient } from "./stripe-client.js";

function ceilDiv(numerator, denominator) {
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

export function billingMeterQuantity({
  observedQuantity,
  includedQuantity = 0,
  billingBlockSize = 1,
}) {
  const observed = BigInt(observedQuantity);
  const included = BigInt(includedQuantity);
  const blockSize = BigInt(billingBlockSize);
  if (observed < 0n || included < 0n) {
    throw new Error("Billing meter quantities cannot be negative");
  }
  if (blockSize <= 0n) {
    throw new Error("Billing meter block size must be positive");
  }
  const billable = observed > included ? observed - included : 0n;
  return {
    billableQuantity: billable,
    providerEventQuantity: ceilDiv(billable, blockSize),
  };
}

export function billingMeterRestagingDecision({
  previousProviderEventQuantity,
  targetProviderEventQuantity,
}) {
  const previous = BigInt(previousProviderEventQuantity);
  const target = BigInt(targetProviderEventQuantity);
  if (previous < 0n || target < 0n) {
    throw new Error("Billing meter restaging quantities cannot be negative");
  }
  if (target < previous) {
    const error = new Error(
      "Closed billing-period usage decreased after staging; manual reconciliation is required",
    );
    error.code = "billing_meter_downward_correction_required";
    throw error;
  }
  return {
    previousProviderEventQuantity: previous,
    targetProviderEventQuantity: target,
    adjustmentProviderEventQuantity: target - previous,
  };
}

function metricForComponent(component) {
  if (component === "ai_credit_overage") return "ai_credits";
  if (component === "managed_string_overage") return "managed_strings";
  if (component === "npm_seat") return "npm_seats";
  return null;
}

async function observedQuantity(
  client,
  organizationId,
  component,
  periodStart,
) {
  if (component === "ai_credit_overage") {
    return client.query(
      `select coalesce(sum(quantity), 0)::text as quantity
       from usage_period_rollups
       where organization_id = $1 and scope_type = 'organization'
         and scope_id = $1 and metric_key = 'ai_credits'
         and period_type = 'subscription' and period_start = $2`,
      [organizationId, periodStart],
    ).then((result) => BigInt(result.rows[0].quantity));
  }
  const resourceKey = component === "managed_string_overage"
    ? "managed_strings"
    : "npm_seats";
  return client.query(
    `select coalesce(max(observed_quantity), 0)::text as quantity
     from organization_resource_high_water
     where organization_id = $1 and resource_key = $2
       and period_start = $3`,
    [organizationId, resourceKey, periodStart],
  ).then((result) => BigInt(result.rows[0].quantity));
}

async function stageMeterOutbox(client, {
  organizationId,
  sourceType,
  sourceId,
  meterKey,
  providerCustomerId,
  providerEventName,
  periodStart,
  periodEnd,
  quantity,
  metadata,
}) {
  if (quantity <= 0n) return;
  await client.query(
    `insert into billing_meter_outbox(
       organization_id, source_type, source_id, meter_key, provider,
       provider_customer_id, provider_event_name, period_start,
       period_end, quantity, metadata
     ) values($1, $2, $3, $4, 'stripe', $5, $6, $7, $8, $9, $10)
     on conflict(source_type, source_id, meter_key) do nothing`,
    [
      organizationId,
      sourceType,
      sourceId,
      meterKey,
      providerCustomerId,
      providerEventName,
      periodStart,
      periodEnd,
      quantity.toString(),
      JSON.stringify(metadata),
    ],
  );
}

export async function stageClosedBillingPeriod(
  client,
  {
    organizationId,
    billingAccountId,
    subscriptionId,
    planId,
    periodStart,
    periodEnd,
  },
) {
  if (!periodStart || !periodEnd) return [];
  const account = await client.query(
    `select provider_customer_id
     from billing_accounts
     where id = $1 and organization_id = $2 and provider = 'stripe'`,
    [billingAccountId, organizationId],
  ).then((result) => result.rows[0]);
  if (!account?.provider_customer_id) {
    throw new Error("Closed billing period has no Stripe customer");
  }
  const prices = await client.query(
    `select price.key, price.component, price.meter_event_name,
            price.included_quantity, price.billing_block_size
     from subscription_items item
     join billing_prices price on price.key = item.billing_price_key
     where item.subscription_id = $1
       and item.provider = 'stripe'
       and item.status = 'active'
       and price.plan_id = $2
       and price.provider = 'stripe'
       and price.component <> 'base'
       and price.meter_event_name is not null
     order by price.component`,
    [subscriptionId, planId],
  );
  const staged = [];
  for (const price of prices.rows) {
    const meterKey = metricForComponent(price.component);
    if (!meterKey) throw new Error(`Unsupported billing meter component ${price.component}`);
    const included = BigInt(price.included_quantity ?? 0);
    const blockSize = BigInt(price.billing_block_size ?? 1);
    const observed = await observedQuantity(
      client,
      organizationId,
      price.component,
      periodStart,
    );
    let billable;
    let providerQuantity;
    try {
      ({
        billableQuantity: billable,
        providerEventQuantity: providerQuantity,
      } = billingMeterQuantity({
        observedQuantity: observed,
        includedQuantity: included,
        billingBlockSize: blockSize,
      }));
    } catch (error) {
      throw new Error(`Billing price ${price.key} is invalid: ${error.message}`);
    }
    let summary = await client.query(
      `insert into billing_meter_period_summaries(
         organization_id, subscription_id, billing_price_key, meter_key,
         period_start, period_end, observed_quantity, included_quantity,
         billable_quantity, billing_block_size, provider_event_quantity,
         metadata
       ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict(subscription_id, billing_price_key, period_start) do nothing
       returning *`,
      [
        organizationId,
        subscriptionId,
        price.key,
        meterKey,
        periodStart,
        periodEnd,
        observed.toString(),
        included.toString(),
        billable.toString(),
        blockSize.toString(),
        providerQuantity.toString(),
        JSON.stringify({
          aggregation: "closed_period_final",
          rounding: "ceiling_to_billing_block",
        }),
      ],
    ).then((result) => result.rows[0] || null);
    let adjustmentProviderQuantity = 0n;
    if (summary) {
      await stageMeterOutbox(client, {
        organizationId,
        sourceType: "period_summary",
        sourceId: summary.id,
        meterKey,
        providerCustomerId: account.provider_customer_id,
        providerEventName: price.meter_event_name,
        periodStart,
        periodEnd,
        quantity: providerQuantity,
        metadata: { billingPriceKey: price.key },
      });
    } else {
      summary = await client.query(
        `select * from billing_meter_period_summaries
         where subscription_id = $1 and billing_price_key = $2
           and period_start = $3
         for update`,
        [subscriptionId, price.key, periodStart],
      ).then((result) => result.rows[0]);
      if (!summary) throw new Error("Closed billing-period summary disappeared");
      if (
        summary.organization_id !== organizationId
        || summary.meter_key !== meterKey
        || new Date(summary.period_end).getTime() !== new Date(periodEnd).getTime()
        || BigInt(summary.included_quantity) !== included
        || BigInt(summary.billing_block_size) !== blockSize
      ) {
        throw new Error("Closed billing-period summary configuration changed");
      }
      const restaging = billingMeterRestagingDecision({
        previousProviderEventQuantity: summary.provider_event_quantity,
        targetProviderEventQuantity: providerQuantity,
      });
      adjustmentProviderQuantity = restaging.adjustmentProviderEventQuantity;
      if (adjustmentProviderQuantity > 0n) {
        const adjustment = await client.query(
          `insert into billing_meter_period_adjustments(
             period_summary_id, observed_quantity, billable_quantity,
             previous_provider_event_quantity, target_provider_event_quantity,
             delta_provider_event_quantity, reason, metadata
           ) values($1, $2, $3, $4, $5, $6, 'late_usage', $7)
           on conflict(period_summary_id, target_provider_event_quantity) do nothing
           returning id`,
          [
            summary.id,
            observed.toString(),
            billable.toString(),
            restaging.previousProviderEventQuantity.toString(),
            restaging.targetProviderEventQuantity.toString(),
            adjustmentProviderQuantity.toString(),
            JSON.stringify({ billingPriceKey: price.key }),
          ],
        ).then((result) => result.rows[0]);
        if (!adjustment) {
          throw new Error("Closed billing-period adjustment could not be staged");
        }
        await stageMeterOutbox(client, {
          organizationId,
          sourceType: "period_adjustment",
          sourceId: adjustment.id,
          meterKey,
          providerCustomerId: account.provider_customer_id,
          providerEventName: price.meter_event_name,
          periodStart,
          periodEnd,
          quantity: adjustmentProviderQuantity,
          metadata: {
            billingPriceKey: price.key,
            periodSummaryId: summary.id,
            adjustmentReason: "late_usage",
          },
        });
      }
      await client.query(
        `update billing_meter_period_summaries
         set observed_quantity = $2, billable_quantity = $3,
             provider_event_quantity = $4,
             metadata = metadata || $5::jsonb,
             updated_at = now()
         where id = $1`,
        [
          summary.id,
          observed.toString(),
          billable.toString(),
          providerQuantity.toString(),
          JSON.stringify({
            lastRestagedAt: new Date().toISOString(),
            lateUsageAdjustment: adjustmentProviderQuantity > 0n,
          }),
        ],
      );
    }
    staged.push({
      meterKey,
      observedQuantity: observed.toString(),
      providerEventQuantity: providerQuantity.toString(),
      adjustmentProviderEventQuantity: adjustmentProviderQuantity.toString(),
    });
  }
  return staged;
}

export async function claimBillingMeterEvents({
  workerId = crypto.randomUUID(),
  limit = 100,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("Billing meter batch size must be from 1 to 1000");
  }
  return withTransaction(async (client) => {
    const result = await client.query(
      `with candidates as (
         select id
         from billing_meter_outbox
         where (
             status in ('pending', 'failed') and next_attempt_at <= now()
           )
           or (
             status = 'processing' and lease_expires_at <= now()
           )
         order by created_at
         for update skip locked
         limit $1
       )
       update billing_meter_outbox work
       set status = 'processing', lease_id = $2,
           lease_expires_at = now() + interval '5 minutes',
           attempts = attempts + 1, updated_at = now()
       from candidates
       where work.id = candidates.id
       returning work.*`,
      [limit, workerId],
    );
    return { workerId, work: result.rows };
  });
}

function stripeClient() {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is required");
  return createPinnedStripeClient(secretKey);
}

export async function deliverBillingMeterEvent(
  work,
  workerId,
  provider = stripeClient(),
) {
  const ageMs = Date.now() - new Date(work.created_at).getTime();
  if (ageMs >= 23 * 60 * 60 * 1000 && work.attempts > 1) {
    const error = new Error(
      "Meter event retry exceeded the safe provider-identifier window; "
      + "manual reconciliation is required",
    );
    error.code = "meter_event_retry_window_expired";
    throw error;
  }
  const identifier = `hedgeling-${work.id}`;
  const event = await provider.billing.meterEvents.create({
    event_name: work.provider_event_name,
    payload: {
      stripe_customer_id: work.provider_customer_id,
      value: String(work.quantity),
    },
    identifier,
    timestamp: Math.floor(new Date(work.period_end).getTime() / 1000) - 1,
  });
  const updated = await query(
    `update billing_meter_outbox
     set status = 'delivered', provider_event_id = $3, delivered_at = now(),
         last_error = null, lease_id = null, lease_expires_at = null,
         updated_at = now()
     where id = $1 and status = 'processing' and lease_id = $2
     returning id`,
    [work.id, workerId, event.identifier || identifier],
  );
  if (!updated.rows[0]) {
    const error = new Error(
      "Stripe accepted the meter event but the local delivery lease was lost",
    );
    error.code = "meter_event_provider_local_commit_failed";
    throw error;
  }
  return event;
}

export async function failBillingMeterEvent(workId, workerId, error) {
  const terminal = error?.code === "meter_event_retry_window_expired";
  return query(
    `update billing_meter_outbox
     set status = 'failed', last_error = $3,
         next_attempt_at = case when $4
           then 'infinity'::timestamptz
           else now() + least(
             interval '1 hour',
             interval '30 seconds' * power(2, least(attempts, 7))
           )
         end,
         lease_id = null, lease_expires_at = null, updated_at = now()
     where id = $1 and status = 'processing' and lease_id = $2
     returning id`,
    [
      workId,
      workerId,
      String(error?.message || error || "Meter delivery failed").slice(0, 2000),
      terminal,
    ],
  ).then((result) => result.rows[0] || null);
}
