import crypto from "node:crypto";
import {
  CognitoIdentityProviderClient,
  GetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import {
  FetchError,
  JwtBaseError,
  NotSupportedError,
  ParameterValidationError,
} from "aws-jwt-verify/error";
import { query, withTransaction } from "./db.js";
import { authenticateServiceAccount } from "./service-accounts.js";
import { authenticateLocal, localSessionToken, validateLocalAuthentication } from "./local-auth.js";

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function cookie(req, name) {
  const item = String(req.get("cookie") || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : "";
}

function ssoCookieSecret() {
  return process.env.HEDGELING_SESSION_SIGNING_SECRET || "";
}

const identityConnectionProofMaxAgeSeconds = 60 * 60 * 24 * 30;
const identityConnectionProofFutureSkewSeconds = 5 * 60;

export function signedIdentityConnection(
  connectionId,
  subject,
  issuedAt = Math.floor(Date.now() / 1000),
) {
  const secret = ssoCookieSecret();
  if (!secret || !connectionId || !subject || !Number.isSafeInteger(issuedAt)) return "";
  const encodedSubject = Buffer.from(String(subject), "utf8").toString("base64url");
  const unsigned = `v1.${connectionId}.${issuedAt}.${encodedSubject}`;
  const signature = crypto.createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

export function identityConnectionFromProof(
  value,
  subject,
  now = Math.floor(Date.now() / 1000),
) {
  const [version, connectionId, issuedAtValue, encodedSubject, signature, ...extra] =
    String(value || "").split(".");
  const issuedAt = Number(issuedAtValue);
  if (
    version !== "v1"
    || !connectionId
    || !encodedSubject
    || !signature
    || extra.length
    || !subject
    || !Number.isSafeInteger(issuedAt)
    || !Number.isSafeInteger(now)
    || issuedAt > now + identityConnectionProofFutureSkewSeconds
    || now - issuedAt > identityConnectionProofMaxAgeSeconds
  ) {
    return null;
  }
  const proofSubject = Buffer.from(encodedSubject, "base64url").toString("utf8");
  if (
    Buffer.from(proofSubject, "utf8").toString("base64url") !== encodedSubject
    || !timingSafeEqualString(proofSubject, subject)
  ) {
    return null;
  }
  const expected = signedIdentityConnection(connectionId, subject, issuedAt);
  return expected && timingSafeEqualString(value, expected) ? connectionId : null;
}

function bearerToken(req) {
  const [scheme, token] = String(req.get("authorization") || "").split(" ");
  if (scheme?.toLowerCase() === "bearer" && token) return token;
  return cookie(req, "hedgeling_access_token");
}

function authMode() {
  return String(process.env.HEDGELING_AUTH_MODE || "cognito");
}

function cognitoConfig() {
  const userPoolId = process.env.COGNITO_USER_POOL_ID || "";
  const clientId = process.env.COGNITO_APP_CLIENT_ID || "";
  if (!userPoolId || !clientId) return null;
  return {
    userPoolId,
    clientId,
    region: process.env.COGNITO_REGION || userPoolId.split("_")[0],
    identityProvider: `cognito:${userPoolId}`,
    userInfoUrl: process.env.COGNITO_USERINFO_URL || "",
    bootstrapAdminGroup: process.env.HEDGELING_COGNITO_SUPER_ADMIN_GROUP || "hedgeling-platform-super-admin",
  };
}

function platformOperationsGroups() {
  return {
    view: process.env.HEDGELING_COGNITO_PAYMENT_OPERATIONS_VIEW_GROUP
      || "hedgeling-payment-operations-view",
    manage: process.env.HEDGELING_COGNITO_PAYMENT_OPERATIONS_MANAGE_GROUP
      || "hedgeling-payment-operations-manage",
  };
}

export function platformOperationsAccess(auth) {
  if (auth?.platformAdmin === true || auth?.user?.platformStaff === true) {
    return { view: true, manage: true };
  }
  if (auth?.principalType !== "user") return { view: false, manage: false };
  const groups = Array.isArray(auth?.cognito?.groups) ? auth.cognito.groups : [];
  const configured = platformOperationsGroups();
  const manage = groups.includes(configured.manage);
  return {
    view: manage || groups.includes(configured.view),
    manage,
  };
}

export function requirePlatformOperationsAccess(req, res, next) {
  const access = platformOperationsAccess(req.auth);
  const required = req.method === "GET" || req.method === "HEAD" ? "view" : "manage";
  if (access[required]) {
    req.platformOperationsAccess = access;
    return next();
  }
  return res.status(403).json({
    error: required === "manage"
      ? "Platform payment-operations management access required"
      : "Platform payment-operations view access required",
  });
}

let verifier = null;
let verifierKey = "";
let idTokenVerifier = null;
let idTokenVerifierKey = "";
let profileClient = null;
let profileClientRegion = "";
let authenticationTestHooks = {};

export function setAuthenticationTestHooks(hooks = {}) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Authentication test hooks are only available in NODE_ENV=test");
  }
  authenticationTestHooks = hooks;
}

function cognitoVerifier(config) {
  const key = `${config.userPoolId}:${config.clientId}`;
  if (!verifier || verifierKey !== key) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: config.userPoolId,
      tokenUse: "access",
      clientId: config.clientId,
    });
    verifierKey = key;
  }
  return verifier;
}

