import crypto from "node:crypto";
import express from "express";
import { query, withTransaction } from "./db.js";
import { auditRequest } from "./audit.js";
import { requireOrganizationPermission } from "./authorization.js";
import { recordOrganizationResourceHighWater } from "./commercial-resources.js";
import { isUuid } from "./validation.js";

const router = express.Router();
const route = (handler) => (req, res, next) => (
  Promise.resolve(handler(req, res)).catch(next)
);
const activeSeatStates = [
  "requested",
  "inviting",
  "invited",
  "active",
  "revoking",
  "failed",
];

function httpError(status, message, code, details) {
  return Object.assign(new Error(message), { status, code, details });
}

function npmUsername(value) {
  const normalized = String(value || "").trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(normalized)) {
    throw httpError(400, "A valid npm username is required", "npm_username_invalid");
  }
  return normalized;
}

function positiveMetadataInteger(metadata, key, { nullable = false } = {}) {
  const value = metadata?.[key];
  if (nullable && value == null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw httpError(
      503,
      `The current plan has an invalid ${key} policy`,
      "npm_seat_policy_invalid",
    );
  }
  return number;
}

async function currentNpmSeatPolicy(client, organizationId, { lock = false } = {}) {
  const result = await client.query(
    `select
       account.status as "accountStatus",
       subscription.state as "subscriptionState",
       coalesce(
         subscription.usage_period_start,
         subscription.current_period_start,
         date_trunc('month', now())
       ) as "periodStart",
       coalesce(
         subscription.usage_period_end,
         case
           when subscription.current_period_start is not null
             then subscription.current_period_start + interval '1 month'
           else date_trunc('month', now()) + interval '1 month'
         end
       ) as "periodEnd",
       plan.key as "planKey",
       plan.name as "planName",
       plan.metadata
     from billing_accounts account
     join lateral (
       select current_subscription.*
       from subscriptions current_subscription
       where current_subscription.billing_account_id = account.id
       order by
         (current_subscription.state <> 'canceled') desc,
         current_subscription.created_at desc
       limit 1
     ) subscription on true
     join product_plans plan on plan.id = subscription.plan_id
     where account.organization_id = $1
     ${lock ? "for update of account" : ""}`,
    [organizationId],
  );
  const row = result.rows[0];
  if (!row) {
    throw httpError(
      402,
      "A current subscription is required for private npm access",
      "subscription_required",
    );
  }
  const commerciallyActive = row.accountStatus === "active"
    && ["trialing", "active"].includes(row.subscriptionState);
  const included = positiveMetadataInteger(row.metadata, "npmSeatsIncluded");
  const maximum = positiveMetadataInteger(
    row.metadata,
    "npmSeatsMaximum",
    { nullable: true },
  );
  return {
    planKey: row.planKey,
    planName: row.planName,
    subscriptionState: row.subscriptionState,
    commerciallyActive,
    included,
    maximum,
    overageAllowed: Boolean(
      row.metadata?.npmSeatOverage
      || Number(row.metadata?.additionalNpmSeatAmountMinor) > 0,
    ),
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
  };
}

async function activeSeatCount(client, organizationId) {
  const result = await client.query(
    `select count(*)::integer as count
     from npm_seat_assignments
     where organization_id = $1 and status = any($2::text[])`,
    [organizationId, activeSeatStates],
  );
  return result.rows[0].count;
}

async function recordSeatHighWater(client, organizationId, policy, quantity) {
  await recordOrganizationResourceHighWater(client, {
    organizationId,
    resourceKey: "npm_seats",
    observedQuantity: quantity,
    metadata: {
      planKey: policy.planKey,
      includedSeats: policy.included,
      method: "monthly_high_water_no_proration",
    },
  });
}

router.get(
  "/organizations/:organizationId/npm-seats",
  requireOrganizationPermission("billing.view"),
  route(async (req, res) => {
    const [policy, seats, highWater] = await Promise.all([
      currentNpmSeatPolicy({ query }, req.authorizedOrganizationId),
      query(
        `select
           id,
           npm_username as "npmUsername",
           status,
           requested_at as "requestedAt",
           provisioned_at as "provisionedAt",
           revoked_at as "revokedAt",
           provider_membership_role as "providerMembershipRole",
           last_error as "lastError"
         from npm_seat_assignments
         where organization_id = $1
         order by created_at desc`,
        [req.authorizedOrganizationId],
      ),
      query(
        `select observed_quantity::text as "observedQuantity",
                period_start as "periodStart", period_end as "periodEnd"
         from organization_resource_high_water
         where organization_id = $1 and resource_key = 'npm_seats'
         order by period_start desc limit 1`,
        [req.authorizedOrganizationId],
      ),
    ]);
    res.json({
      policy,
      seats: seats.rows,
      currentHighWater: highWater.rows[0] || null,
    });
  }),
);

