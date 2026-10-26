import crypto from "node:crypto";
import express from "express";
import { withTransaction } from "./db.js";
import { auditRequest } from "./audit.js";
import { requireProjectPermission } from "./authorization.js";
import { effectiveOrganizationAccess } from "./entitlements.js";
import { projectLifecycleAccess } from "./data-lifecycle-status.js";

const router = express.Router();
const route = (handler) => (req, res, next) => (
  Promise.resolve(handler(req, res)).catch(next)
);

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function configuredPrivateKey() {
  const encoded = String(
    process.env.HEDGELING_LEASE_SIGNING_PRIVATE_KEY || "",
  ).trim();
  if (!encoded) return null;
  try {
    return encoded.includes("BEGIN PRIVATE KEY")
      ? crypto.createPrivateKey(encoded.replace(/\\n/g, "\n"))
      : crypto.createPrivateKey({
        key: Buffer.from(encoded, "base64"),
        format: "der",
        type: "pkcs8",
      });
  } catch {
    throw new Error(
      "HEDGELING_LEASE_SIGNING_PRIVATE_KEY must be an Ed25519 PKCS8 key "
      + "encoded as PEM or base64 DER",
    );
  }
}

function leaseConfiguration() {
  const privateKey = configuredPrivateKey();
  const keyId = String(process.env.HEDGELING_LEASE_SIGNING_KEY_ID || "").trim();
  const ttlHours = Number(process.env.HEDGELING_LEASE_TTL_HOURS || 24);
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 24) {
    throw new Error("HEDGELING_LEASE_TTL_HOURS must be an integer from 1 to 24");
  }
  if (privateKey && privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("The entitlement-lease signing key must be Ed25519");
  }
  if (privateKey && (!keyId || keyId.length > 100)) {
    throw new Error(
      "HEDGELING_LEASE_SIGNING_KEY_ID is required and cannot exceed 100 characters",
    );
  }
  return { privateKey, keyId, ttlHours };
}

export function validateEntitlementLeaseConfiguration() {
  const config = leaseConfiguration();
  if (
    process.env.NODE_ENV === "production"
    && process.env.HEDGELING_SELF_SERVICE_SIGNUP_ENABLED === "true"
    && !config.privateKey
  ) {
    throw new Error(
      "Self-service production deployments require "
      + "HEDGELING_LEASE_SIGNING_PRIVATE_KEY and HEDGELING_LEASE_SIGNING_KEY_ID",
    );
  }
  return config;
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function signEntitlementLease(payload, {
  privateKey,
  keyId,
} = leaseConfiguration()) {
  if (!privateKey) {
    throw httpError(
      503,
      "Entitlement-lease signing is not configured",
      "entitlement_lease_not_configured",
    );
  }
  const header = {
    alg: "EdDSA",
    typ: "HDLG-LEASE",
    kid: keyId,
  };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const signature = crypto.sign(
    null,
    Buffer.from(signingInput, "utf8"),
    privateKey,
  ).toString("base64url");
  return `${signingInput}.${signature}`;
}

export function verifyEntitlementLease(
  token,
  publicKey,
  { now = Math.floor(Date.now() / 1000) } = {},
) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Entitlement lease is malformed");
  const [encodedHeader, encodedPayload, signature] = parts;
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  if (header.alg !== "EdDSA" || header.typ !== "HDLG-LEASE") {
    throw new Error("Entitlement lease header is invalid");
  }
  if (
    !crypto.verify(
      null,
      Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
      publicKey,
      Buffer.from(signature, "base64url"),
    )
  ) {
    throw new Error("Entitlement lease signature is invalid");
  }
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) {
    throw new Error("Entitlement lease timestamps are invalid");
  }
  if (payload.exp <= now) throw new Error("Entitlement lease has expired");
  if (payload.iat > now + 300) throw new Error("Entitlement lease was issued in the future");
  return { header, payload };
}

export function entitlementLeaseExpiration({ now, ttlHours, lifecycle }) {
  const issuedAt = now instanceof Date ? now : new Date(now);
  let expiresAt = new Date(
    issuedAt.getTime() + ttlHours * 60 * 60 * 1000,
  );
  if (!lifecycle || lifecycle.mode === "active") return expiresAt;
  if (lifecycle.mode !== "export_only") {
    throw httpError(
      403,
      "Entitlement leases are unavailable after the data-export window closes",
      "data_lifecycle_export_expired",
    );
  }
  const lifecycleDeadline = new Date(lifecycle.exportAvailableUntil);
  if (
    !Number.isFinite(lifecycleDeadline.getTime())
    || lifecycleDeadline.getTime() <= issuedAt.getTime()
  ) {
    throw httpError(
      403,
      "Entitlement leases are unavailable after the data-export window closes",
      "data_lifecycle_export_expired",
    );
  }
  if (lifecycleDeadline < expiresAt) expiresAt = lifecycleDeadline;
  return expiresAt;
}

