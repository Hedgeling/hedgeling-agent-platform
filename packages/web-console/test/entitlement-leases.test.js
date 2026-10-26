import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  entitlementLeaseExpiration,
  signEntitlementLease,
  validateEntitlementLeaseConfiguration,
  verifyEntitlementLease,
} from "../src/entitlement-leases.js";

function withEnv(values, fn) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(values)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("lease signing remains optional outside self-service production", () => withEnv({
  NODE_ENV: "development",
  HEDGELING_SELF_SERVICE_SIGNUP_ENABLED: null,
  HEDGELING_LEASE_SIGNING_PRIVATE_KEY: null,
  HEDGELING_LEASE_SIGNING_KEY_ID: null,
  HEDGELING_LEASE_TTL_HOURS: null,
}, () => {
  const configuration = validateEntitlementLeaseConfiguration();
  assert.equal(configuration.privateKey, null);
  assert.equal(configuration.ttlHours, 24);
}));

test("self-service production requires an Ed25519 signing key", () => withEnv({
  NODE_ENV: "production",
  HEDGELING_SELF_SERVICE_SIGNUP_ENABLED: "true",
  HEDGELING_LEASE_SIGNING_PRIVATE_KEY: null,
  HEDGELING_LEASE_SIGNING_KEY_ID: null,
}, () => {
  assert.throws(
    () => validateEntitlementLeaseConfiguration(),
    /require HEDGELING_LEASE_SIGNING_PRIVATE_KEY/,
  );
}));

test("signed entitlement leases verify and preserve commercial capabilities", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const payload = {
    iss: "hedgeling",
    aud: "@hedgeling/i18n",
    jti: crypto.randomUUID(),
    iat: 100,
    exp: 200,
    capabilities: {
      localExtraction: false,
      localDiagnostics: false,
      catalogRead: true,
      productionBuildFallback: true,
    },
  };
  const token = signEntitlementLease(payload, {
    privateKey,
    keyId: "launch-2026-07",
  });
  const verified = verifyEntitlementLease(token, publicKey, { now: 150 });
  assert.equal(verified.header.kid, "launch-2026-07");
  assert.deepEqual(verified.payload, payload);
});

test("lease verification fails closed after expiration or on tampering", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const token = signEntitlementLease(
    { iat: 100, exp: 200, capabilities: {} },
    { privateKey, keyId: "test" },
  );
  assert.throws(
    () => verifyEntitlementLease(token, publicKey, { now: 200 }),
    /expired/,
  );
  const tamperedParts = token.split(".");
  tamperedParts[2] = `${tamperedParts[2][0] === "A" ? "B" : "A"}${tamperedParts[2].slice(1)}`;
  assert.throws(
    () => verifyEntitlementLease(tamperedParts.join("."), publicKey, { now: 150 }),
    /signature/,
  );
});

test("lifecycle leases clamp to the export deadline and reject dead windows", () => {
  const now = new Date("2026-08-09T12:00:00.000Z");
  assert.equal(
    entitlementLeaseExpiration({
      now,
      ttlHours: 24,
      lifecycle: {
        mode: "export_only",
        exportAvailableUntil: "2026-08-09T18:00:00.000Z",
      },
    }).toISOString(),
    "2026-08-09T18:00:00.000Z",
  );
  assert.throws(
    () => entitlementLeaseExpiration({
      now,
      ttlHours: 24,
      lifecycle: {
        mode: "export_only",
        exportAvailableUntil: "2026-08-09T11:59:59.000Z",
      },
    }),
    (error) => error.status === 403 && error.code === "data_lifecycle_export_expired",
  );
  assert.throws(
    () => entitlementLeaseExpiration({
      now,
      ttlHours: 24,
      lifecycle: { mode: "purged" },
    }),
    (error) => error.status === 403 && error.code === "data_lifecycle_export_expired",
  );
});
