import crypto from "node:crypto";
import express from "express";
import { insertAuditEvent, auditRequest } from "./audit.js";
import { query, withTransaction } from "./db.js";
import { requirePlatformAdmin } from "./auth.js";
import {
  organizationPermissions,
  requireOrganizationPermission,
} from "./authorization.js";
import { isUuid } from "./validation.js";

export const dataLifecycleRouter = express.Router();
export const platformDataLifecycleRouter = express.Router();
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
const activeStates = ["scheduled", "processing", "failed"];
const terminalWorkOrderStates = ["paid", "canceled"];
const terminalStatementStates = ["paid", "void"];

function clean(value) {
  return String(value ?? "").trim();
}

function httpError(status, message, code, details) {
  return Object.assign(new Error(message), { status, code, details });
}

function column(row, snakeCase, camelCase) {
  return Object.prototype.hasOwnProperty.call(row, snakeCase)
    ? row[snakeCase]
    : row[camelCase];
}

export function dataExportGraceDays() {
  const value = Number(process.env.HEDGELING_DATA_EXPORT_GRACE_DAYS || 30);
  if (!Number.isInteger(value) || value < 1 || value > 90) {
    throw new Error("HEDGELING_DATA_EXPORT_GRACE_DAYS must be an integer from 1 to 90");
  }
  return value;
}

export function dataLifecycleMaxAttempts() {
  const value = Number(process.env.HEDGELING_DATA_LIFECYCLE_MAX_ATTEMPTS || 24);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("HEDGELING_DATA_LIFECYCLE_MAX_ATTEMPTS must be an integer from 1 to 100");
  }
  return value;
}

export function validateDataLifecycleConfiguration() {
  return {
    exportGraceDays: dataExportGraceDays(),
    maxAttempts: dataLifecycleMaxAttempts(),
  };
}

function requireHuman(req) {
  if (!req.auth?.user?.id) {
    throw httpError(
      403,
      "Data-lifecycle decisions require a human user",
      "human_user_required",
    );
  }
  return req.auth.user.id;
}

function publicRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: column(row, "organization_id", "organizationId"),
    targetType: column(row, "target_type", "targetType"),
    projectId: column(row, "project_id", "projectId"),
    state: row.state,
    policyVersion: column(row, "policy_version", "policyVersion"),
    reason: row.reason,
    requestedByUserId: column(row, "requested_by_user_id", "requestedByUserId"),
    requestedAt: column(row, "requested_at", "requestedAt"),
    exportAvailableUntil: column(row, "export_available_until", "exportAvailableUntil"),
    purgeAfter: column(row, "purge_after", "purgeAfter"),
    legalHoldAt: column(row, "legal_hold_at", "legalHoldAt"),
    legalHoldReason: column(row, "legal_hold_reason", "legalHoldReason"),
    canceledAt: column(row, "canceled_at", "canceledAt"),
    cancellationReason: column(row, "cancellation_reason", "cancellationReason"),
    attemptCount: column(row, "attempt_count", "attemptCount"),
    retryAt: column(row, "retry_at", "retryAt"),
    lastError: column(row, "last_error", "lastError"),
    purgeSummary: column(row, "purge_summary", "purgeSummary") || {},
    completedAt: column(row, "completed_at", "completedAt"),
  };
}

async function organizationTarget(client, organizationId, { lock = false } = {}) {
  const result = await client.query(
    `select id, name, status, organization_type as "organizationType"
     from organizations where id = $1 ${lock ? "for update" : ""}`,
    [organizationId],
  );
  return result.rows[0] || null;
}

async function projectTarget(client, organizationId, projectId, { lock = false } = {}) {
  const result = await client.query(
    `select project.id, project.name, project.slug, project.data_purged_at as "dataPurgedAt"
     from projects project
     join business_units business_unit on business_unit.id = project.business_unit_id
     where project.id = $1 and business_unit.organization_id = $2
     ${lock ? "for update of project" : ""}`,
    [projectId, organizationId],
  );
  return result.rows[0] || null;
}

async function currentSubscription(client, organizationId) {
  const result = await client.query(
    `select subscription.state, subscription.provider,
            subscription.cancel_at_period_end as "cancelAtPeriodEnd",
            subscription.current_period_end as "currentPeriodEnd"
     from billing_accounts account
     left join lateral (
       select candidate.*
       from subscriptions candidate
       where candidate.billing_account_id = account.id
       order by (candidate.state <> 'canceled') desc, candidate.created_at desc
       limit 1
     ) subscription on true
     where account.organization_id = $1`,
    [organizationId],
  );
  return result.rows[0] || null;
}

async function assertProviderSubscriptionTerminated(client, organizationId) {
  const subscription = await currentSubscription(client, organizationId);
  if (
    subscription?.provider
    && !["canceled", "unpaid"].includes(subscription.state)
  ) {
    throw httpError(
      409,
      "Cancel the provider subscription before organization deletion can continue",
      "subscription_termination_required",
      { subscriptionState: subscription.state },
    );
  }
}