router.post(
  "/organizations/:organizationId/npm-seats",
  requireOrganizationPermission("billing.manage"),
  route(async (req, res) => {
    const username = npmUsername(req.body?.npmUsername);
    const result = await withTransaction(async (client) => {
      await client.query(
        "select pg_advisory_xact_lock(hashtext($1))",
        [`npm-seat:${req.authorizedOrganizationId}`],
      );
      const policy = await currentNpmSeatPolicy(
        client,
        req.authorizedOrganizationId,
        { lock: true },
      );
      if (!policy.commerciallyActive) {
        throw httpError(
          402,
          "Private npm access is frozen until billing is current",
          "subscription_not_current",
        );
      }
      const existing = await client.query(
        `select id, npm_username as "npmUsername", status
         from npm_seat_assignments
         where organization_id = $1 and lower(npm_username) = $2
           and status <> 'revoked'
         for update`,
        [req.authorizedOrganizationId, username],
      );
      if (existing.rows[0]) {
        return { seat: existing.rows[0], policy, created: false };
      }
      const currentCount = await activeSeatCount(
        client,
        req.authorizedOrganizationId,
      );
      if (policy.maximum != null && currentCount >= policy.maximum) {
        throw httpError(
          402,
          `The ${policy.planName} plan allows at most ${policy.maximum} npm seat(s)`,
          "npm_seat_limit_exceeded",
          { currentCount, maximum: policy.maximum },
        );
      }
      const nextCount = currentCount + 1;
      if (nextCount > policy.included && !policy.overageAllowed) {
        throw httpError(
          402,
          "The included npm-seat allowance is exhausted",
          "npm_seat_upgrade_required",
          { currentCount, included: policy.included },
        );
      }
      const seat = await client.query(
        `insert into npm_seat_assignments(
           organization_id, npm_username, requested_by_user_id,
           provider_membership_role
         ) values($1, $2, $3, 'developer')
         returning id, npm_username as "npmUsername", status,
                   requested_at as "requestedAt"`,
        [
          req.authorizedOrganizationId,
          username,
          req.auth?.user?.id || null,
        ],
      ).then((queryResult) => queryResult.rows[0]);
      await client.query(
        `insert into npm_provisioning_outbox(
           seat_assignment_id, operation, idempotency_key, metadata
         ) values($1, 'invite', $2, $3)`,
        [
          seat.id,
          `npm-seat:${seat.id}:invite`,
          JSON.stringify({
            organizationId: req.authorizedOrganizationId,
            npmUsername: username,
          }),
        ],
      );
      await recordSeatHighWater(
        client,
        req.authorizedOrganizationId,
        policy,
        nextCount,
      );
      await auditRequest(client, req, {
        action: "npm_seat.requested",
        resourceType: "npm_seat_assignment",
        resourceId: seat.id,
        afterState: {
          ...seat,
          planKey: policy.planKey,
          seatNumber: nextCount,
          included: nextCount <= policy.included,
          highWaterBilling: nextCount > policy.included,
        },
      });
      return { seat, policy, created: true, nextCount };
    });
    res.status(result.created ? 202 : 200).json({
      seat: result.seat,
      included: result.nextCount
        ? result.nextCount <= result.policy.included
        : null,
      billing: "monthly_high_water_no_proration",
      policy: result.policy,
    });
  }),
);

router.delete(
  "/organizations/:organizationId/npm-seats/:seatId",
  requireOrganizationPermission("billing.manage"),
  route(async (req, res) => {
    if (!isUuid(req.params.seatId)) {
      throw httpError(400, "Npm seat ID is invalid", "npm_seat_id_invalid");
    }
    const result = await withTransaction(async (client) => {
      await client.query(
        "select pg_advisory_xact_lock(hashtext($1))",
        [`npm-seat:${req.authorizedOrganizationId}`],
      );
      const seat = await client.query(
        `select * from npm_seat_assignments
         where id = $1 and organization_id = $2 for update`,
        [req.params.seatId, req.authorizedOrganizationId],
      ).then((queryResult) => queryResult.rows[0]);
      if (!seat) throw httpError(404, "Npm seat not found", "npm_seat_not_found");
      if (seat.status === "revoked") return { seat, changed: false };
      await client.query(
        `update npm_provisioning_outbox
         set status = 'canceled', updated_at = now()
         where seat_assignment_id = $1 and operation = 'invite'
           and status in ('pending', 'failed')`,
        [seat.id],
      );
      const updated = await client.query(
        `update npm_seat_assignments
         set status = 'revoking', updated_at = now()
         where id = $1
         returning id, npm_username as "npmUsername", status`,
        [seat.id],
      ).then((queryResult) => queryResult.rows[0]);
      await client.query(
        `insert into npm_provisioning_outbox(
           seat_assignment_id, operation, idempotency_key, metadata
         ) values($1, 'revoke', $2, $3)
         on conflict(idempotency_key) do nothing`,
        [
          seat.id,
          `npm-seat:${seat.id}:revoke`,
          JSON.stringify({
            organizationId: req.authorizedOrganizationId,
            npmUsername: seat.npm_username,
          }),
        ],
      );
      await auditRequest(client, req, {
        action: "npm_seat.revocation_requested",
        resourceType: "npm_seat_assignment",
        resourceId: seat.id,
        beforeState: {
          npmUsername: seat.npm_username,
          status: seat.status,
        },
        afterState: updated,
      });
      return { seat: updated, changed: true };
    });
    res.status(result.changed ? 202 : 200).json({
      seat: result.seat,
      note: "Monthly high-water billing is not prorated or reduced by revocation.",
    });
  }),
);

