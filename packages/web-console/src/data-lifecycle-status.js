import { query } from "./db.js";

const projectExportPermissions = new Set([
  "strings.view",
  "translations.view",
  "locales.view",
  "prompts.view",
  "personas.view",
  "glossary.view",
  "exports.run",
]);

const organizationLifecyclePermissions = new Set([
  "organization.view",
  "organization.delete",
  "audit.view",
  "audit.export",
  "billing.view",
  "usage.view",
]);

const organizationLockedPermissions = new Set([
  "organization.view",
  "organization.delete",
  "billing.view",
  "usage.view",
]);

export function lifecycleMode(record, now = Date.now()) {
  if (!record) return "active";
  if (record.dataPurgedAt || record.state === "purged") return "purged";
  if (!["scheduled", "processing", "failed"].includes(record.state)) return "active";
  return new Date(record.exportAvailableUntil).getTime() > now
    ? "export_only"
    : "locked";
}

export function restrictProjectPermissions(permissions, record, now = Date.now()) {
  const mode = lifecycleMode(record, now);
  if (mode === "active") return permissions;
  if (mode === "export_only") {
    return permissions.filter((permission) => projectExportPermissions.has(permission));
  }
  return [];
}

export function restrictOrganizationPermissions(permissions, record, now = Date.now()) {
  const mode = lifecycleMode(record, now);
  if (mode === "active") return permissions;
  if (mode === "purged") return [];
  const allowed = mode === "export_only"
    ? organizationLifecyclePermissions
    : organizationLockedPermissions;
  return permissions.filter((permission) => allowed.has(permission));
}

export async function projectLifecycleAccess(
  projectId,
  organizationId,
  database = { query },
) {
  const result = await database.query(
    `select
       project.data_purged_at as "dataPurgedAt",
       lifecycle.id,
       lifecycle.state,
       lifecycle.target_type as "targetType",
       lifecycle.export_available_until as "exportAvailableUntil",
       lifecycle.purge_after as "purgeAfter",
       lifecycle.legal_hold_at as "legalHoldAt"
     from projects project
     left join lateral (
       select request.*
       from data_lifecycle_requests request
       where request.organization_id = $2
         and request.state in ('scheduled', 'processing', 'failed', 'purged')
         and (
           (request.target_type = 'organization' and request.project_id is null)
           or (request.target_type = 'project' and request.project_id = $1)
         )
       order by
         (request.target_type = 'organization') desc,
         request.requested_at desc
       limit 1
     ) lifecycle on true
     where project.id = $1`,
    [projectId, organizationId],
  );
  const row = result.rows[0] || null;
  return {
    ...(row || {}),
    mode: lifecycleMode(row),
  };
}

export async function organizationLifecycleAccess(
  organizationId,
  database = { query },
) {
  const result = await database.query(
    `select id, state, target_type as "targetType",
            export_available_until as "exportAvailableUntil",
            purge_after as "purgeAfter", legal_hold_at as "legalHoldAt"
     from data_lifecycle_requests
     where organization_id = $1 and target_type = 'organization'
       and state in ('scheduled', 'processing', 'failed', 'purged')
     order by requested_at desc
     limit 1`,
    [organizationId],
  );
  const row = result.rows[0] || null;
  return {
    ...(row || {}),
    mode: lifecycleMode(row),
  };
}

export async function organizationLifecycleAccessForOrganizations(
  organizationIds,
  database = { query },
) {
  const ids = [...new Set(organizationIds.filter(Boolean))];
  const access = new Map(ids.map((id) => [id, { mode: "active" }]));
  if (!ids.length) return access;
  const result = await database.query(
    `select distinct on (request.organization_id)
            request.organization_id as "organizationId",
            request.id, request.state, request.target_type as "targetType",
            request.export_available_until as "exportAvailableUntil",
            request.purge_after as "purgeAfter",
            request.legal_hold_at as "legalHoldAt"
     from data_lifecycle_requests request
     where request.organization_id = any($1::uuid[])
       and request.target_type = 'organization'
       and request.state in ('scheduled', 'processing', 'failed', 'purged')
     order by request.organization_id, request.requested_at desc`,
    [ids],
  );
  for (const row of result.rows) {
    access.set(row.organizationId, { ...row, mode: lifecycleMode(row) });
  }
  return access;
}

export const lifecyclePermissionSets = Object.freeze({
  projectExport: [...projectExportPermissions],
  organization: [...organizationLifecyclePermissions],
  organizationLocked: [...organizationLockedPermissions],
});
