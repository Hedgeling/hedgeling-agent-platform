import crypto from "node:crypto";
import dns from "node:dns/promises";
import express from "express";
import { query, withTransaction } from "./db.js";
import { auditRequest } from "./audit.js";
import { requireOrganizationPermission } from "./authorization.js";
import {
  authenticateCognitoAccessToken,
  signedIdentityConnection,
  verifyCognitoIdToken,
} from "./auth.js";
import { setAuthenticationCookies } from "./cognito-login.js";
import { isUuid, optionalTimestamp } from "./validation.js";

export const identityAdminRouter = express.Router();
export const identityPublicRouter = express.Router();
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
let testHooks = {};

export function setEnterpriseIdentityTestHooks(hooks = {}) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Enterprise identity test hooks are only available in NODE_ENV=test");
  }
  testHooks = hooks;
}

function clean(value) {
  return String(value ?? "").trim();
}

export function cognitoUsernameMatchesProvider(username, providerName) {
  const normalizedProvider = clean(providerName).toLowerCase();
  return Boolean(normalizedProvider)
    && clean(username).toLowerCase().startsWith(`${normalizedProvider}_`);
}

function httpError(status, message, code = null) {
  const error = Object.assign(new Error(message), { status });
  if (code) error.code = code;
  return error;
}

function requireHumanIdentityAdministrator(req, res, next) {
  if (!req.auth?.user?.id) {
    return res.status(403).json({
      error: "Identity administration requires an authenticated human user",
    });
  }
  return next();
}

async function withUniqueConflict(callback, message, code) {
  try {
    return await callback();
  } catch (error) {
    if (error?.code === "23505") throw httpError(409, message, code);
    throw error;
  }
}

function domain(value) {
  const normalized = clean(value).toLowerCase().replace(/\.$/, "");
  if (
    normalized.length > 253
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalized)
  ) {
    throw httpError(400, "A valid registrable email domain is required");
  }
  return normalized;
}

function safeNext(value) {
  const next = clean(value);
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function cookieOptions(maxAge) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `Path=/api/auth/sso; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function setCookie(res, name, value, maxAge = 600) {
  res.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; ${cookieOptions(maxAge)}`);
}

