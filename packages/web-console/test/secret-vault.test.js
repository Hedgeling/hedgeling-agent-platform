import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { encryptSecret, decryptSecret, vaultReady } from "../src/secret-vault.js";
import { validateGeminiKey } from "../src/organization-ai.js";

test("provider secrets authenticate their tenant, support key rotation, and fail closed", () => {
  const previous = [process.env.HEDGELING_AI_KEYRING, process.env.HEDGELING_AI_KEY_ID];
  try {
    delete process.env.HEDGELING_AI_KEYRING; delete process.env.HEDGELING_AI_KEY_ID;
    assert.equal(vaultReady(), false); assert.throws(() => encryptSecret("secret", "org-a"), { code: "ai_key_storage_unconfigured" });
    const old = crypto.randomBytes(32).toString("base64"); const next = crypto.randomBytes(32).toString("base64");
    process.env.HEDGELING_AI_KEYRING = JSON.stringify({ old }); process.env.HEDGELING_AI_KEY_ID = "old";
    const saved = encryptSecret("private-provider-key", "org-a");
    assert.ok(!JSON.stringify(saved).includes("private-provider-key"));
    assert.equal(decryptSecret(saved, "org-a"), "private-provider-key");
    assert.throws(() => decryptSecret(saved, "org-a", "meta"), { code: "ai_key_unavailable" });
    const meta = encryptSecret("private-meta-key", "org-a", "meta");
    assert.equal(decryptSecret(meta, "org-a", "meta"), "private-meta-key");
    assert.throws(() => decryptSecret(meta, "org-a"), { code: "ai_key_unavailable" });
    assert.throws(() => decryptSecret(saved, "org-b"), { code: "ai_key_unavailable" });
    assert.throws(() => decryptSecret({ ...saved, ciphertext: Buffer.from("tampered").toString("base64") }, "org-a"), { code: "ai_key_unavailable" });
    process.env.HEDGELING_AI_KEYRING = JSON.stringify({ old, next }); process.env.HEDGELING_AI_KEY_ID = "next";
    assert.equal(decryptSecret(saved, "org-a"), "private-provider-key");
    assert.equal(encryptSecret("rotated-key", "org-a").keyId, "next");
  } finally {
    for (const [i, key] of ["HEDGELING_AI_KEYRING", "HEDGELING_AI_KEY_ID"].entries()) { if (previous[i] == null) delete process.env[key]; else process.env[key] = previous[i]; }
  }
});
test("key validation uses metadata and headers, and never reflects provider errors or keys", async () => {
  const key = "test-key-not-real";
  const result = await validateGeminiKey(key, "configured-model", async (url, options) => {
    assert.ok(!url.includes(key)); assert.ok(!url.includes("generateContent"));
    assert.equal(options.headers["x-goog-api-key"], key); assert.equal(options.redirect, "error");
    return new Response("{}", { status: 200 });
  });
  assert.equal(result.model, "configured-model");
  await assert.rejects(() => validateGeminiKey(key, "configured-model", async () => new Response(key, { status: 403 })), (error) => !error.message.includes(key) && error.status === 422);
});
