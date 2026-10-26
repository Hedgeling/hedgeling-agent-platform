import { query } from "./db.js";
import { humanDecisionDenied } from "./principal-policy.js";
import { isUuid } from "./validation.js";
import {
  organizationLifecycleAccess,
  organizationLifecycleAccessForOrganizations,
  projectLifecycleAccess,
  restrictOrganizationPermissions,
  restrictProjectPermissions,
} from "./data-lifecycle-status.js";

export function isPlatformAdmin(auth) {
  return auth?.platformAdmin === true || auth?.user?.platformStaff === true;
}

async function lifecycleOrganizationPermissions(
  organizationId,
  permissions,
  lifecycle = null,
) {
  return restrictOrganizationPermissions(
    permissions,
    lifecycle || await organizationLifecycleAccess(organizationId),
  );
}

async function lifecycleProjectPermissions(project, permissions) {
  return restrictProjectPermissions(
    permissions,
    await projectLifecycleAccess(project.id, project.organizationId),
  );
}

async function activeSupportPermissions(auth, organizationId) {
  if (!auth?.user?.id) return [];
  const result = await query(
    `select distinct unnest(permission_keys) as key
     from support_access_grants
     where organization_id = $1 and user_id = $2 and revoked_at is null
       and starts_at <= now() and expires_at > now()`,
    [organizationId, auth.user.id],
  );
  return result.rows.map((row) => row.key);
}

export async function organizationAccessForOrganizations(auth, organizationIds) {
  const selectedIds = [...new Set(
    (organizationIds || []).filter((organizationId) => isUuid(organizationId)),
  )];
  const access = new Map();
  if (!selectedIds.length) return access;
  if (isPlatformAdmin(auth)) {
    const permissions = await query("select key from permissions order by key")
      .then((result) => result.rows.map((row) => row.key));
    const lifecycle = await organizationLifecycleAccessForOrganizations(selectedIds);
    await Promise.all(selectedIds.map(async (organizationId) => {
      access.set(
        organizationId,
        await lifecycleOrganizationPermissions(
          organizationId,
          permissions,
          lifecycle.get(organizationId),
        ),
      );
    }));
    return access;
  }
  if (auth?.principalType === "service_account") {
    const organizationId = auth.serviceAccount?.organizationId;
    if (!selectedIds.includes(organizationId)) return access;
    const result = await query(
      `select array_agg(distinct permission.key order by permission.key) as permissions
       from service_accounts account
       join organizations organization
         on organization.id = account.organization_id
        and organization.status = 'active'
       left join role_assignments assignment
         on assignment.principal_type = 'service_account'
        and assignment.principal_id = account.id
        and assignment.scope_type = 'organization'
        and assignment.scope_id = organization.id
        and assignment.revoked_at is null
        and (assignment.expires_at is null or assignment.expires_at > now())
       left join role_permissions role_permission
         on role_permission.role_id = assignment.role_id
       left join permissions permission on permission.id = role_permission.permission_id
       where account.id = $1 and account.organization_id = $2
         and account.status = 'active'
       group by account.id`,
      [auth.serviceAccount.id, organizationId],
    );
    if (result.rows[0]) {
      access.set(
        organizationId,
        await lifecycleOrganizationPermissions(
          organizationId,
          result.rows[0].permissions || [],
        ),
      );
    }
    return access;
  }
  if (!auth?.user?.id) return access;
  const result = await query(
    `with selected as (
       select unnest($2::uuid[]) as organization_id
     ),
     active_support as (
       select support.organization_id, unnest(support.permission_keys) as permission_key
       from support_access_grants support
       join selected on selected.organization_id = support.organization_id
       where support.user_id = $1 and support.revoked_at is null
         and support.starts_at <= now() and support.expires_at > now()
     ),
     identity_allowed as (
       select selected.organization_id
       from selected
       left join organization_identity_policies policy
         on policy.organization_id = selected.organization_id
       where exists(
           select 1 from active_support
           where active_support.organization_id = selected.organization_id
         )
         or coalesce(not policy.sso_required, true)
         or (
           $3::uuid is not null
           and exists(
             select 1 from identity_connections connection
             where connection.id = $3
               and connection.organization_id = selected.organization_id
               and connection.status = 'active'
           )
         )
         or exists(
           select 1 from recovery_login_grants recovery
           where recovery.organization_id = selected.organization_id
             and recovery.user_id = $1
             and recovery.revoked_at is null
             and recovery.expires_at > now()
         )
     ),
     active_memberships as (
       select membership.id, membership.organization_id
       from organization_memberships membership
       join organizations organization
         on organization.id = membership.organization_id
        and organization.status = 'active'
       join identity_allowed allowed
         on allowed.organization_id = membership.organization_id
       where membership.user_id = $1 and membership.status = 'active'
         and (membership.expires_at is null or membership.expires_at > now())
     ),
     active_teams as (
       select membership.organization_id, team_membership.team_id
       from active_memberships membership
       join team_memberships team_membership
         on team_membership.organization_membership_id = membership.id
     ),
     role_grants as (
       select distinct membership.organization_id, permission.key
       from active_memberships membership
       join role_assignments assignment
         on assignment.scope_type = 'organization'
        and assignment.scope_id = membership.organization_id
        and assignment.revoked_at is null
        and (assignment.expires_at is null or assignment.expires_at > now())
        and (
          (assignment.principal_type = 'user' and assignment.principal_id = $1)
          or (
            assignment.principal_type = 'team'
            and assignment.principal_id in (
              select team_id from active_teams
              where organization_id = membership.organization_id
            )
          )
        )
       join role_permissions role_permission
         on role_permission.role_id = assignment.role_id
       join permissions permission on permission.id = role_permission.permission_id
     ),
     granted_permissions as (
       select organization_id, key from role_grants
       union
       select organization_id, permission_key from active_support
     )
     select allowed.organization_id as "organizationId",
            coalesce(
              array_agg(granted.key order by granted.key)
                filter (where granted.key is not null),
              '{}'::text[]
            ) as permissions
     from identity_allowed allowed
     left join granted_permissions granted
       on granted.organization_id = allowed.organization_id
     group by allowed.organization_id`,
    [auth.user.id, selectedIds, auth.identityConnectionId || null],
  );
  const lifecycle = await organizationLifecycleAccessForOrganizations(
    result.rows.map((row) => row.organizationId),
  );
  await Promise.all(result.rows.map(async (row) => {
    access.set(
      row.organizationId,
      await lifecycleOrganizationPermissions(
        row.organizationId,
        row.permissions,
        lifecycle.get(row.organizationId),
      ),
    );
  }));
  return access;
}

