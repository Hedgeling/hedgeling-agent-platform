import crypto from "node:crypto";
import express from "express";
import { query, withTransaction } from "./db.js";
import { auditRequest, insertAuditEvent } from "./audit.js";
import { requireOrganizationPermission } from "./authorization.js";
import { isUuid, optionalTimestamp } from "./validation.js";

export const scimAdminRouter = express.Router();
export const scimPublicRouter = express.Router();
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
const userSchema = "urn:ietf:params:scim:schemas:core:2.0:User";
const groupSchema = "urn:ietf:params:scim:schemas:core:2.0:Group";
const listSchema = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const missingBoolean = Symbol("missingBoolean");

function clean(value) {
  return String(value ?? "").trim();
}

function httpError(status, message, scimType = null) {
  return Object.assign(new Error(message), { status, scimType });
}

export function mapScimWriteError(error, resource = "user") {
  const resourceName = resource === "group" ? "group" : "user";
  return error?.code === "23505"
    ? httpError(
      409,
      `A SCIM ${resourceName} with the requested identifiers already exists`,
      "uniqueness",
    )
    : error;
}

function scimBoolean(value, fallback = missingBoolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  if (value == null && fallback !== missingBoolean) return fallback;
  throw httpError(400, "active must be a boolean", "invalidValue");
}