function cognitoIdTokenVerifier(config) {
  const key = `${config.userPoolId}:${config.clientId}`;
  if (!idTokenVerifier || idTokenVerifierKey !== key) {
    idTokenVerifier = CognitoJwtVerifier.create({
      userPoolId: config.userPoolId,
      tokenUse: "id",
      clientId: config.clientId,
    });
    idTokenVerifierKey = key;
  }
  return idTokenVerifier;
}

export async function verifyCognitoIdToken(idToken, expectedNonce) {
  const config = cognitoConfig();
  if (!config) {
    throw Object.assign(
      new Error("Cognito authentication is not configured"),
      { status: 503 },
    );
  }
  if (!idToken || !expectedNonce) {
    throw Object.assign(
      new Error("The SSO identity token or nonce is missing"),
      { status: 401 },
    );
  }
  let payload;
  try {
    payload = authenticationTestHooks.verifyIdToken
      ? await authenticationTestHooks.verifyIdToken(config, idToken)
      : await cognitoIdTokenVerifier(config).verify(idToken);
  } catch (error) {
    const providerFailure = error instanceof FetchError
      || error instanceof ParameterValidationError
      || error instanceof NotSupportedError
      || !(error instanceof JwtBaseError);
    console.error("[auth] Cognito ID token verification failed", {
      name: error?.name || "Error",
      message: error?.message || "Unknown Cognito ID token verification error",
      category: providerFailure ? "provider" : "authentication",
    });
    throw Object.assign(
      new Error(
        providerFailure
          ? "Cognito identity verification is unavailable"
          : "Invalid or expired Cognito identity token",
      ),
      { status: providerFailure ? 503 : 401, cause: error },
    );
  }
  if (
    !payload?.sub
    || !payload?.nonce
    || !timingSafeEqualString(payload.nonce, expectedNonce)
  ) {
    throw Object.assign(
      new Error("The SSO identity token nonce is invalid or expired"),
      { status: 403 },
    );
  }
  return payload;
}

function getUserProfile(response) {
  const profile = Object.fromEntries(
    (response?.UserAttributes || []).map((attribute) => [attribute.Name, attribute.Value]),
  );
  if (response?.Username) profile.username = response.Username;
  return profile;
}

function cognitoProfileClient(config) {
  if (!profileClient || profileClientRegion !== config.region) {
    profileClient = new CognitoIdentityProviderClient({ region: config.region });
    profileClientRegion = config.region;
  }
  return profileClient;
}

const cognitoProfileAuthenticationErrors = new Set([
  "NotAuthorizedException",
  "TokenExpiredException",
]);

export function cognitoProfileLookupStatus(error, source = "get-user") {
  const responseStatus = Number(
    error?.cognitoProfileStatus
    || error?.$metadata?.httpStatusCode,
  );
  const authenticationStatuses = source === "userinfo"
    ? [401, 403]
    : [400, 401, 403];
  return cognitoProfileAuthenticationErrors.has(error?.name)
    || authenticationStatuses.includes(responseStatus)
    ? 401
    : 503;
}

