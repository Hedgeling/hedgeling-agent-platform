import crypto from "node:crypto";
import { HUMAN_DECISION_PERMISSIONS } from "./principal-policy.js";
import express from "express";
import { query, withTransaction } from "./db.js";
import { auditRequest } from "./audit.js";
import {
  isPlatformAdmin,
  organizationAccessForOrganizations,
  requireOrganizationPermission,
} from "./authorization.js";
import { organizationBillingAccess } from "./entitlements.js";
import {
  createStripeCheckoutSession,
  createStripePortalSession,
} from "./stripe-billing.js";
import {
  organizationBudgetStatus,
  organizationUsageSummary,
} from "./usage.js";
import { isUuid, optionalTimestamp } from "./validation.js";

const router = express.Router();
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
const allowedMembershipStatuses = new Set(["invited", "active", "suspended", "removed"]);
const allowedMembershipTypes = new Set(["internal", "external"]);
const allowedScopeTypes = new Set(["organization", "business_unit", "project"]);

for (const parameter of [
  "organizationId",
  "businessUnitId",
  "membershipId",
  "teamId",
  "assignmentId",
  "budgetId",
  "alertId",
]) {
  router.param(parameter, (req, res, next, value) => (
    isUuid(value) ? next() : res.status(400).json({ error: `${parameter} is invalid` })
  ));
}

function clean(value) {
  return String(value ?? "").trim();
}

