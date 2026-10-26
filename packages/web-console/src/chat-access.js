import { effectiveOrganizationAccess } from "./entitlements.js";
import { fail } from "./action-errors.js";

export async function chatAccess(organizationId) {
  const access = organizationId ? await effectiveOrganizationAccess(organizationId, "agent_chat") : null;
  // An explicitly selected local fixture can demonstrate the creation flow
  // without fabricating paid subscriptions. Real trial expiry still applies.
  const localDemo = process.env.NODE_ENV !== "production" && process.env.HEDGELING_AUTH_MODE === "local"
    && process.env.HEDGELING_AGENT_PROVIDER === "fixture";
  if (localDemo && (!access || access.reason === "subscription_missing")) return { allowed: true, reason: "local_demo", included: true, trialEndsAt: null };
  // A provider trial also ends at its timestamp even if a webhook is delayed.
  const expired = access?.subscriptionState === "trialing" && access.currentPeriodEnd && new Date(access.currentPeriodEnd) <= new Date();
  const allowed = Boolean(access?.allowed && !expired);
  const reason = expired ? "trial_expired" : access?.reason || "organization_required";
  return { allowed, included: true, reason, trialEndsAt: access?.subscriptionState === "trialing" ? access.currentPeriodEnd : null,
    limits: access?.limits || {},
    message: allowed ? "Chat is included with your platform plan. Translation credits are separate."
      : expired ? "Your 14-day trial has ended. Upgrade your plan to keep chatting with Hedgeling."
      : organizationId ? "An active platform plan is needed to chat. Open Billing & usage to review your plan." : "Choose an organization with an active plan or trial to start chatting." };
}
export async function requireChatAccess(organizationId) {
  const access = await chatAccess(organizationId);
  if (!access.allowed) throw fail(402, access.message, "agent_plan_required");
  return access;
}