function requestCookie(req, name) {
  const item = String(req.get("cookie") || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : "";
}

function hostedUiConfiguration() {
  const rawDomain = clean(process.env.COGNITO_DOMAIN);
  const clientId = clean(process.env.COGNITO_APP_CLIENT_ID);
  const redirectUri = clean(process.env.COGNITO_SSO_REDIRECT_URI);
  if (!rawDomain || !clientId || !redirectUri) {
    throw httpError(503, "Enterprise SSO is not configured");
  }
  const baseUrl = /^https:\/\//i.test(rawDomain)
    ? rawDomain.replace(/\/$/, "")
    : `https://${rawDomain.replace(/\/$/, "")}`;
  return { baseUrl, clientId, redirectUri };
}

function identityConfiguration(row) {
  return {
    policy: row.policy || {
      passwordLoginEnabled: true,
      ssoRequired: false,
      jitMembershipEnabled: false,
      jitMembershipType: "internal",
    },
    domains: row.domains || [],
    connections: row.connections || [],
    recoveryGrants: row.recoveryGrants || [],
  };
}

for (const parameter of ["organizationId", "domainId", "connectionId", "recoveryGrantId"]) {
  identityAdminRouter.param(parameter, (req, res, next, value) => (
    isUuid(value) ? next() : res.status(400).json({ error: `${parameter} is invalid` })
  ));
}

identityAdminRouter.get(
  "/organizations/:organizationId/identity",
  requireOrganizationPermission("identity.manage"),
  route(async (req, res) => {
    const organizationId = req.authorizedOrganizationId;
    await query(
      `insert into organization_identity_policies(organization_id)
       values($1) on conflict(organization_id) do nothing`,
      [organizationId],
    );
    const [policy, domains, connections, recoveryGrants] = await Promise.all([
      query(
        `select password_login_enabled as "passwordLoginEnabled",
                sso_required as "ssoRequired",
                jit_membership_enabled as "jitMembershipEnabled",
                jit_membership_type as "jitMembershipType",
                updated_at as "updatedAt"
         from organization_identity_policies where organization_id = $1`,
        [organizationId],
      ),
      query(
        `select id, domain, status, verified_at as "verifiedAt",
                created_at as "createdAt"
         from organization_verified_domains
         where organization_id = $1 order by domain`,
        [organizationId],
      ),
      query(
        `select id, connection_type as "connectionType", display_name as "displayName",
                cognito_provider_name as "cognitoProviderName", status, metadata,
                created_at as "createdAt", updated_at as "updatedAt"
         from identity_connections
         where organization_id = $1 order by lower(display_name)`,
        [organizationId],
      ),
      query(
        `select grant_record.id, grant_record.user_id as "userId", users.email,
                grant_record.reason, grant_record.expires_at as "expiresAt",
                grant_record.created_at as "createdAt"
         from recovery_login_grants grant_record
         join users on users.id = grant_record.user_id
         where grant_record.organization_id = $1 and grant_record.revoked_at is null
           and grant_record.expires_at > now()
         order by grant_record.expires_at`,
        [organizationId],
      ),
    ]);
    res.json(identityConfiguration({
      policy: policy.rows[0],
      domains: domains.rows,
      connections: connections.rows,
      recoveryGrants: recoveryGrants.rows,
    }));
  }),
);

identityAdminRouter.patch(
  "/organizations/:organizationId/identity/policy",
  requireOrganizationPermission("identity.manage"),
  requireHumanIdentityAdministrator,
  route(async (req, res) => {
    for (const key of ["passwordLoginEnabled", "ssoRequired", "jitMembershipEnabled"]) {
      if (req.body[key] != null && typeof req.body[key] !== "boolean") {
        throw httpError(400, `${key} must be boolean`);
      }
    }
    const membershipTypeInput = req.body.jitMembershipType;
    if (
      membershipTypeInput != null
      && !["internal", "external"].includes(clean(membershipTypeInput))
    ) {
      throw httpError(400, "jitMembershipType must be internal or external");
    }
    const policy = await withTransaction(async (client) => {
      await client.query(
        `insert into organization_identity_policies(organization_id)
         values($1) on conflict(organization_id) do nothing`,
        [req.authorizedOrganizationId],
      );
      const before = await client.query(
        `select password_login_enabled as "passwordLoginEnabled",
                sso_required as "ssoRequired",
                jit_membership_enabled as "jitMembershipEnabled",
                jit_membership_type as "jitMembershipType"
         from organization_identity_policies
         where organization_id = $1 for update`,
        [req.authorizedOrganizationId],
      );
      const ssoRequired = req.body.ssoRequired ?? before.rows[0].ssoRequired;
      const membershipType = membershipTypeInput == null
        ? before.rows[0].jitMembershipType
        : clean(membershipTypeInput);
      let passwordLoginEnabled = req.body.passwordLoginEnabled
        ?? before.rows[0].passwordLoginEnabled;
      if (ssoRequired) {
        const ready = await client.query(
          `select
             exists (
               select 1 from identity_connections
               where organization_id = $1 and status = 'active'
             )
             and exists (
               select 1 from organization_verified_domains
               where organization_id = $1 and status = 'verified'
             ) as ready`,
          [req.authorizedOrganizationId],
        );
        if (!ready.rows[0].ready) {
          throw httpError(409, "Activate an identity connection and verify a domain before requiring SSO");
        }
        passwordLoginEnabled = false;
      }
      const updated = await client.query(
        `update organization_identity_policies
         set password_login_enabled = $2, sso_required = $3,
             jit_membership_enabled = $4, jit_membership_type = $5,
             updated_by_user_id = $6, updated_at = now()
         where organization_id = $1
         returning password_login_enabled as "passwordLoginEnabled",
                   sso_required as "ssoRequired",
                   jit_membership_enabled as "jitMembershipEnabled",
                   jit_membership_type as "jitMembershipType",
                   updated_at as "updatedAt"`,
        [
          req.authorizedOrganizationId,
          passwordLoginEnabled,
          ssoRequired,
          req.body.jitMembershipEnabled ?? before.rows[0].jitMembershipEnabled,
          membershipType,
          req.auth?.user?.id || null,
        ],
      );
      await auditRequest(client, req, {
        action: "identity.policy_updated",
        resourceType: "organization_identity_policy",
        resourceId: req.authorizedOrganizationId,
        beforeState: before.rows[0],
        afterState: updated.rows[0],
      });
      return updated.rows[0];
    });
    res.json({ policy });
  }),
);

identityAdminRouter.post(
  "/organizations/:organizationId/identity/domains",
  requireOrganizationPermission("identity.manage"),
  requireHumanIdentityAdministrator,
  route(async (req, res) => {
    const claimedDomain = domain(req.body.domain);
    const token = crypto.randomBytes(24).toString("base64url");
    const tokenDigest = crypto.createHash("sha256").update(token).digest("hex");
    const record = await withUniqueConflict(() => withTransaction(async (client) => {
      const result = await client.query(
        `insert into organization_verified_domains(
           organization_id, domain, verification_digest
         ) values($1, $2, $3)
         returning id, domain, status, created_at as "createdAt"`,
        [req.authorizedOrganizationId, claimedDomain, tokenDigest],
      );
      await auditRequest(client, req, {
        action: "identity.domain_claimed",
        resourceType: "verified_domain",
        resourceId: result.rows[0].id,
        afterState: result.rows[0],
      });
      return result.rows[0];
    }), "This domain is already claimed by an organization", "identity_domain_conflict");
    res.status(201).json({
      domain: record,
      dns: {
        type: "TXT",
        name: `_hedgeling-verification.${claimedDomain}`,
        value: `hedgeling-verification=${token}`,
      },
      warning: "The DNS verification value is shown only in this response.",
    });
  }),
);

identityAdminRouter.post(
  "/organizations/:organizationId/identity/domains/:domainId/verify",
  requireOrganizationPermission("identity.manage"),
  requireHumanIdentityAdministrator,
  route(async (req, res) => {
    const record = await query(
      `select id, domain, verification_digest as "verificationDigest", status
       from organization_verified_domains
       where id = $1 and organization_id = $2`,
      [req.params.domainId, req.authorizedOrganizationId],
    );
    if (!record.rows[0]) throw httpError(404, "Domain claim not found");
    if (record.rows[0].status === "verified") return res.json({ domain: record.rows[0] });
    const records = testHooks.resolveTxt
      ? await testHooks.resolveTxt(`_hedgeling-verification.${record.rows[0].domain}`)
      : await dns.resolveTxt(`_hedgeling-verification.${record.rows[0].domain}`)
        .catch(() => []);
    const values = records.map((parts) => parts.join(""));
    const matched = values.some((value) => {
      const token = value.startsWith("hedgeling-verification=")
        ? value.slice("hedgeling-verification=".length)
        : "";
      return token
        && crypto.createHash("sha256").update(token).digest("hex")
          === record.rows[0].verificationDigest;
    });
    if (!matched) throw httpError(409, "The required DNS TXT verification record was not found");
    const verified = await withTransaction(async (client) => {
      const result = await client.query(
        `update organization_verified_domains
         set status = 'verified', verified_at = now(), verified_by_user_id = $3,
             updated_at = now()
         where id = $1 and organization_id = $2
         returning id, domain, status, verified_at as "verifiedAt"`,
        [req.params.domainId, req.authorizedOrganizationId, req.auth?.user?.id || null],
      );
      await auditRequest(client, req, {
        action: "identity.domain_verified",
        resourceType: "verified_domain",
        resourceId: req.params.domainId,
        afterState: result.rows[0],
      });
      return result.rows[0];
    });
    res.json({ domain: verified });
  }),
);

identityAdminRouter.delete(
  "/organizations/:organizationId/identity/domains/:domainId",
  requireOrganizationPermission("identity.manage"),
  requireHumanIdentityAdministrator,
  route(async (req, res) => {
    await withTransaction(async (client) => {
      const safety = await client.query(
        `select policy.sso_required,
                domain.status,
                (
                  select count(*)::int
                  from organization_verified_domains other_domain
                  where other_domain.organization_id = $2
                    and other_domain.status = 'verified'
                    and other_domain.id <> $1
                ) as other_verified_domains
         from organization_verified_domains domain
         join organization_identity_policies policy
           on policy.organization_id = domain.organization_id
         where domain.id = $1 and domain.organization_id = $2
         for update of domain`,
        [req.params.domainId, req.authorizedOrganizationId],
      );
      if (!safety.rows[0]) throw httpError(404, "Active domain claim not found");
      if (
        safety.rows[0].sso_required
        && safety.rows[0].status === "verified"
        && safety.rows[0].other_verified_domains === 0
      ) {
        throw httpError(409, "Disable required SSO or verify another domain before revoking this domain");
      }
      const result = await client.query(
        `update organization_verified_domains
         set status = 'revoked', revoked_at = now(), updated_at = now()
         where id = $1 and organization_id = $2 and status <> 'revoked'
         returning id, domain`,
        [req.params.domainId, req.authorizedOrganizationId],
      );
      if (!result.rows[0]) throw httpError(404, "Active domain claim not found");
      await auditRequest(client, req, {
        action: "identity.domain_revoked",
        resourceType: "verified_domain",
        resourceId: req.params.domainId,
        beforeState: result.rows[0],
      });
    });
    res.status(204).end();
  }),
);

identityAdminRouter.post(
  "/organizations/:organizationId/identity/connections",
  requireOrganizationPermission("identity.manage"),
  requireHumanIdentityAdministrator,
  route(async (req, res) => {
    const connectionType = clean(req.body.connectionType).toLowerCase();
    const displayName = clean(req.body.displayName);
    const providerName = clean(req.body.cognitoProviderName);
    if (!["saml", "oidc"].includes(connectionType)) throw httpError(400, "Connection type must be saml or oidc");
    if (!displayName || displayName.length > 200) throw httpError(400, "Connection display name is required");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(providerName)) throw httpError(400, "A valid Cognito provider name is required");
    const connection = await withTransaction(async (client) => {
      const result = await client.query(
        `insert into identity_connections(
           organization_id, connection_type, display_name,
           cognito_provider_name, metadata, created_by_user_id
         ) values($1, $2, $3, $4, $5, $6)
         returning id, connection_type as "connectionType", display_name as "displayName",
                   cognito_provider_name as "cognitoProviderName", status, metadata`,
        [
          req.authorizedOrganizationId,
          connectionType,
          displayName,
          providerName,
          JSON.stringify({}),
          req.auth?.user?.id || null,
        ],
      );
      await auditRequest(client, req, {
        action: "identity.connection_created",
        resourceType: "identity_connection",
        resourceId: result.rows[0].id,
        afterState: result.rows[0],
      });
      return result.rows[0];
    });
    res.status(201).json({ connection });
  }),
);

