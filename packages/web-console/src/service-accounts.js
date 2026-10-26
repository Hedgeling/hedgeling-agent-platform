import crypto from "node:crypto";
import express from "express";
import { query, withTransaction } from "./db.js";
import { auditRequest } from "./audit.js";
import { requireOrganizationPermission } from "./authorization.js";
import { isUuid, optionalTimestamp } from "./validation.js";

const router = express.Router();
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

function clean(value) {
  return String(value ?? "").trim();
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function createServiceCredential() {
  const prefix = crypto.randomBytes(8).toString("hex");
  const secret = crypto.randomBytes(32).toString("base64url");
  const token = `hdlg_sa_${prefix}_${secret}`;
  return { prefix, token, digest: digest(token) };
}

function serviceToken(value) {
  const match = /^hdlg_sa_([a-f0-9]{16})_([A-Za-z0-9_-]{40,})$/.exec(String(value || ""));
  return match ? { prefix: match[1], value: String(value) } : null;
}

export async function authenticateServiceAccount(token) {
  const parsed = serviceToken(token);
  if (!parsed) return null;
  const result = await query(
    `select credential.id as "credentialId", credential.token_digest as "tokenDigest",
            account.id, account.organization_id as "organizationId", account.name,
            account.status, organization.status as "organizationStatus"
     from service_account_credentials credential
     join service_accounts account on account.id = credential.service_account_id
     join organizations organization on organization.id = account.organization_id
     where credential.token_prefix = $1 and credential.status = 'active'
       and credential.revoked_at is null
       and (credential.expires_at is null or credential.expires_at > now())`,
    [parsed.prefix],
  );
  const account = result.rows[0];
  if (!account) return null;
  const supplied = Buffer.from(digest(parsed.value), "hex");
  const expected = Buffer.from(account.tokenDigest, "hex");
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  if (account.status !== "active" || account.organizationStatus !== "active") {
    throw httpError(403, "Service account access is suspended");
  }
  await query(
    `update service_account_credentials set last_used_at = now()
     where id = $1
       and (last_used_at is null or last_used_at < now() - interval '5 minutes')`,
    [account.credentialId],
  );
  return {
    method: "service_account",
    principalType: "service_account",
    principalId: account.id,
    serviceAccount: {
      id: account.id,
      organizationId: account.organizationId,
      name: account.name,
      credentialId: account.credentialId,
    },
  };
}

for (const parameter of ["organizationId", "serviceAccountId", "credentialId"]) {
  router.param(parameter, (req, res, next, value) => (
    isUuid(value) ? next() : res.status(400).json({ error: `${parameter} is invalid` })
  ));
}

router.get(
  "/organizations/:organizationId/service-accounts",
  requireOrganizationPermission("api_credentials.manage"),
  route(async (req, res) => {
    const result = await query(
      `select account.id, account.name, account.status,
              account.owner_user_id as "ownerUserId", account.metadata,
              account.created_at as "createdAt", account.updated_at as "updatedAt",
              coalesce(json_agg(json_build_object(
                'id', credential.id,
                'prefix', credential.token_prefix,
                'status', credential.status,
                'expiresAt', credential.expires_at,
                'lastUsedAt', credential.last_used_at,
                'createdAt', credential.created_at
              ) order by credential.created_at desc)
                filter (where credential.id is not null), '[]') as credentials
       from service_accounts account
       left join service_account_credentials credential
         on credential.service_account_id = account.id
       where account.organization_id = $1
       group by account.id order by lower(account.name)`,
      [req.authorizedOrganizationId],
    );
    res.json({ serviceAccounts: result.rows });
  }),
);

router.post(
  "/organizations/:organizationId/service-accounts",
  requireOrganizationPermission("api_credentials.manage"),
  route(async (req, res) => {
    const name = clean(req.body.name);
    if (!name || name.length > 200) throw httpError(400, "Service account name is required and cannot exceed 200 characters");
    const expiresAt = optionalTimestamp(req.body.expiresAt);
    const created = createServiceCredential();
    const result = await withTransaction(async (client) => {
      const account = await client.query(
        `insert into service_accounts(organization_id, name, owner_user_id, metadata)
         values($1, $2, $3, $4)
         returning id, name, status, owner_user_id as "ownerUserId", metadata,
                   created_at as "createdAt"`,
        [
          req.authorizedOrganizationId,
          name,
          req.auth?.user?.id || null,
          JSON.stringify(req.body.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {}),
        ],
      );
      const credential = await client.query(
        `insert into service_account_credentials(
           service_account_id, token_prefix, token_digest, expires_at, created_by_user_id
         ) values($1, $2, $3, $4, $5)
         returning id, token_prefix as prefix, status, expires_at as "expiresAt",
                   created_at as "createdAt"`,
        [account.rows[0].id, created.prefix, created.digest, expiresAt, req.auth?.user?.id || null],
      );
      await auditRequest(client, req, {
        action: "service_account.created",
        resourceType: "service_account",
        resourceId: account.rows[0].id,
        afterState: { ...account.rows[0], credential: credential.rows[0] },
      });
      return { account: account.rows[0], credential: credential.rows[0] };
    });
    res.status(201).json({
      serviceAccount: result.account,
      credential: { ...result.credential, token: created.token },
      warning: "Copy this credential now. It will not be shown again.",
    });
  }),
);

router.post(
  "/organizations/:organizationId/service-accounts/:serviceAccountId/credentials",
  requireOrganizationPermission("api_credentials.manage"),
  route(async (req, res) => {
    const expiresAt = optionalTimestamp(req.body.expiresAt);
    const created = createServiceCredential();
    const credential = await withTransaction(async (client) => {
      const account = await client.query(
        `select id from service_accounts
         where id = $1 and organization_id = $2 and status <> 'revoked'
         for update`,
        [req.params.serviceAccountId, req.authorizedOrganizationId],
      );
      if (!account.rows[0]) throw httpError(404, "Service account not found");
      if (req.body.revokeExisting !== false) {
        await client.query(
          `update service_account_credentials
           set status = 'revoked', revoked_at = now(), revoked_by_user_id = $2
           where service_account_id = $1 and status = 'active'`,
          [req.params.serviceAccountId, req.auth?.user?.id || null],
        );
      }
      const result = await client.query(
        `insert into service_account_credentials(
           service_account_id, token_prefix, token_digest, expires_at, created_by_user_id
         ) values($1, $2, $3, $4, $5)
         returning id, token_prefix as prefix, status, expires_at as "expiresAt",
                   created_at as "createdAt"`,
        [
          req.params.serviceAccountId,
          created.prefix,
          created.digest,
          expiresAt,
          req.auth?.user?.id || null,
        ],
      );
      await auditRequest(client, req, {
        action: "service_account.credential_rotated",
        resourceType: "service_account",
        resourceId: req.params.serviceAccountId,
        afterState: result.rows[0],
        metadata: { revokedExisting: req.body.revokeExisting !== false },
      });
      return result.rows[0];
    });
    res.status(201).json({
      credential: { ...credential, token: created.token },
      warning: "Copy this credential now. It will not be shown again.",
    });
  }),
);

router.delete(
  "/organizations/:organizationId/service-accounts/:serviceAccountId/credentials/:credentialId",
  requireOrganizationPermission("api_credentials.manage"),
  route(async (req, res) => {
    await withTransaction(async (client) => {
      const result = await client.query(
        `update service_account_credentials credential
         set status = 'revoked', revoked_at = now(), revoked_by_user_id = $4
         from service_accounts account
         where credential.id = $1 and credential.service_account_id = account.id
           and account.id = $2 and account.organization_id = $3
           and credential.status = 'active'
         returning credential.id`,
        [
          req.params.credentialId,
          req.params.serviceAccountId,
          req.authorizedOrganizationId,
          req.auth?.user?.id || null,
        ],
      );
      if (!result.rows[0]) throw httpError(404, "Active credential not found");
      await auditRequest(client, req, {
        action: "service_account.credential_revoked",
        resourceType: "service_account_credential",
        resourceId: req.params.credentialId,
      });
    });
    res.status(204).end();
  }),
);

router.patch(
  "/organizations/:organizationId/service-accounts/:serviceAccountId",
  requireOrganizationPermission("api_credentials.manage"),
  route(async (req, res) => {
    const status = clean(req.body.status);
    if (!["active", "suspended", "revoked"].includes(status)) throw httpError(400, "A valid service account status is required");
    const account = await withTransaction(async (client) => {
      const before = await client.query(
        `select id, name, status from service_accounts
         where id = $1 and organization_id = $2 for update`,
        [req.params.serviceAccountId, req.authorizedOrganizationId],
      );
      if (!before.rows[0]) throw httpError(404, "Service account not found");
      const updated = await client.query(
        `update service_accounts set status = $3, updated_at = now()
         where id = $1 and organization_id = $2
         returning id, name, status, updated_at as "updatedAt"`,
        [req.params.serviceAccountId, req.authorizedOrganizationId, status],
      );
      if (status === "revoked") {
        await client.query(
          `update service_account_credentials
           set status = 'revoked', revoked_at = coalesce(revoked_at, now()),
               revoked_by_user_id = coalesce(revoked_by_user_id, $2)
           where service_account_id = $1 and status = 'active'`,
          [req.params.serviceAccountId, req.auth?.user?.id || null],
        );
      }
      await auditRequest(client, req, {
        action: "service_account.status_changed",
        resourceType: "service_account",
        resourceId: req.params.serviceAccountId,
        beforeState: before.rows[0],
        afterState: updated.rows[0],
      });
      return updated.rows[0];
    });
    res.json({ serviceAccount: account });
  }),
);

export default router;
