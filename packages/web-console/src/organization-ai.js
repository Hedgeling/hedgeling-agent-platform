import express from "express";
import { query, withTransaction } from "./db.js";
import { requireOrganizationPermission } from "./authorization.js";
import { effectiveOrganizationAccess } from "./entitlements.js";
import { isHumanDecisionActor } from "./principal-policy.js";
import { auditRequest } from "./audit.js";
import { isUuid } from "./validation.js";
import { fail } from "./action-errors.js";
import { encryptSecret, decryptSecret, vaultReady } from "./secret-vault.js";
import { geminiModelForPlan } from "./ai-credits.js";
import { authRateLimit } from "./auth-rate-limit.js";

const router = express.Router();
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const base = "/organizations/:organizationId/ai-providers";
router.use(base, authRateLimit({ key: "organization-ai-settings", limit: 100, identity: (req) => req.auth?.user?.id }));
router.param("organizationId", (req, res, next, id) => isUuid(id) ? next() : res.status(400).json({ error: "Invalid organization ID" }));

function requireConsoleHuman(req, _res, next) {
  if (!isHumanDecisionActor(req.auth) || req.get("authorization") || !req.get("cookie")) return next(fail(403, "Manage provider keys from your signed-in console", "human_confirmation_required"));
  next();
}
async function byokAccess(organizationId) {
  const access = await effectiveOrganizationAccess(organizationId, "ai_byok");
  if (!access.allowed) throw fail(402, "Organization keys require an active paid platform plan.", "byok_plan_required");
  return access;
}
export async function organizationAiSettings(organizationId) {
  const [settings, credential, entitlement] = await Promise.all([
    query("select translation_mode,revision from organization_ai_settings where organization_id=$1", [organizationId]),
    query("select provider,last_four,validated_at,updated_at from organization_ai_credentials where organization_id=$1", [organizationId]),
    effectiveOrganizationAccess(organizationId, "ai_byok"),
  ]);
  const saved = credential.rows[0];
  return { translationMode: settings.rows[0]?.translation_mode || "managed", revision: settings.rows[0]?.revision || 0,
    chat: { mode: "managed", included: true }, eligible: entitlement.allowed, storageReady: vaultReady(),
    credential: saved ? { provider: saved.provider, maskedKey: `••••${saved.last_four}`, validatedAt: saved.validated_at, updatedAt: saved.updated_at } : null };
}

// Used by every server-side translation adapter; never fall back to managed
// credits when the organization explicitly selected its own provider account.
export async function translationProvider(organizationId) {
  const settings = (await query("select translation_mode from organization_ai_settings where organization_id=$1", [organizationId])).rows[0];
  if (settings?.translation_mode !== "byok") return { mode: "managed", key: null };
  await byokAccess(organizationId);
  const credential = (await query("select encrypted_secret from organization_ai_credentials where organization_id=$1", [organizationId])).rows[0];
  if (!credential) throw fail(409, "Connect an organization key or explicitly switch translation back to Hedgeling AI.", "byok_key_missing");
  return { mode: "byok", key: decryptSecret(credential.encrypted_secret, organizationId) };
}

// Metadata-only validation: no generated content and no inference charge.
export async function validateGeminiKey(key, model, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, {
      headers: { "x-goog-api-key": key }, redirect: "error", signal: AbortSignal.timeout(10000),
    });
  } catch { throw fail(502, "Google could not be reached. Try testing the key again.", "provider_validation_failed"); }
  await response.body?.cancel();
  if (!response.ok) throw fail(422, "Google could not verify access to the configured translation model. Check the key and its permissions.", "provider_key_invalid");
  return { checkedAt: new Date().toISOString(), model };
}

export async function expireAiProposals(client = { query }) {
  await client.query("update organization_ai_proposals set payload='{}',status='expired' where status='pending' and expires_at<=now()");
}