export async function dataLifecycleBlockers(
  client,
  organizationId,
  projectId = null,
) {
  const workOrder = await client.query(
    `select count(*)::integer as count
     from work_orders work_order
     join vendor_relationships relationship
       on relationship.id = work_order.vendor_relationship_id
     where ($2::uuid is null or work_order.project_id = $2)
       and (
         $2::uuid is not null
         or relationship.customer_organization_id = $1
         or relationship.agency_organization_id = $1
       )
       and work_order.status <> all($3::text[])`,
    [organizationId, projectId, terminalWorkOrderStates],
  );
  const blockers = {
    openWorkOrders: workOrder.rows[0].count,
    unsettledStatements: 0,
    activePaymentAttempts: 0,
    activeRefunds: 0,
    activeReversals: 0,
    activeProviderDisputes: 0,
    openPaymentExceptions: 0,
    openRecoveryCases: 0,
  };
  if (projectId) return blockers;

  const organizationBlockers = await client.query(
    `select
       (
         select count(*)::integer
         from payable_statements statement
         join vendor_relationships relationship
           on relationship.id = statement.vendor_relationship_id
         where (
           relationship.customer_organization_id = $1
           or relationship.agency_organization_id = $1
         ) and statement.status <> all($2::text[])
       ) as "unsettledStatements",
       (
         select count(*)::integer from facilitated_payment_attempts attempt
         where $1 in (attempt.customer_organization_id, attempt.agency_organization_id)
           and (
             attempt.state in ('created', 'requires_action', 'processing')
             or attempt.checkout_status in ('creating', 'open')
           )
       ) as "activePaymentAttempts",
       (
         select count(*)::integer
         from facilitated_refunds refund
         join facilitated_payments payment on payment.id = refund.facilitated_payment_id
         where $1 in (payment.customer_organization_id, payment.agency_organization_id)
           and refund.status in ('requested', 'submitting', 'pending', 'requires_action')
       ) as "activeRefunds",
       (
         select count(*)::integer
         from facilitated_transfer_reversals reversal
         join facilitated_transfer_instructions transfer
           on transfer.id = reversal.transfer_instruction_id
         join facilitated_payments payment on payment.id = transfer.facilitated_payment_id
         where $1 in (payment.customer_organization_id, payment.agency_organization_id)
           and reversal.status = 'submitting'
       ) as "activeReversals",
       (
         select count(*)::integer
         from facilitated_provider_disputes dispute
         join facilitated_payments payment on payment.id = dispute.facilitated_payment_id
         where $1 in (payment.customer_organization_id, payment.agency_organization_id)
           and dispute.status in (
             'warning_needs_response', 'warning_under_review',
             'needs_response', 'under_review'
           )
       ) as "activeProviderDisputes",
       (
         select count(*)::integer from facilitated_payment_exceptions exception_record
         where exception_record.organization_id = $1 and exception_record.status = 'open'
       ) as "openPaymentExceptions",
       (
         select count(*)::integer
         from facilitated_recovery_cases recovery
         left join facilitated_payments payment
           on payment.id = recovery.facilitated_payment_id
         left join facilitated_payouts payout on payout.id = recovery.payout_id
         left join agency_connected_accounts connected
           on connected.id = payout.connected_account_id
         where recovery.status in ('open', 'recovering')
           and (
             $1 in (payment.customer_organization_id, payment.agency_organization_id)
             or connected.agency_organization_id = $1
           )
       ) as "openRecoveryCases"`,
    [organizationId, terminalStatementStates],
  );
  return { ...blockers, ...organizationBlockers.rows[0] };
}

function hasBlockers(blockers) {
  return Object.values(blockers).some((count) => Number(count) > 0);
}

async function assertLifecycleMayBeScheduled(client, organizationId, projectId) {
  if (!projectId) {
    await assertProviderSubscriptionTerminated(client, organizationId);
  }
  const blockers = await dataLifecycleBlockers(client, organizationId, projectId);
  if (hasBlockers(blockers)) {
    throw httpError(
      409,
      "Resolve open work and payment obligations before scheduling deletion",
      "data_lifecycle_commercial_blockers",
      blockers,
    );
  }
}

async function existingCurrentRequest(client, organizationId, projectId) {
  const result = await client.query(
    `select * from data_lifecycle_requests
     where organization_id = $1 and state = any($3::text[])
       and (
         ($2::uuid is null and target_type = 'organization')
         or ($2::uuid is not null and target_type = 'project' and project_id = $2)
       )
     order by requested_at desc limit 1`,
    [organizationId, projectId, activeStates],
  );
  return result.rows[0] || null;
}

