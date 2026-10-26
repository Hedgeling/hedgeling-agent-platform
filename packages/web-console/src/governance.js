import express from "express";
import { query, withTransaction } from "./db.js";
import { auditRequest } from "./audit.js";
import {
  organizationIdentityAllows,
  organizationPermissions,
  requireOrganizationPermission,
} from "./authorization.js";
import { requirePlatformAdmin } from "./auth.js";
import { isUuid, optionalTimestamp } from "./validation.js";

export const governanceRouter = express.Router();
export const platformGovernanceRouter = express.Router();
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
const scopeTypes = new Set(["organization", "business_unit", "project"]);
const supportDeniedPermissions = new Set([
  "billing.manage",
  "payment_records.manage",
  "payout_accounts.view",
  "payout_accounts.manage",
  "facilitated_payments.view",
  "facilitated_payments.initiate",
  "facilitated_payments.refund",
  "facilitated_transfers.release",
  "payables.approve",
  "roles.assign",
  "identity.manage",
  "provisioning.manage",
  "security.manage",
  "support_access.manage",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function httpError(status, message, code = null) {
  const error = Object.assign(new Error(message), { status });
  if (code) error.code = code;
  return error;
}

function requireHuman(req) {
  if (!req.auth?.user?.id) throw httpError(403, "This governance action requires a human user");
  return req.auth.user.id;
}

async function scopeBelongs(client, organizationId, scopeType, scopeId) {
  if (scopeType === "organization") return scopeId === organizationId;
  if (scopeType === "business_unit") {
    const result = await client.query(
      "select 1 from business_units where id = $1 and organization_id = $2",
      [scopeId, organizationId],
    );
    return Boolean(result.rows[0]);
  }
  const result = await client.query(
    `select 1 from projects project
     join business_units business_unit on business_unit.id = project.business_unit_id
     where project.id = $1 and business_unit.organization_id = $2`,
    [scopeId, organizationId],
  );
  return Boolean(result.rows[0]);
}

function conditions(value) {
  const locales = [...new Set(
    (Array.isArray(value?.locales) ? value.locales : [])
      .map(clean)
      .filter(Boolean),
  )].sort();
  if (locales.length > 50 || locales.some((locale) => !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale))) {
    throw httpError(400, "Locale conditions must contain at most 50 valid locale tags");
  }
  return locales.length ? { locales } : {};
}

for (const parameter of [
  "organizationId",
  "accessRequestId",
  "campaignId",
  "reviewItemId",
  "supportGrantId",
]) {
  governanceRouter.param(parameter, (req, res, next, value) => (
    isUuid(value) ? next() : res.status(400).json({ error: `${parameter} is invalid` })
  ));
  platformGovernanceRouter.param(parameter, (req, res, next, value) => (
    isUuid(value) ? next() : res.status(400).json({ error: `${parameter} is invalid` })
  ));
}

governanceRouter.post("/organizations/:organizationId/access-requests", route(async (req, res) => {
  const userId = requireHuman(req);
  const organizationId = req.params.organizationId;
  if (!isUuid(organizationId)) throw httpError(400, "Organization ID is invalid");
  if (!await organizationIdentityAllows(req.auth, organizationId)) {
    throw httpError(403, "Organization sign-in policy is not satisfied");
  }
  const roleId = clean(req.body.roleId);
  const scopeType = clean(req.body.scopeType);
  const scopeId = clean(req.body.scopeId);
  const reason = clean(req.body.reason);
  if (!isUuid(roleId) || !scopeTypes.has(scopeType) || !isUuid(scopeId) || !reason) {
    throw httpError(400, "Role, scope, and reason are required");
  }
  if (reason.length > 2000) throw httpError(400, "Access request reason cannot exceed 2000 characters");
  const requestedExpiresAt = optionalTimestamp(req.body.expiresAt);
  const requestConditions = conditions(req.body.conditions);
  const accessRequest = await withTransaction(async (client) => {
    const membership = await client.query(
      `select 1 from organization_memberships
       where organization_id = $1 and user_id = $2 and status = 'active'
         and (expires_at is null or expires_at > now())`,
      [organizationId, userId],
    );
    if (!membership.rows[0]) throw httpError(403, "An active organization membership is required");
    const role = await client.query(
      "select 1 from roles where id = $1 and (organization_id is null or organization_id = $2)",
      [roleId, organizationId],
    );
    if (!role.rows[0]) throw httpError(400, "Role is not available to this organization");
    if (!await scopeBelongs(client, organizationId, scopeType, scopeId)) {
      throw httpError(400, "Scope does not belong to this organization");
    }
    const result = await client.query(
      `insert into access_requests(
         organization_id, requested_by_user_id, role_id, scope_type, scope_id,
         inherit_to_children, conditions, requested_expires_at, reason
       ) values($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id, role_id as "roleId", scope_type as "scopeType",
                 scope_id as "scopeId", inherit_to_children as "inheritToChildren",
                 conditions, requested_expires_at as "requestedExpiresAt",
                 reason, status, created_at as "createdAt"`,
      [
        organizationId,
        userId,
        roleId,
        scopeType,
        scopeId,
        req.body.inheritToChildren === true,
        JSON.stringify(requestConditions),
        requestedExpiresAt,
        reason,
      ],
    );
    await auditRequest(client, req, {
      organizationId,
      action: "access_request.created",
      resourceType: "access_request",
      resourceId: result.rows[0].id,
      afterState: result.rows[0],
    });
    return result.rows[0];
  });
  res.status(201).json({ accessRequest });
}));

governanceRouter.get("/organizations/:organizationId/access-requests", route(async (req, res) => {
  const userId = requireHuman(req);
  if (!await organizationIdentityAllows(req.auth, req.params.organizationId)) {
    throw httpError(403, "Organization sign-in policy is not satisfied");
  }
  const permissions = await organizationPermissions(req.auth, req.params.organizationId);
  const canApprove = permissions.includes("access_requests.approve");
  const result = await query(
    `select request.id, request.requested_by_user_id as "requestedByUserId",
            requester.email as "requesterEmail", role.id as "roleId",
            role.name as "roleName", request.scope_type as "scopeType",
            request.scope_id as "scopeId",
            request.inherit_to_children as "inheritToChildren",
            request.conditions, request.requested_expires_at as "requestedExpiresAt",
            request.reason, request.status,
            request.decided_by_user_id as "decidedByUserId",
            request.decision_reason as "decisionReason",
            request.decided_at as "decidedAt", request.created_at as "createdAt"
     from access_requests request
     join users requester on requester.id = request.requested_by_user_id
     join roles role on role.id = request.role_id
     where request.organization_id = $1
       and ($2::boolean or request.requested_by_user_id = $3)
     order by request.created_at desc limit 250`,
    [req.params.organizationId, canApprove, userId],
  );
  if (!canApprove) {
    const membership = await query(
      `select 1 from organization_memberships
       where organization_id = $1 and user_id = $2 and status = 'active'`,
      [req.params.organizationId, userId],
    );
    if (!membership.rows[0]) throw httpError(403, "Organization access is required");
  }
  res.json({ accessRequests: result.rows, canApprove });
}));

governanceRouter.post(
  "/organizations/:organizationId/access-requests/:accessRequestId/cancel",
  route(async (req, res) => {
    const userId = requireHuman(req);
    if (!await organizationIdentityAllows(req.auth, req.params.organizationId)) {
      throw httpError(403, "Organization sign-in policy is not satisfied");
    }
    req.authorizedOrganizationId = req.params.organizationId;
    const accessRequest = await withTransaction(async (client) => {
      const result = await client.query(
        `update access_requests
         set status = 'canceled', decided_at = now(), updated_at = now()
         where id = $1 and organization_id = $2
           and requested_by_user_id = $3 and status = 'pending'
         returning id, status, decided_at as "decidedAt"`,
        [req.params.accessRequestId, req.params.organizationId, userId],
      );
      if (!result.rows[0]) throw httpError(404, "Pending access request not found");
      await auditRequest(client, req, {
        organizationId: req.params.organizationId,
        action: "access_request.canceled",
        resourceType: "access_request",
        resourceId: req.params.accessRequestId,
        afterState: result.rows[0],
      });
      return result.rows[0];
    });
    res.json({ accessRequest });
  }),
);

governanceRouter.patch(
  "/organizations/:organizationId/access-requests/:accessRequestId",
  requireOrganizationPermission("access_requests.approve"),
  route(async (req, res) => {
    const decisionMaker = requireHuman(req);
    const decision = clean(req.body.decision);
    const decisionReason = clean(req.body.reason) || null;
    if (!["approved", "rejected"].includes(decision)) {
      throw httpError(400, "Decision must be approved or rejected");
    }
    const accessRequest = await withTransaction(async (client) => {
      const requestResult = await client.query(
        `select * from access_requests
         where id = $1 and organization_id = $2 for update`,
        [req.params.accessRequestId, req.authorizedOrganizationId],
      );
      const request = requestResult.rows[0];
      if (!request) throw httpError(404, "Access request not found");
      if (request.status !== "pending") throw httpError(409, "Access request has already been decided");
      if (request.requested_by_user_id === decisionMaker) {
        throw httpError(409, "Access requests cannot be self-approved");
      }
      if (
        decision === "approved"
        && request.requested_expires_at
        && new Date(request.requested_expires_at).getTime() <= Date.now()
      ) {
        throw httpError(409, "The requested access expiry has already passed");
      }
      let assignmentId = null;
      if (decision === "approved") {
        const assignment = await client.query(
          `insert into role_assignments(
             principal_type, principal_id, role_id, scope_type, scope_id,
             inherit_to_children, conditions, granted_by_user_id, expires_at
           ) values('user', $1, $2, $3, $4, $5, $6, $7, $8)
           returning id`,
          [
            request.requested_by_user_id,
            request.role_id,
            request.scope_type,
            request.scope_id,
            request.inherit_to_children,
            request.conditions,
            decisionMaker,
            request.requested_expires_at,
          ],
        );
        assignmentId = assignment.rows[0].id;
      }
      const updated = await client.query(
        `update access_requests
         set status = $3, decided_by_user_id = $4, decision_reason = $5,
             decided_at = now(), role_assignment_id = $6, updated_at = now()
         where id = $1 and organization_id = $2
         returning id, status, decided_by_user_id as "decidedByUserId",
                   decision_reason as "decisionReason",
                   role_assignment_id as "roleAssignmentId",
                   decided_at as "decidedAt"`,
        [
          req.params.accessRequestId,
          req.authorizedOrganizationId,
          decision,
          decisionMaker,
          decisionReason,
          assignmentId,
        ],
      );
      await auditRequest(client, req, {
        action: `access_request.${decision}`,
        resourceType: "access_request",
        resourceId: req.params.accessRequestId,
        beforeState: { status: request.status },
        afterState: updated.rows[0],
      });
      return updated.rows[0];
    });
    res.json({ accessRequest });
  }),
);

governanceRouter.post(
  "/organizations/:organizationId/access-reviews",
  requireOrganizationPermission("access_reviews.manage"),
  route(async (req, res) => {
    const creator = requireHuman(req);
    const name = clean(req.body.name);
    const reviewerUserId = clean(req.body.reviewerUserId || creator);
    if (!name || name.length > 200 || !isUuid(reviewerUserId)) {
      throw httpError(400, "Campaign name and reviewer are required");
    }
    const dueAt = optionalTimestamp(req.body.dueAt, "dueAt");
    const campaign = await withTransaction(async (client) => {
      const reviewer = await client.query(
        `select 1 from organization_memberships
         where organization_id = $1 and user_id = $2 and status = 'active'`,
        [req.authorizedOrganizationId, reviewerUserId],
      );
      if (!reviewer.rows[0]) throw httpError(400, "Reviewer must be an active organization member");
      const result = await client.query(
        `insert into access_review_campaigns(
           organization_id, name, due_at, created_by_user_id
         ) values($1, $2, $3, $4)
         returning id, name, status, due_at as "dueAt", created_at as "createdAt"`,
        [req.authorizedOrganizationId, name, dueAt, creator],
      );
      const assignments = await client.query(
        `insert into access_review_items(
           campaign_id, role_assignment_id, reviewer_user_id, assignment_snapshot
         )
         select $2, ra.id, $3, to_jsonb(ra)
         from role_assignments ra
         where ra.revoked_at is null
           and (ra.expires_at is null or ra.expires_at > now())
           and (
             (ra.scope_type = 'organization' and ra.scope_id = $1)
             or (
               ra.scope_type = 'business_unit'
               and ra.scope_id in (
                 select id from business_units where organization_id = $1
               )
             )
             or (
               ra.scope_type = 'project'
               and ra.scope_id in (
                 select project.id from projects project
                 join business_units business_unit
                   on business_unit.id = project.business_unit_id
                 where business_unit.organization_id = $1
               )
             )
           )
         returning id`,
        [req.authorizedOrganizationId, result.rows[0].id, reviewerUserId],
      );
      await auditRequest(client, req, {
        action: "access_review.created",
        resourceType: "access_review_campaign",
        resourceId: result.rows[0].id,
        afterState: { ...result.rows[0], itemCount: assignments.rowCount, reviewerUserId },
      });
      return { ...result.rows[0], itemCount: assignments.rowCount, reviewerUserId };
    });
    res.status(201).json({ campaign });
  }),
);

governanceRouter.get(
  "/organizations/:organizationId/access-reviews",
  requireOrganizationPermission("access_reviews.manage"),
  route(async (req, res) => {
    const result = await query(
      `select campaign.id, campaign.name, campaign.status,
              campaign.due_at as "dueAt", campaign.opened_at as "openedAt",
              campaign.completed_at as "completedAt",
              count(item.id)::int as "itemCount",
              count(item.id) filter (where item.decision = 'pending')::int as "pendingCount"
       from access_review_campaigns campaign
       left join access_review_items item on item.campaign_id = campaign.id
       where campaign.organization_id = $1
       group by campaign.id order by campaign.created_at desc`,
      [req.authorizedOrganizationId],
    );
    res.json({ campaigns: result.rows });
  }),
);

governanceRouter.patch(
  "/organizations/:organizationId/access-reviews/:campaignId",
  requireOrganizationPermission("access_reviews.manage"),
  route(async (req, res) => {
    requireHuman(req);
    const transition = clean(req.body.transition);
    if (!["open", "complete", "cancel"].includes(transition)) {
      throw httpError(400, "A valid campaign transition is required");
    }
    const campaign = await withTransaction(async (client) => {
      const before = await client.query(
        `select id, status from access_review_campaigns
         where id = $1 and organization_id = $2 for update`,
        [req.params.campaignId, req.authorizedOrganizationId],
      );
      if (!before.rows[0]) throw httpError(404, "Access review campaign not found");
      const transitionAllowed = transition === "open"
        ? before.rows[0].status === "draft"
        : transition === "complete"
          ? before.rows[0].status === "open"
          : ["draft", "open"].includes(before.rows[0].status);
      if (!transitionAllowed) throw httpError(409, "Campaign transition is not allowed");
      if (transition === "complete") {
        const pending = await client.query(
          `select count(*)::int as count from access_review_items
           where campaign_id = $1 and decision = 'pending'`,
          [req.params.campaignId],
        );
        if (pending.rows[0].count) throw httpError(409, "Every review item must be decided before completion");
      }
      const nextStatus = transition === "cancel" ? "canceled" : transition === "open" ? "open" : "completed";
      const result = await client.query(
        `update access_review_campaigns
         set status = $3,
             opened_at = case when $3 = 'open' then now() else opened_at end,
             completed_at = case when $3 = 'completed' then now() else completed_at end,
             updated_at = now()
         where id = $1 and organization_id = $2
         returning id, name, status, opened_at as "openedAt",
                   completed_at as "completedAt"`,
        [req.params.campaignId, req.authorizedOrganizationId, nextStatus],
      );
      await auditRequest(client, req, {
        action: `access_review.${nextStatus}`,
        resourceType: "access_review_campaign",
        resourceId: req.params.campaignId,
        beforeState: before.rows[0],
        afterState: result.rows[0],
      });
      return result.rows[0];
    });
    res.json({ campaign });
  }),
);

governanceRouter.get(
  "/organizations/:organizationId/access-reviews/:campaignId/items",
  route(async (req, res) => {
    const userId = requireHuman(req);
    if (!await organizationIdentityAllows(req.auth, req.params.organizationId)) {
      throw httpError(403, "Organization sign-in policy is not satisfied");
    }
    req.authorizedOrganizationId = req.params.organizationId;
    const permissions = await organizationPermissions(req.auth, req.params.organizationId);
    const canManage = permissions.includes("access_reviews.manage");
    if (!canManage) {
      const membership = await query(
        `select 1 from organization_memberships
         where organization_id = $1 and user_id = $2 and status = 'active'
           and (expires_at is null or expires_at > now())`,
        [req.params.organizationId, userId],
      );
      if (!membership.rows[0]) throw httpError(403, "An active reviewer membership is required");
    }
    const result = await query(
      `select item.id, item.role_assignment_id as "roleAssignmentId",
              item.reviewer_user_id as "reviewerUserId", reviewer.email as "reviewerEmail",
              item.decision, item.decision_reason as "decisionReason",
              item.decided_at as "decidedAt", item.assignment_snapshot as "assignmentSnapshot"
       from access_review_items item
       join access_review_campaigns campaign on campaign.id = item.campaign_id
       join users reviewer on reviewer.id = item.reviewer_user_id
       where item.campaign_id = $1 and campaign.organization_id = $2
         and ($3::boolean or item.reviewer_user_id = $4)
       order by item.created_at`,
      [req.params.campaignId, req.params.organizationId, canManage, userId],
    );
    res.json({ items: result.rows });
  }),
);

governanceRouter.patch(
  "/organizations/:organizationId/access-reviews/:campaignId/items/:reviewItemId",
  route(async (req, res) => {
    const reviewer = requireHuman(req);
    if (!await organizationIdentityAllows(req.auth, req.params.organizationId)) {
      throw httpError(403, "Organization sign-in policy is not satisfied");
    }
    const membership = await query(
      `select 1 from organization_memberships
       where organization_id = $1 and user_id = $2 and status = 'active'
         and (expires_at is null or expires_at > now())`,
      [req.params.organizationId, reviewer],
    );
    if (!membership.rows[0]) throw httpError(403, "An active reviewer membership is required");
    req.authorizedOrganizationId = req.params.organizationId;
    const decision = clean(req.body.decision);
    const reason = clean(req.body.reason) || null;
    if (!["retain", "revoke"].includes(decision)) {
      throw httpError(400, "Review decision must be retain or revoke");
    }
    const item = await withTransaction(async (client) => {
      const before = await client.query(
        `select item.*, campaign.status as campaign_status
         from access_review_items item
         join access_review_campaigns campaign on campaign.id = item.campaign_id
         where item.id = $1 and item.campaign_id = $2
           and campaign.organization_id = $3
         for update of item`,
        [req.params.reviewItemId, req.params.campaignId, req.params.organizationId],
      );
      const current = before.rows[0];
      if (!current) throw httpError(404, "Review item not found");
      if (current.campaign_status !== "open" || current.decision !== "pending") {
        throw httpError(409, "Review item is not pending in an open campaign");
      }
      if (current.reviewer_user_id !== reviewer) {
        throw httpError(403, "Only the assigned reviewer can decide this item");
      }
      if (decision === "revoke") {
        await client.query(
          `update role_assignments set revoked_at = coalesce(revoked_at, now())
           where id = $1`,
          [current.role_assignment_id],
        );
      }
      const result = await client.query(
        `update access_review_items
         set decision = $2, decision_reason = $3, decided_at = now()
         where id = $1
         returning id, decision, decision_reason as "decisionReason",
                   decided_at as "decidedAt"`,
        [req.params.reviewItemId, decision, reason],
      );
      await auditRequest(client, req, {
        action: `access_review.assignment_${decision === "retain" ? "retained" : "revoked"}`,
        resourceType: "access_review_item",
        resourceId: req.params.reviewItemId,
        beforeState: { decision: current.decision },
        afterState: result.rows[0],
        metadata: { roleAssignmentId: current.role_assignment_id },
      });
      return result.rows[0];
    });
    res.json({ item });
  }),
);

governanceRouter.get(
  "/organizations/:organizationId/governance-report",
  requireOrganizationPermission("access_reviews.manage"),
  route(async (req, res) => {
    const staleDays = Math.min(Math.max(Number(req.query.staleDays) || 90, 1), 3650);
    const [members, assignments, serviceAccounts] = await Promise.all([
      query(
        `select membership.id as "membershipId", users.id as "userId", users.email,
                membership.status,
                max(identity.last_authenticated_at) as "lastAuthenticatedAt",
                max(identity.last_authenticated_at) is null
                  or max(identity.last_authenticated_at) < now() - ($2::int * interval '1 day')
                  as stale
         from organization_memberships membership
         join users on users.id = membership.user_id
         left join user_identities identity on identity.user_id = users.id
         where membership.organization_id = $1 and membership.status <> 'removed'
         group by membership.id, users.id order by lower(users.email)`,
        [req.authorizedOrganizationId, staleDays],
      ),
      query(
        `select assignment.id, assignment.principal_type as "principalType",
                assignment.principal_id as "principalId", role.name as "roleName",
                assignment.scope_type as "scopeType", assignment.scope_id as "scopeId",
                assignment.expires_at as "expiresAt",
                assignment.expires_at is not null
                  and assignment.expires_at < now() + interval '30 days' as "expiresSoon"
         from role_assignments assignment
         join roles role on role.id = assignment.role_id
         where assignment.revoked_at is null and (
           (assignment.scope_type = 'organization' and assignment.scope_id = $1)
           or (
             assignment.scope_type = 'business_unit'
             and assignment.scope_id in (
               select id from business_units where organization_id = $1
             )
           )
           or (
             assignment.scope_type = 'project'
             and assignment.scope_id in (
               select project.id from projects project
               join business_units business_unit
                 on business_unit.id = project.business_unit_id
               where business_unit.organization_id = $1
             )
           )
         ) order by assignment.created_at`,
        [req.authorizedOrganizationId],
      ),
      query(
        `select account.id, account.name, account.status,
                max(credential.last_used_at) as "lastUsedAt",
                count(credential.id) filter (
                  where credential.status = 'active'
                    and (credential.expires_at is null or credential.expires_at > now())
                )::int as "activeCredentialCount"
         from service_accounts account
         left join service_account_credentials credential
           on credential.service_account_id = account.id
         where account.organization_id = $1
         group by account.id order by lower(account.name)`,
        [req.authorizedOrganizationId],
      ),
    ]);
    res.json({
      generatedAt: new Date().toISOString(),
      staleDays,
      members: members.rows,
      assignments: assignments.rows,
      serviceAccounts: serviceAccounts.rows,
    });
  }),
);

governanceRouter.get(
  "/organizations/:organizationId/audit-export",
  requireOrganizationPermission("audit.export"),
  route(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 1000, 1), 10_000);
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;
    if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime()))) {
      throw httpError(400, "Audit export dates must be valid ISO timestamps");
    }
    const result = await query(
      `select id, actor_type as "actorType", actor_id as "actorId",
              effective_user_id as "effectiveUserId", action,
              resource_type as "resourceType", resource_id as "resourceId",
              request_id as "requestId", ip_address::text as "ipAddress",
              before_state as "beforeState", after_state as "afterState",
              metadata, created_at as "createdAt"
       from audit_events
       where organization_id = $1
         and ($2::timestamptz is null or created_at >= $2)
         and ($3::timestamptz is null or created_at < $3)
       order by created_at desc limit $4`,
      [
        req.authorizedOrganizationId,
        from?.toISOString() || null,
        to?.toISOString() || null,
        limit,
      ],
    );
    res.set("Content-Disposition", `attachment; filename="hedgeling-audit-${req.authorizedOrganizationId}.json"`);
    res.json({
      organizationId: req.authorizedOrganizationId,
      generatedAt: new Date().toISOString(),
      events: result.rows,
    });
  }),
);