function scimMemberId(member) {
  return clean(member?.value ?? member);
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createToken() {
  const prefix = crypto.randomBytes(8).toString("hex");
  const token = `hdlg_scim_${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
  return { prefix, token, digest: digest(token) };
}

function bearer(req) {
  const [scheme, token] = clean(req.get("authorization")).split(" ");
  return scheme?.toLowerCase() === "bearer" ? token : "";
}

function scimUser(row) {
  return {
    schemas: [userSchema],
    id: row.userId,
    externalId: row.externalId,
    userName: row.email,
    displayName: row.displayName || row.email,
    active: row.membershipStatus === "active",
    emails: [{ value: row.email, primary: true, type: "work" }],
    meta: {
      resourceType: "User",
      created: row.createdAt,
      lastModified: row.updatedAt,
    },
  };
}

function scimGroup(row) {
  return {
    schemas: [groupSchema],
    id: row.teamId,
    externalId: row.externalId,
    displayName: row.displayName,
    members: row.members || [],
    meta: {
      resourceType: "Group",
      created: row.createdAt,
      lastModified: row.updatedAt,
    },
  };
}

function userSelect(extraWhere = "") {
  return `select link.user_id as "userId", link.external_id as "externalId",
                 users.email, users.display_name as "displayName",
                 membership.status as "membershipStatus",
                 link.created_at as "createdAt", link.updated_at as "updatedAt"
          from scim_user_links link
          join users on users.id = link.user_id
          join organization_memberships membership
            on membership.organization_id = link.organization_id
           and membership.user_id = link.user_id
          where link.organization_id = $1 ${extraWhere}`;
}

function groupSelect(extraWhere = "") {
  return `select link.team_id as "teamId", link.external_id as "externalId",
                 team.name as "displayName", link.created_at as "createdAt",
                 link.updated_at as "updatedAt",
                 coalesce(json_agg(json_build_object(
                   'value', user_link.user_id,
                   'display', users.email
                 ) order by lower(users.email))
                   filter (where user_link.user_id is not null), '[]') as members
          from scim_group_links link
          join teams team on team.id = link.team_id
          left join team_memberships team_member on team_member.team_id = team.id
          left join organization_memberships membership
            on membership.id = team_member.organization_membership_id
          left join scim_user_links user_link
            on user_link.organization_id = link.organization_id
           and user_link.user_id = membership.user_id
          left join users on users.id = user_link.user_id
          where link.organization_id = $1 ${extraWhere}
          group by link.id, team.id`;
}

async function scimAudit(client, req, action, resourceType, resourceId, beforeState, afterState) {
  await insertAuditEvent(client, {
    auth: {
      principalType: "system_agent",
      principalId: req.scimAuth.tokenId,
    },
    organizationId: req.scimAuth.organizationId,
    action,
    resourceType,
    resourceId,
    requestId: req.get("x-request-id") || null,
    ipAddress: req.ip || null,
    beforeState,
    afterState,
    metadata: { protocol: "scim" },
  });
}

async function authenticateScim(req, res, next) {
  try {
    if (!isUuid(req.params.organizationId)) {
      throw httpError(404, "Resource not found");
    }
    const match = /^hdlg_scim_([a-f0-9]{16})_([A-Za-z0-9_-]{40,})$/.exec(bearer(req));
    if (!match) throw httpError(401, "Invalid SCIM bearer token");
    const result = await query(
      `select token.id, token.organization_id as "organizationId",
              token.token_digest as "tokenDigest"
       from scim_tokens token
       join organizations organization on organization.id = token.organization_id
       where token.token_prefix = $1 and token.organization_id = $2
         and token.status = 'active' and token.revoked_at is null
         and (token.expires_at is null or token.expires_at > now())
         and organization.status = 'active'`,
      [match[1], req.params.organizationId],
    );
    const token = result.rows[0];
    const suppliedDigest = Buffer.from(digest(bearer(req)), "hex");
    const storedDigest = Buffer.from(token?.tokenDigest || "", "hex");
    if (
      !token
      || suppliedDigest.length !== storedDigest.length
      || !crypto.timingSafeEqual(suppliedDigest, storedDigest)
    ) {
      throw httpError(401, "Invalid or expired SCIM bearer token");
    }
    req.scimAuth = { tokenId: token.id, organizationId: token.organizationId };
    await query(
      `update scim_tokens set last_used_at = now()
       where id = $1 and (last_used_at is null or last_used_at < now() - interval '5 minutes')`,
      [token.id],
    );
    return next();
  } catch (error) {
    return next(error);
  }
}

for (const parameter of ["organizationId", "scimTokenId"]) {
  scimAdminRouter.param(parameter, (req, res, next, value) => (
    isUuid(value) ? next() : res.status(400).json({ error: `${parameter} is invalid` })
  ));
}

scimAdminRouter.get(
  "/organizations/:organizationId/scim-tokens",
  requireOrganizationPermission("provisioning.manage"),
  route(async (req, res) => {
    const result = await query(
      `select id, name, token_prefix as prefix, status,
              expires_at as "expiresAt", last_used_at as "lastUsedAt",
              created_at as "createdAt", revoked_at as "revokedAt"
       from scim_tokens where organization_id = $1
       order by created_at desc`,
      [req.authorizedOrganizationId],
    );
    res.json({ tokens: result.rows });
  }),
);

scimAdminRouter.post(
  "/organizations/:organizationId/scim-tokens",
  requireOrganizationPermission("provisioning.manage"),
  route(async (req, res) => {
    const name = clean(req.body.name);
    if (!name || name.length > 200) throw httpError(400, "SCIM token name is required");
    const expiresAt = optionalTimestamp(req.body.expiresAt);
    const created = createToken();
    const token = await withTransaction(async (client) => {
      const result = await client.query(
        `insert into scim_tokens(
           organization_id, name, token_prefix, token_digest,
           expires_at, created_by_user_id
         ) values($1, $2, $3, $4, $5, $6)
         returning id, name, token_prefix as prefix, status,
                   expires_at as "expiresAt", created_at as "createdAt"`,
        [
          req.authorizedOrganizationId,
          name,
          created.prefix,
          created.digest,
          expiresAt,
          req.auth?.user?.id || null,
        ],
      );
      await auditRequest(client, req, {
        action: "scim.token_created",
        resourceType: "scim_token",
        resourceId: result.rows[0].id,
        afterState: result.rows[0],
      });
      return result.rows[0];
    });
    res.status(201).json({
      scimToken: { ...token, token: created.token },
      baseUrl: `/scim/v2/${req.authorizedOrganizationId}`,
      warning: "Copy this SCIM token now. It will not be shown again.",
    });
  }),
);

scimAdminRouter.delete(
  "/organizations/:organizationId/scim-tokens/:scimTokenId",
  requireOrganizationPermission("provisioning.manage"),
  route(async (req, res) => {
    await withTransaction(async (client) => {
      const result = await client.query(
        `update scim_tokens set status = 'revoked', revoked_at = now(),
                revoked_by_user_id = $3
         where id = $1 and organization_id = $2 and status = 'active'
         returning id, name, token_prefix as prefix`,
        [req.params.scimTokenId, req.authorizedOrganizationId, req.auth?.user?.id || null],
      );
      if (!result.rows[0]) throw httpError(404, "Active SCIM token not found");
      await auditRequest(client, req, {
        action: "scim.token_revoked",
        resourceType: "scim_token",
        resourceId: req.params.scimTokenId,
        beforeState: result.rows[0],
      });
    });
    res.status(204).end();
  }),
);

scimPublicRouter.use("/:organizationId", authenticateScim);
scimPublicRouter.use((_req, res, next) => {
  res.type("application/scim+json");
  next();
});

scimPublicRouter.get("/:organizationId/ServiceProviderConfig", (_req, res) => {
  res.json({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 100 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", primary: true }],
  });
});

scimPublicRouter.get("/:organizationId/Users", route(async (req, res) => {
  const filter = clean(req.query.filter);
  const match = /^userName eq "([^"]+)"$/i.exec(filter);
  if (filter && !match) throw httpError(400, "Only userName eq filters are supported", "invalidFilter");
  const params = [req.scimAuth.organizationId];
  let where = "";
  if (match) {
    params.push(match[1].toLowerCase());
    where = `and lower(users.email) = $${params.length}`;
  }
  const startIndex = Math.max(Number.parseInt(req.query.startIndex, 10) || 1, 1);
  const count = Math.min(Math.max(Number.parseInt(req.query.count, 10) || 100, 0), 100);
  const total = await query(
    `select count(*)::int as count
     from scim_user_links link join users on users.id = link.user_id
     where link.organization_id = $1 ${where}`,
    params,
  );
  params.push(count, startIndex - 1);
  const result = await query(
    `${userSelect(where)} order by lower(users.email)
     limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  res.json({
    schemas: [listSchema],
    totalResults: total.rows[0].count,
    startIndex,
    itemsPerPage: result.rowCount,
    Resources: result.rows.map(scimUser),
  });
}));