async function scheduleLifecycle(req) {
  const userId = requireHuman(req);
  const organizationId = req.authorizedOrganizationId;
  const targetType = clean(req.body.targetType);
  const projectId = targetType === "project" ? clean(req.body.projectId) : null;
  const reason = clean(req.body.reason);
  const confirmation = clean(req.body.confirmation);
  if (!["organization", "project"].includes(targetType)) {
    throw httpError(400, "targetType must be organization or project", "target_type_invalid");
  }
  if (targetType === "project" && !isUuid(projectId)) {
    throw httpError(400, "A valid projectId is required", "project_id_invalid");
  }
  if (!reason || reason.length > 2000) {
    throw httpError(400, "A reason from 1 to 2000 characters is required", "reason_invalid");
  }
  const graceDays = dataExportGraceDays();
  return withTransaction(async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`data-lifecycle:${organizationId}`],
    );
    const organization = await organizationTarget(client, organizationId, { lock: true });
    if (!organization) throw httpError(404, "Organization not found", "organization_not_found");
    const target = projectId
      ? await projectTarget(client, organizationId, projectId, { lock: true })
      : organization;
    if (!target) throw httpError(404, "Project not found", "project_not_found");
    if (target.dataPurgedAt || organization.status === "closed") {
      throw httpError(409, "This target has already been purged", "data_already_purged");
    }
    if (confirmation !== target.name) {
      throw httpError(
        400,
        "Type the current organization or project name exactly to confirm deletion",
        "deletion_confirmation_mismatch",
      );
    }
    const current = await existingCurrentRequest(client, organizationId, projectId);
    if (current) return { request: publicRequest(current), replayed: true };
    if (targetType === "project") {
      const parent = await existingCurrentRequest(client, organizationId, null);
      if (parent) {
        throw httpError(
          409,
          "Organization deletion is already scheduled",
          "organization_deletion_already_scheduled",
          { dataLifecycleRequestId: parent.id },
        );
      }
    } else {
      const childRequests = await client.query(
        `select id, project_id as "projectId"
         from data_lifecycle_requests
         where organization_id = $1 and target_type = 'project'
           and state = any($2::text[])
         order by requested_at`,
        [organizationId, activeStates],
      );
      if (childRequests.rows.length) {
        throw httpError(
          409,
          "Cancel the pending project deletion requests before scheduling organization deletion",
          "project_deletions_already_scheduled",
          { requests: childRequests.rows },
        );
      }
    }
    await assertLifecycleMayBeScheduled(client, organizationId, projectId);
    const requestedAt = new Date();
    const purgeAfter = new Date(
      requestedAt.getTime() + graceDays * 24 * 60 * 60 * 1000,
    );
    const inserted = await client.query(
      `insert into data_lifecycle_requests(
         organization_id, target_type, project_id, reason,
         requested_by_user_id, requested_at, export_available_until,
         purge_after
       ) values($1, $2, $3, $4, $5, $6, $7, $7)
       returning *`,
      [
        organizationId,
        targetType,
        projectId,
        reason,
        userId,
        requestedAt,
        purgeAfter,
      ],
    );
    const lifecycle = inserted.rows[0];
    await auditRequest(client, req, {
      action: "data_lifecycle.scheduled",
      resourceType: "data_lifecycle_request",
      resourceId: lifecycle.id,
      afterState: {
        targetType,
        projectId,
        policyVersion: lifecycle.policy_version,
        exportAvailableUntil: lifecycle.export_available_until,
        purgeAfter: lifecycle.purge_after,
        reason,
      },
    });
    return { request: publicRequest(lifecycle), replayed: false };
  });
}

for (const parameter of ["organizationId", "requestId"]) {
  dataLifecycleRouter.param(parameter, (req, res, next, value) => (
    isUuid(value) ? next() : res.status(400).json({ error: `${parameter} is invalid` })
  ));
  platformDataLifecycleRouter.param(parameter, (req, res, next, value) => (
    isUuid(value) ? next() : res.status(400).json({ error: `${parameter} is invalid` })
  ));
}

function requireDataLifecycleReadAccess(req, res, next) {
  Promise.resolve().then(async () => {
    const userId = requireHuman(req);
    const organizationId = req.params.organizationId;
    const exists = await query(
      "select id from organizations where id = $1",
      [organizationId],
    );
    if (!exists.rows[0]) {
      return res.status(404).json({ error: "Organization not found" });
    }
    const permissions = await organizationPermissions(req.auth, organizationId);
    if (permissions.includes("organization.view")) {
      req.authorizedOrganizationId = organizationId;
      req.organizationPermissions = permissions;
      return next();
    }
    const receipt = await query(
      `select 1
       from data_lifecycle_requests
       where organization_id = $1 and requested_by_user_id = $2
         and state = 'purged'
       limit 1`,
      [organizationId, userId],
    );
    if (receipt.rowCount) {
      req.authorizedOrganizationId = organizationId;
      req.dataLifecycleReceiptOnly = true;
      return next();
    }
    return res.status(403).json({
      error: "You do not have permission for this organization",
    });
  }).catch(next);
}

dataLifecycleRouter.get(
  "/organizations/:organizationId/data-lifecycle",
  requireDataLifecycleReadAccess,
  route(async (req, res) => {
    const userId = requireHuman(req);
    const params = [req.authorizedOrganizationId];
    const receiptFilter = req.dataLifecycleReceiptOnly
      ? "and requested_by_user_id = $2 and state = 'purged'"
      : "";
    if (req.dataLifecycleReceiptOnly) params.push(userId);
    const result = await query(
      `select * from data_lifecycle_requests
       where organization_id = $1 ${receiptFilter}
       order by requested_at desc limit 100`,
      params,
    );
    res.json({
      requests: result.rows.map(publicRequest),
      receiptOnly: req.dataLifecycleReceiptOnly === true,
    });
  }),
);

dataLifecycleRouter.post(
  "/organizations/:organizationId/data-lifecycle",
  requireOrganizationPermission("organization.delete"),
  route(async (req, res) => {
    const result = await scheduleLifecycle(req);
    res.status(result.replayed ? 200 : 201).json(result);
  }),
);