platformGovernanceRouter.use(requirePlatformAdmin);

platformGovernanceRouter.get("/support-access", route(async (req, res) => {
  const result = await query(
    `select grant_record.id, grant_record.organization_id as "organizationId",
            organization.name as "organizationName", grant_record.user_id as "userId",
            users.email, grant_record.access_type as "accessType",
            grant_record.permission_keys as "permissionKeys", grant_record.reason,
            grant_record.ticket_reference as "ticketReference",
            grant_record.starts_at as "startsAt", grant_record.expires_at as "expiresAt",
            grant_record.revoked_at as "revokedAt", grant_record.created_at as "createdAt"
     from support_access_grants grant_record
     join organizations organization on organization.id = grant_record.organization_id
     join users on users.id = grant_record.user_id
     order by grant_record.created_at desc limit 500`,
  );
  res.json({ supportAccessGrants: result.rows });
}));

platformGovernanceRouter.post("/support-access", route(async (req, res) => {
  const approverId = requireHuman(req);
  const organizationId = clean(req.body.organizationId);
  const userId = clean(req.body.userId);
  const accessType = clean(req.body.accessType || "support");
  const reason = clean(req.body.reason);
  const ticketReference = clean(req.body.ticketReference) || null;
  const permissionKeys = [...new Set(
    (Array.isArray(req.body.permissionKeys) ? req.body.permissionKeys : [])
      .map(clean)
      .filter(Boolean),
  )].sort();
  if (!isUuid(organizationId) || !isUuid(userId) || !["support", "break_glass"].includes(accessType)) {
    throw httpError(400, "Organization, user, and access type are required");
  }
  if (!reason || !permissionKeys.length) throw httpError(400, "Reason and permissions are required");
  if (reason.length > 2000) throw httpError(400, "Support access reason cannot exceed 2000 characters");
  if (accessType === "support" && permissionKeys.some((key) => supportDeniedPermissions.has(key))) {
    throw httpError(400, "Support access cannot include privileged security, billing, or payment permissions");
  }
  const expiresAt = optionalTimestamp(req.body.expiresAt);
  if (!expiresAt) throw httpError(400, "Support access expiry is required");
  const maximumMs = accessType === "break_glass" ? 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
  if (new Date(expiresAt).getTime() > Date.now() + maximumMs) {
    throw httpError(400, `${accessType === "break_glass" ? "Break-glass" : "Support"} access exceeds its maximum duration`);
  }
  if (accessType === "break_glass" && !ticketReference) {
    throw httpError(400, "Break-glass access requires an incident or ticket reference");
  }
  const grant = await withTransaction(async (client) => {
    const validPermissions = await client.query(
      "select key from permissions where key = any($1::text[])",
      [permissionKeys],
    );
    if (validPermissions.rowCount !== permissionKeys.length) {
      throw httpError(400, "One or more support permissions are invalid");
    }
    const target = await client.query(
      "select id from users where id = $1 and status = 'active'",
      [userId],
    );
    if (!target.rows[0]) throw httpError(400, "Support user must be active");
    const result = await client.query(
      `insert into support_access_grants(
         organization_id, user_id, access_type, permission_keys, reason,
         ticket_reference, expires_at, approved_by_user_id
       ) values($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, organization_id as "organizationId", user_id as "userId",
                 access_type as "accessType", permission_keys as "permissionKeys",
                 reason, ticket_reference as "ticketReference",
                 starts_at as "startsAt", expires_at as "expiresAt"`,
      [
        organizationId,
        userId,
        accessType,
        permissionKeys,
        reason,
        ticketReference,
        expiresAt,
        approverId,
      ],
    );
    await auditRequest(client, req, {
      organizationId,
      action: `support_access.${accessType}_granted`,
      resourceType: "support_access_grant",
      resourceId: result.rows[0].id,
      afterState: result.rows[0],
    });
    return result.rows[0];
  });
  res.status(201).json({ supportAccessGrant: grant });
}));

platformGovernanceRouter.delete("/support-access/:supportGrantId", route(async (req, res) => {
  const revokerId = requireHuman(req);
  await withTransaction(async (client) => {
    const result = await client.query(
      `update support_access_grants
       set revoked_at = now(), revoked_by_user_id = $2
       where id = $1 and revoked_at is null
       returning id, organization_id as "organizationId",
                 access_type as "accessType", user_id as "userId"`,
      [req.params.supportGrantId, revokerId],
    );
    if (!result.rows[0]) throw httpError(404, "Active support access grant not found");
    await auditRequest(client, req, {
      organizationId: result.rows[0].organizationId,
      action: "support_access.revoked",
      resourceType: "support_access_grant",
      resourceId: req.params.supportGrantId,
      beforeState: result.rows[0],
    });
  });
  res.status(204).end();
}));