function logCognitoProfileError(error, source) {
  console.error("[auth] Cognito profile lookup failed", {
    source,
    name: error?.name || "Error",
    message: error?.message || "Unknown Cognito profile error",
    httpStatusCode: error?.cognitoProfileStatus
      || error?.$metadata?.httpStatusCode
      || null,
  });
}

async function cognitoUserProfile(config, payload, accessToken) {
  if (authenticationTestHooks.userInfo) {
    return authenticationTestHooks.userInfo(config, accessToken);
  }
  const scopes = String(payload.scope || "").split(/\s+/).filter(Boolean);
  const source = scopes.includes("openid") ? "userinfo" : "get-user";
  try {
    if (source === "userinfo") {
      if (!config.userInfoUrl) {
        throw Object.assign(
          new Error("COGNITO_USERINFO_URL is not configured"),
          { cognitoProfileStatus: 503 },
        );
      }
      const response = await fetch(config.userInfoUrl, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw Object.assign(
          new Error(`UserInfo returned HTTP ${response.status}`),
          { cognitoProfileStatus: response.status },
        );
      }
      return response.json();
    }
    const response = authenticationTestHooks.getUser
      ? await authenticationTestHooks.getUser(config, accessToken)
      : await cognitoProfileClient(config).send(new GetUserCommand({ AccessToken: accessToken }));
    return getUserProfile(response);
  } catch (error) {
    logCognitoProfileError(error, source);
    const status = cognitoProfileLookupStatus(error, source);
    throw Object.assign(
      new Error(
        status === 401
          ? "Cognito user profile authentication failed"
          : "Cognito user profile service is unavailable",
      ),
      { status, cause: error },
    );
  }
}

async function loadOrCreateCognitoUser(config, payload, accessToken, identityConnectionId = null) {
  const groups = Array.isArray(payload["cognito:groups"]) ? payload["cognito:groups"] : [];
  const platformStaff = groups.includes(config.bootstrapAdminGroup);
  const existing = await query(
    `select u.id, u.email, u.display_name as "displayName", u.status, u.platform_staff as "platformStaff"
     from user_identities i
     join users u on u.id = i.user_id
     where i.provider = $1 and i.provider_subject = $2`,
    [config.identityProvider, payload.sub],
  );
  if (existing.rows[0]) {
    return withTransaction(async (client) => {
      const changed = await client.query(
        `update users set platform_staff = $2, updated_at = now()
         where id = $1 and platform_staff is distinct from $2
         returning id, email, display_name as "displayName", status,
                   platform_staff as "platformStaff"`,
        [existing.rows[0].id, platformStaff],
      );
      await client.query(
        `update user_identities set last_authenticated_at = now(),
             identity_connection_id = coalesce($3, identity_connection_id)
         where provider = $1 and provider_subject = $2
           and (
             last_authenticated_at is null
             or last_authenticated_at < now() - interval '5 minutes'
             or ($3::uuid is not null and identity_connection_id is distinct from $3)
           )`,
        [config.identityProvider, payload.sub, identityConnectionId],
      );
      if (changed.rows[0]) {
        await client.query(
          `insert into audit_events(
             actor_type, actor_id, effective_user_id, action, resource_type,
             resource_id, before_state, after_state, metadata
           ) values('user', $1, $1, 'identity.platform_access_synced', 'user', $1, $2, $3, $4)`,
          [
            existing.rows[0].id,
            JSON.stringify({ platformStaff: existing.rows[0].platformStaff }),
            JSON.stringify({ platformStaff }),
            JSON.stringify({ provider: config.identityProvider, group: config.bootstrapAdminGroup }),
          ],
        );
      }
      return changed.rows[0] || { ...existing.rows[0], platformStaff };
    });
  }

  const profile = await cognitoUserProfile(config, payload, accessToken);
  const email = typeof profile?.email === "string" ? profile.email.trim().toLowerCase() : "";
  if (!email || profile?.sub !== payload.sub) {
    throw Object.assign(new Error("First sign-in requires a Cognito profile with a verified email"), { status: 403 });
  }
  if (profile.email_verified !== true && profile.email_verified !== "true") {
    throw Object.assign(new Error("A verified email address is required"), { status: 403 });
  }

  return withTransaction(async (client) => {
    const userResult = await client.query(
      `insert into users(email, display_name, status, platform_staff)
       values($1, $2, 'active', $3)
       on conflict((lower(email))) do update
       set display_name = coalesce(excluded.display_name, users.display_name),
           platform_staff = excluded.platform_staff,
           status = case when users.status = 'invited' then 'active' else users.status end,
           updated_at = now()
       returning id, email, display_name as "displayName", status, platform_staff as "platformStaff"`,
      [email, profile.name || profile.preferred_username || null, platformStaff],
    );
    const user = userResult.rows[0];
    await client.query(
      `insert into user_identities(
         user_id, provider, provider_subject, email_verified,
         last_authenticated_at, identity_connection_id
       )
       values($1, $2, $3, true, now(), $4)
       on conflict(provider, provider_subject) do update
       set last_authenticated_at = now(),
           identity_connection_id = coalesce(excluded.identity_connection_id, user_identities.identity_connection_id)`,
      [user.id, config.identityProvider, payload.sub, identityConnectionId],
    );
    await client.query(
      `insert into audit_events(actor_type, actor_id, effective_user_id, action, resource_type, resource_id, after_state, metadata)
       values('user', $1, $1, 'identity.linked', 'user', $1, $2, $3)`,
      [
        user.id,
        JSON.stringify({ email: user.email, platformStaff: user.platformStaff }),
        JSON.stringify({ provider: config.identityProvider, platformStaff }),
      ],
    );
    return user;
  });
}