export async function organizationIdentityAllows(auth, organizationId) {
  if (isPlatformAdmin(auth)) return true;
  if (auth?.principalType === "service_account") {
    return auth.serviceAccount?.organizationId === organizationId;
  }
  if (!auth?.user?.id) return false;
  if ((await activeSupportPermissions(auth, organizationId)).length) return true;
  const result = await query(
    `select
       not policy.sso_required
       or (
         $3::uuid is not null
         and exists (
           select 1 from identity_connections connection
           where connection.id = $3 and connection.organization_id = $1
             and connection.status = 'active'
         )
       )
       or exists (
         select 1 from recovery_login_grants recovery
         where recovery.organization_id = $1 and recovery.user_id = $2
           and recovery.revoked_at is null and recovery.expires_at > now()
       ) as allowed
     from organization_identity_policies policy
     where policy.organization_id = $1`,
    [organizationId, auth.user.id, auth.identityConnectionId || null],
  );
  return result.rows[0]?.allowed !== false;
}

async function projectBySlug(slug) {
  const result = await query(
    `select p.id, p.slug, p.name, p.business_unit_id as "businessUnitId",
            bu.organization_id as "organizationId"
     from projects p
     join business_units bu on bu.id = p.business_unit_id
     where p.slug = $1`,
    [slug],
  );
  return result.rows[0] || null;
}

async function projectBySourceString(sourceId) {
  const result = await query(
    `select p.id, p.slug, p.name, p.business_unit_id as "businessUnitId",
            bu.organization_id as "organizationId"
     from source_strings s
     join projects p on p.id = s.project_id
     join business_units bu on bu.id = p.business_unit_id
     where s.id = $1`,
    [sourceId],
  );
  return result.rows[0] || null;
}