identityAdminRouter.patch(
  "/organizations/:organizationId/identity/connections/:connectionId",
  requireOrganizationPermission("identity.manage"),
  requireHumanIdentityAdministrator,
  route(async (req, res) => {
    const status = clean(req.body.status);
    if (!["draft", "active", "disabled"].includes(status)) throw httpError(400, "A valid connection status is required");
    const connection = await withTransaction(async (client) => {
      if (status === "active") {
        const verified = await client.query(
          `select 1 from organization_verified_domains
           where organization_id = $1 and status = 'verified' limit 1`,
          [req.authorizedOrganizationId],
        );
        if (!verified.rows[0]) throw httpError(409, "Verify an organization domain before activating SSO");
      }
      const before = await client.query(
        `select id, status from identity_connections
         where id = $1 and organization_id = $2 for update`,
        [req.params.connectionId, req.authorizedOrganizationId],
      );
      if (!before.rows[0]) throw httpError(404, "Identity connection not found");
      if (status !== "active" && before.rows[0].status === "active") {
        const safety = await client.query(
          `select policy.sso_required,
                  (
                    select count(*)::int
                    from identity_connections other_connection
                    where other_connection.organization_id = $1
                      and other_connection.status = 'active'
                      and other_connection.id <> $2
                  ) as other_active_connections
           from organization_identity_policies policy
           where policy.organization_id = $1`,
          [req.authorizedOrganizationId, req.params.connectionId],
        );
        if (safety.rows[0]?.sso_required && safety.rows[0].other_active_connections === 0) {
          throw httpError(409, "Disable required SSO or activate another connection before disabling this connection");
        }
      }
      const result = await client.query(
        `update identity_connections set status = $3, updated_at = now()
         where id = $1 and organization_id = $2
         returning id, connection_type as "connectionType",
                   display_name as "displayName",
                   cognito_provider_name as "cognitoProviderName",
                   status, metadata, updated_at as "updatedAt"`,
        [req.params.connectionId, req.authorizedOrganizationId, status],
      );
      await auditRequest(client, req, {
        action: "identity.connection_status_changed",
        resourceType: "identity_connection",
        resourceId: req.params.connectionId,
        beforeState: before.rows[0],
        afterState: result.rows[0],
      });
      return result.rows[0];
    });
    res.json({ connection });
  }),
);

