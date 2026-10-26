import crypto from "node:crypto";
import express from "express";
import { query, withTransaction } from "./db.js";
import { createServiceCredential } from "./service-accounts.js";
import {
  issueTrialPackageDownload,
  publicTrialPackageConfiguration,
} from "./trial-package-downloads.js";

const router = express.Router();
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

export const SELF_SERVICE_WORKFLOWS = Object.freeze([
  {
    key: "ai_publish",
    version: 1,
    name: "AI → Publish",
    description: "Generate translations with AI and publish without a required human gate.",
  },
  {
    key: "ai_human_review",
    version: 1,
    name: "AI → Human review → Publish",
    description: "Generate with AI, then require human review before publication.",
  },
  {
    key: "ai_translator_lead",
    version: 1,
    name: "AI → Translator edit → Lead approval → Publish",
    description: "Use a two-stage linguistic workflow after AI generation.",
  },
  {
    key: "human_reviewer",
    version: 1,
    name: "Human translation → Reviewer approval → Publish",
    description: "Use a fully human translation and review workflow.",
  },
]);

export const SELF_SERVICE_TRIAL_LIMITS = Object.freeze({
  businessUnits: 1,
  projects: 1,
  targetLocales: 3,
  activeSourceStrings: 2500,
  aiCredits: 25000,
  internalUsers: 3,
  vendorRelationships: 1,
  agencyLinguists: 5,
  activeWorkOrders: 3,
  glossaryTerms: 500,
  activeWorkflows: 1,
  serviceAccounts: 1,
  activeCredentials: 2,
  concurrentAiRuns: 1,
});

const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
  "yahoo.com",
  "proton.me",
  "protonmail.com",
]);

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function clean(value) {
  return String(value ?? "").trim();
}

function slug(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function locale(value) {
  const normalized = clean(value).replace(/_/g, "-");
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(normalized)) return "";
  try {
    return new Intl.Locale(normalized).toString();
  } catch {
    return "";
  }
}

function signupEnabled() {
  return process.env.HEDGELING_SELF_SERVICE_SIGNUP_ENABLED === "true";
}

function trialDays() {
  const value = Number(process.env.HEDGELING_SELF_SERVICE_TRIAL_DAYS || 14);
  if (!Number.isInteger(value) || value < 1 || value > 90) {
    throw new Error("HEDGELING_SELF_SERVICE_TRIAL_DAYS must be an integer from 1 to 90");
  }
  return value;
}

function termsVersion() {
  return process.env.HEDGELING_TERMS_VERSION || "2026-07-30";
}

function privacyVersion() {
  return process.env.HEDGELING_PRIVACY_VERSION || "2026-07-30";
}

function requireEnabled() {
  if (!signupEnabled()) {
    throw httpError(404, "Self-service onboarding is not enabled", "self_service_disabled");
  }
}

function requireUser(req) {
  if (req.auth?.principalType !== "user" || !req.auth?.user?.id) {
    throw httpError(403, "A user account is required", "user_required");
  }
  return req.auth.user;
}

export function selfServiceConfiguration() {
  return {
    enabled: signupEnabled(),
    trialDays: trialDays(),
    termsVersion: termsVersion(),
    privacyVersion: privacyVersion(),
    termsUrl: process.env.HEDGELING_TERMS_URL
      || null,
    privacyUrl: process.env.HEDGELING_PRIVACY_URL
      || null,
    trialPackage: publicTrialPackageConfiguration(),
    limits: SELF_SERVICE_TRIAL_LIMITS,
    workflows: SELF_SERVICE_WORKFLOWS,
  };
}

export function validateWorkspaceInput(body = {}) {
  const organizationName = clean(body.organizationName);
  const projectName = clean(body.projectName);
  const sourceLocale = locale(body.sourceLocale);
  const targetLocales = [...new Set(
    (Array.isArray(body.targetLocales) ? body.targetLocales : [])
      .map(locale)
      .filter(Boolean),
  )].filter((item) => item.toLowerCase() !== sourceLocale.toLowerCase());
  const workflow = SELF_SERVICE_WORKFLOWS.find(
    (candidate) => candidate.key === clean(body.workflowPresetKey),
  );
  if (!organizationName || organizationName.length > 200) {
    throw httpError(400, "Organization name is required and cannot exceed 200 characters");
  }
  if (!projectName || projectName.length > 200) {
    throw httpError(400, "Project name is required and cannot exceed 200 characters");
  }
  if (!sourceLocale) throw httpError(400, "A valid source locale is required");
  if (!targetLocales.length || targetLocales.length > SELF_SERVICE_TRIAL_LIMITS.targetLocales) {
    throw httpError(
      400,
      `Choose between 1 and ${SELF_SERVICE_TRIAL_LIMITS.targetLocales} target locales`,
    );
  }
  if (!workflow) throw httpError(400, "Choose a supported workflow");
  if (
    body.acceptedTerms !== true
    || body.acceptedPrivacy !== true
    || body.termsVersion !== termsVersion()
    || body.privacyVersion !== privacyVersion()
  ) {
    throw httpError(400, "Current Terms of Service and Privacy Policy acceptance is required");
  }
  return {
    organizationName,
    projectName,
    sourceLocale,
    targetLocales,
    workflow,
  };
}