dataLifecycleRouter.post(
  "/organizations/:organizationId/data-lifecycle/:requestId/cancel",
  requireOrganizationPermission("organization.delete"),
  route(async (req, res) => {
    const userId = requireHuman(req);
    const reason = clean(req.body.reason);
    if (!reason || reason.length > 2000) {
      throw httpError(400, "A cancellation reason is required", "reason_invalid");
    }
    const canceled = await withTransaction(async (client) => {
      const before = await client.query(
        `select * from data_lifecycle_requests
         where id = $1 and organization_id = $2 for update`,
        [req.params.requestId, req.authorizedOrganizationId],
      ).then((result) => result.rows[0]);
      if (!before) throw httpError(404, "Data-lifecycle request not found", "request_not_found");
      if (!["scheduled", "failed"].includes(before.state)) {
        throw httpError(409, "Only a pending deletion can be canceled", "request_not_cancelable");
      }
      if (before.legal_hold_at) {
        throw httpError(
          409,
          "A request under legal hold cannot be canceled",
          "legal_hold_active",
        );
      }
      if (new Date(before.export_available_until).getTime() <= Date.now()) {
        throw httpError(409, "The cancellation window has ended", "cancellation_window_ended");
      }
      const updated = await client.query(
        `update data_lifecycle_requests
         set state = 'canceled', canceled_at = now(), canceled_by_user_id = $3,
             cancellation_reason = $4, lease_id = null, lease_expires_at = null,
             retry_at = null, last_error = null, updated_at = now()
         where id = $1 and organization_id = $2
         returning *`,
        [req.params.requestId, req.authorizedOrganizationId, userId, reason],
      ).then((result) => result.rows[0]);
      await auditRequest(client, req, {
        action: "data_lifecycle.canceled",
        resourceType: "data_lifecycle_request",
        resourceId: updated.id,
        beforeState: publicRequest(before),
        afterState: publicRequest(updated),
      });
      return updated;
    });
    res.json({ request: publicRequest(canceled) });
  }),
);

async function redactProjectAudit(client, organizationId, projectId, requestId, purgedAt) {
  const result = await client.query(
    `with content_ids as (
       select $2::uuid as id
       union select id from source_strings where project_id = $2
       union
       select translation.id from translations translation
       join source_strings source on source.id = translation.source_string_id
       where source.project_id = $2
       union
       select revision.id from translation_revisions revision
       join source_strings source on source.id = revision.source_string_id
       where source.project_id = $2
       union select id from prompts where project_id = $2
       union select id from personas where project_id = $2
       union select id from glossary_terms where project_id = $2
       union select id from pipeline_runs where project_id = $2
       union select id from gemini_calls where project_id = $2
       union select id from locales where project_id = $2
       union select id from project_workflows where project_id = $2
       union select id from usage_events where project_id = $2
       union
       select item.id from usage_event_items item
       where item.usage_event_id in (
         select id from usage_events where project_id = $2
       )
       union select id from work_orders where project_id = $2
     )
     update audit_events
     set before_state = null, after_state = null,
         metadata = jsonb_build_object(
           'customerContentPurged', true,
           'dataLifecycleRequestId', $3::text,
           'purgedAt', $4::text
         )
     where organization_id = $1
       and resource_id in (select id from content_ids)`,
    [organizationId, projectId, requestId, purgedAt.toISOString()],
  );
  return result.rowCount;
}

async function purgeProjectContent(client, {
  organizationId,
  projectId,
  requestId,
  purgedAt,
}) {
  const project = await projectTarget(client, organizationId, projectId, { lock: true });
  if (!project) throw new Error("Lifecycle project no longer exists");
  if (project.dataPurgedAt) {
    return { projectId, alreadyPurged: true };
  }
  const counts = await client.query(
    `select
       (select count(*)::integer from source_strings where project_id = $1) as "sourceStrings",
       (
         select count(*)::integer from translations translation
         join source_strings source on source.id = translation.source_string_id
         where source.project_id = $1
       ) as translations,
       (
         select count(*)::integer from translation_revisions revision
         join source_strings source on source.id = revision.source_string_id
         where source.project_id = $1
       ) as "translationRevisions",
       (select count(*)::integer from context_variants context_record
         join source_strings source on source.id = context_record.source_string_id
         where source.project_id = $1) as "contextVariants",
       (select count(*)::integer from prompts where project_id = $1) as prompts,
       (select count(*)::integer from personas where project_id = $1) as personas,
       (select count(*)::integer from glossary_terms where project_id = $1) as "glossaryTerms",
       (select count(*)::integer from pipeline_runs where project_id = $1) as "pipelineRuns",
       (select count(*)::integer from gemini_calls where project_id = $1) as "geminiCalls",
       (select count(*)::integer from locales where project_id = $1) as locales,
       (select count(*)::integer from project_workflows where project_id = $1) as "projectWorkflows",
       (select count(*)::integer from usage_events where project_id = $1) as "usageEventsScrubbed"`,
    [projectId],
  ).then((result) => result.rows[0]);
  const redactedAuditEvents = await redactProjectAudit(
    client,
    organizationId,
    projectId,
    requestId,
    purgedAt,
  );

  await client.query(
    `update usage_event_items item
     set source_string_id = null, translation_revision_id = null,
         source_locale = null, target_locale = null,
         metadata = jsonb_build_object('customerContentPurged', true)
     from usage_events event
     where event.id = item.usage_event_id and event.project_id = $1`,
    [projectId],
  );
  await client.query(
    `update usage_events
     set response_body = null,
         metadata = jsonb_build_object(
           'customerContentPurged', true,
           'dataLifecycleRequestId', $2::text
         )
     where project_id = $1`,
    [projectId, requestId],
  );
  await client.query(
    `delete from translation_revisions
     where source_string_id in (select id from source_strings where project_id = $1)`,
    [projectId],
  );
  await client.query(
    `delete from translations
     where source_string_id in (select id from source_strings where project_id = $1)`,
    [projectId],
  );
  await client.query(
    `delete from analysis_passes
     where source_string_id in (select id from source_strings where project_id = $1)`,
    [projectId],
  );
  await client.query(
    `delete from context_variants
     where source_string_id in (select id from source_strings where project_id = $1)`,
    [projectId],
  );
  await client.query(
    `update source_strings
     set source_hash = 'purged:' || id::text,
         source_text = '[customer content purged]', shape = null, purpose = null,
         visual_context = null, limit_chars = null, updated_at = $2
     where project_id = $1`,
    [projectId, purgedAt],
  );
  await client.query("delete from gemini_calls where project_id = $1", [projectId]);
  await client.query("delete from localization_jobs where project_id = $1", [projectId]);
  // Conversations can refer to several projects in their organization. Purge
  // that organization's conversations rather than retaining source content in
  // model history or pretending a partial transcript can be redacted safely.
  await client.query("delete from agent_runs where organization_id = $1", [organizationId]);
  await client.query("delete from agent_proposals where organization_id = $1", [organizationId]);
  await client.query("delete from pipeline_runs where project_id = $1", [projectId]);
  await client.query("delete from prompts where project_id = $1", [projectId]);
  await client.query("delete from personas where project_id = $1", [projectId]);
  await client.query("delete from glossary_terms where project_id = $1", [projectId]);
  await client.query("delete from locales where project_id = $1", [projectId]);
  await client.query("delete from project_workflows where project_id = $1", [projectId]);
  await client.query(
    `delete from vendor_relationship_scopes
     where scope_type = 'project' and scope_id = $1`,
    [projectId],
  );
  await client.query(
    `update role_assignments
     set revoked_at = coalesce(revoked_at, $2)
     where scope_type = 'project' and scope_id = $1`,
    [projectId, purgedAt],
  );
  await client.query(
    `update projects
     set slug = 'deleted-' || replace(id::text, '-', ''),
         name = 'Deleted project', source_locale = null,
         data_purged_at = $2, updated_at = $2
     where id = $1`,
    [projectId, purgedAt],
  );
  return { projectId, ...counts, redactedAuditEvents };
}

