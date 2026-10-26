import assert from "node:assert/strict";
import test from "node:test";
import { subscriptionAllows } from "../src/entitlements.js";
import { createServiceCredential } from "../src/service-accounts.js";
import {
  SELF_SERVICE_TRIAL_LIMITS,
  selfServiceConfiguration,
  validateWorkspaceInput,
} from "../src/self-service.js";

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

test("self-service configuration publishes the fixed trial contract", () => withEnv({
  HEDGELING_SELF_SERVICE_SIGNUP_ENABLED: "true",
  HEDGELING_SELF_SERVICE_TRIAL_DAYS: "14",
  HEDGELING_TERMS_VERSION: "terms-v1",
  HEDGELING_PRIVACY_VERSION: "privacy-v1",
}, () => {
  const configuration = selfServiceConfiguration();
  assert.equal(configuration.enabled, true);
  assert.equal(configuration.trialDays, 14);
  assert.equal(configuration.limits.targetLocales, 3);
  assert.equal(configuration.limits.activeSourceStrings, 2500);
  assert.equal(configuration.limits.aiCredits, 25000);
  assert.equal(configuration.workflows.length, 4);
}));

test("workspace validation normalizes locales and pins legal acceptance", () => withEnv({
  HEDGELING_TERMS_VERSION: "terms-v1",
  HEDGELING_PRIVACY_VERSION: "privacy-v1",
}, () => {
  const input = validateWorkspaceInput({
    organizationName: " Acme Games ",
    projectName: " Player UI ",
    sourceLocale: "en_US",
    targetLocales: ["fr_FR", "de-DE", "fr-FR", "en-US"],
    workflowPresetKey: "ai_human_review",
    acceptedTerms: true,
    acceptedPrivacy: true,
    termsVersion: "terms-v1",
    privacyVersion: "privacy-v1",
  });
  assert.equal(input.organizationName, "Acme Games");
  assert.equal(input.sourceLocale, "en-US");
  assert.deepEqual(input.targetLocales, ["fr-FR", "de-DE"]);
  assert.equal(input.workflow.version, 1);

  assert.throws(
    () => validateWorkspaceInput({
      organizationName: "Acme",
      projectName: "UI",
      sourceLocale: "en-US",
      targetLocales: ["fr", "de", "es", "it"],
      workflowPresetKey: "ai_publish",
      acceptedTerms: true,
      acceptedPrivacy: true,
      termsVersion: "terms-v1",
      privacyVersion: "privacy-v1",
    }),
    /Choose between 1 and 3 target locales/,
  );
}));

test("service credentials are high-entropy one-time bearer tokens", () => {
  const first = createServiceCredential();
  const second = createServiceCredential();
  assert.match(first.token, /^hdlg_sa_[a-f0-9]{16}_[A-Za-z0-9_-]{40,}$/);
  assert.equal(first.digest.length, 64);
  assert.notEqual(first.token, second.token);
  assert.equal(SELF_SERVICE_TRIAL_LIMITS.activeCredentials, 2);
});

test("expired local trials fail paid writes but retain the configured export grace", () => {
  const now = Date.parse("2026-08-20T00:00:00.000Z");
  const periodEnd = "2026-08-15T00:00:00.000Z";
  const graceEnd = "2026-09-14T00:00:00.000Z";
  assert.equal(
    subscriptionAllows("paid_write", "trialing", graceEnd, periodEnd, null, now),
    false,
  );
  assert.equal(
    subscriptionAllows("export", "trialing", graceEnd, periodEnd, null, now),
    true,
  );
  assert.equal(
    subscriptionAllows("retention", "trialing", graceEnd, periodEnd, null, now),
    true,
  );
  assert.equal(
    subscriptionAllows("paid_write", "active", null, periodEnd, "stripe", now),
    true,
  );
});