async function workspaceForUser(client, userId) {
  const result = await client.query(
    `select
       claim.organization_id as "organizationId",
       organization.name as "organizationName",
       organization.slug as "organizationSlug",
       business_unit.id as "businessUnitId",
       business_unit.name as "businessUnitName",
       project.id as "projectId",
       project.name as "projectName",
       project.slug as "projectSlug",
       project.source_locale as "sourceLocale",
       onboarding.target_locales as "targetLocales",
       onboarding.workflow_preset_key as "workflowPresetKey",
       onboarding.workflow_version as "workflowVersion",
       subscription.state as "subscriptionState",
       subscription.provider as "subscriptionProvider",
       subscription.current_period_start as "trialStartedAt",
       subscription.current_period_end as "trialEndsAt",
       subscription.grace_ends_at as "exportGraceEndsAt",
       plan.key as "planKey",
       plan.metadata as "planMetadata",
       service_account.id as "serviceAccountId",
       service_account.name as "serviceAccountName",
       provisioning.status as "upgradeProvisioningStatus",
       provisioning.last_error as "upgradeProvisioningError",
       provisioning.provider_subscription_id as "upgradeProviderSubscriptionId"
     from self_service_trial_claims claim
     join organizations organization on organization.id = claim.organization_id
     join organization_onboarding onboarding
       on onboarding.organization_id = organization.id
     join business_units business_unit on business_unit.id = onboarding.business_unit_id
     join projects project on project.id = onboarding.project_id
     join billing_accounts account on account.organization_id = organization.id
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
     left join service_accounts service_account
       on service_account.id = onboarding.service_account_id
     left join lateral (
       select current_provisioning.*
       from billing_subscription_provisioning current_provisioning
       where current_provisioning.organization_id = organization.id
       order by current_provisioning.created_at desc
       limit 1
     ) provisioning on true
     where claim.owner_user_id = $1`,
    [userId],
  );
  return result.rows[0] || null;
}

export async function publicPlanCatalog(_req, res) {
  const result = await query(
    `select
       plan.key,
       plan.name,
       plan.version,
       plan.metadata,
       coalesce(
         json_agg(
           json_build_object(
             'key', price.key,
             'currency', price.currency,
             'billingInterval', price.billing_interval,
             'unitAmountMinor', price.unit_amount_minor,
             'component', price.component
           )
           order by price.billing_interval, price.currency
         ) filter (where price.key is not null),
         '[]'
       ) as prices
     from product_plans plan
     left join billing_prices price
       on price.plan_id = plan.id
      and price.active = true
      and price.provider = 'stripe'
     where plan.status = 'active'
       and plan.metadata->>'public' = 'true'
     group by plan.id
     order by
       case
         when plan.metadata->>'displayOrder' ~ '^[0-9]+$'
           then (plan.metadata->>'displayOrder')::integer
         else 999
       end,
       plan.name`,
  );
  res.json({
    plans: result.rows,
    checkoutEnabled: process.env.HEDGELING_STRIPE_ENABLED === "true",
  });
}

router.get("/config", route(async (_req, res) => {
  requireEnabled();
  res.json(selfServiceConfiguration());
}));

router.get("/status", route(async (req, res) => {
  requireEnabled();
  const user = requireUser(req);
  const workspace = await workspaceForUser({ query }, user.id);
  res.json({
    needsWorkspace: !workspace,
    workspace,
    configuration: selfServiceConfiguration(),
  });
}));

router.post("/trial-package-download", route(async (req, res) => {
  requireEnabled();
  await issueTrialPackageDownload(req, res);
}));