export async function claimNpmProvisioningWork({
  workerId = crypto.randomUUID(),
  limit = 10,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Npm provisioning batch size must be from 1 to 100");
  }
  return withTransaction(async (client) => {
    const result = await client.query(
      `with candidates as (
         select id
         from npm_provisioning_outbox
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
       update npm_provisioning_outbox work
       set status = 'processing',
           lease_id = $2,
           lease_expires_at = now() + interval '5 minutes',
           attempts = attempts + 1,
           updated_at = now()
       from candidates
       where work.id = candidates.id
       returning work.*`,
      [limit, workerId],
    );
    return { workerId, work: result.rows };
  });
}

export async function queueOrganizationNpmSeatRevocations(
  client,
  organizationId,
  { reason = "subscription_canceled" } = {},
) {
  const seats = await client.query(
    `update npm_seat_assignments
     set status = 'revoking', updated_at = now()
     where organization_id = $1
       and status not in ('revoking', 'revoked')
     returning id, npm_username`,
    [organizationId],
  );
  for (const seat of seats.rows) {
    await client.query(
      `update npm_provisioning_outbox
       set status = 'canceled', updated_at = now()
       where seat_assignment_id = $1
         and operation = 'invite'
         and status in ('pending', 'failed')`,
      [seat.id],
    );
    await client.query(
      `insert into npm_provisioning_outbox(
         seat_assignment_id, operation, idempotency_key, metadata
       ) values($1, 'revoke', $2, $3)
       on conflict(idempotency_key) do nothing`,
      [
        seat.id,
        `npm-seat:${seat.id}:revoke`,
        JSON.stringify({
          organizationId,
          npmUsername: seat.npm_username,
          reason,
        }),
      ],
    );
  }
  return seats.rows.length;
}

export async function completeNpmProvisioningWork(
  workId,
  workerId,
  providerState = {},
) {
  return withTransaction(async (client) => {
    const work = await client.query(
      `update npm_provisioning_outbox
       set status = 'succeeded', completed_at = now(), last_error = null,
           lease_id = null, lease_expires_at = null, updated_at = now(),
           metadata = case
             when metadata->>'dataLifecyclePurge' = 'true'
               then jsonb_build_object(
                 'reason', 'data_lifecycle_purge',
                 'dataLifecyclePurge', true,
                 'dataLifecycleRequestId', metadata->>'dataLifecycleRequestId'
               )
             else metadata
           end
       where id = $1 and status = 'processing' and lease_id = $2
       returning *`,
      [workId, workerId],
    ).then((result) => result.rows[0]);
    if (!work) throw httpError(409, "Npm provisioning lease was lost");
    const finalStatus = work.operation === "revoke" ? "revoked" : "invited";
    await client.query(
      `update npm_seat_assignments
       set status = $2,
           npm_username = case
             when $2 = 'revoked' and $4::boolean
               then 'deleted-' || replace(id::text, '-', '')
             else npm_username
           end,
           provisioned_at = case when $2 = 'invited'
             then coalesce(provisioned_at, now()) else provisioned_at end,
           revoked_at = case when $2 = 'revoked' then now() else null end,
           provider_state = case
             when $4::boolean then '{}'::jsonb
             else provider_state || $3::jsonb
           end,
           last_error = null,
           updated_at = now()
       where id = $1`,
      [
        work.seat_assignment_id,
        finalStatus,
        JSON.stringify(providerState),
        work.metadata?.dataLifecyclePurge === true,
      ],
    );
    return work;
  });
}

export async function failNpmProvisioningWork(workId, workerId, error) {
  const message = String(error?.message || error || "Npm provisioning failed")
    .slice(0, 2000);
  return withTransaction(async (client) => {
    const work = await client.query(
      `update npm_provisioning_outbox
       set status = 'failed', last_error = $3,
           next_attempt_at = now() + least(
             interval '1 hour',
             interval '30 seconds' * power(2, least(attempts, 7))
           ),
           lease_id = null, lease_expires_at = null, updated_at = now()
       where id = $1 and status = 'processing' and lease_id = $2
       returning *`,
      [workId, workerId, message],
    ).then((result) => result.rows[0]);
    if (!work) return null;
    await client.query(
      `update npm_seat_assignments
       set status = 'failed', last_error = $2, updated_at = now()
       where id = $1 and status <> 'revoked'`,
      [work.seat_assignment_id, message],
    );
    return work;
  });
}

export default router;