async function stageNpmRevocations(client, organizationId, requestId, purgedAt) {
  await client.query(
    `update npm_provisioning_outbox work
     set status = case
           when work.status in ('pending', 'failed') then 'canceled'
           else work.status
         end,
         metadata = jsonb_build_object(
           'customerProfilePurged', true,
           'dataLifecycleRequestId', $3::text
         ),
         updated_at = $2
     from npm_seat_assignments seat
     where seat.id = work.seat_assignment_id
       and seat.organization_id = $1
       and work.operation = 'invite'`,
    [organizationId, purgedAt, requestId],
  );
  const seats = await client.query(
    `update npm_seat_assignments
     set status = 'revoking', updated_at = $2, last_error = null
     where organization_id = $1 and status <> 'revoked'
     returning id`,
    [organizationId, purgedAt],
  );
  await client.query(
    `update roles
     set key = 'deleted-' || replace(id::text, '-', ''),
         name = 'Deleted role', description = null, updated_at = $2
     where organization_id = $1`,
    [organizationId, purgedAt],
  );
  for (const seat of seats.rows) {
    await client.query(
      `insert into npm_provisioning_outbox(
         seat_assignment_id, operation, idempotency_key, metadata
       ) values($1, 'revoke', $2, $3)
       on conflict(idempotency_key) do update
       set metadata = npm_provisioning_outbox.metadata || excluded.metadata,
           status = case
             when npm_provisioning_outbox.status = 'canceled' then 'pending'
             else npm_provisioning_outbox.status
           end,
           next_attempt_at = least(npm_provisioning_outbox.next_attempt_at, now()),
           updated_at = now()`,
      [
        seat.id,
        `npm-seat:${seat.id}:revoke`,
        JSON.stringify({
          reason: "data_lifecycle_purge",
          dataLifecyclePurge: true,
          dataLifecycleRequestId: requestId,
        }),
      ],
    );
  }
  const alreadyRevoked = await client.query(
    `update npm_seat_assignments
     set npm_username = 'deleted-' || replace(id::text, '-', ''),
         provider_state = '{}'::jsonb, last_error = null, updated_at = $2
     where organization_id = $1 and status = 'revoked'`,
    [organizationId, purgedAt],
  );
  await client.query(
    `update npm_provisioning_outbox work
     set metadata = jsonb_build_object(
           'reason', 'data_lifecycle_purge',
           'dataLifecyclePurge', true,
           'dataLifecycleRequestId', $2::text
         ),
         updated_at = now()
     from npm_seat_assignments seat
     where seat.id = work.seat_assignment_id
       and seat.organization_id = $1
       and work.operation = 'revoke'
       and work.status = 'succeeded'`,
    [organizationId, requestId],
  );
  return seats.rowCount + alreadyRevoked.rowCount;
}