function slug(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function audit(client, req, action, resourceType, resourceId, beforeState, afterState) {
  await auditRequest(client, req, {
    action,
    resourceType,
    resourceId,
    beforeState,
    afterState,
  });
}

async function scopeBelongsToOrganization(client, organizationId, scopeType, scopeId) {
  if (scopeType === "organization") return scopeId === organizationId;
  const table = scopeType === "business_unit" ? "business_units" : "projects";
  const join = scopeType === "project"
    ? "join business_units bu on bu.id = resource.business_unit_id"
    : "";
  const owner = scopeType === "project" ? "bu.organization_id" : "resource.organization_id";
  const result = await client.query(
    `select 1 from ${table} resource ${join} where resource.id = $1 and ${owner} = $2`,
    [scopeId, organizationId],
  );
  return Boolean(result.rows[0]);
}

router.post("/invitations/accept", route(async (req, res) => {
  if (!req.auth?.user?.id) throw httpError(403, "A user account is required to accept an invitation");
  const token = clean(req.body.token);
  if (!token) throw httpError(400, "Invitation token is required");
  const digest = crypto.createHash("sha256").update(token).digest("hex");
  const acceptedMembership = await withTransaction(async (client) => {
    const invitationResult = await client.query(
      `select i.id, i.organization_id, i.email, om.id as membership_id
       from invitations i
       join organization_memberships om on om.organization_id = i.organization_id
       join users u on u.id = om.user_id and lower(u.email) = lower(i.email)
       where i.token_digest = $1 and i.accepted_at is null and i.revoked_at is null
         and i.expires_at > now() and u.id = $2
       for update`,
      [digest, req.auth.user.id],
    );
    const invitation = invitationResult.rows[0];
    if (!invitation) throw httpError(400, "Invitation is invalid, expired, or belongs to another account");
    await client.query("update invitations set accepted_at = now() where id = $1", [invitation.id]);
    const membership = await client.query(
      `update organization_memberships set status = 'active', activated_at = coalesce(activated_at, now()),
         updated_at = now() where id = $1
       returning id, organization_id as "organizationId", status`,
      [invitation.membership_id],
    );
    await client.query(
      `update users set status = case when status = 'invited' then 'active' else status end,
         updated_at = now()
       where id = $1`,
      [req.auth.user.id],
    );
    req.authorizedOrganizationId = invitation.organization_id;
    await audit(client, req, "member.invitation_accepted", "organization_membership", invitation.membership_id, { status: "invited" }, membership.rows[0]);
    return membership.rows[0];
  });
  res.json({ membership: acceptedMembership });
}));

router.get("/organizations", route(async (req, res) => {
  const result = isPlatformAdmin(req.auth)
    ? await query(
      `select o.id, o.slug, o.name, o.organization_type as "organizationType", o.status,
              o.default_currency as "defaultCurrency"
       from organizations o order by lower(o.name)`,
    )
    : req.auth?.principalType === "service_account"
      ? await query(
        `select o.id, o.slug, o.name, o.organization_type as "organizationType", o.status,
                o.default_currency as "defaultCurrency"
         from organizations o
         where o.id = $1 and o.status = 'active'`,
        [req.auth.serviceAccount.organizationId],
      )
      : await query(
        `select visible.id, visible.slug, visible.name,
                visible.organization_type as "organizationType", visible.status,
                visible.default_currency as "defaultCurrency"
         from (
           select organization.*
           from organizations organization
           join organization_memberships membership
             on membership.organization_id = organization.id
           where membership.user_id = $1 and membership.status = 'active'
             and (membership.expires_at is null or membership.expires_at > now())
           union
           select organization.*
           from organizations organization
           join support_access_grants support
             on support.organization_id = organization.id
           where support.user_id = $1 and support.revoked_at is null
             and support.starts_at <= now() and support.expires_at > now()
         ) visible
         order by lower(visible.name)`,
        [req.auth.user.id],
      );
  const access = await organizationAccessForOrganizations(
    req.auth,
    result.rows.map((organization) => organization.id),
  );
  const organizations = result.rows
    .filter((organization) => access.has(organization.id))
    .map((organization) => ({
      ...organization,
      permissions: access.get(organization.id),
    }));
  res.json({ organizations });
}));

router.get(
  "/organizations/:organizationId",
  requireOrganizationPermission("organization.view"),
  route(async (req, res) => {
    const organizationId = req.authorizedOrganizationId;
    const [organization, businessUnits, projects, members, teams, roles, assignments, serviceAccounts] = await Promise.all([
      query(
        `select id, slug, name, organization_type as "organizationType", status,
                default_currency as "defaultCurrency", metadata, created_at as "createdAt"
         from organizations where id = $1`,
        [organizationId],
      ),
      query(
        `select id, slug, name, status, metadata, created_at as "createdAt"
         from business_units where organization_id = $1 order by lower(name)`,
        [organizationId],
      ),
      query(
        `select p.id, p.slug, p.name, p.business_unit_id as "businessUnitId"
         from projects p join business_units bu on bu.id = p.business_unit_id
         where bu.organization_id = $1 order by lower(p.name)`,
        [organizationId],
      ),
      query(
        `select om.id, om.user_id as "userId", u.email, u.display_name as "displayName",
                om.membership_type as "membershipType", om.status, om.expires_at as "expiresAt",
                om.created_at as "createdAt"
         from organization_memberships om join users u on u.id = om.user_id
         where om.organization_id = $1 order by lower(coalesce(u.display_name, u.email))`,
        [organizationId],
      ),
      query(
        `select t.id, t.slug, t.name, coalesce(json_agg(tm.organization_membership_id)
                filter (where tm.organization_membership_id is not null), '[]') as "membershipIds"
         from teams t left join team_memberships tm on tm.team_id = t.id
         where t.organization_id = $1 group by t.id order by lower(t.name)`,
        [organizationId],
      ),
      query(
        `select r.id, r.key, r.name, r.description, r.system_role as "systemRole"
         from roles r where r.organization_id is null or r.organization_id = $1
         order by r.system_role desc, lower(r.name)`,
        [organizationId],
      ),
      query(
        `select ra.id, ra.principal_type as "principalType", ra.principal_id as "principalId",
                r.key as "roleKey", r.name as "roleName", ra.scope_type as "scopeType",
                ra.scope_id as "scopeId", ra.inherit_to_children as "inheritToChildren",
                ra.conditions, ra.expires_at as "expiresAt", ra.created_at as "createdAt"
         from role_assignments ra join roles r on r.id = ra.role_id
         where ra.revoked_at is null and (
           (ra.scope_type = 'organization' and ra.scope_id = $1)
           or (ra.scope_type = 'business_unit' and ra.scope_id in
             (select id from business_units where organization_id = $1))
           or (ra.scope_type = 'project' and ra.scope_id in
             (select p.id from projects p join business_units bu on bu.id = p.business_unit_id
              where bu.organization_id = $1))
         ) order by ra.created_at desc`,
        [organizationId],
      ),
      query(
        `select id, name, status, owner_user_id as "ownerUserId",
                metadata, created_at as "createdAt"
         from service_accounts where organization_id = $1
         order by lower(name)`,
        [organizationId],
      ),
    ]);
    res.json({
      organization: organization.rows[0],
      permissions: req.organizationPermissions,
      businessUnits: businessUnits.rows,
      projects: projects.rows,
      members: members.rows,
      teams: teams.rows,
      roles: roles.rows,
      assignments: assignments.rows,
      serviceAccounts: serviceAccounts.rows,
    });
  }),
);

router.patch(
  "/organizations/:organizationId",
  requireOrganizationPermission("organization.update"),
  route(async (req, res) => {
    const name = clean(req.body.name);
    if (!name) throw httpError(400, "Organization name is required");
    const organization = await withTransaction(async (client) => {
      const before = await client.query("select name, default_currency as \"defaultCurrency\" from organizations where id = $1", [req.authorizedOrganizationId]);
      const updated = await client.query(
        `update organizations set name = $2, default_currency = $3, updated_at = now()
         where id = $1 returning id, slug, name, default_currency as "defaultCurrency"`,
        [req.authorizedOrganizationId, name, clean(req.body.defaultCurrency || "USD").toUpperCase()],
      );
      await audit(client, req, "organization.updated", "organization", req.authorizedOrganizationId, before.rows[0], updated.rows[0]);
      return updated.rows[0];
    });
    res.json({ organization });
  }),
);

router.get(
  "/organizations/:organizationId/billing-access",
  requireOrganizationPermission("billing.view"),
  route(async (req, res) => {
    res.json(await organizationBillingAccess(req.authorizedOrganizationId));
  }),
);

router.get(
  "/organizations/:organizationId/usage",
  requireOrganizationPermission("usage.view"),
  route(async (req, res) => {
    const businessUnitId = clean(req.query.businessUnitId) || null;
    const projectId = clean(req.query.projectId) || null;
    if (businessUnitId && !isUuid(businessUnitId)) {
      throw httpError(400, "businessUnitId is invalid");
    }
    if (projectId && !isUuid(projectId)) {
      throw httpError(400, "projectId is invalid");
    }
    res.json(await organizationUsageSummary(req.authorizedOrganizationId, {
      from: req.query.from,
      to: req.query.to,
      businessUnitId,
      projectId,
    }));
  }),
);

router.get(
  "/organizations/:organizationId/budgets",
  requireOrganizationPermission("usage.view"),
  route(async (req, res) => {
    const [budgets, metrics, alerts] = await Promise.all([
      organizationBudgetStatus(req.authorizedOrganizationId),
      query(
        `select key, name, unit, description
         from usage_metric_definitions order by unit, name`,
      ),
      query(
        `select alert.id, alert.budget_id as "budgetId", alert.threshold,
                alert.period_start as "periodStart",
                alert.observed_quantity::text as "observedQuantity",
                alert.acknowledged_at as "acknowledgedAt",
                alert.created_at as "createdAt",
                budget.metric_key as "metricKey",
                budget.scope_type as "scopeType",
                budget.business_unit_id as "businessUnitId",
                budget.project_id as "projectId"
         from usage_budget_alerts alert
         join usage_budgets budget on budget.id = alert.budget_id
         where budget.organization_id = $1
         order by alert.created_at desc
         limit 100`,
        [req.authorizedOrganizationId],
      ),
    ]);
    res.json({ budgets, metrics: metrics.rows, alerts: alerts.rows });
  }),
);

router.post(
  "/organizations/:organizationId/budgets",
  requireOrganizationPermission("budgets.manage"),
  route(async (req, res) => {
    const scopeType = clean(req.body.scopeType);
    const scopeId = clean(req.body.scopeId) || null;
    const metricKey = clean(req.body.metricKey);
    const limitQuantity = clean(req.body.limitQuantity);
    const warningPercent = Number(req.body.warningPercent ?? 80);
    const enforcement = clean(req.body.enforcement || "warn");
    const period = clean(req.body.period || "subscription");
    const reason = clean(req.body.reason);
    const expiresAt = optionalTimestamp(req.body.expiresAt, "expiresAt");
    if (!["organization", "business_unit", "project"].includes(scopeType)) {
      throw httpError(400, "scopeType is invalid");
    }
    if (scopeType !== "organization" && (!scopeId || !isUuid(scopeId))) {
      throw httpError(400, "A valid scopeId is required");
    }
    if (!/^[1-9][0-9]*$/.test(limitQuantity)) {
      throw httpError(400, "limitQuantity must be a positive integer");
    }
    if (BigInt(limitQuantity) > 9_223_372_036_854_775_807n) {
      throw httpError(400, "limitQuantity exceeds the supported maximum");
    }
    if (!Number.isInteger(warningPercent) || warningPercent < 1 || warningPercent > 100) {
      throw httpError(400, "warningPercent must be an integer from 1 to 100");
    }
    if (!["observe", "warn", "block"].includes(enforcement)) {
      throw httpError(400, "enforcement is invalid");
    }
    if (!["subscription", "calendar_month"].includes(period)) {
      throw httpError(400, "period is invalid");
    }
    if (!reason) throw httpError(400, "A reason is required");

    const budget = await withTransaction(async (client) => {
      const metric = await client.query(
        "select key from usage_metric_definitions where key = $1",
        [metricKey],
      );
      if (!metric.rows[0]) throw httpError(400, "metricKey is invalid");
      let businessUnitId = null;
      let projectId = null;
      if (scopeType === "business_unit") {
        const belongs = await scopeBelongsToOrganization(
          client,
          req.authorizedOrganizationId,
          "business_unit",
          scopeId,
        );
        if (!belongs) throw httpError(404, "Business unit not found");
        businessUnitId = scopeId;
      } else if (scopeType === "project") {
        const project = await client.query(
          `select project.id, project.business_unit_id as "businessUnitId"
           from projects project
           join business_units unit on unit.id = project.business_unit_id
           where project.id = $1 and unit.organization_id = $2`,
          [scopeId, req.authorizedOrganizationId],
        );
        if (!project.rows[0]) throw httpError(404, "Project not found");
        businessUnitId = project.rows[0].businessUnitId;
        projectId = project.rows[0].id;
      }
      const previous = await client.query(
        `select * from usage_budgets
         where organization_id = $1 and scope_type = $2
           and business_unit_id is not distinct from $3
           and project_id is not distinct from $4
           and metric_key = $5 and superseded_at is null
         for update`,
        [
          req.authorizedOrganizationId,
          scopeType,
          businessUnitId,
          projectId,
          metricKey,
        ],
      );
      if (previous.rows[0]) {
        await client.query(
          "update usage_budgets set superseded_at = now() where id = $1",
          [previous.rows[0].id],
        );
      }
      const inserted = await client.query(
        `insert into usage_budgets(
           organization_id, scope_type, business_unit_id, project_id, metric_key,
           limit_quantity, warning_percent, enforcement, period, reason,
           starts_at, expires_at, created_by_user_id
         ) values(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           case $9
             when 'calendar_month' then date_trunc('month', now())
             else coalesce(
               (
                 select subscription.current_period_start
                 from billing_accounts account
                 join lateral (
                   select current_subscription.current_period_start
                   from subscriptions current_subscription
                   where current_subscription.billing_account_id = account.id
                   order by
                     (current_subscription.state <> 'canceled') desc,
                     current_subscription.created_at desc
                   limit 1
                 ) subscription on true
                 where account.organization_id = $1
               ),
               date_trunc('month', now())
             )
           end,
           $11, $12
         )
         returning id, scope_type as "scopeType", business_unit_id as "businessUnitId",
                   project_id as "projectId", metric_key as "metricKey",
                   limit_quantity::text as "limitQuantity", warning_percent as "warningPercent",
                   enforcement, period, reason, starts_at as "startsAt",
                   expires_at as "expiresAt"`,
        [
          req.authorizedOrganizationId,
          scopeType,
          businessUnitId,
          projectId,
          metricKey,
          limitQuantity,
          warningPercent,
          enforcement,
          period,
          reason,
          expiresAt,
          req.auth?.user?.id || null,
        ],
      );
      await audit(
        client,
        req,
        previous.rows[0] ? "usage_budget.replaced" : "usage_budget.created",
        "usage_budget",
        inserted.rows[0].id,
        previous.rows[0] || null,
        inserted.rows[0],
      );
      return inserted.rows[0];
    });
    res.status(201).json({ budget });
  }),
);

router.delete(
  "/organizations/:organizationId/budgets/:budgetId",
  requireOrganizationPermission("budgets.manage"),
  route(async (req, res) => {
    await withTransaction(async (client) => {
      const before = await client.query(
        `select * from usage_budgets
         where id = $1 and organization_id = $2 and superseded_at is null
         for update`,
        [req.params.budgetId, req.authorizedOrganizationId],
      );
      if (!before.rows[0]) throw httpError(404, "Budget not found");
      const removed = await client.query(
        `update usage_budgets set superseded_at = now()
         where id = $1 returning *`,
        [req.params.budgetId],
      );
      await audit(
        client,
        req,
        "usage_budget.removed",
        "usage_budget",
        req.params.budgetId,
        before.rows[0],
        removed.rows[0],
      );
    });
    res.json({ ok: true });
  }),
);

router.post(
  "/organizations/:organizationId/budget-alerts/:alertId/acknowledge",
  requireOrganizationPermission("budgets.manage"),
  route(async (req, res) => {
    const acknowledged = await withTransaction(async (client) => {
      const before = await client.query(
        `select alert.id, alert.threshold,
                alert.acknowledged_at as "acknowledgedAt"
         from usage_budget_alerts alert
         join usage_budgets budget on budget.id = alert.budget_id
         where alert.id = $1 and budget.organization_id = $2
         for update of alert`,
        [req.params.alertId, req.authorizedOrganizationId],
      );
      if (!before.rows[0]) throw httpError(404, "Budget alert not found");
      if (before.rows[0].acknowledgedAt) return before.rows[0];
      const result = await client.query(
        `update usage_budget_alerts
         set acknowledged_at = now(), acknowledged_by_user_id = $2
         where id = $1
         returning id, threshold, acknowledged_at as "acknowledgedAt"`,
        [req.params.alertId, req.auth?.user?.id || null],
      );
      await audit(
        client,
        req,
        "usage_budget_alert.acknowledged",
        "usage_budget_alert",
        req.params.alertId,
        before.rows[0],
        result.rows[0],
      );
      return result.rows[0];
    });
    res.json({ alert: acknowledged });
  }),
);

router.post(
  "/organizations/:organizationId/billing/checkout",
  requireOrganizationPermission("billing.manage"),
  route(createStripeCheckoutSession),
);

router.post(
  "/organizations/:organizationId/billing/portal",
  requireOrganizationPermission("billing.manage"),
  route(createStripePortalSession),
);

router.post(
  "/organizations/:organizationId/business-units",
  requireOrganizationPermission("business_units.create"),
  route(async (req, res) => {
    const name = clean(req.body.name);
    const unitSlug = slug(req.body.slug || name);
    if (!name || !unitSlug) throw httpError(400, "Business-unit name is required");
    const businessUnit = await withTransaction(async (client) => {
      const result = await client.query(
        `insert into business_units(organization_id, slug, name)
         values($1, $2, $3) returning id, slug, name, status`,
        [req.authorizedOrganizationId, unitSlug, name],
      );
      await audit(client, req, "business_unit.created", "business_unit", result.rows[0].id, null, result.rows[0]);
      return result.rows[0];
    });
    res.status(201).json({ businessUnit });
  }),
);

router.patch(
  "/organizations/:organizationId/business-units/:businessUnitId",
  requireOrganizationPermission("business_units.manage"),
  route(async (req, res) => {
    const name = clean(req.body.name);
    const status = clean(req.body.status);
    if (!name || !["active", "archived"].includes(status)) throw httpError(400, "Valid name and status are required");
    const businessUnit = await withTransaction(async (client) => {
      const before = await client.query("select id, name, status from business_units where id = $1 and organization_id = $2", [req.params.businessUnitId, req.authorizedOrganizationId]);
      if (!before.rows[0]) throw httpError(404, "Business unit not found");
      const updated = await client.query(
        `update business_units set name = $3, status = $4, updated_at = now()
         where id = $1 and organization_id = $2 returning id, slug, name, status`,
        [req.params.businessUnitId, req.authorizedOrganizationId, name, status],
      );
      await audit(client, req, "business_unit.updated", "business_unit", req.params.businessUnitId, before.rows[0], updated.rows[0]);
      return updated.rows[0];
    });
    res.json({ businessUnit });
  }),
);

router.post(
  "/organizations/:organizationId/invitations",
  requireOrganizationPermission("members.invite"),
  route(async (req, res) => {
    const email = clean(req.body.email).toLowerCase();
    const membershipType = clean(req.body.membershipType || "internal");
    if (!email.includes("@") || !allowedMembershipTypes.has(membershipType)) throw httpError(400, "Valid email and membership type are required");
    const token = crypto.randomBytes(32).toString("base64url");
    const digest = crypto.createHash("sha256").update(token).digest("hex");
    const membershipExpiresAt = optionalTimestamp(req.body.expiresAt);
    const invitationResult = await withTransaction(async (client) => {
      const userResult = await client.query(
        `insert into users(email, display_name, status) values($1, $2, 'invited')
         on conflict((lower(email))) do update set updated_at = now()
         returning id, email, display_name as "displayName"`,
        [email, clean(req.body.displayName) || null],
      );
      const user = userResult.rows[0];
      const membership = await client.query(
        `insert into organization_memberships(
           organization_id, user_id, membership_type, status, invited_by_user_id, expires_at
         ) values($1, $2, $3, 'invited', $4, $5)
         on conflict(organization_id, user_id) do update set
           membership_type = excluded.membership_type, status = 'invited',
           invited_by_user_id = excluded.invited_by_user_id, expires_at = excluded.expires_at,
           updated_at = now()
         returning id, user_id as "userId", membership_type as "membershipType", status, expires_at as "expiresAt"`,
        [req.authorizedOrganizationId, user.id, membershipType, req.auth?.user?.id || null, membershipExpiresAt],
      );
      const invitation = await client.query(
        `insert into invitations(organization_id, email, token_digest, membership_type, invited_by_user_id, expires_at)
         values($1, $2, $3, $4, $5, now() + interval '7 days')
         returning id, email, membership_type as "membershipType", expires_at as "expiresAt"`,
        [req.authorizedOrganizationId, email, digest, membershipType, req.auth?.user?.id || null],
      );
      await audit(client, req, "member.invited", "organization_membership", membership.rows[0].id, null, { ...membership.rows[0], email });
      return {
        invitation: invitation.rows[0],
        membership: membership.rows[0],
      };
    });
    res.status(201).json({ ...invitationResult, onboardingToken: token });
  }),
);

router.patch(
  "/organizations/:organizationId/members/:membershipId",
  requireOrganizationPermission("members.manage"),
  route(async (req, res) => {
    const status = clean(req.body.status);
    const membershipType = clean(req.body.membershipType);
    const expiresAt = optionalTimestamp(req.body.expiresAt);
    if (!allowedMembershipStatuses.has(status) || !allowedMembershipTypes.has(membershipType)) {
      throw httpError(400, "Valid membership status and type are required");
    }
    const membership = await withTransaction(async (client) => {
      const before = await client.query("select * from organization_memberships where id = $1 and organization_id = $2", [req.params.membershipId, req.authorizedOrganizationId]);
      if (!before.rows[0]) throw httpError(404, "Member not found");
      if (before.rows[0].user_id === req.auth?.user?.id && status !== "active") {
        throw httpError(409, "You cannot suspend or remove your own membership");
      }
      const updated = await client.query(
        `update organization_memberships set membership_type = $3, status = $4,
           expires_at = $5, activated_at = case when $4 = 'active' then coalesce(activated_at, now()) else activated_at end,
           updated_at = now()
         where id = $1 and organization_id = $2
         returning id, user_id as "userId", membership_type as "membershipType", status, expires_at as "expiresAt"`,
        [req.params.membershipId, req.authorizedOrganizationId, membershipType, status, expiresAt],
      );
      await audit(client, req, `member.${status}`, "organization_membership", req.params.membershipId, before.rows[0], updated.rows[0]);
      return updated.rows[0];
    });
    res.json({ membership });
  }),
);

router.post(
  "/organizations/:organizationId/teams",
  requireOrganizationPermission("teams.manage"),
  route(async (req, res) => {
    const name = clean(req.body.name);
    const teamSlug = slug(req.body.slug || name);
    if (!name || !teamSlug) throw httpError(400, "Team name is required");
    const team = await withTransaction(async (client) => {
      const result = await client.query(
        `insert into teams(organization_id, slug, name) values($1, $2, $3)
         returning id, slug, name`,
        [req.authorizedOrganizationId, teamSlug, name],
      );
      await audit(client, req, "team.created", "team", result.rows[0].id, null, result.rows[0]);
      return result.rows[0];
    });
    res.status(201).json({ team });
  }),
);

router.put(
  "/organizations/:organizationId/teams/:teamId/members",
  requireOrganizationPermission("teams.manage"),
  route(async (req, res) => {
    const membershipIds = [...new Set(Array.isArray(req.body.membershipIds) ? req.body.membershipIds.map(clean).filter(Boolean) : [])];
    await withTransaction(async (client) => {
      const team = await client.query("select id from teams where id = $1 and organization_id = $2", [req.params.teamId, req.authorizedOrganizationId]);
      if (!team.rows[0]) throw httpError(404, "Team not found");
      if (membershipIds.length) {
        const valid = await client.query(
          "select id from organization_memberships where organization_id = $1 and id = any($2::uuid[]) and status <> 'removed'",
          [req.authorizedOrganizationId, membershipIds],
        );
        if (valid.rowCount !== membershipIds.length) throw httpError(400, "Every team member must belong to this organization");
      }
      const before = await client.query("select organization_membership_id from team_memberships where team_id = $1", [req.params.teamId]);
      await client.query("delete from team_memberships where team_id = $1", [req.params.teamId]);
      if (membershipIds.length) {
        await client.query(
          `insert into team_memberships(team_id, organization_membership_id)
           select $1, unnest($2::uuid[])`,
          [req.params.teamId, membershipIds],
        );
      }
      await audit(client, req, "team.members_updated", "team", req.params.teamId, { membershipIds: before.rows.map((row) => row.organization_membership_id) }, { membershipIds });
    });
    res.json({ membershipIds });
  }),
);

router.post(
  "/organizations/:organizationId/role-assignments",
  requireOrganizationPermission("roles.assign"),
  route(async (req, res) => {
    const principalType = clean(req.body.principalType);
    const principalId = clean(req.body.principalId);
    const roleId = clean(req.body.roleId);
    const scopeType = clean(req.body.scopeType);
    const scopeId = clean(req.body.scopeId);
    if (!["user", "team", "service_account"].includes(principalType) || !principalId || !roleId || !allowedScopeTypes.has(scopeType) || !scopeId) {
      throw httpError(400, "Principal, role, and supported scope are required");
    }
    if (![principalId, roleId, scopeId].every(isUuid)) {
      throw httpError(400, "Principal, role, and scope IDs must be valid UUIDs");
    }
    const expiresAt = optionalTimestamp(req.body.expiresAt);
    const locales = [...new Set(
      (Array.isArray(req.body.conditions?.locales) ? req.body.conditions.locales : [])
        .map(clean)
        .filter(Boolean),
    )].sort();
    if (locales.length > 50 || locales.some((locale) => !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale))) {
      throw httpError(400, "Locale conditions must contain at most 50 valid locale tags");
    }
    const conditions = locales.length ? { locales } : {};
    const assignment = await withTransaction(async (client) => {
      const principal = principalType === "user"
        ? await client.query("select 1 from organization_memberships where organization_id = $1 and user_id = $2 and status <> 'removed'", [req.authorizedOrganizationId, principalId])
        : principalType === "team"
          ? await client.query("select 1 from teams where organization_id = $1 and id = $2", [req.authorizedOrganizationId, principalId])
          : await client.query("select 1 from service_accounts where organization_id = $1 and id = $2 and status <> 'revoked'", [req.authorizedOrganizationId, principalId]);
      if (!principal.rows[0]) throw httpError(400, "Principal does not belong to this organization");
      const role = await client.query("select id, key from roles where id = $1 and (organization_id is null or organization_id = $2)", [roleId, req.authorizedOrganizationId]);
      if (!role.rows[0]) throw httpError(400, "Role is not available to this organization");
      if (role.rows[0].key.startsWith("platform_")) throw httpError(403, "Platform roles cannot be granted through tenant role assignments");
      if (principalType === "service_account") {
        const permissions = await client.query(
          `select p.key from role_permissions rp join permissions p on p.id = rp.permission_id where rp.role_id = $1`, [roleId],
        );
        if (permissions.rows.some(({ key }) => HUMAN_DECISION_PERMISSIONS.has(key))) {
          throw httpError(403, "Service accounts cannot receive human decision or access-administration roles");
        }
      }
      if (!await scopeBelongsToOrganization(client, req.authorizedOrganizationId, scopeType, scopeId)) {
        throw httpError(400, "Scope does not belong to this organization");
      }
      const existingGrant = await client.query(
        `select id from role_assignments
         where principal_type = $1 and principal_id = $2 and role_id = $3
           and scope_type = $4 and scope_id = $5
           and inherit_to_children = $6
           and canonical_role_assignment_conditions(conditions)
             = canonical_role_assignment_conditions($7::jsonb)
           and revoked_at is null`,
        [
          principalType,
          principalId,
          roleId,
          scopeType,
          scopeId,
          req.body.inheritToChildren === true,
          JSON.stringify(conditions),
        ],
      );
      if (existingGrant.rows[0]) {
        throw httpError(409, "This exact role assignment already exists at the selected scope");
      }
      const result = await client.query(
        `insert into role_assignments(
           principal_type, principal_id, role_id, scope_type, scope_id,
           inherit_to_children, conditions, granted_by_user_id, expires_at
         ) values($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning id, principal_type as "principalType", principal_id as "principalId",
                   scope_type as "scopeType", scope_id as "scopeId",
                   inherit_to_children as "inheritToChildren", expires_at as "expiresAt"`,
        [
          principalType, principalId, roleId, scopeType, scopeId,
          req.body.inheritToChildren === true,
          JSON.stringify(conditions),
          req.auth?.user?.id || null,
          expiresAt,
        ],
      );
      await audit(client, req, "role_assignment.created", "role_assignment", result.rows[0].id, null, result.rows[0]);
      return result.rows[0];
    });
    res.status(201).json({ assignment });
  }),
);