async function applySsoJitMembership(user, identityConnectionId) {
  if (!identityConnectionId) return;
  await withTransaction(async (client) => {
    const connectionResult = await client.query(
      `select connection.organization_id, policy.jit_membership_enabled,
              policy.jit_membership_type
       from identity_connections connection
       join organization_identity_policies policy
         on policy.organization_id = connection.organization_id
       join organization_verified_domains domain
         on domain.organization_id = connection.organization_id
        and domain.status = 'verified'
        and domain.domain = split_part(lower($2), '@', 2)
       where connection.id = $1 and connection.status = 'active'
       for update of connection`,
      [identityConnectionId, user.email],
    );
    const connection = connectionResult.rows[0];
    if (!connection?.jit_membership_enabled) return;
    const membership = await client.query(
      `insert into organization_memberships(
         organization_id, user_id, membership_type, status, activated_at
       ) values($1, $2, $3, 'active', now())
       on conflict(organization_id, user_id) do update
       set status = case
             when organization_memberships.status = 'invited' then 'active'
             else organization_memberships.status
           end,
           activated_at = coalesce(organization_memberships.activated_at, now()),
           updated_at = now()
       returning id, status`,
      [connection.organization_id, user.id, connection.jit_membership_type],
    );
    await client.query(
      `insert into audit_events(
         organization_id, actor_type, actor_id, effective_user_id, action,
         resource_type, resource_id, after_state, metadata
       ) values($1, 'user', $2, $2, 'identity.jit_membership_applied',
                'organization_membership', $3, $4, $5)`,
      [
        connection.organization_id,
        user.id,
        membership.rows[0].id,
        JSON.stringify(membership.rows[0]),
        JSON.stringify({ identityConnectionId }),
      ],
    );
  });
}

async function loadMemberships(userId) {
  const result = await query(
    `select
       m.id,
       m.organization_id as "organizationId",
       o.slug as "organizationSlug",
       o.organization_type as "organizationType",
       m.membership_type as "membershipType",
       m.expires_at as "expiresAt"
     from organization_memberships m
     join organizations o on o.id = m.organization_id
     where m.user_id = $1
       and m.status = 'active'
       and o.status = 'active'
       and (m.expires_at is null or m.expires_at > now())
     order by lower(o.name)`,
    [userId],
  );
  return result.rows;
}