identityAdminRouter.post(
  "/organizations/:organizationId/identity/recovery-grants",
  requireOrganizationPermission("identity.manage"),
  requireHumanIdentityAdministrator,
  route(async (req, res) => {
    const userId = clean(req.body.userId);
    const reason = clean(req.body.reason);
    const expiresAt = optionalTimestamp(req.body.expiresAt);
    if (!isUuid(userId) || !reason || !expiresAt) throw httpError(400, "User, reason, and expiry are required");
    if (reason.length > 1000) throw httpError(400, "Recovery reason cannot exceed 1000 characters");
    if (new Date(expiresAt).getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      throw httpError(400, "Recovery login grants cannot exceed 24 hours");
    }
    const grant = await withUniqueConflict(() => withTransaction(async (client) => {
      const membership = await client.query(
        `select 1 from organization_memberships
         where organization_id = $1 and user_id = $2 and status = 'active'`,
        [req.authorizedOrganizationId, userId],
      );
      if (!membership.rows[0]) throw httpError(400, "Recovery user must be an active organization member");
      await client.query(
        `update recovery_login_grants
         set revoked_at = now(), revoked_by_user_id = $3
         where organization_id = $1 and user_id = $2 and revoked_at is null
           and expires_at <= now()`,
        [req.authorizedOrganizationId, userId, req.auth?.user?.id || null],
      );
      const result = await client.query(
        `insert into recovery_login_grants(
           organization_id, user_id, reason, expires_at, granted_by_user_id
         ) values($1, $2, $3, $4, $5)
         returning id, user_id as "userId", reason, expires_at as "expiresAt",
                   created_at as "createdAt"`,
        [req.authorizedOrganizationId, userId, reason, expiresAt, req.auth?.user?.id],
      );
      await auditRequest(client, req, {
        action: "identity.recovery_granted",
        resourceType: "recovery_login_grant",
        resourceId: result.rows[0].id,
        afterState: result.rows[0],
      });
      return result.rows[0];
    }), "This user already has an active recovery login grant", "identity_recovery_conflict");
    res.status(201).json({ recoveryGrant: grant });
  }),
);

