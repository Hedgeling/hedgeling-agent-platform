import crypto from "node:crypto";

// Versioned server-side wrapping keys, injected by the deployment secret store.
// No plaintext credential is persisted, returned, or included in audit events.
function keyring() {
  try {
    const keys = JSON.parse(process.env.HEDGELING_AI_KEYRING || "{}");
    const active = process.env.HEDGELING_AI_KEY_ID || "";
    if (!active || !Object.hasOwn(keys, active)) throw new Error();
    const decoded = new Map(Object.entries(keys).map(([id, value]) => {
      if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error();
      const key = Buffer.from(value, "base64");
      if (key.length !== 32) throw new Error();
      return [id, key];
    }));
    return { active, keys: decoded };
  } catch {
    throw Object.assign(new Error("Organization key storage is not configured. Contact your administrator."), { status: 503, code: "ai_key_storage_unconfigured" });
  }
}
export function vaultReady() { try { keyring(); return true; } catch { return false; } }
export function encryptSecret(secret, organizationId, provider = "gemini") {
  const ring = keyring();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ring.keys.get(ring.active), iv);
  cipher.setAAD(Buffer.from(`hedgeling:${provider}:${organizationId}`));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { version: 1, keyId: ring.active, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}
export function decryptSecret(envelope, organizationId, provider = "gemini") {
  const ring = keyring();
  try {
    if (envelope.version !== 1 || !ring.keys.has(envelope.keyId)) throw new Error();
    const decipher = crypto.createDecipheriv("aes-256-gcm", ring.keys.get(envelope.keyId), Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(`hedgeling:${provider}:${organizationId}`));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw Object.assign(new Error("The saved AI key could not be opened. Contact your administrator."), { status: 503, code: "ai_key_unavailable" });
  }
}