router.delete(
  "/organizations/:organizationId/role-assignments/:assignmentId",
  requireOrganizationPermission("roles.assign"),
  route(async (req, res) => {
    await withTransaction(async (client) => {
      const before = await client.query(
        `select ra.* from role_assignments ra where ra.id = $1 and ra.revoked_at is null and (
           (ra.scope_type = 'organization' and ra.scope_id = $2)
           or (ra.scope_type = 'business_unit' and ra.scope_id in (select id from business_units where organization_id = $2))
           or (ra.scope_type = 'project' and ra.scope_id in
             (select p.id from projects p join business_units bu on bu.id = p.business_unit_id where bu.organization_id = $2))
         )`,
        [req.params.assignmentId, req.authorizedOrganizationId],
      );
      if (!before.rows[0]) throw httpError(404, "Role assignment not found");
      await client.query("update role_assignments set revoked_at = now() where id = $1", [req.params.assignmentId]);
      await audit(client, req, "role_assignment.revoked", "role_assignment", req.params.assignmentId, before.rows[0], { revoked: true });
    });
    res.status(204).end();
  }),
);

router.get(
  "/organizations/:organizationId/audit",
  requireOrganizationPermission("audit.view"),
  route(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 250);
    const result = await query(
      `select ae.id, ae.actor_type as "actorType", ae.action,
              ae.resource_type as "resourceType", ae.resource_id as "resourceId",
              ae.before_state as "beforeState", ae.after_state as "afterState",
              ae.created_at as "createdAt", users.email as "actorEmail",
              coalesce(users.display_name, service_account.name) as "actorName"
       from audit_events ae
       left join users on ae.actor_type = 'user' and users.id = ae.actor_id
       left join service_accounts service_account
         on ae.actor_type = 'service_account' and service_account.id = ae.actor_id
       where ae.organization_id = $1 order by ae.created_at desc limit $2`,
      [req.authorizedOrganizationId, limit],
    );
    res.json({ events: result.rows });
  }),
);

export default router;