identityAdminRouter.delete(
  "/organizations/:organizationId/identity/recovery-grants/:recoveryGrantId",
  requireOrganizationPermission("identity.manage"),
  requireHumanIdentityAdministrator,
  route(async (req, res) => {
    await withTransaction(async (client) => {
      const result = await client.query(
        `update recovery_login_grants
         set revoked_at = now(), revoked_by_user_id = $3
         where id = $1 and organization_id = $2 and revoked_at is null
         returning id, user_id as "userId", reason`,
        [req.params.recoveryGrantId, req.authorizedOrganizationId, req.auth?.user?.id || null],
      );
      if (!result.rows[0]) throw httpError(404, "Active recovery grant not found");
      await auditRequest(client, req, {
        action: "identity.recovery_revoked",
        resourceType: "recovery_login_grant",
        resourceId: req.params.recoveryGrantId,
        beforeState: result.rows[0],
      });
    });
    res.status(204).end();
  }),
);

identityPublicRouter.post("/discover", route(async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const emailDomain = email.includes("@") ? email.split("@").pop() : "";
  const recoveryRequested = req.body.recovery === true;
  if (!emailDomain) throw httpError(400, "A valid email address is required");
  const result = await query(
    `select connection.id, connection.cognito_provider_name as "providerName",
            policy.password_login_enabled as "passwordLoginEnabled",
            policy.sso_required as "ssoRequired"
     from organization_verified_domains domain
     left join identity_connections connection
       on connection.organization_id = domain.organization_id
      and connection.status = 'active'
     join organization_identity_policies policy
       on policy.organization_id = domain.organization_id
     where domain.domain = $1 and domain.status = 'verified'
     order by connection.created_at limit 1`,
    [emailDomain],
  );
  const connection = result.rows[0];
  if (!connection) return res.json({ method: "password", passwordLoginEnabled: true });
  if (recoveryRequested) {
    return res.json({
      method: "password",
      passwordLoginEnabled: true,
    });
  }
  if (!connection.id) {
    return res.json({
      method: "password",
      passwordLoginEnabled: connection.passwordLoginEnabled,
      ssoRequired: connection.ssoRequired,
      ssoUnavailable: connection.ssoRequired,
    });
  }
  const config = hostedUiConfiguration();
  const state = crypto.randomBytes(24).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const nonce = crypto.randomBytes(24).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const parameters = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: config.redirectUri,
    identity_provider: connection.providerName,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  setCookie(res, "hedgeling_sso_state", state);
  setCookie(res, "hedgeling_sso_verifier", verifier);
  setCookie(res, "hedgeling_sso_nonce", nonce);
  setCookie(res, "hedgeling_sso_connection", connection.id);
  setCookie(res, "hedgeling_sso_next", safeNext(req.body.next));
  return res.json({
    method: "sso",
    url: `${config.baseUrl}/oauth2/authorize?${parameters.toString()}`,
    passwordLoginEnabled: connection.passwordLoginEnabled,
    ssoRequired: connection.ssoRequired,
  });
}));