export async function projectPermissions(auth, project, context = {}) {
  if (isPlatformAdmin(auth)) {
    const result = await query("select key from permissions order by key");
    return lifecycleProjectPermissions(project, result.rows.map((row) => row.key));
  }
  if (!project || !await organizationIdentityAllows(auth, project.organizationId)) return [];
  if (auth?.principalType === "service_account") {
    const result = await query(
      `select distinct permission.key
       from role_assignments ra
       join roles role on role.id = ra.role_id
       join role_permissions rp on rp.role_id = role.id
       join permissions permission on permission.id = rp.permission_id
       join service_accounts account
         on account.id = $1 and account.organization_id = $2 and account.status = 'active'
       join organizations organization on organization.id = $2 and organization.status = 'active'
       where ra.principal_type = 'service_account' and ra.principal_id = $1
         and ra.revoked_at is null
         and (ra.expires_at is null or ra.expires_at > now())
         and (
           not (ra.conditions ? 'locales')
           or ($5::text is not null and ra.conditions->'locales' ? $5)
           or $6::boolean
         )
         and (
           (ra.scope_type = 'project' and ra.scope_id = $3)
           or (ra.inherit_to_children and ra.scope_type = 'business_unit' and ra.scope_id = $4)
           or (ra.inherit_to_children and ra.scope_type = 'organization' and ra.scope_id = $2)
         )
       order by permission.key`,
      [
        auth.serviceAccount.id,
        project.organizationId,
        project.id,
        project.businessUnitId,
        context.locale || null,
        context.allowUnknownLocale === true,
      ],
    );
    return lifecycleProjectPermissions(project, result.rows.map((row) => row.key));
  }
  if (!auth?.user?.id) return [];
  const result = await query(
    `with active_teams as (
       select tm.team_id
       from team_memberships tm
       join organization_memberships om on om.id = tm.organization_membership_id
       where om.user_id = $1
         and om.organization_id = $2
         and om.status = 'active'
         and (om.expires_at is null or om.expires_at > now())
     )
     select distinct permission.key
       from role_assignments ra
       join roles r on r.id = ra.role_id
       join role_permissions rp on rp.role_id = r.id
       join permissions permission on permission.id = rp.permission_id
       join organizations organization on organization.id = $2
       join organization_memberships om
         on om.organization_id = $2 and om.user_id = $1
       where organization.status = 'active'
         and om.status = 'active'
         and (om.expires_at is null or om.expires_at > now())
         and ra.revoked_at is null
         and (ra.expires_at is null or ra.expires_at > now())
         and (
           not (ra.conditions ? 'locales')
           or ($5::text is not null and ra.conditions->'locales' ? $5)
           or $6::boolean
         )
         and (
           (ra.principal_type = 'user' and ra.principal_id = $1)
           or (ra.principal_type = 'team' and ra.principal_id in (select team_id from active_teams))
         )
         and (
           (ra.scope_type = 'project' and ra.scope_id = $3)
           or (ra.inherit_to_children and ra.scope_type = 'business_unit' and ra.scope_id = $4)
           or (ra.inherit_to_children and ra.scope_type = 'organization' and ra.scope_id = $2)
         )
     order by permission.key`,
    [
      auth.user.id,
      project.organizationId,
      project.id,
      project.businessUnitId,
      context.locale || null,
      context.allowUnknownLocale === true,
    ],
  );
  const support = await activeSupportPermissions(auth, project.organizationId);
  return lifecycleProjectPermissions(
    project,
    [...new Set([...result.rows.map((row) => row.key), ...support])].sort(),
  );
}

async function hasProjectPermission(auth, project, permission, context) {
  return (await projectPermissions(auth, project, context)).includes(permission);
}

export async function organizationPermissions(auth, organizationId) {
  if (isPlatformAdmin(auth)) {
    const result = await query("select key from permissions order by key");
    return lifecycleOrganizationPermissions(
      organizationId,
      result.rows.map((row) => row.key),
    );
  }
  if (!organizationId || !await organizationIdentityAllows(auth, organizationId)) return [];
  if (auth?.principalType === "service_account") {
    const result = await query(
      `select distinct permission.key
       from role_assignments ra
       join roles role on role.id = ra.role_id
       join role_permissions rp on rp.role_id = role.id
       join permissions permission on permission.id = rp.permission_id
       join service_accounts account
         on account.id = $1 and account.organization_id = $2 and account.status = 'active'
       join organizations organization on organization.id = $2 and organization.status = 'active'
       where ra.principal_type = 'service_account' and ra.principal_id = $1
         and ra.scope_type = 'organization' and ra.scope_id = $2
         and ra.revoked_at is null
         and (ra.expires_at is null or ra.expires_at > now())
       order by permission.key`,
      [auth.serviceAccount.id, organizationId],
    );
    return lifecycleOrganizationPermissions(
      organizationId,
      result.rows.map((row) => row.key),
    );
  }
  if (!auth?.user?.id) return [];
  const result = await query(
    `with active_teams as (
       select tm.team_id
       from team_memberships tm
       join organization_memberships om on om.id = tm.organization_membership_id
       where om.user_id = $1 and om.organization_id = $2
         and om.status = 'active'
         and (om.expires_at is null or om.expires_at > now())
     )
     select distinct permission.key
     from role_assignments ra
     join roles r on r.id = ra.role_id
     join role_permissions rp on rp.role_id = r.id
     join permissions permission on permission.id = rp.permission_id
     join organizations organization on organization.id = $2
     join organization_memberships om
       on om.organization_id = $2 and om.user_id = $1
     where organization.status = 'active'
       and om.status = 'active'
       and (om.expires_at is null or om.expires_at > now())
       and ra.revoked_at is null
       and (ra.expires_at is null or ra.expires_at > now())
       and (
         (ra.principal_type = 'user' and ra.principal_id = $1)
         or (ra.principal_type = 'team' and ra.principal_id in (select team_id from active_teams))
       )
       and ra.scope_type = 'organization'
       and ra.scope_id = $2
     order by permission.key`,
    [auth.user.id, organizationId],
  );
  const support = await activeSupportPermissions(auth, organizationId);
  return lifecycleOrganizationPermissions(
    organizationId,
    [...new Set([...result.rows.map((row) => row.key), ...support])].sort(),
  );
}