router.post("/workspace", route(async (req, res) => {
  requireEnabled();
  const user = requireUser(req);
  const input = validateWorkspaceInput(req.body);
  const createdCredential = createServiceCredential();
  const result = await withTransaction(async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtext($1))",
      [`self-service-trial:${user.id}`],
    );
    const existing = await workspaceForUser(client, user.id);
    if (existing) return { workspace: existing, token: null, created: false };

    const planResult = await client.query(
      `select id from product_plans
       where key = 'self-service-trial-v1' and status = 'active'
       for share`,
    );
    if (!planResult.rows[0]) {
      throw httpError(503, "The self-service trial plan is not configured");
    }

    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const organizationSlug = `${slug(input.organizationName) || "workspace"}-${suffix}`;
    const projectSlug = `${organizationSlug}-${slug(input.projectName) || "project"}`;
    const email = clean(user.email).toLowerCase();
    const emailDomain = email.includes("@") ? email.split("@").at(-1) : "";
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + trialDays() * 24 * 60 * 60 * 1000);
    const exportGraceEndsAt = new Date(endsAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    const credentialExpiresAt = new Date(
      startsAt.getTime() + 180 * 24 * 60 * 60 * 1000,
    );

    const organization = await client.query(
      `insert into organizations(
         slug, name, organization_type, status, metadata
       ) values($1, $2, 'customer', 'active', $3)
       returning id, slug, name`,
      [
        organizationSlug,
        input.organizationName,
        JSON.stringify({
          acquisition: "self_service",
          trial: true,
          ownerDomain: PUBLIC_EMAIL_DOMAINS.has(emailDomain) ? null : emailDomain,
        }),
      ],
    ).then((queryResult) => queryResult.rows[0]);
    const businessUnit = await client.query(
      `insert into business_units(organization_id, slug, name, metadata)
       values($1, 'default', 'Main', '{"selfServiceDefault":true}'::jsonb)
       returning id, slug, name`,
      [organization.id],
    ).then((queryResult) => queryResult.rows[0]);
    const project = await client.query(
      `insert into projects(slug, name, business_unit_id, source_locale)
       values($1, $2, $3, $4)
       returning id, slug, name, source_locale as "sourceLocale"`,
      [projectSlug, input.projectName, businessUnit.id, input.sourceLocale],
    ).then((queryResult) => queryResult.rows[0]);
    for (const targetLocale of input.targetLocales) {
      await client.query(
        "insert into locales(project_id, locale) values($1, $2)",
        [project.id, targetLocale],
      );
    }
    const membership = await client.query(
      `insert into organization_memberships(
         organization_id, user_id, membership_type, status, activated_at
       ) values($1, $2, 'internal', 'active', now())
       returning id`,
      [organization.id, user.id],
    ).then((queryResult) => queryResult.rows[0]);
    await client.query(
      `insert into role_assignments(
         principal_type, principal_id, role_id, scope_type, scope_id,
         inherit_to_children, granted_by_user_id
       )
       select 'user', $1, role.id, 'organization', $2, true, $1
       from roles role
       where role.organization_id is null and role.key = 'organization_owner'`,
      [user.id, organization.id],
    );
    await client.query(
      `insert into organization_identity_policies(organization_id)
       values($1) on conflict(organization_id) do nothing`,
      [organization.id],
    );
    const account = await client.query(
      `insert into billing_accounts(
         organization_id, status, billing_email, currency, metadata
       ) values($1, 'active', $2, 'USD', '{"selfService":true}'::jsonb)
       returning id`,
      [organization.id, email],
    ).then((queryResult) => queryResult.rows[0]);
    await client.query(
      `insert into subscriptions(
         billing_account_id, plan_id, state, current_period_start,
         current_period_end, grace_ends_at, metadata
       ) values($1, $2, 'trialing', $3, $4, $5, $6)`,
      [
        account.id,
        planResult.rows[0].id,
        startsAt.toISOString(),
        endsAt.toISOString(),
        exportGraceEndsAt.toISOString(),
        JSON.stringify({
          localTrial: true,
          trialDays: trialDays(),
          exportGraceDays: 30,
        }),
      ],
    );
    await client.query(
      `insert into project_workflows(
         project_id, preset_key, preset_version, status, configuration,
         activated_by_user_id
       ) values($1, $2, $3, 'active', $4, $5)`,
      [
        project.id,
        input.workflow.key,
        input.workflow.version,
        JSON.stringify({ source: "self_service_preset" }),
        user.id,
      ],
    );
    const serviceAccount = await client.query(
      `insert into service_accounts(
         organization_id, name, owner_user_id, metadata
       ) values($1, $2, $3, $4)
       returning id, name`,
      [
        organization.id,
        `${input.projectName} integration`,
        user.id,
        JSON.stringify({ selfServiceDefault: true, projectId: project.id }),
      ],
    ).then((queryResult) => queryResult.rows[0]);
    await client.query(
      `insert into service_account_credentials(
         service_account_id, token_prefix, token_digest, expires_at,
         created_by_user_id
       ) values($1, $2, $3, $4, $5)`,
      [
        serviceAccount.id,
        createdCredential.prefix,
        createdCredential.digest,
        credentialExpiresAt.toISOString(),
        user.id,
      ],
    );
    await client.query(
      `insert into role_assignments(
         principal_type, principal_id, role_id, scope_type, scope_id,
         inherit_to_children, granted_by_user_id
       )
       select 'service_account', $1, role.id, 'organization', $2, true, $3
       from roles role
       where role.organization_id is null and role.key = 'developer'`,
      [serviceAccount.id, organization.id, user.id],
    );
    for (const [documentType, version] of [
      ["terms_of_service", termsVersion()],
      ["privacy_policy", privacyVersion()],
    ]) {
      await client.query(
        `insert into user_legal_acceptances(
           user_id, document_type, document_version, accepted_at,
           ip_address, user_agent, metadata
         ) values($1, $2, $3, now(), $4, $5, $6)
         on conflict(user_id, document_type, document_version) do nothing`,
        [
          user.id,
          documentType,
          version,
          req.ip || null,
          clean(req.get("user-agent")).slice(0, 500) || null,
          JSON.stringify({ flow: "self_service_workspace" }),
        ],
      );
    }
    await client.query(
      `insert into self_service_trial_claims(
         owner_user_id, organization_id, owner_email, email_domain,
         trial_started_at, trial_ends_at
       ) values($1, $2, $3, $4, $5, $6)`,
      [
        user.id,
        organization.id,
        email,
        PUBLIC_EMAIL_DOMAINS.has(emailDomain) ? null : emailDomain,
        startsAt.toISOString(),
        endsAt.toISOString(),
      ],
    );
    await client.query(
      `insert into organization_onboarding(
         organization_id, owner_user_id, business_unit_id, project_id,
         service_account_id, state, source_locale, target_locales,
         workflow_preset_key, workflow_version, completed_at
       ) values($1, $2, $3, $4, $5, 'complete', $6, $7, $8, $9, now())`,
      [
        organization.id,
        user.id,
        businessUnit.id,
        project.id,
        serviceAccount.id,
        input.sourceLocale,
        input.targetLocales,
        input.workflow.key,
        input.workflow.version,
      ],
    );
    await client.query(
      `insert into audit_events(
         organization_id, actor_type, actor_id, effective_user_id,
         action, resource_type, resource_id, after_state, metadata
       ) values($1, 'user', $2, $2, 'self_service.workspace_created',
                'organization', $1, $3, $4)`,
      [
        organization.id,
        user.id,
        JSON.stringify({
          organization,
          businessUnit,
          project,
          membershipId: membership.id,
          workflow: input.workflow,
          serviceAccountId: serviceAccount.id,
          trialEndsAt: endsAt.toISOString(),
        }),
        JSON.stringify({ source: "self_service" }),
      ],
    );

    return {
      workspace: {
        organizationId: organization.id,
        organizationName: organization.name,
        organizationSlug: organization.slug,
        businessUnitId: businessUnit.id,
        businessUnitName: businessUnit.name,
        projectId: project.id,
        projectName: project.name,
        projectSlug: project.slug,
        sourceLocale: project.sourceLocale,
        targetLocales: input.targetLocales,
        workflowPresetKey: input.workflow.key,
        workflowVersion: input.workflow.version,
        subscriptionState: "trialing",
        subscriptionProvider: null,
        trialStartedAt: startsAt.toISOString(),
        trialEndsAt: endsAt.toISOString(),
        exportGraceEndsAt: exportGraceEndsAt.toISOString(),
        planKey: "self-service-trial-v1",
        planMetadata: { kind: "trial", trialDays: trialDays() },
        serviceAccountId: serviceAccount.id,
        serviceAccountName: serviceAccount.name,
      },
      token: createdCredential.token,
      tokenExpiresAt: credentialExpiresAt.toISOString(),
      created: true,
    };
  });

  res.status(result.created ? 201 : 200).json({
    workspace: result.workspace,
    credential: result.token
      ? {
        token: result.token,
        expiresAt: result.tokenExpiresAt,
        warning: "Copy this credential now. It will not be shown again.",
      }
      : null,
    created: result.created,
  });
}));

export default router;
