import { query } from "./db.js";
import { isPlatformAdmin } from "./authorization.js";
import { projectLifecycleAccess } from "./data-lifecycle-status.js";

export function subscriptionAllows(
  accessClass,
  state,
  graceEndsAt,
  currentPeriodEnd,
  provider,
  now = Date.now(),
) {
  if (accessClass === "retention") return true;
  const localTrialExpired = provider == null
    && state === "trialing"
    && currentPeriodEnd != null
    && new Date(currentPeriodEnd).getTime() <= now;
  if (localTrialExpired) {
    return accessClass === "export"
      && graceEndsAt != null
      && new Date(graceEndsAt).getTime() > now;
  }
  if (["trialing", "active"].includes(state)) return true;
  if (accessClass === "export" && ["past_due", "paused"].includes(state)) return true;
  if (state === "past_due" && accessClass === "paid_write") {
    return graceEndsAt != null && new Date(graceEndsAt).getTime() > now;
  }
  return false;
}

export async function organizationFeatureAccess(
  organizationId,
  featureKey,
  database = { query },
) {
  if (!featureKey) return { enabled: true, source: "not_required" };
  const result = await database.query(
    `select
       flag.default_enabled as "defaultEnabled",
       override.enabled as "overrideEnabled"
     from feature_flags flag
     left join lateral (
       select organization_override.enabled
       from organization_feature_flag_overrides organization_override
       where organization_override.organization_id = $1
         and organization_override.feature_key = flag.key
         and organization_override.superseded_at is null
         and organization_override.starts_at <= now()
         and (
           organization_override.expires_at is null
           or organization_override.expires_at > now()
         )
       order by organization_override.created_at desc
       limit 1
     ) override on true
     where flag.key = $2`,
    [organizationId, featureKey],
  );
  const flag = result.rows[0];
  if (!flag) return { enabled: false, source: "unknown_feature" };
  if (flag.overrideEnabled != null) {
    return { enabled: flag.overrideEnabled, source: "organization_override" };
  }
  return { enabled: flag.defaultEnabled, source: "platform_default" };
}

export async function effectiveOrganizationAccess(
  organizationId,
  entitlementKey,
  { featureKey = entitlementKey } = {},
) {
  const result = await query(
    `select
       definition.key,
       definition.access_class as "accessClass",
       account.status as "accountStatus",
       subscription.state as "subscriptionState",
       subscription.provider as "subscriptionProvider",
       subscription.current_period_end as "currentPeriodEnd",
       subscription.grace_ends_at as "graceEndsAt",
       plan.key as "planKey",
       plan_entitlement.enabled as "planEnabled",
       plan_entitlement.limits as "planLimits",
       override.enabled as "overrideEnabled",
       override.limits as "overrideLimits"
     from entitlement_definitions definition
     left join billing_accounts account on account.organization_id = $1
     left join lateral (
       select current_subscription.*
       from subscriptions current_subscription
       where current_subscription.billing_account_id = account.id
       order by
         (current_subscription.state <> 'canceled') desc,
         current_subscription.created_at desc
       limit 1
     ) subscription on true
     left join product_plans plan on plan.id = subscription.plan_id
     left join plan_entitlements plan_entitlement
       on plan_entitlement.plan_id = plan.id
      and plan_entitlement.entitlement_key = definition.key
     left join lateral (
       select organization_override.enabled, organization_override.limits
       from organization_entitlement_overrides organization_override
       where organization_override.organization_id = $1
         and organization_override.entitlement_key = definition.key
         and organization_override.superseded_at is null
         and organization_override.starts_at <= now()
         and (
           organization_override.expires_at is null
           or organization_override.expires_at > now()
         )
       order by organization_override.created_at desc
       limit 1
     ) override on true
     where definition.key = $2`,
    [organizationId, entitlementKey],
  );
  const entitlement = result.rows[0];
  const feature = await organizationFeatureAccess(organizationId, featureKey);
  if (!entitlement) {
    return {
      allowed: false,
      entitlementKey,
      featureKey,
      featureEnabled: feature.enabled,
      reason: "unknown_entitlement",
    };
  }

  const hasOverride = entitlement.overrideEnabled != null;
  const configured = hasOverride
    ? entitlement.overrideEnabled
    : entitlement.planEnabled === true;
  const subscriptionAllowed = entitlement.accountStatus === "active"
    && subscriptionAllows(
      entitlement.accessClass,
      entitlement.subscriptionState,
      entitlement.graceEndsAt,
      entitlement.currentPeriodEnd,
      entitlement.subscriptionProvider,
    );
  const localTrialExpired = entitlement.subscriptionProvider == null
    && entitlement.subscriptionState === "trialing"
    && entitlement.currentPeriodEnd != null
    && new Date(entitlement.currentPeriodEnd).getTime() <= Date.now();
  const commerciallyAllowed = entitlement.overrideEnabled === true || subscriptionAllowed;
  const allowed = configured && commerciallyAllowed && feature.enabled;

  let reason = "allowed";
  if (!feature.enabled) reason = "feature_disabled";
  else if (hasOverride && !configured) reason = "entitlement_overridden_off";
  else if (!hasOverride && !entitlement.subscriptionState) reason = "subscription_missing";
  else if (!configured) reason = "plan_not_entitled";
  else if (!commerciallyAllowed) reason = entitlement.accountStatus && entitlement.accountStatus !== "active"
    ? "billing_account_inactive"
    : localTrialExpired
      ? "subscription_trial_expired"
      : `subscription_${entitlement.subscriptionState || "missing"}`;

  return {
    allowed,
    entitlementKey,
    accessClass: entitlement.accessClass,
    featureKey,
    featureEnabled: feature.enabled,
    featureSource: feature.source,
    entitlementSource: hasOverride ? "organization_override" : "plan",
    accountStatus: entitlement.accountStatus || null,
    subscriptionState: entitlement.subscriptionState || null,
    subscriptionProvider: entitlement.subscriptionProvider || null,
    currentPeriodEnd: entitlement.currentPeriodEnd || null,
    graceEndsAt: entitlement.graceEndsAt || null,
    planKey: entitlement.planKey || null,
    limits: (hasOverride ? entitlement.overrideLimits : entitlement.planLimits) || {},
    reason,
  };
}

