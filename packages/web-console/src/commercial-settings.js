import express from "express";
import { query, withTransaction } from "./db.js";
import { auditRequest } from "./audit.js";
import { requireOrganizationPermission } from "./authorization.js";

const router = express.Router();
const route = (handler) => (req, res, next) => (
  Promise.resolve(handler(req, res)).catch(next)
);

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

async function spendPolicy(client, organizationId) {
  const result = await client.query(
    `select
       plan.key as "planKey",
       plan.name as "planName",
       plan_entitlement.limits
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
     left join plan_entitlements plan_entitlement
       on plan_entitlement.plan_id = plan.id
      and plan_entitlement.entitlement_key = 'ai_revision'
     where account.organization_id = $1`,
    [organizationId],
  );
  const row = result.rows[0];
  if (!row) {
    throw httpError(402, "A current plan is required", "subscription_required");
  }
  return {
    planKey: row.planKey,
    planName: row.planName,
    overageEnabled:
      row.limits?.usage?.ai_credits?.enforcement === "overage",
    includedAiCredits:
      Number(row.limits?.usage?.ai_credits?.included) || null,
  };
}

router.get(
  "/organizations/:organizationId/commercial-settings",
  requireOrganizationPermission("billing.view"),
  route(async (req, res) => {
    const [policy, settings] = await Promise.all([
      spendPolicy({ query }, req.authorizedOrganizationId),
      query(
        `select ai_credit_overage_cap_minor as "aiCreditOverageCapMinor",
                currency, changed_at as "changedAt"
         from organization_spend_controls
         where organization_id = $1`,
        [req.authorizedOrganizationId],
      ),
    ]);
    res.json({
      policy,
      spendControls: settings.rows[0] || {
        aiCreditOverageCapMinor: "0",
        currency: "USD",
        changedAt: null,
      },
    });
  }),
);

router.put(
  "/organizations/:organizationId/commercial-settings/ai-credit-cap",
  requireOrganizationPermission("billing.manage"),
  route(async (req, res) => {
    const amount = Number(req.body?.amountMinor);
    if (
      !Number.isSafeInteger(amount)
      || amount < 0
      || amount > 100_000_000
    ) {
      throw httpError(
        400,
        "AI-credit overage cap must be a whole cent amount from 0 to 100,000,000 ($1,000,000)",
        "ai_credit_cap_invalid",
      );
    }
    const saved = await withTransaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`spend-controls:${req.authorizedOrganizationId}`]);
      const policy = await spendPolicy(client, req.authorizedOrganizationId);
      if (!policy.overageEnabled) {
        throw httpError(
          409,
          `${policy.planName} does not support AI-credit overages`,
          "ai_credit_overage_not_supported",
        );
      }
      const before = await client.query(
        `select ai_credit_overage_cap_minor as "aiCreditOverageCapMinor",
                currency, changed_at as "changedAt"
         from organization_spend_controls
         where organization_id = $1 for update`,
        [req.authorizedOrganizationId],
      ).then((result) => result.rows[0] || null);
      if (req.body?.expectedAmountMinor != null && String(before?.aiCreditOverageCapMinor || "0") !== String(req.body.expectedAmountMinor)) {
        throw httpError(409, "The spending limit changed. Reload Billing & usage and review your change again.", "spending_limit_changed");
      }
      const after = await client.query(
        `insert into organization_spend_controls(
           organization_id, ai_credit_overage_cap_minor, currency,
           changed_by_user_id, changed_at
         ) values($1, $2, 'USD', $3, now())
         on conflict(organization_id) do update
         set ai_credit_overage_cap_minor = excluded.ai_credit_overage_cap_minor,
             changed_by_user_id = excluded.changed_by_user_id,
             changed_at = now()
         returning ai_credit_overage_cap_minor as "aiCreditOverageCapMinor",
                   currency, changed_at as "changedAt"`,
        [
          req.authorizedOrganizationId,
          amount,
          req.auth?.user?.id || null,
        ],
      ).then((result) => result.rows[0]);
      await auditRequest(client, req, {
        action: "billing.ai_credit_overage_cap_changed",
        resourceType: "organization",
        resourceId: req.authorizedOrganizationId,
        beforeState: before,
        afterState: after,
        metadata: {
          pricing: "$10 per 10,000-credit block",
          enforcement: "hard_pre_reservation_cap",
        },
      });
      return { policy, spendControls: after };
    });
    res.json(saved);
  }),
);

export default router;