async function purgeOrganizationAccess(client, organizationId, requestId, purgedAt) {
  // Empty organizations also own conversations and pending creation previews.
  await client.query("delete from agent_runs where organization_id = $1", [organizationId]);
  await client.query("delete from agent_proposals where organization_id = $1", [organizationId]);
  const npmRevocations = await stageNpmRevocations(
    client,
    organizationId,
    requestId,
    purgedAt,
  );
  await client.query(
    `update organization_onboarding
     set service_account_id = null, source_locale = 'und',
         target_locales = array['und']::text[], updated_at = $2
     where organization_id = $1`,
    [organizationId, purgedAt],
  );
  await client.query(
    `update service_account_credentials credential
     set status = 'revoked', revoked_at = coalesce(revoked_at, $2)
     from service_accounts account
     where account.id = credential.service_account_id
       and account.organization_id = $1 and credential.status = 'active'`,
    [organizationId, purgedAt],
  );
  await client.query(
    `update service_accounts
     set status = 'revoked', name = 'Revoked service account',
         metadata = '{}'::jsonb, updated_at = $2
     where organization_id = $1`,
    [organizationId, purgedAt],
  );
  await client.query(
    `update scim_tokens
     set status = 'revoked', revoked_at = coalesce(revoked_at, $2)
     where organization_id = $1 and status = 'active'`,
    [organizationId, purgedAt],
  );
  await client.query("delete from scim_user_links where organization_id = $1", [organizationId]);
  await client.query("delete from scim_group_links where organization_id = $1", [organizationId]);
  await client.query("delete from identity_connections where organization_id = $1", [organizationId]);
  await client.query("delete from organization_verified_domains where organization_id = $1", [organizationId]);
  await client.query("delete from invitations where organization_id = $1", [organizationId]);
  await client.query("delete from teams where organization_id = $1", [organizationId]);
  await client.query(
    `update recovery_login_grants
     set revoked_at = coalesce(revoked_at, $2)
     where organization_id = $1 and revoked_at is null`,
    [organizationId, purgedAt],
  );
  await client.query(
    `update support_access_grants
     set revoked_at = coalesce(revoked_at, $2)
     where organization_id = $1 and revoked_at is null`,
    [organizationId, purgedAt],
  );
  await client.query(
    `update role_assignments
     set revoked_at = coalesce(revoked_at, $2)
     where revoked_at is null and (
       (scope_type = 'organization' and scope_id = $1)
       or (
         scope_type = 'business_unit' and scope_id in (
           select id from business_units where organization_id = $1
         )
       )
       or (
         scope_type = 'project' and scope_id in (
           select project.id from projects project
           join business_units business_unit on business_unit.id = project.business_unit_id
           where business_unit.organization_id = $1
         )
       )
     )`,
    [organizationId, purgedAt],
  );
  await client.query(
    `update organization_memberships
     set status = 'removed', updated_at = $2
     where organization_id = $1`,
    [organizationId, purgedAt],
  );
  await client.query(
    `update business_units
     set status = 'archived', slug = 'closed-' || replace(id::text, '-', ''),
         name = 'Closed business unit', metadata = '{}'::jsonb, updated_at = $2
     where organization_id = $1`,
    [organizationId, purgedAt],
  );
  await client.query(
    `update vendor_relationships
     set status = 'terminated', effective_to = coalesce(effective_to, $2::date),
         updated_at = $2::timestamptz
     where customer_organization_id = $1 or agency_organization_id = $1`,
    [organizationId, purgedAt],
  );
  await client.query("delete from organization_ai_credentials where organization_id=$1", [organizationId]);
  await client.query("delete from organization_ai_proposals where organization_id=$1", [organizationId]);
  await client.query("delete from organization_ai_settings where organization_id=$1", [organizationId]);
  await client.query(
    `update billing_accounts
     set status = 'closed', billing_email = null, updated_at = $2
     where organization_id = $1`,
    [organizationId, purgedAt],
  );
  await client.query(
    `update subscriptions subscription
     set state = 'canceled', cancel_at_period_end = false, updated_at = $2
     from billing_accounts account
     where account.id = subscription.billing_account_id
       and account.organization_id = $1
       and subscription.provider is null
       and subscription.state <> 'canceled'`,
    [organizationId, purgedAt],
  );
  await client.query(
    `update self_service_trial_claims
     set owner_email = 'deleted+' || replace(id::text, '-', '') || '@invalid',
         email_domain = null
     where organization_id = $1`,
    [organizationId],
  );
  await client.query(
    `update audit_events
     set before_state = null, after_state = null,
         metadata = jsonb_build_object(
           'customerProfilePurged', true,
           'dataLifecycleRequestId', $2::text,
           'purgedAt', $3::text
         )
     where organization_id = $1
       and (
         action like 'self_service.%'
         or resource_type in (
           'organization', 'business_unit', 'project', 'membership',
           'invitation', 'team', 'service_account', 'identity_connection',
           'verified_domain', 'source_string', 'translation',
           'translation_revision', 'prompt', 'persona', 'glossary_term', 'localization_job'
         )
       )`,
    [organizationId, requestId, purgedAt],
  );
  await client.query(
    `update organizations
     set status = 'closed', slug = 'closed-' || replace(id::text, '-', ''),
         name = 'Closed organization',
         metadata = jsonb_build_object(
           'customerContentPurged', true,
           'dataLifecycleRequestId', $2::text,
           'dataPurgedAt', ($3::timestamptz)::text
         ),
         updated_at = $3::timestamptz
     where id = $1`,
    [organizationId, requestId, purgedAt],
  );
  return { npmRevocations };
}

