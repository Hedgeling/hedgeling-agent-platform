import assert from "node:assert/strict";
import test from "node:test";
import {
  publicTrialPackageConfiguration,
  trialPackageDownloadConfiguration,
  trialPackageTtlSeconds,
  validateTrialPackageDownloadConfiguration,
} from "../src/trial-package-downloads.js";

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

const configuredEnvironment = {
  HEDGELING_TRIAL_PACKAGE_DOWNLOAD_ENABLED: "true",
  AWS_REGION: "us-east-1",
  HEDGELING_TRIAL_PACKAGE_BUCKET: "hedgeling-private-artifacts",
  HEDGELING_TRIAL_PACKAGE_KEY: "trial/i18n/0.1.0/package.tgz",
  HEDGELING_TRIAL_PACKAGE_VERSION: "0.1.0",
  HEDGELING_TRIAL_PACKAGE_FILENAME: "hedgeling-i18n-0.1.0.tgz",
  HEDGELING_TRIAL_PACKAGE_SHA256: "a".repeat(64),
  HEDGELING_TRIAL_PACKAGE_DOWNLOAD_TTL_SECONDS: "600",
  HEDGELING_TRIAL_PACKAGE_DOWNLOADS_PER_HOUR: "10",
};

test("trial package configuration exposes integrity without storage coordinates", () => (
  withEnv(configuredEnvironment, () => {
    const privateConfiguration = trialPackageDownloadConfiguration();
    assert.equal(privateConfiguration.bucket, "hedgeling-private-artifacts");
    const publicConfiguration = publicTrialPackageConfiguration();
    assert.deepEqual(publicConfiguration, {
      enabled: true,
      ttlSeconds: 600,
      version: "0.1.0",
      sha256: "a".repeat(64),
      filename: "hedgeling-i18n-0.1.0.tgz",
    });
    assert.equal("bucket" in publicConfiguration, false);
    assert.equal("key" in publicConfiguration, false);
  })
));

test("trial package links never outlive the configured TTL or trial", () => {
  assert.equal(trialPackageTtlSeconds(600, 5000), 600);
  assert.equal(trialPackageTtlSeconds(600, 125.9), 125);
  assert.equal(trialPackageTtlSeconds(600, 29), 0);
});

test("production self-service fails closed without trial distribution", () => (
  withEnv({
    NODE_ENV: "production",
    HEDGELING_SELF_SERVICE_SIGNUP_ENABLED: "true",
    HEDGELING_TRIAL_PACKAGE_DOWNLOAD_ENABLED: null,
  }, () => {
    assert.throws(
      validateTrialPackageDownloadConfiguration,
      /require the signed trial-package download configuration/,
    );
  })
));

test("trial package configuration rejects unpinned artifacts", () => (
  withEnv({
    ...configuredEnvironment,
    HEDGELING_TRIAL_PACKAGE_SHA256: "latest",
  }, () => {
    assert.throws(
      trialPackageDownloadConfiguration,
      /must be a lowercase SHA-256 digest/,
    );
  })
));