async function leaseCommercialProjection(organizationId, projectId) {
  const [extraction, diagnostics, hostedAi, exports, lifecycle, byok] = await Promise.all([
    effectiveOrganizationAccess(organizationId, "local_extraction"),
    effectiveOrganizationAccess(organizationId, "local_diagnostics"),
    effectiveOrganizationAccess(organizationId, "ai_revision"),
    effectiveOrganizationAccess(organizationId, "verified_exports"),
    projectLifecycleAccess(projectId, organizationId),
    effectiveOrganizationAccess(organizationId, "ai_byok"),
  ]);
  if (lifecycle.mode !== "active") {
    return {
      capabilities: {
        localExtraction: false,
        localDiagnostics: false,
        hostedAi: false,
        byokAi: false,
        catalogRead: lifecycle.mode === "export_only",
        productionBuildFallback: true,
      },
      commercialState: lifecycle.mode === "export_only"
        ? "deletion_scheduled"
        : lifecycle.mode === "purged"
          ? "content_purged"
          : "deletion_export_expired",
      planKey: extraction.planKey
        || diagnostics.planKey
        || hostedAi.planKey
        || exports.planKey
        || null,
      reasons: {
        localExtraction: "data_lifecycle_restricted",
        localDiagnostics: "data_lifecycle_restricted",
        hostedAi: "data_lifecycle_restricted",
        catalogRead: lifecycle.mode === "export_only"
          ? "data_lifecycle_export_window"
          : "data_lifecycle_restricted",
      },
      lifecycle,
    };
  }
  return {
    capabilities: {
      localExtraction: extraction.allowed,
      localDiagnostics: diagnostics.allowed,
      hostedAi: hostedAi.allowed,
      byokAi: hostedAi.allowed && byok.allowed,
      catalogRead: exports.allowed,
      productionBuildFallback: true,
    },
    commercialState: extraction.subscriptionState
      || diagnostics.subscriptionState
      || hostedAi.subscriptionState
      || exports.subscriptionState
      || "missing",
    planKey: extraction.planKey
      || diagnostics.planKey
      || hostedAi.planKey
      || exports.planKey
      || null,
    reasons: {
      localExtraction: extraction.reason,
      localDiagnostics: diagnostics.reason,
      hostedAi: hostedAi.reason,
      catalogRead: exports.reason,
    },
  };
}

router.post(
  "/projects/:slug/entitlement-lease",
  requireProjectPermission("strings.view", { ignoreLocale: true }),
  route(async (req, res) => {
    if (
      req.auth?.principalType !== "service_account"
      || !req.auth.serviceAccount?.id
    ) {
      throw httpError(
        403,
        "Entitlement leases require a project service-account credential",
        "service_account_required",
      );
    }
    const config = leaseConfiguration();
    if (!config.privateKey) {
      throw httpError(
        503,
        "Entitlement-lease signing is not configured",
        "entitlement_lease_not_configured",
      );
    }
    const projection = await leaseCommercialProjection(
      req.authorizedProject.organizationId,
      req.authorizedProject.id,
    );
    const now = new Date();
    const expiresAt = entitlementLeaseExpiration({
      now,
      ttlHours: config.ttlHours,
      lifecycle: projection.lifecycle,
    });
    const jti = crypto.randomUUID();
    const payload = {
      iss: "hedgeling",
      aud: "@hedgeling/i18n",
      jti,
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(expiresAt.getTime() / 1000),
      sub: req.auth.serviceAccount.id,
      organizationId: req.authorizedProject.organizationId,
      projectId: req.authorizedProject.id,
      projectSlug: req.authorizedProject.slug,
      planKey: projection.planKey,
      commercialState: projection.commercialState,
      capabilities: projection.capabilities,
    };
    const token = signEntitlementLease(payload, config);
    const publicKey = crypto.createPublicKey(config.privateKey).export({
      format: "der",
      type: "spki",
    }).toString("base64");
    await withTransaction(async (client) => {
      await client.query(
        `insert into entitlement_lease_issuances(
           jti, organization_id, project_id, service_account_id,
           service_account_credential_id, plan_key, key_id, capabilities,
           commercial_state, issued_at, expires_at
         ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          jti,
          req.authorizedProject.organizationId,
          req.authorizedProject.id,
          req.auth.serviceAccount.id,
          req.auth.serviceAccount.credentialId || null,
          projection.planKey,
          config.keyId,
          JSON.stringify(projection.capabilities),
          projection.commercialState,
          now,
          expiresAt,
        ],
      );
      await auditRequest(client, req, {
        action: "entitlement_lease.issued",
        resourceType: "project",
        resourceId: req.authorizedProject.id,
        afterState: {
          jti,
          keyId: config.keyId,
          expiresAt,
          planKey: projection.planKey,
          commercialState: projection.commercialState,
          capabilities: projection.capabilities,
          reasons: projection.reasons,
        },
      });
    });
    res.json({
      lease: token,
      keyId: config.keyId,
      publicKey,
      issuedAt: now,
      expiresAt,
      commercialState: projection.commercialState,
      capabilities: projection.capabilities,
      reasons: projection.reasons,
    });
  }),
);

export default router;
