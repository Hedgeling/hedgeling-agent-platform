import assert from "node:assert/strict";
import test from "node:test";
import {
  lifecycleMode,
  restrictOrganizationPermissions,
  restrictProjectPermissions,
} from "../src/data-lifecycle-status.js";
import { validateDataLifecycleConfiguration } from "../src/data-lifecycle.js";
import { applyLifecycleExportAccess } from "../src/entitlements.js";

const now = Date.parse("2026-08-09T12:00:00.000Z");

test("scheduled deletion is export-only until its deadline", () => {
  const lifecycle = {
    state: "scheduled",
    exportAvailableUntil: "2026-09-08T12:00:00.000Z",
  };
  assert.equal(lifecycleMode(lifecycle, now), "export_only");
  assert.deepEqual(
    restrictProjectPermissions([
      "strings.view",
      "exports.run",
      "translations.edit",
      "imports.run",
    ], lifecycle, now),
    ["strings.view", "exports.run"],
  );
});

test("an expired export window and purged content deny project access", () => {
  const expired = {
    state: "failed",
    exportAvailableUntil: "2026-08-08T12:00:00.000Z",
  };
  assert.equal(lifecycleMode(expired, now), "locked");
  assert.deepEqual(restrictProjectPermissions(["strings.view"], expired, now), []);
  assert.equal(lifecycleMode({ dataPurgedAt: new Date(now) }, now), "purged");
});

test("organization access retains only lifecycle, audit, billing, and usage controls", () => {
  const lifecycle = {
    state: "scheduled",
    exportAvailableUntil: "2026-09-08T12:00:00.000Z",
  };
  assert.deepEqual(
    restrictOrganizationPermissions([
      "organization.view",
      "organization.delete",
      "billing.view",
      "members.invite",
      "roles.assign",
    ], lifecycle, now),
    ["organization.view", "organization.delete", "billing.view"],
  );
  assert.deepEqual(
    restrictOrganizationPermissions(["organization.view"], { state: "purged" }, now),
    [],
  );
  assert.deepEqual(
    restrictOrganizationPermissions(
      ["organization.view", "audit.export", "billing.view"],
      { state: "failed", exportAvailableUntil: "2026-08-08T12:00:00.000Z" },
      now,
    ),
    ["organization.view", "billing.view"],
  );
});

test("canceled lifecycle requests restore ordinary access", () => {
  const canceled = {
    state: "canceled",
    exportAvailableUntil: "2026-08-08T12:00:00.000Z",
  };
  assert.equal(lifecycleMode(canceled, now), "active");
  assert.deepEqual(
    restrictProjectPermissions(["translations.edit"], canceled, now),
    ["translations.edit"],
  );
});

test("data lifecycle configuration bounds the contractual export window", () => {
  const previous = process.env.HEDGELING_DATA_EXPORT_GRACE_DAYS;
  const previousMaxAttempts = process.env.HEDGELING_DATA_LIFECYCLE_MAX_ATTEMPTS;
  try {
    process.env.HEDGELING_DATA_EXPORT_GRACE_DAYS = "30";
    process.env.HEDGELING_DATA_LIFECYCLE_MAX_ATTEMPTS = "24";
    assert.deepEqual(validateDataLifecycleConfiguration(), {
      exportGraceDays: 30,
      maxAttempts: 24,
    });
    process.env.HEDGELING_DATA_EXPORT_GRACE_DAYS = "0";
    assert.throws(validateDataLifecycleConfiguration, /integer from 1 to 90/);
    process.env.HEDGELING_DATA_EXPORT_GRACE_DAYS = "30";
    process.env.HEDGELING_DATA_LIFECYCLE_MAX_ATTEMPTS = "101";
    assert.throws(validateDataLifecycleConfiguration, /integer from 1 to 100/);
  } finally {
    if (previous == null) delete process.env.HEDGELING_DATA_EXPORT_GRACE_DAYS;
    else process.env.HEDGELING_DATA_EXPORT_GRACE_DAYS = previous;
    if (previousMaxAttempts == null) {
      delete process.env.HEDGELING_DATA_LIFECYCLE_MAX_ATTEMPTS;
    } else {
      process.env.HEDGELING_DATA_LIFECYCLE_MAX_ATTEMPTS = previousMaxAttempts;
    }
  }
});

test("the export window overrides plan and organization feature restrictions only", () => {
  const lifecycle = { mode: "export_only" };
  const organizationDisabled = applyLifecycleExportAccess({
    accessClass: "export",
    allowed: false,
    featureEnabled: false,
    featureSource: "organization_override",
    reason: "feature_disabled",
  }, lifecycle);
  assert.equal(organizationDisabled.allowed, true);
  assert.equal(organizationDisabled.featureEnabled, true);
  assert.equal(
    organizationDisabled.featureSource,
    "data_lifecycle_portability_override",
  );
  assert.equal(organizationDisabled.reason, "data_lifecycle_export_window");

  const platformDisabled = applyLifecycleExportAccess({
    accessClass: "export",
    allowed: false,
    featureEnabled: false,
    featureSource: "platform_default",
    reason: "feature_disabled",
  }, lifecycle);
  assert.equal(platformDisabled.allowed, false);
  assert.equal(platformDisabled.featureEnabled, false);
});