export async function claimDueDataLifecycleRequests({
  workerId = crypto.randomUUID(),
  limit = 10,
} = {}) {
  if (!isUuid(workerId)) throw new Error("Data-lifecycle workerId must be a UUID");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Data-lifecycle batch size must be from 1 to 100");
  }
  const maxAttempts = dataLifecycleMaxAttempts();
  return withTransaction(async (client) => {
    const claimed = await client.query(
      `with exhausted_leases as (
         update data_lifecycle_requests
         set state = 'failed', retry_at = null,
             lease_id = null, lease_expires_at = null,
             last_error = coalesce(
               last_error,
               'Automatic retry limit reached after expired worker leases'
             ),
             updated_at = now()
         where state = 'processing' and lease_expires_at <= now()
           and attempt_count >= $3
         returning id
       ),
       candidates as (
         select id
         from data_lifecycle_requests
         where legal_hold_at is null
           and purge_after <= now()
           and (
             (state = 'scheduled')
             or (state = 'failed' and retry_at is not null and retry_at <= now())
             or (
               state = 'processing' and lease_expires_at <= now()
               and attempt_count < $3
             )
           )
         order by purge_after, requested_at
         for update skip locked
         limit $1
       )
       update data_lifecycle_requests request
       set state = 'processing', lease_id = $2,
           lease_expires_at = now() + interval '15 minutes',
           attempt_count = attempt_count + 1, retry_at = null,
           last_error = null, updated_at = now()
       from candidates
       where request.id = candidates.id
       returning request.*`,
      [limit, workerId, maxAttempts],
    );
    return { workerId, requests: claimed.rows.map(publicRequest) };
  });
}

async function failLifecycleRequest(requestId, workerId, error) {
  const message = String(error?.message || error || "Unknown lifecycle failure").slice(0, 2000);
  const maxAttempts = dataLifecycleMaxAttempts();
  await query(
    `update data_lifecycle_requests
     set state = 'failed', last_error = $3,
         retry_at = case
           when attempt_count >= $4 then null
           else now() + interval '1 hour'
         end,
         lease_id = null, lease_expires_at = null, updated_at = now()
     where id = $1 and state = 'processing' and lease_id = $2`,
    [requestId, workerId, message, maxAttempts],
  );
}

export async function purgeClaimedDataLifecycleRequest(requestId, workerId) {
  try {
    return await withTransaction(async (client) => {
      const lifecycle = await client.query(
        `select * from data_lifecycle_requests
         where id = $1 and state = 'processing' and lease_id = $2
         for update`,
        [requestId, workerId],
      ).then((result) => result.rows[0]);
      if (!lifecycle) throw new Error("Data-lifecycle processing lease was lost");
      if (lifecycle.legal_hold_at) throw new Error("Data-lifecycle request is under legal hold");
      if (new Date(lifecycle.purge_after).getTime() > Date.now()) {
        throw new Error("Data-lifecycle export window has not ended");
      }
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`data-lifecycle:${lifecycle.organization_id}`],
      );
      if (!lifecycle.project_id) {
        await assertProviderSubscriptionTerminated(
          client,
          lifecycle.organization_id,
        );
      }
      const blockers = await dataLifecycleBlockers(
        client,
        lifecycle.organization_id,
        lifecycle.project_id,
      );
      if (hasBlockers(blockers)) {
        throw httpError(
          409,
          "Commercial obligations appeared after deletion was scheduled",
          "data_lifecycle_commercial_blockers",
          blockers,
        );
      }
      const purgedAt = new Date();
      const projectIds = lifecycle.project_id
        ? [lifecycle.project_id]
        : await client.query(
          `select project.id
           from projects project
           join business_units business_unit on business_unit.id = project.business_unit_id
           where business_unit.organization_id = $1
           order by project.id`,
          [lifecycle.organization_id],
        ).then((result) => result.rows.map((row) => row.id));
      const projects = [];
      for (const projectId of projectIds) {
        projects.push(await purgeProjectContent(client, {
          organizationId: lifecycle.organization_id,
          projectId,
          requestId: lifecycle.id,
          purgedAt,
        }));
      }
      const organization = lifecycle.target_type === "organization"
        ? await purgeOrganizationAccess(
          client,
          lifecycle.organization_id,
          lifecycle.id,
          purgedAt,
        )
        : null;
      const summary = {
        policyVersion: lifecycle.policy_version,
        purgedAt: purgedAt.toISOString(),
        projects,
        organization,
        retainedCategories: [
          "audit_facts",
          "billing_and_tax_records",
          "legal_acceptances",
          "usage_measurements",
          "vendor_and_payment_facts",
        ],
      };
      const completed = await client.query(
        `update data_lifecycle_requests
         set state = 'purged', completed_at = $3, purge_summary = $4,
             lease_id = null, lease_expires_at = null, retry_at = null,
             last_error = null, updated_at = $3
         where id = $1 and state = 'processing' and lease_id = $2
         returning *`,
        [requestId, workerId, purgedAt, JSON.stringify(summary)],
      ).then((result) => result.rows[0]);
      if (!completed) throw new Error("Data-lifecycle completion lease was lost");
      await insertAuditEvent(client, {
        auth: { principalType: "system_agent", principalId: workerId },
        organizationId: lifecycle.organization_id,
        action: "data_lifecycle.purged",
        resourceType: "data_lifecycle_request",
        resourceId: lifecycle.id,
        afterState: summary,
      });
      return publicRequest(completed);
    });
  } catch (error) {
    await failLifecycleRequest(requestId, workerId, error).catch(() => {});
    throw error;
  }
}

export async function processDueDataLifecycleRequests({
  workerId = crypto.randomUUID(),
  limit = 10,
} = {}) {
  const claim = await claimDueDataLifecycleRequests({ workerId, limit });
  const outcomes = [];
  for (const request of claim.requests) {
    try {
      outcomes.push({
        requestId: request.id,
        status: "purged",
        request: await purgeClaimedDataLifecycleRequest(request.id, claim.workerId),
      });
    } catch (error) {
      outcomes.push({
        requestId: request.id,
        status: "failed",
        error: String(error?.message || error).slice(0, 500),
      });
    }
  }
  return { workerId: claim.workerId, claimed: claim.requests.length, outcomes };
}