scimPublicRouter.get("/:organizationId/Users/:userId", route(async (req, res) => {
  if (!isUuid(req.params.userId)) throw httpError(404, "User not found");
  const result = await query(`${userSelect("and link.user_id = $2")}`, [
    req.scimAuth.organizationId,
    req.params.userId,
  ]);
  if (!result.rows[0]) throw httpError(404, "User not found");
  res.json(scimUser(result.rows[0]));
}));

async function upsertUser(req, userId = null) {
  const email = clean(
    req.body.userName
      || req.body.emails?.find((item) => item.primary)?.value
      || req.body.emails?.[0]?.value,
  ).toLowerCase();
  const externalId = clean(req.body.externalId || email);
  const displayName = clean(req.body.displayName || req.body.name?.formatted) || null;
  const active = scimBoolean(req.body.active, true);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, "userName must be an email address", "invalidValue");
  if (!externalId) throw httpError(400, "externalId is required", "invalidValue");
  if (email.length > 320 || externalId.length > 500 || (displayName && displayName.length > 500)) {
    throw httpError(400, "User identifiers exceed supported lengths", "invalidValue");
  }
  return withTransaction(async (client) => {
    let existing = null;
    if (userId) {
      const found = await client.query(`${userSelect("and link.user_id = $2")} for update of link`, [
        req.scimAuth.organizationId,
        userId,
      ]);
      existing = found.rows[0];
      if (!existing) throw httpError(404, "User not found");
    } else {
      const found = await client.query(`${userSelect("and link.external_id = $2")} for update of link`, [
        req.scimAuth.organizationId,
        externalId,
      ]);
      existing = found.rows[0] || null;
    }
    const emailOwnerCandidate = await client.query(
      "select id from users where lower(email) = $1",
      [email],
    );
    const userIdsToLock = [...new Set(
      [existing?.userId, emailOwnerCandidate.rows[0]?.id].filter(Boolean),
    )].sort();
    const lockedUsers = userIdsToLock.length
      ? await client.query(
        `select id, email, display_name as "displayName"
         from users where id = any($1::uuid[]) order by id for update`,
        [userIdsToLock],
      )
      : { rows: [] };
    const emailOwner = lockedUsers.rows.find(
      (user) => user.email.toLowerCase() === email,
    ) || null;
    let resultingUserId;
    if (existing) {
      const linkedUser = lockedUsers.rows.find((user) => user.id === existing.userId);
      if (!linkedUser) throw httpError(404, "User not found");
      if (emailOwner && emailOwner.id !== existing.userId) {
        throw httpError(409, "The requested email belongs to another Hedgeling user", "uniqueness");
      }
      const shared = await client.query(
        `select 1 from organization_memberships
         where user_id = $1 and organization_id <> $2 limit 1`,
        [existing.userId, req.scimAuth.organizationId],
      );
      if (
        shared.rows[0]
        && linkedUser.email.toLowerCase() !== email
      ) {
        throw httpError(
          409,
          "A cross-organization user must update their global email outside SCIM",
          "uniqueness",
        );
      }
      if (
        shared.rows[0]
        && displayName !== null
        && linkedUser.displayName !== displayName
      ) {
        throw httpError(
          409,
          "A cross-organization user must update their global display name outside SCIM",
          "mutability",
        );
      }
      if (!shared.rows[0]) {
        await client.query(
          `update users set email = $2,
               display_name = coalesce($3, display_name), updated_at = now()
           where id = $1`,
          [existing.userId, email, displayName],
        );
      }
      resultingUserId = existing.userId;
    } else if (emailOwner) {
      const targetMembership = await client.query(
        `select 1 from organization_memberships
         where organization_id = $1 and user_id = $2`,
        [req.scimAuth.organizationId, emailOwner.id],
      );
      if (!targetMembership.rows[0]) {
        throw httpError(
          409,
          "The requested email belongs to an existing Hedgeling user; invite them before SCIM linking",
          "uniqueness",
        );
      }
      resultingUserId = emailOwner.id;
    } else {
      const created = await client.query(
        `insert into users(email, display_name, status)
         values($1, $2, 'active') returning id`,
        [email, displayName],
      );
      resultingUserId = created.rows[0].id;
    }
    const membership = await client.query(
      `insert into organization_memberships(
         organization_id, user_id, membership_type, status, activated_at
       ) values($1, $2, 'internal', $3, case when $3 = 'active' then now() end)
       on conflict(organization_id, user_id) do update
       set status = excluded.status,
           activated_at = case
             when excluded.status = 'active'
               then coalesce(organization_memberships.activated_at, now())
             else organization_memberships.activated_at
           end,
           updated_at = now()
       returning id`,
      [req.scimAuth.organizationId, resultingUserId, active ? "active" : "suspended"],
    );
    if (!active) {
      await client.query(
        "delete from team_memberships where organization_membership_id = $1",
        [membership.rows[0].id],
      );
    }
    await client.query(
      `insert into scim_user_links(organization_id, user_id, external_id)
       values($1, $2, $3)
       on conflict(organization_id, user_id) do update
       set external_id = excluded.external_id, updated_at = now()`,
      [req.scimAuth.organizationId, resultingUserId, externalId],
    );
    const result = await client.query(`${userSelect("and link.user_id = $2")}`, [
      req.scimAuth.organizationId,
      resultingUserId,
    ]);
    await scimAudit(
      client,
      req,
      existing ? "scim.user_updated" : "scim.user_created",
      "user",
      resultingUserId,
      existing,
      result.rows[0],
    );
    return { created: !existing, user: scimUser(result.rows[0]) };
  }).catch((error) => {
    throw mapScimWriteError(error);
  });
}