router.get(base, requireOrganizationPermission("ai_providers.view"), route(async (req, res) => {
  res.set("Cache-Control", "no-store").json(await organizationAiSettings(req.authorizedOrganizationId));
}));
router.post(`${base}/test`, requireOrganizationPermission("ai_providers.manage"), requireConsoleHuman, route(async (req, res) => {
  const org = req.authorizedOrganizationId;
  await byokAccess(org);
  let key = req.body?.key;
  let savedEnvelope = null;
  if (key == null) {
    const row = (await query("select encrypted_secret from organization_ai_credentials where organization_id=$1", [org])).rows[0];
    if (!row) throw fail(404, "Connect a Gemini key first");
    savedEnvelope = row.encrypted_secret;
    key = decryptSecret(savedEnvelope, org);
  }
  validateKeyInput(key);
  const access = await effectiveOrganizationAccess(org, "ai_revision");
  const result = await validateGeminiKey(key, geminiModelForPlan(access.limits));
  if (savedEnvelope) await query("update organization_ai_credentials set validated_at=$3 where organization_id=$1 and encrypted_secret=$2::jsonb", [org, JSON.stringify(savedEnvelope), result.checkedAt]);
  res.set("Cache-Control", "no-store").json(result);
}));
function validateKeyInput(key) {
  if (typeof key !== "string" || key.length < 20 || key.length > 512 || !/^[A-Za-z0-9_-]+$/.test(key)) throw fail(400, "Enter a valid Gemini API key", "provider_key_invalid");
}
router.post(`${base}/preview`, requireOrganizationPermission("ai_providers.manage"), requireConsoleHuman, route(async (req, res) => {
  const org = req.authorizedOrganizationId;
  const { action, key, mode } = req.body || {};
  if (!["connect", "remove", "translation_mode"].includes(action)) throw fail(400, "Unknown provider setting");
  if (action !== "remove" && !(action === "translation_mode" && mode === "managed")) await byokAccess(org);
  let payload = {};
  if (action === "connect") { validateKeyInput(key); payload = { encryptedSecret: encryptSecret(key, org), lastFour: key.slice(-4) }; }
  if (action === "translation_mode") {
    if (!["managed", "byok"].includes(mode)) throw fail(400, "Choose a translation provider");
    payload = { mode };
  }
  const proposal = await withTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`ai-settings:${org}`]);
    await expireAiProposals(client);
    const count = (await client.query("select count(*)::int as n from organization_ai_proposals where user_id=$1 and created_at>now()-interval '1 day'", [req.auth.user.id])).rows[0].n;
    if (count >= 100) throw fail(429, "Your daily provider-settings preview limit has been reached");
    const settings = (await client.query("select translation_mode,revision from organization_ai_settings where organization_id=$1", [org])).rows[0];
    const current = settings?.translation_mode || "managed";
    const credential = (await client.query("select last_four from organization_ai_credentials where organization_id=$1", [org])).rows[0];
    if (action === "remove" && !credential) throw fail(409, "There is no saved key to remove");
    if (action === "translation_mode" && mode === "byok" && !credential) throw fail(409, "Connect your Gemini key first");
    if (action === "translation_mode" && mode === current) throw fail(400, "This provider is already selected");
    const preview = { action, title: action === "connect" ? `${credential ? "Replace" : "Connect"} Gemini key` : action === "remove" ? "Remove Gemini key" : "Change translation provider",
      before: action === "translation_mode" ? current : credential ? `••••${credential.last_four}` : "No key connected",
      after: action === "translation_mode" ? mode : action === "connect" ? `••••${payload.lastFour}` : "No key connected",
      effect: action === "remove" && current === "byok" ? "New AI translations will stop until you connect a key or explicitly choose Hedgeling AI."
        : action === "translation_mode" ? mode === "byok" ? "Google bills your organization directly. Hedgeling translation credits will not be charged." : "New AI translations use your Hedgeling credit allowance and approved spending cap."
        : "The key is stored encrypted. Your translation provider stays unchanged. Test access after saving.",
      chat: "Chat stays included with the platform and uses Hedgeling AI." };
    return (await client.query("insert into organization_ai_proposals(organization_id,user_id,action,expected_revision,payload,preview) values($1,$2,$3,$4,$5,$6) returning id,preview,expires_at as \"expiresAt\"", [org, req.auth.user.id, action, settings?.revision || 0, payload, preview])).rows[0];
  });
  res.set("Cache-Control", "no-store").json({ proposal });
}));
router.post(`${base}/proposals/:id/:decision`, requireOrganizationPermission("ai_providers.manage"), requireConsoleHuman, route(async (req, res) => {
  if (!isUuid(req.params.id) || !["confirm", "reject"].includes(req.params.decision)) throw fail(400, "Invalid confirmation");
  const org = req.authorizedOrganizationId;
  await expireAiProposals();
  const outcome = await withTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`ai-settings:${org}`]);
    const p = (await client.query("select * from organization_ai_proposals where id=$1 and organization_id=$2 and user_id=$3 for update", [req.params.id, org, req.auth.user.id])).rows[0];
    if (!p) throw fail(404, "Preview not found");
    if (p.status === "confirmed" && req.params.decision === "confirm") return { replayed: true };
    if (p.status !== "pending" || new Date(p.expires_at) <= new Date()) throw fail(409, "This preview expired or was discarded. Review the change again.");
    if (req.params.decision === "reject") {
      await client.query("update organization_ai_proposals set status='rejected',payload='{}' where id=$1", [p.id]);
      return { rejected: true };
    }
    if (p.action !== "remove" && !(p.action === "translation_mode" && p.payload.mode === "managed")) await byokAccess(org);
    await client.query("insert into organization_ai_settings(organization_id) values($1) on conflict do nothing", [org]);
    const settings = (await client.query("select revision from organization_ai_settings where organization_id=$1 for update", [org])).rows[0];
    if (settings.revision !== p.expected_revision) throw fail(409, "Provider settings changed. Review a fresh preview before saving.");
    if (p.action === "connect") {
      // Verify the wrapping key still exists; rewrap to the active key at commit.
      const encrypted = encryptSecret(decryptSecret(p.payload.encryptedSecret, org), org);
      await client.query(`insert into organization_ai_credentials(organization_id,provider,encrypted_secret,last_four,created_by_user_id)
        values($1,'gemini',$2,$3,$4) on conflict(organization_id) do update set encrypted_secret=$2,last_four=$3,created_by_user_id=$4,validated_at=null,updated_at=now()`, [org, encrypted, p.payload.lastFour, req.auth.user.id]);
    } else if (p.action === "remove") await client.query("delete from organization_ai_credentials where organization_id=$1", [org]);
    else await client.query("update organization_ai_settings set translation_mode=$2 where organization_id=$1", [org, p.payload.mode]);
    await client.query("update organization_ai_settings set revision=revision+1,updated_at=now() where organization_id=$1", [org]);
    await client.query("update organization_ai_proposals set status='confirmed',payload='{}' where id=$1", [p.id]);
    await auditRequest(client, req, { action: `ai_provider.${p.action}`, resourceType: "organization", resourceId: org, beforeState: { value: p.preview.before }, afterState: { value: p.preview.after } });
    return { confirmed: true };
  });
  res.set("Cache-Control", "no-store").json(outcome);
}));

export default router;