export function applyLifecycleExportAccess(access, lifecycle) {
  if (lifecycle?.mode !== "export_only" || access.accessClass !== "export") {
    return access;
  }
  // A customer-confirmed deletion window is a data-portability right, not a
  // plan upgrade. Organization-level rollout settings cannot withdraw that
  // right, while the platform default remains an emergency global kill switch.
  const portabilityFeatureOverride = access.featureEnabled === false
    && access.featureSource === "organization_override";
  if (!access.featureEnabled && !portabilityFeatureOverride) return access;
  return {
    ...access,
    allowed: true,
    featureEnabled: true,
    configuredFeatureEnabled: access.featureEnabled,
    configuredFeatureSource: access.featureSource,
    featureSource: portabilityFeatureOverride
      ? "data_lifecycle_portability_override"
      : access.featureSource,
    reason: "data_lifecycle_export_window",
  };
}

export function requireProjectEntitlement(entitlementKey, options = {}) {
  return async (req, res, next) => {
    try {
      const organizationId = req.authorizedProject?.organizationId;
      if (!organizationId) {
        return res.status(500).json({ error: "Project authorization must run before entitlement checks" });
      }
      let access = await effectiveOrganizationAccess(organizationId, entitlementKey, options);
      const lifecycle = await projectLifecycleAccess(
        req.authorizedProject.id,
        organizationId,
      );
      access = applyLifecycleExportAccess(access, lifecycle);
      req.commercialAccess = access;
      if (!access.featureEnabled) {
        return res.status(403).json({
          error: "This feature is not enabled for the organization",
          code: "feature_disabled",
        });
      }
      if (isPlatformAdmin(req.auth) || access.allowed) return next();
      return res.status(402).json({
        error: "The organization subscription does not include this operation",
        code: access.reason === "subscription_trial_expired"
          ? "trial_expired"
          : "entitlement_required",
        reason: access.reason,
        subscriptionState: access.subscriptionState,
      });
    } catch (error) {
      return next(error);
    }
  };
}

export async function organizationBillingAccess(organizationId) {
  const accountResult = await query(
    `select
       account.id,
       account.status,
       account.provider,
       account.currency,
       subscription.state as "subscriptionState",
       subscription.current_period_start as "currentPeriodStart",
       subscription.current_period_end as "currentPeriodEnd",
       subscription.grace_ends_at as "graceEndsAt",
       subscription.cancel_at_period_end as "cancelAtPeriodEnd",
       plan.key as "planKey",
       plan.name as "planName"
     from billing_accounts account
     left join lateral (
       select current_subscription.*
       from subscriptions current_subscription
       where current_subscription.billing_account_id = account.id
       order by
         (current_subscription.state <> 'canceled') desc,
         current_subscription.created_at desc
       limit 1
     ) subscription on true
     left join product_plans plan on plan.id = subscription.plan_id
     where account.organization_id = $1`,
    [organizationId],
  );
  const definitions = await query("select key from entitlement_definitions order by key");
  const entitlements = await Promise.all(definitions.rows.map((definition) => (
    effectiveOrganizationAccess(organizationId, definition.key)
  )));
  return {
    account: accountResult.rows[0] || null,
    entitlements,
  };
}