identityPublicRouter.get("/sso/callback", route(async (req, res) => {
  const state = clean(req.query.state);
  const expectedState = requestCookie(req, "hedgeling_sso_state");
  const verifier = requestCookie(req, "hedgeling_sso_verifier");
  const nonce = requestCookie(req, "hedgeling_sso_nonce");
  const connectionId = requestCookie(req, "hedgeling_sso_connection");
  const next = safeNext(requestCookie(req, "hedgeling_sso_next"));
  if (
    !state
    || !expectedState
    || state !== expectedState
    || !verifier
    || !nonce
    || !isUuid(connectionId)
  ) {
    throw httpError(400, "The SSO callback state is invalid or expired");
  }
  const connection = await query(
    `select id, cognito_provider_name as "providerName"
     from identity_connections where id = $1 and status = 'active'`,
    [connectionId],
  );
  if (!connection.rows[0]) throw httpError(403, "The identity connection is not active");
  const config = hostedUiConfiguration();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code: clean(req.query.code),
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });
  const tokenResult = testHooks.exchangeCode
    ? await testHooks.exchangeCode({ connectionId, body })
    : await fetch(`${config.baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    }).then(async (response) => {
      if (!response.ok) throw httpError(401, "The SSO authorization code was not accepted");
      return response.json();
    });
  if (!tokenResult.access_token || !tokenResult.id_token) {
    throw httpError(401, "The SSO token response was incomplete");
  }
  const identityPayload = await verifyCognitoIdToken(tokenResult.id_token, nonce);
  const authentication = await authenticateCognitoAccessToken(tokenResult.access_token, {
    identityConnectionId: connectionId,
    validatePayload: (payload) => {
      const username = clean(payload.username || payload["cognito:username"]);
      if (!cognitoUsernameMatchesProvider(username, connection.rows[0].providerName)) {
        throw httpError(403, "The SSO token did not originate from the selected identity provider");
      }
    },
  });
  if (identityPayload.sub !== authentication.cognito.subject) {
    throw httpError(
      403,
      "The SSO identity and access tokens do not identify the same user",
    );
  }
  setAuthenticationCookies(res, {
    AuthenticationResult: {
      AccessToken: tokenResult.access_token,
      RefreshToken: tokenResult.refresh_token,
      ExpiresIn: tokenResult.expires_in,
    },
  });
  const identityCookie = signedIdentityConnection(
    connectionId,
    authentication.cognito.subject,
  );
  if (!identityCookie) throw httpError(503, "SSO session signing is not configured");
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.append(
    "Set-Cookie",
    `hedgeling_identity_connection=${encodeURIComponent(identityCookie)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure}`,
  );
  for (const name of [
    "hedgeling_sso_state",
    "hedgeling_sso_verifier",
    "hedgeling_sso_nonce",
    "hedgeling_sso_connection",
    "hedgeling_sso_next",
  ]) {
    setCookie(res, name, "", 0);
  }
  res.redirect(302, next);
}));