export function requireOrganizationPermission(permission, options = {}) {
  return async (req, res, next) => {
    try {
      if (humanDecisionDenied(req.auth, permission)) {
        return res.status(403).json({ error: "This decision requires a human user", code: "human_decision_required" });
      }
      const organizationId = String(
        req.params[options.param || "organizationId"] || req.query.organizationId || "",
      ).trim();
      if (!organizationId) return res.status(400).json({ error: "Organization is required" });
      if (!isUuid(organizationId)) return res.status(400).json({ error: "Organization ID is invalid" });
      const exists = await query("select id from organizations where id = $1", [organizationId]);
      if (!exists.rows[0]) return res.status(404).json({ error: "Organization not found" });
      const permissions = await organizationPermissions(req.auth, organizationId);
      if (!permissions.includes(permission)) {
        return res.status(403).json({ error: "You do not have permission for this organization" });
      }
      req.authorizedOrganizationId = organizationId;
      req.organizationPermissions = permissions;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function slugFromRequest(req) {
  return String(req.query.project || req.params.slug || req.body?.projectSlug || "").trim();
}

export function requireProjectPermission(permission, options = {}) {
  return async (req, res, next) => {
    try {
      if (humanDecisionDenied(req.auth, permission)) {
        return res.status(403).json({ error: "This decision requires a human user", code: "human_decision_required" });
      }
      const sourceId = options.sourceParam ? req.params[options.sourceParam] : null;
      if (sourceId && !isUuid(sourceId)) {
        return res.status(400).json({ error: "Resource ID is invalid" });
      }
      const project = sourceId
        ? await projectBySourceString(sourceId)
        : await projectBySlug(slugFromRequest(req));
      if (!project) return res.status(404).json({ error: "Project not found" });
      if (isPlatformAdmin(req.auth)) {
        const lifecycle = await projectLifecycleAccess(project.id, project.organizationId);
        if (!restrictProjectPermissions([permission], lifecycle).includes(permission)) {
          return res.status(403).json({
            error: "This project is outside its customer-content access window",
            code: "project_data_lifecycle_restricted",
          });
        }
      } else {
        let allowed;
        if (options.localeListQuery) {
          let requestedLocales = String(req.query[options.localeListQuery] || "")
            .split(",")
            .map((locale) => locale.trim())
            .filter(Boolean);
          if (!requestedLocales.length) {
            const localeResult = await query(
              `select distinct t.locale
               from translations t join source_strings s on s.id = t.source_string_id
               where s.project_id = $1 order by t.locale`,
              [project.id],
            );
            requestedLocales = localeResult.rows.map((row) => row.locale);
          }
          allowed = requestedLocales.length
            ? (await Promise.all(requestedLocales.map((locale) => (
              hasProjectPermission(req.auth, project, permission, { locale })
            )))).every(Boolean)
            : await hasProjectPermission(req.auth, project, permission, {});
          req.authorizedLocales = requestedLocales;
        } else {
          allowed = await hasProjectPermission(req.auth, project, permission, {
            locale: options.ignoreLocale
              ? null
              : req.params.locale || req.query.locale || req.body?.locale || null,
            allowUnknownLocale: options.ignoreLocale === true,
          });
        }
        if (!allowed) return res.status(403).json({ error: "You do not have access to this project" });
      }
      req.authorizedProject = project;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export async function listAccessibleProjects(auth) {
  if (isPlatformAdmin(auth)) {
    const result = await query(
      `select p.slug, p.name, p.updated_at as "updatedAt",
              bu.name as "businessUnitName", o.name as "organizationName", o.id as "organizationId"
       from projects p
       join business_units bu on bu.id = p.business_unit_id
       join organizations o on o.id = bu.organization_id
       where p.data_purged_at is null
       order by lower(o.name), lower(bu.name), lower(p.name)`,
    );
    return result.rows;
  }
  if (auth?.principalType === "service_account") {
    const result = await query(
      `select distinct p.slug, p.name, p.updated_at as "updatedAt",
              bu.name as "businessUnitName", organization.name as "organizationName", organization.id as "organizationId"
       from projects p
       join business_units bu on bu.id = p.business_unit_id
       join organizations organization
         on organization.id = bu.organization_id and organization.status = 'active'
       join service_accounts account
         on account.id = $1 and account.organization_id = organization.id
        and account.status = 'active'
       join role_assignments ra
         on ra.principal_type = 'service_account' and ra.principal_id = account.id
       join role_permissions rp on rp.role_id = ra.role_id
       join permissions permission
         on permission.id = rp.permission_id and permission.key = 'strings.view'
       where p.data_purged_at is null
         and ra.revoked_at is null
         and (ra.expires_at is null or ra.expires_at > now())
         and (
           (ra.scope_type = 'project' and ra.scope_id = p.id)
           or (ra.inherit_to_children and ra.scope_type = 'business_unit' and ra.scope_id = bu.id)
           or (
             ra.inherit_to_children and ra.scope_type = 'organization'
             and ra.scope_id = organization.id
           )
         )
       order by "organizationName", "businessUnitName", p.name`,
      [auth.serviceAccount.id],
    );
    return result.rows;
  }
  if (!auth?.user?.id) return [];
  const result = await query(
    `select distinct p.slug, p.name, p.updated_at as "updatedAt",
            bu.name as "businessUnitName", o.name as "organizationName",
            o.id as "organizationId"
     from projects p
     join business_units bu on bu.id = p.business_unit_id
     join organizations o on o.id = bu.organization_id
     join organization_memberships om on om.organization_id = o.id and om.user_id = $1
     join role_assignments ra on (
       (ra.principal_type = 'user' and ra.principal_id = $1)
       or (
         ra.principal_type = 'team' and ra.principal_id in (
           select tm.team_id from team_memberships tm
           join organization_memberships team_om on team_om.id = tm.organization_membership_id
           where team_om.user_id = $1 and team_om.organization_id = o.id and team_om.status = 'active'
         )
       )
     )
     join role_permissions rp on rp.role_id = ra.role_id
     join permissions permission on permission.id = rp.permission_id and permission.key = 'strings.view'
     where o.status = 'active'
       and p.data_purged_at is null
       and om.status = 'active'
       and (om.expires_at is null or om.expires_at > now())
       and ra.revoked_at is null
       and (ra.expires_at is null or ra.expires_at > now())
       and (
         (ra.scope_type = 'project' and ra.scope_id = p.id)
         or (ra.inherit_to_children and ra.scope_type = 'business_unit' and ra.scope_id = bu.id)
         or (ra.inherit_to_children and ra.scope_type = 'organization' and ra.scope_id = o.id)
       )
     order by "organizationName", "businessUnitName", p.name`,
    [auth.user.id],
  );
  const supportResult = await query(
    `select distinct project.slug, project.name, project.updated_at as "updatedAt",
            business_unit.name as "businessUnitName",
            organization.name as "organizationName",
            organization.id as "organizationId"
     from support_access_grants grant_record
     join organizations organization
       on organization.id = grant_record.organization_id
      and organization.status = 'active'
     join business_units business_unit
       on business_unit.organization_id = organization.id
     join projects project on project.business_unit_id = business_unit.id
     where grant_record.user_id = $1 and grant_record.revoked_at is null
       and project.data_purged_at is null
       and grant_record.starts_at <= now() and grant_record.expires_at > now()
       and 'strings.view' = any(grant_record.permission_keys)
     order by "organizationName", "businessUnitName", project.name`,
    [auth.user.id],
  );
  const combined = new Map(
    [...result.rows, ...supportResult.rows].map((project) => [project.slug, project]),
  );
  const access = await organizationAccessForOrganizations(
    auth,
    [...combined.values()].map((project) => project.organizationId),
  );
  const allowed = [...combined.values()]
    .filter((project) => access.has(project.organizationId));
  return allowed.sort((left, right) => (
    `${left.organizationName}\u0000${left.businessUnitName}\u0000${left.name}`
      .localeCompare(`${right.organizationName}\u0000${right.businessUnitName}\u0000${right.name}`)
  ));
}