export async function authenticateCognitoAccessToken(accessToken, options = {}) {
  const config = cognitoConfig();
  if (!config) throw Object.assign(new Error("Cognito authentication is not configured"), { status: 503 });
  let payload;
  try {
    payload = authenticationTestHooks.verify
      ? await authenticationTestHooks.verify(config, accessToken)
      : await cognitoVerifier(config).verify(accessToken);
  } catch {
    throw Object.assign(new Error("Invalid or expired Cognito access token"), { status: 401 });
  }
  if (options.validatePayload) await options.validatePayload(payload);
  const identityConnectionId = options.identityConnectionId || identityConnectionFromProof(
    options.identityConnectionProof,
    payload.sub,
  );
  const user = await loadOrCreateCognitoUser(
    config,
    payload,
    accessToken,
    identityConnectionId || null,
  );
  if (user.status !== "active") throw Object.assign(new Error("User access is suspended"), { status: 403 });
  await applySsoJitMembership(user, identityConnectionId || null);
  const memberships = await loadMemberships(user.id);
  const auth = {
    method: "cognito",
    principalType: "user",
    principalId: user.id,
    user,
    memberships,
    identityConnectionId: identityConnectionId || null,
    cognito: {
      subject: payload.sub,
      username: payload.username || payload["cognito:username"] || "",
      groups: payload["cognito:groups"] || [],
      scope: payload.scope || "",
    },
  };
  auth.platformOperations = platformOperationsAccess(auth);
  return auth;
}

async function authenticateCognito(req, accessToken) {
  return authenticateCognitoAccessToken(accessToken, {
    identityConnectionProof: cookie(req, "hedgeling_identity_connection"),
  });
}

