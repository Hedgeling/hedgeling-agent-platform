import express from "express";
import { query } from "./db.js";
import { requireOrganizationPermission } from "./authorization.js";
import { organizationBillingAccess } from "./entitlements.js";
import { chatAccess } from "./chat-access.js";
import { isUuid } from "./validation.js";
import { aiCreditOverageAmountMinor } from "./ai-credits.js";

const router = express.Router();
router.get("/organizations/:organizationId/billing-summary", (req, res, next) => isUuid(req.params.organizationId) ? next() : res.status(400).json({ error: "Invalid organization ID" }),
  requireOrganizationPermission("billing.view"), (req, res, next) => (async () => {
    const org = req.authorizedOrganizationId;
    const [billing, chat, period, resources, settings] = await Promise.all([
      organizationBillingAccess(org), chatAccess(org),
      query(`select coalesce(s.usage_period_start,s.current_period_start,date_trunc('month',now())) as start,
          coalesce(s.usage_period_end,s.current_period_end) as "end", a.provider_customer_id is not null as "hasCustomer",
          (s.provider='stripe' and s.state<>'canceled') as "hasSubscription"
        from billing_accounts a left join lateral(select * from subscriptions where billing_account_id=a.id order by (state<>'canceled') desc,created_at desc limit 1) s on true where a.organization_id=$1`, [org]),
      query(`select count(*)::text as count from source_strings s join projects p on p.id=s.project_id join business_units b on b.id=p.business_unit_id where b.organization_id=$1 and p.data_purged_at is null`, [org]),
      query("select ai_credit_overage_cap_minor as cap from organization_spend_controls where organization_id=$1", [org]),
    ]);
    const start = period.rows[0]?.start || new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const [usage, highWater] = await Promise.all([
      // Read the same period-attributed rollups that metered billing invoices
      // from, so the console never disagrees with the billed quantities.
      query(`select metric_key,coalesce(sum(quantity),0)::text as quantity from usage_period_rollups
        where organization_id=$1 and scope_type='organization' and scope_id=$1
        and metric_key in ('ai_credits','agent_chat_tokens')
        and period_type='subscription' and period_start=$2 group by metric_key`, [org, start]),
      query("select observed_quantity::text as quantity from organization_resource_high_water where organization_id=$1 and resource_key='managed_strings' and period_start=$2", [org, start]),
    ]);
    const used = Object.fromEntries(usage.rows.map((row) => [row.metric_key, row.quantity]));
    const creditPolicy = billing.entitlements.find((e) => e.entitlementKey === "ai_revision")?.limits?.usage?.ai_credits;
    const stringPolicy = billing.entitlements.find((e) => e.entitlementKey === "state_imports")?.limits;
    const included = creditPolicy?.included ?? creditPolicy?.limit ?? null;
    const overages = creditPolicy?.enforcement === "overage";
    const stripeEnabled = process.env.HEDGELING_STRIPE_ENABLED === "true";
    const stripeKey = process.env.STRIPE_SECRET_KEY || "";
    res.set("Cache-Control", "no-store").json({ ...billing, chat, period: { start, end: period.rows[0]?.end || null },
      strings: { current: resources.rows[0].count, highWater: highWater.rows[0]?.quantity || resources.rows[0].count, limits: stringPolicy || {} },
      ai: { usedCredits: used.ai_credits || "0", includedCredits: included, overages, capMinor: settings.rows[0]?.cap || "0",
        estimatedOverageMinor: overages ? aiCreditOverageAmountMinor(BigInt(used.ai_credits || 0), BigInt(included || 0)) : 0, currency: "USD" },
      includedChatTokens: used.agent_chat_tokens || "0",
      payment: { enabled: stripeEnabled && Boolean(stripeKey), mode: !stripeEnabled || !stripeKey ? "unconfigured" : /^(sk|rk)_test_/.test(stripeKey) ? "test" : "live", hasCustomer: Boolean(period.rows[0]?.hasCustomer), hasSubscription: Boolean(period.rows[0]?.hasSubscription) },
    });
  })().catch(next));
export default router;
