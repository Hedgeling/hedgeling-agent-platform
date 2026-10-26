import assert from "node:assert/strict";
import test from "node:test";
import { auditActor } from "../src/audit.js";
import {
  identityConnectionFromProof,
  signedIdentityConnection,
  validateAuthenticationConfiguration,
} from "../src/auth.js";
import { cognitoUsernameMatchesProvider } from "../src/enterprise-identity.js";
import { mapScimWriteError } from "../src/scim.js";
import { authenticateServiceAccount } from "../src/service-accounts.js";

function withEnv(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("audit actors preserve human, service-account, system-agent, and platform attribution", () => {
  assert.deepEqual(auditActor({
    principalType: "service_account",
    serviceAccount: { id: "11111111-1111-4111-8111-111111111111" },
  }), {
    actorType: "service_account",
    actorId: "11111111-1111-4111-8111-111111111111",
    effectiveUserId: null,
  });
  assert.deepEqual(auditActor({
    principalType: "system_agent",
    principalId: "22222222-2222-4222-8222-222222222222",
  }), {
    actorType: "system_agent",
    actorId: "22222222-2222-4222-8222-222222222222",
    effectiveUserId: null,
  });
  assert.deepEqual(auditActor({ user: { id: "33333333-3333-4333-8333-333333333333" } }), {
    actorType: "user",
    actorId: "33333333-3333-4333-8333-333333333333",
    effectiveUserId: "33333333-3333-4333-8333-333333333333",
  });
  assert.deepEqual(auditActor({ platformAdmin: true }), {
    actorType: "platform",
    actorId: null,
    effectiveUserId: null,
  });
});

test("identity connection proofs bind the provider connection, subject, and expiry", () => withEnv({
  HEDGELING_SESSION_SIGNING_SECRET: "test-session-secret",
  ADMIN_PASSWORD: null,
  HEDGELING_ADMIN_PASSWORD: null,
}, () => {
  const connectionId = "44444444-4444-4444-8444-444444444444";
  const subject = "55555555-5555-4555-8555-555555555555";
  const issuedAt = 1_800_000_000;
  const value = signedIdentityConnection(connectionId, subject, issuedAt);
  assert.match(value, new RegExp(`^v1\\.${connectionId}\\.${issuedAt}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$`));
  assert.equal(value, signedIdentityConnection(connectionId, subject, issuedAt));
  assert.equal(identityConnectionFromProof(value, subject, issuedAt + 60), connectionId);
  assert.equal(identityConnectionFromProof(value, "different-subject", issuedAt + 60), null);
  assert.equal(identityConnectionFromProof(value, subject, issuedAt + 31 * 24 * 60 * 60), null);
  assert.equal(identityConnectionFromProof(`${value}tampered`, subject, issuedAt + 60), null);
  assert.equal(identityConnectionFromProof(`${connectionId}.legacy-signature`, subject, issuedAt), null);
  assert.doesNotMatch(value, /test-session-secret/);
}));

test("Cognito federated usernames match providers without depending on case preservation", () => {
  assert.equal(cognitoUsernameMatchesProvider("AzureAD_subject", "AzureAD"), true);
  assert.equal(cognitoUsernameMatchesProvider("azuread_subject", "AzureAD"), true);
  assert.equal(cognitoUsernameMatchesProvider("CognitoUsers_subject", "AzureAD"), false);
  assert.equal(cognitoUsernameMatchesProvider("AzureADOther_subject", "AzureAD"), false);
});

test("SCIM uniqueness races become retry-safe conflicts", () => {
  const userConflict = mapScimWriteError({ code: "23505" });
  assert.equal(userConflict.status, 409);
  assert.equal(userConflict.scimType, "uniqueness");
  assert.match(userConflict.message, /SCIM user/);
  const groupConflict = mapScimWriteError({ code: "23505" }, "group");
  assert.equal(groupConflict.status, 409);
  assert.equal(groupConflict.scimType, "uniqueness");
  assert.match(groupConflict.message, /SCIM group/);
  const original = new Error("database unavailable");
  assert.equal(mapScimWriteError(original), original);
});

test("hosted Cognito SSO requires an HTTPS callback and a session signing secret in production", () => {
  const base = {
    NODE_ENV: "production",
    HEDGELING_AUTH_MODE: "cognito",
    COGNITO_USER_POOL_ID: "us-east-1_example",
    COGNITO_APP_CLIENT_ID: "client",
    COGNITO_USERINFO_URL: "https://example.auth.us-east-1.amazoncognito.com/oauth2/userInfo",
    COGNITO_DOMAIN: "example.auth.us-east-1.amazoncognito.com",
    COGNITO_SSO_REDIRECT_URI: "https://console.example.com/api/auth/sso/callback",
    HEDGELING_SESSION_SIGNING_SECRET: null,
    ADMIN_PASSWORD: null,
    HEDGELING_ADMIN_PASSWORD: null,
  };
  withEnv(base, () => assert.throws(
    () => validateAuthenticationConfiguration({ warn: () => {} }),
    /SESSION_SIGNING_SECRET/,
  ));
  withEnv({
    ...base,
    HEDGELING_SESSION_SIGNING_SECRET: "a-production-signing-secret-with-32-bytes",
    COGNITO_SSO_REDIRECT_URI: "http://console.example.com/api/auth/sso/callback",
  }, () => assert.throws(
    () => validateAuthenticationConfiguration({ warn: () => {} }),
    /must use HTTPS/,
  ));
  withEnv({
    ...base,
    HEDGELING_SESSION_SIGNING_SECRET: "too-short",
  }, () => assert.throws(
    () => validateAuthenticationConfiguration({ warn: () => {} }),
    /at least 32 bytes/,
  ));
});

test("malformed service-account tokens fail without touching credential storage", async () => {
  assert.equal(await authenticateServiceAccount("not-a-service-token"), null);
  assert.equal(await authenticateServiceAccount("hdlg_sa_short_secret"), null);
});