platformDataLifecycleRouter.use(requirePlatformAdmin);

platformDataLifecycleRouter.get("/data-lifecycle", route(async (req, res) => {
  requireHuman(req);
  const state = clean(req.query.state);
  if (state && ![...activeStates, "purged", "canceled"].includes(state)) {
    throw httpError(400, "Data-lifecycle state is invalid", "state_invalid");
  }
  const params = [];
  const filters = [];
  if (state) {
    params.push(state);
    filters.push(`request.state = $${params.length}`);
  }
  const result = await query(
    `select request.*, organization.name as "organizationName",
            project.name as "projectName"
     from data_lifecycle_requests request
     join organizations organization on organization.id = request.organization_id
     left join projects project on project.id = request.project_id
     ${filters.length ? `where ${filters.join(" and ")}` : ""}
     order by request.requested_at desc limit 250`,
    params,
  );
  res.json({
    requests: result.rows.map((row) => ({
      ...publicRequest(row),
      organizationName: row.organizationName,
      projectName: row.projectName,
    })),
  });
}));

platformDataLifecycleRouter.post(
  "/data-lifecycle/:requestId/hold",
  route(async (req, res) => {
    const userId = requireHuman(req);
    const reason = clean(req.body.reason);
    if (!reason || reason.length > 2000) {
      throw httpError(400, "A legal-hold reason is required", "reason_invalid");
    }
    const updated = await withTransaction(async (client) => {
      const before = await client.query(
        "select * from data_lifecycle_requests where id = $1 for update",
        [req.params.requestId],
      ).then((result) => result.rows[0]);
      if (!before) throw httpError(404, "Data-lifecycle request not found", "request_not_found");
      if (!["scheduled", "failed"].includes(before.state)) {
        throw httpError(409, "A processing or completed request cannot be held", "request_not_holdable");
      }
      const row = await client.query(
        `update data_lifecycle_requests
         set legal_hold_at = now(), legal_hold_by_user_id = $2,
             legal_hold_reason = $3, updated_at = now()
         where id = $1 returning *`,
        [req.params.requestId, userId, reason],
      ).then((result) => result.rows[0]);
      await auditRequest(client, req, {
        organizationId: row.organization_id,
        action: "data_lifecycle.legal_hold_applied",
        resourceType: "data_lifecycle_request",
        resourceId: row.id,
        beforeState: publicRequest(before),
        afterState: publicRequest(row),
      });
      return row;
    });
    res.json({ request: publicRequest(updated) });
  }),
);

platformDataLifecycleRouter.post(
  "/data-lifecycle/:requestId/release-hold",
  route(async (req, res) => {
    requireHuman(req);
    const reason = clean(req.body.reason);
    if (!reason || reason.length > 2000) {
      throw httpError(400, "A hold-release reason is required", "reason_invalid");
    }
    const updated = await withTransaction(async (client) => {
      const before = await client.query(
        "select * from data_lifecycle_requests where id = $1 for update",
        [req.params.requestId],
      ).then((result) => result.rows[0]);
      if (!before) throw httpError(404, "Data-lifecycle request not found", "request_not_found");
      if (!before.legal_hold_at) {
        throw httpError(409, "This request is not under legal hold", "legal_hold_missing");
      }
      const row = await client.query(
        `update data_lifecycle_requests
         set legal_hold_at = null, legal_hold_by_user_id = null,
             legal_hold_reason = null,
             retry_at = case when purge_after <= now() then now() else retry_at end,
             updated_at = now()
         where id = $1 returning *`,
        [req.params.requestId],
      ).then((result) => result.rows[0]);
      await auditRequest(client, req, {
        organizationId: row.organization_id,
        action: "data_lifecycle.legal_hold_released",
        resourceType: "data_lifecycle_request",
        resourceId: row.id,
        beforeState: publicRequest(before),
        afterState: { ...publicRequest(row), releaseReason: reason },
      });
      return row;
    });
    res.json({ request: publicRequest(updated) });
  }),
);

platformDataLifecycleRouter.post(
  "/data-lifecycle/:requestId/retry",
  route(async (req, res) => {
    requireHuman(req);
    const reason = clean(req.body.reason);
    if (!reason || reason.length > 2000) {
      throw httpError(400, "A retry reason is required", "reason_invalid");
    }
    const updated = await withTransaction(async (client) => {
      const before = await client.query(
        "select * from data_lifecycle_requests where id = $1 for update",
        [req.params.requestId],
      ).then((result) => result.rows[0]);
      if (!before) throw httpError(404, "Data-lifecycle request not found", "request_not_found");
      if (before.state !== "failed" || before.legal_hold_at) {
        throw httpError(409, "Only an unheld failed request can be retried", "request_not_retryable");
      }
      const row = await client.query(
        `update data_lifecycle_requests
         set retry_at = now(), last_error = null, updated_at = now()
         where id = $1 returning *`,
        [req.params.requestId],
      ).then((result) => result.rows[0]);
      await auditRequest(client, req, {
        organizationId: row.organization_id,
        action: "data_lifecycle.retry_requested",
        resourceType: "data_lifecycle_request",
        resourceId: row.id,
        beforeState: publicRequest(before),
        afterState: { ...publicRequest(row), retryReason: reason },
      });
      return row;
    });
    res.json({ request: publicRequest(updated) });
  }),
);

export default dataLifecycleRouter;