export function requireAuthentication(req, res, next) {
  const mode = authMode();
  if (!["cognito", "local"].includes(mode)) {
    return res.status(503).json({ error: "Unsupported authentication mode; configure Cognito or explicit local troubleshooting" });
  }
  const authorization = String(req.get("authorization") || "");
  if (/^Basic\s/i.test(authorization)) {
    res.set("WWW-Authenticate", 'Bearer realm="Hedgeling"');
    return res.status(401).json({ error: "Basic Auth has been removed; use a named login or scoped bearer credential" });
  }
  const token = bearerToken(req);
  if (token?.startsWith("hdlg_sa_")) {
    return authenticateServiceAccount(token).then((auth) => {
      if (!auth) return res.status(401).json({ error: "Invalid or expired service-account credential" });
      req.auth = auth;
      return next();
    }).catch(next);
  }
  if (mode === "local") {
    return authenticateLocal(req, token || localSessionToken(req)).then((auth) => {
      if (auth) { req.auth = auth; return next(); }
      if (!token && req.method === "GET" && req.accepts("html") && !req.path.startsWith("/api/")) {
        return res.redirect(302, "/local-login");
      }
      res.set("WWW-Authenticate", 'Bearer realm="Hedgeling Local"');
      return res.status(401).json({ error: "Local authentication required" });
    }).catch(next);
  }
  if (token) {
    return authenticateCognito(req, token).then((auth) => { req.auth = auth; next(); }).catch(next);
  }
  if (req.method === "GET" && req.accepts("html") && !req.path.startsWith("/api/")) {
    return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl || "/")}`);
  }
  res.set("WWW-Authenticate", 'Bearer realm="Hedgeling"');
  return res.status(401).json({ error: "Authentication required" });
}

export function requirePlatformAdmin(req, res, next) {
  if (req.auth?.platformAdmin || req.auth?.user?.platformStaff === true) return next();
  return res.status(403).json({ error: "Platform administrator access required" });
}

export function authenticationConfiguration() {
  const config = cognitoConfig();
  const signupEnabled = process.env.HEDGELING_SELF_SERVICE_SIGNUP_ENABLED === "true";
  return {
    mode: authMode(),
    cognitoConfigured: Boolean(config),
    userPoolId: config?.userPoolId || null,
    appClientId: config?.clientId || null,
    selfServiceSignupEnabled: signupEnabled && Boolean(config),
    trialDays: Number(process.env.HEDGELING_SELF_SERVICE_TRIAL_DAYS || 14),
    termsVersion: process.env.HEDGELING_TERMS_VERSION || "2026-07-30",
    privacyVersion: process.env.HEDGELING_PRIVACY_VERSION || "2026-07-30",
    termsUrl: process.env.HEDGELING_TERMS_URL || null,
    privacyUrl: process.env.HEDGELING_PRIVACY_URL || null,
  };
}

export function validateAuthenticationConfiguration({ warn = console.warn } = {}) {
  const mode = authMode();
  const config = cognitoConfig();
  const trustProxyValue = process.env.HEDGELING_TRUST_PROXY_HOPS || "0";
  const trustProxyHops = Number(trustProxyValue);
  if (!["cognito", "local"].includes(mode)) throw new Error("Basic/hybrid authentication has been removed; use cognito or local");
  if (process.env.HEDGELING_DEV_AUTH === "true") throw new Error("HEDGELING_DEV_AUTH has been removed; use dev:local");
  if (process.env.ADMIN_PASSWORD || process.env.HEDGELING_ADMIN_PASSWORD) {
    throw new Error("Remove retained Basic Auth passwords from the server environment");
  }
  if (mode === "local") validateLocalAuthentication();
  if (mode === "cognito" && !config) {
    throw new Error("Cognito auth mode requires COGNITO_USER_POOL_ID and COGNITO_APP_CLIENT_ID");
  }
  if (
    process.env.HEDGELING_SELF_SERVICE_SIGNUP_ENABLED === "true"
    && mode !== "cognito"
  ) {
    throw new Error("Self-service signup requires Cognito auth mode");
  }
  if (process.env.HEDGELING_SELF_SERVICE_SIGNUP_ENABLED === "true") {
    const configuredTrialDays = Number(
      process.env.HEDGELING_SELF_SERVICE_TRIAL_DAYS || 14,
    );
    if (
      !Number.isInteger(configuredTrialDays)
      || configuredTrialDays < 1
      || configuredTrialDays > 90
    ) {
      throw new Error(
        "HEDGELING_SELF_SERVICE_TRIAL_DAYS must be an integer from 1 to 90",
      );
    }
    if (process.env.NODE_ENV === "production") {
      for (const name of [
        "HEDGELING_TERMS_VERSION",
        "HEDGELING_PRIVACY_VERSION",
      ]) {
        const version = String(process.env[name] || "").trim();
        if (!version || version.length > 100) {
          throw new Error(
            `${name} is required and cannot exceed 100 characters in production`,
          );
        }
      }
      for (const name of ["HEDGELING_TERMS_URL", "HEDGELING_PRIVACY_URL"]) {
        let legalUrl;
        try {
          legalUrl = new URL(process.env[name] || "");
        } catch {
          throw new Error(`${name} must be an absolute HTTPS URL in production`);
        }
        if (legalUrl.protocol !== "https:") {
          throw new Error(`${name} must be an absolute HTTPS URL in production`);
        }
      }
    }
  }
  if (mode === "cognito" && !config.userInfoUrl) {
    throw new Error("Cognito auth mode requires COGNITO_USERINFO_URL for first-sign-in identity linking");
  }
  if (process.env.COGNITO_DOMAIN) {
    if (!process.env.COGNITO_SSO_REDIRECT_URI) {
      throw new Error("COGNITO_DOMAIN requires COGNITO_SSO_REDIRECT_URI");
    }
    if (!ssoCookieSecret()) {
      throw new Error("Enterprise SSO requires HEDGELING_SESSION_SIGNING_SECRET");
    }
    if (
      process.env.NODE_ENV === "production"
      && Buffer.byteLength(ssoCookieSecret()) < 32
    ) {
      throw new Error(
        "HEDGELING_SESSION_SIGNING_SECRET must contain at least 32 bytes in production",
      );
    }
    if (
      process.env.NODE_ENV === "production"
      && !String(process.env.COGNITO_SSO_REDIRECT_URI).startsWith("https://")
    ) {
      throw new Error("COGNITO_SSO_REDIRECT_URI must use HTTPS in production");
    }
  }
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0) {
    throw new Error("HEDGELING_TRUST_PROXY_HOPS must be a non-negative integer");
  }
  if (process.env.NODE_ENV === "production" && trustProxyHops === 0) {
    warn(
      "HEDGELING_TRUST_PROXY_HOPS is 0 in production; authentication rate limits may group all users behind a load balancer.",
    );
  }
  return true;
}