scimPublicRouter.post("/:organizationId/Users", route(async (req, res) => {
  const result = await upsertUser(req);
  res.status(result.created ? 201 : 200).json(result.user);
}));

scimPublicRouter.put("/:organizationId/Users/:userId", route(async (req, res) => {
  if (!isUuid(req.params.userId)) throw httpError(404, "User not found");
  res.json((await upsertUser(req, req.params.userId)).user);
}));

scimPublicRouter.patch("/:organizationId/Users/:userId", route(async (req, res) => {
  if (!isUuid(req.params.userId)) throw httpError(404, "User not found");
  const current = await query(`${userSelect("and link.user_id = $2")}`, [
    req.scimAuth.organizationId,
    req.params.userId,
  ]);
  if (!current.rows[0]) throw httpError(404, "User not found");
  const body = {
    userName: current.rows[0].email,
    displayName: current.rows[0].displayName,
    externalId: current.rows[0].externalId,
    active: current.rows[0].membershipStatus === "active",
  };
  for (const operation of req.body.Operations || []) {
    const path = clean(operation.path).toLowerCase();
    if (path === "active") body.active = scimBoolean(operation.value);
    else if (path === "displayname") body.displayName = clean(operation.value);
    else if (path === "username") body.userName = clean(operation.value);
    else if (!path && operation.value && typeof operation.value === "object") Object.assign(body, operation.value);
    else throw httpError(400, `Unsupported PATCH path: ${operation.path}`, "invalidPath");
  }
  req.body = body;
  res.json((await upsertUser(req, req.params.userId)).user);
}));

scimPublicRouter.delete("/:organizationId/Users/:userId", route(async (req, res) => {
  if (!isUuid(req.params.userId)) throw httpError(404, "User not found");
  const existing = await query(`${userSelect("and link.user_id = $2")}`, [
    req.scimAuth.organizationId,
    req.params.userId,
  ]);
  if (!existing.rows[0]) throw httpError(404, "User not found");
  req.body = {
    userName: existing.rows[0].email,
    displayName: existing.rows[0].displayName,
    externalId: existing.rows[0].externalId,
    active: false,
  };
  await upsertUser(req, req.params.userId);
  res.status(204).end();
}));

scimPublicRouter.get("/:organizationId/Groups", route(async (req, res) => {
  const filter = clean(req.query.filter);
  const match = /^displayName eq "([^"]+)"$/i.exec(filter);
  if (filter && !match) throw httpError(400, "Only displayName eq filters are supported", "invalidFilter");
  const params = [req.scimAuth.organizationId];
  let where = "";
  if (match) {
    params.push(match[1]);
    where = `and lower(team.name) = lower($${params.length})`;
  }
  const startIndex = Math.max(Number.parseInt(req.query.startIndex, 10) || 1, 1);
  const count = Math.min(Math.max(Number.parseInt(req.query.count, 10) || 100, 0), 100);
  const total = await query(
    `select count(*)::int as count
     from scim_group_links link join teams team on team.id = link.team_id
     where link.organization_id = $1 ${where}`,
    params,
  );
  params.push(count, startIndex - 1);
  const result = await query(
    `${groupSelect(where)} order by lower(team.name)
     limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  res.json({
    schemas: [listSchema],
    totalResults: total.rows[0].count,
    startIndex,
    itemsPerPage: result.rowCount,
    Resources: result.rows.map(scimGroup),
  });
}));

scimPublicRouter.get("/:organizationId/Groups/:groupId", route(async (req, res) => {
  if (!isUuid(req.params.groupId)) throw httpError(404, "Group not found");
  const result = await query(groupSelect("and link.team_id = $2"), [
    req.scimAuth.organizationId,
    req.params.groupId,
  ]);
  if (!result.rows[0]) throw httpError(404, "Group not found");
  res.json(scimGroup(result.rows[0]));
}));

async function replaceGroup(req, groupId = null) {
  const displayName = clean(req.body.displayName);
  const externalId = clean(req.body.externalId || displayName);
  const memberIds = [...new Set(
    (Array.isArray(req.body.members) ? req.body.members : [])
      .map(scimMemberId)
      .filter(Boolean),
  )];
  if (!displayName || displayName.length > 200) throw httpError(400, "displayName is required", "invalidValue");
  if (externalId.length > 500) throw httpError(400, "externalId cannot exceed 500 characters", "invalidValue");
  if (memberIds.some((id) => !isUuid(id))) throw httpError(400, "Group member IDs are invalid", "invalidValue");
  return withTransaction(async (client) => {
    let existing = null;
    if (groupId) {
      const found = await client.query(groupSelect("and link.team_id = $2"), [
        req.scimAuth.organizationId,
        groupId,
      ]);
      existing = found.rows[0];
      if (!existing) throw httpError(404, "Group not found");
    } else {
      const found = await client.query(groupSelect("and link.external_id = $2"), [
        req.scimAuth.organizationId,
        externalId,
      ]);
      existing = found.rows[0] || null;
    }
    let teamId = existing?.teamId;
    if (!teamId) {
      const team = await client.query(
        `insert into teams(organization_id, slug, name)
         values($1, $2, $3) returning id`,
        [
          req.scimAuth.organizationId,
          `scim-${crypto.randomBytes(8).toString("hex")}`,
          displayName,
        ],
      );
      teamId = team.rows[0].id;
      await client.query(
        `insert into scim_group_links(organization_id, team_id, external_id)
         values($1, $2, $3)`,
        [req.scimAuth.organizationId, teamId, externalId],
      );
    } else {
      await client.query(
        "update teams set name = $2, updated_at = now() where id = $1",
        [teamId, displayName],
      );
      await client.query(
        `update scim_group_links
         set external_id = $3, updated_at = now()
         where organization_id = $1 and team_id = $2`,
        [req.scimAuth.organizationId, teamId, externalId],
      );
    }
    if (memberIds.length) {
      const valid = await client.query(
        `select link.user_id, membership.id as membership_id
         from scim_user_links link
         join organization_memberships membership
           on membership.organization_id = link.organization_id
          and membership.user_id = link.user_id
          and membership.status = 'active'
         where link.organization_id = $1 and link.user_id = any($2::uuid[])`,
        [req.scimAuth.organizationId, memberIds],
      );
      if (valid.rowCount !== memberIds.length) {
        throw httpError(400, "Every group member must be an active SCIM-managed user", "invalidValue");
      }
      await client.query("delete from team_memberships where team_id = $1", [teamId]);
      await client.query(
        `insert into team_memberships(team_id, organization_membership_id)
         select $1, membership.id
         from organization_memberships membership
         where membership.organization_id = $2
           and membership.user_id = any($3::uuid[])`,
        [teamId, req.scimAuth.organizationId, memberIds],
      );
    } else {
      await client.query("delete from team_memberships where team_id = $1", [teamId]);
    }
    const result = await client.query(groupSelect("and link.team_id = $2"), [
      req.scimAuth.organizationId,
      teamId,
    ]);
    await scimAudit(
      client,
      req,
      existing ? "scim.group_updated" : "scim.group_created",
      "team",
      teamId,
      existing,
      result.rows[0],
    );
    return { created: !existing, group: scimGroup(result.rows[0]) };
  }).catch((error) => {
    throw mapScimWriteError(error, "group");
  });
}

scimPublicRouter.post("/:organizationId/Groups", route(async (req, res) => {
  const result = await replaceGroup(req);
  res.status(result.created ? 201 : 200).json(result.group);
}));

scimPublicRouter.put("/:organizationId/Groups/:groupId", route(async (req, res) => {
  if (!isUuid(req.params.groupId)) throw httpError(404, "Group not found");
  res.json((await replaceGroup(req, req.params.groupId)).group);
}));

scimPublicRouter.patch("/:organizationId/Groups/:groupId", route(async (req, res) => {
  if (!isUuid(req.params.groupId)) throw httpError(404, "Group not found");
  const current = await query(groupSelect("and link.team_id = $2"), [
    req.scimAuth.organizationId,
    req.params.groupId,
  ]);
  if (!current.rows[0]) throw httpError(404, "Group not found");
  const body = {
    displayName: current.rows[0].displayName,
    externalId: current.rows[0].externalId,
    members: current.rows[0].members,
  };
  for (const operation of req.body.Operations || []) {
    const path = clean(operation.path).toLowerCase();
    const operationName = clean(operation.op).toLowerCase();
    const memberFilter = /^members\[value eq "([0-9a-f-]+)"\]$/i.exec(path);
    if (path === "displayname") body.displayName = clean(operation.value);
    else if (path === "members" || (!path && operation.value?.members)) {
      const values = operation.value?.members || operation.value || [];
      if (operationName === "remove") {
        if (operation.value == null) {
          body.members = [];
        } else {
          const removedIds = new Set(
            (Array.isArray(values) ? values : [values])
              .map(scimMemberId)
              .filter(Boolean),
          );
          body.members = body.members.filter(
            (member) => !removedIds.has(scimMemberId(member)),
          );
        }
      } else if (operationName === "add") {
        body.members = [
          ...body.members,
          ...(Array.isArray(values) ? values : [values])
            .map(scimMemberId)
            .filter(Boolean)
            .map((value) => ({ value })),
        ];
      } else body.members = values;
    } else if (memberFilter && operationName === "remove") {
      body.members = body.members.filter(
        (member) => scimMemberId(member) !== memberFilter[1],
      );
    } else throw httpError(400, `Unsupported PATCH path: ${operation.path}`, "invalidPath");
  }
  req.body = body;
  res.json((await replaceGroup(req, req.params.groupId)).group);
}));

scimPublicRouter.delete("/:organizationId/Groups/:groupId", route(async (req, res) => {
  if (!isUuid(req.params.groupId)) throw httpError(404, "Group not found");
  await withTransaction(async (client) => {
    const before = await client.query(groupSelect("and link.team_id = $2"), [
      req.scimAuth.organizationId,
      req.params.groupId,
    ]);
    if (!before.rows[0]) throw httpError(404, "Group not found");
    await client.query("delete from team_memberships where team_id = $1", [req.params.groupId]);
    await client.query(
      "delete from scim_group_links where organization_id = $1 and team_id = $2",
      [req.scimAuth.organizationId, req.params.groupId],
    );
    await scimAudit(client, req, "scim.group_deleted", "team", req.params.groupId, before.rows[0], null);
  });
  res.status(204).end();
}));

scimPublicRouter.use((error, _req, res, _next) => {
  res.status(error.status || 500).type("application/scim+json").json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(error.status || 500),
    detail: error.message || "SCIM request failed",
    ...(error.scimType ? { scimType: error.scimType } : {}),
  });
});
