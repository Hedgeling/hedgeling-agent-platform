import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { auditRequest } from "./audit.js";
import { withTransaction } from "./db.js";

let trialPackageDownloadTestHooks = {};

function httpError(status, message, code, details) {
  return Object.assign(new Error(message), { status, code, details });
}

function clean(value) {
  return String(value ?? "").trim();
}

function required(value, name) {
  const normalized = clean(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function boundedInteger(value, name, {
  minimum,
  maximum,
  fallback,
}) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function safeFilename(value) {
  const normalized = clean(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.tgz$/.test(normalized)) {
    throw new Error(
      "HEDGELING_TRIAL_PACKAGE_FILENAME must be a safe .tgz filename",
    );
  }
  return normalized;
}

export function setTrialPackageDownloadTestHooks(hooks = {}) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "Trial-package download test hooks are only available in NODE_ENV=test",
    );
  }
  trialPackageDownloadTestHooks = hooks;
}

export function trialPackageDownloadConfiguration() {
  const enabled = process.env.HEDGELING_TRIAL_PACKAGE_DOWNLOAD_ENABLED === "true";
  if (!enabled) {
    return {
      enabled: false,
      ttlSeconds: 600,
      maximumPerHour: 10,
      version: null,
      sha256: null,
      filename: null,
    };
  }
  const version = required(
    process.env.HEDGELING_TRIAL_PACKAGE_VERSION,
    "HEDGELING_TRIAL_PACKAGE_VERSION",
  );
  const sha256 = required(
    process.env.HEDGELING_TRIAL_PACKAGE_SHA256,
    "HEDGELING_TRIAL_PACKAGE_SHA256",
  ).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(
      "HEDGELING_TRIAL_PACKAGE_SHA256 must be a lowercase SHA-256 digest",
    );
  }
  return {
    enabled: true,
    region: required(
      process.env.AWS_REGION
      || process.env.AWS_DEFAULT_REGION
      || process.env.COGNITO_REGION,
      "AWS_REGION",
    ),
    bucket: required(
      process.env.HEDGELING_TRIAL_PACKAGE_BUCKET,
      "HEDGELING_TRIAL_PACKAGE_BUCKET",
    ),
    key: required(
      process.env.HEDGELING_TRIAL_PACKAGE_KEY,
      "HEDGELING_TRIAL_PACKAGE_KEY",
    ),
    version,
    sha256,
    filename: safeFilename(
      process.env.HEDGELING_TRIAL_PACKAGE_FILENAME
      || `hedgeling-i18n-${version}.tgz`,
    ),
    ttlSeconds: boundedInteger(
      process.env.HEDGELING_TRIAL_PACKAGE_DOWNLOAD_TTL_SECONDS,
      "HEDGELING_TRIAL_PACKAGE_DOWNLOAD_TTL_SECONDS",
      { minimum: 60, maximum: 900, fallback: 600 },
    ),
    maximumPerHour: boundedInteger(
      process.env.HEDGELING_TRIAL_PACKAGE_DOWNLOADS_PER_HOUR,
      "HEDGELING_TRIAL_PACKAGE_DOWNLOADS_PER_HOUR",
      { minimum: 1, maximum: 100, fallback: 10 },
    ),
  };
}

export function publicTrialPackageConfiguration() {
  const config = trialPackageDownloadConfiguration();
  return {
    enabled: config.enabled,
    ttlSeconds: config.ttlSeconds,
    version: config.version,
    sha256: config.sha256,
    filename: config.filename,
  };
}

export function validateTrialPackageDownloadConfiguration() {
  const config = trialPackageDownloadConfiguration();
  if (
    process.env.NODE_ENV === "production"
    && process.env.HEDGELING_SELF_SERVICE_SIGNUP_ENABLED === "true"
    && !config.enabled
  ) {
    throw new Error(
      "Self-service production deployments require the signed trial-package "
      + "download configuration",
    );
  }
  return config;
}

export function trialPackageTtlSeconds(configuredTtlSeconds, remainingSeconds) {
  const remaining = Math.floor(Number(remainingSeconds));
  if (!Number.isFinite(remaining) || remaining < 30) return 0;
  return Math.max(1, Math.min(configuredTtlSeconds, remaining));
}

async function signTrialPackageDownload(config, expiresIn) {
  if (trialPackageDownloadTestHooks.signUrl) {
    return trialPackageDownloadTestHooks.signUrl({ config, expiresIn });
  }
  const client = new S3Client({ region: config.region });
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: config.key,
      ResponseContentDisposition: `attachment; filename="${config.filename}"`,
      ResponseContentType: "application/gzip",
    }),
    { expiresIn },
  );
}

async function claimTrialPackageDownload(req, config) {
  return withTransaction(async (client) => {
    const userId = req.auth?.principalType === "user"
      ? req.auth?.user?.id
      : null;
    if (!userId) {
      throw httpError(
        403,
        "A user account is required",
        "user_required",
      );
    }
    await client.query(
      "select pg_advisory_xact_lock(hashtext($1))",
      [`trial-package-download:${userId}`],
    );
    const eligibility = await client.query(
      `select
         claim.organization_id as "organizationId",
         account.status as "accountStatus",
         subscription.id as "subscriptionId",
         subscription.state as "subscriptionState",
         subscription.provider as "subscriptionProvider",
         subscription.current_period_end as "trialEndsAt",
         extract(
           epoch from subscription.current_period_end - now()
         ) as "remainingSeconds",
         onboarding.project_id as "onboardingProjectId",
         plan.key as "planKey",
         plan.metadata->>'kind' as "planKind",
         lifecycle.id as "dataLifecycleRequestId",
         now() as "databaseNow"
       from self_service_trial_claims claim
       join billing_accounts account
         on account.organization_id = claim.organization_id
       join lateral (
         select candidate.*
         from subscriptions candidate
         where candidate.billing_account_id = account.id
         order by
           (candidate.state <> 'canceled') desc,
           candidate.created_at desc
         limit 1
         for update
       ) subscription on true
       join product_plans plan on plan.id = subscription.plan_id
       left join organization_onboarding onboarding
         on onboarding.organization_id = claim.organization_id
       left join lateral (
         select request.id
         from data_lifecycle_requests request
         where request.organization_id = claim.organization_id
           and request.state in ('scheduled', 'processing', 'failed', 'purged')
           and (
             request.target_type = 'organization'
             or (
               request.target_type = 'project'
               and (
                 request.project_id = onboarding.project_id
                 or onboarding.project_id is null
               )
             )
           )
         order by (request.target_type = 'organization') desc,
                  request.requested_at desc
         limit 1
       ) lifecycle on true
       where claim.owner_user_id = $1`,
      [userId],
    ).then((result) => result.rows[0]);
    if (!eligibility) {
      throw httpError(
        404,
        "Create a trial workspace before downloading the package",
        "trial_workspace_required",
      );
    }
    if (eligibility.dataLifecycleRequestId) {
      throw httpError(
        409,
        "Trial package downloads stop when workspace deletion is scheduled",
        "trial_package_data_lifecycle_restricted",
      );
    }
    if (!eligibility.onboardingProjectId) {
      throw httpError(
        404,
        "Create a trial workspace before downloading the package",
        "trial_workspace_required",
      );
    }
    if (
      eligibility.planKey !== "self-service-trial-v1"
      || eligibility.planKind !== "trial"
      || eligibility.subscriptionProvider
    ) {
      throw httpError(
        409,
        "Private npm membership replaces trial package downloads after upgrade",
        "trial_package_paid_plan",
      );
    }
    if (
      eligibility.accountStatus !== "active"
      || eligibility.subscriptionState !== "trialing"
    ) {
      throw httpError(
        402,
        "The trial must be active to download the package",
        "trial_package_subscription_inactive",
      );
    }
    const ttlSeconds = trialPackageTtlSeconds(
      config.ttlSeconds,
      eligibility.remainingSeconds,
    );
    if (!ttlSeconds) {
      throw httpError(
        402,
        "The trial has expired; upgrade to install from private npm",
        "trial_package_expired",
      );
    }
    const recentCount = await client.query(
      `select count(*)::integer as count
       from trial_package_download_issuances
       where user_id = $1
         and requested_at >= now() - interval '1 hour'
         and status in ('requested', 'issued')`,
      [userId],
    ).then((result) => result.rows[0].count);
    if (recentCount >= config.maximumPerHour) {
      throw httpError(
        429,
        "The hourly trial-package download limit has been reached",
        "trial_package_rate_limited",
        { maximumPerHour: config.maximumPerHour },
      );
    }
    const requestedAt = new Date(eligibility.databaseNow);
    const expiresAt = new Date(
      requestedAt.getTime() + ttlSeconds * 1000,
    );
    const issuance = await client.query(
      `insert into trial_package_download_issuances(
         organization_id, user_id, subscription_id,
         artifact_version, artifact_sha256, artifact_bucket, artifact_key,
         status, requested_at, expires_at, ip_address, user_agent, metadata
       ) values($1, $2, $3, $4, $5, $6, $7, 'requested', $8, $9, $10, $11, $12)
       returning id`,
      [
        eligibility.organizationId,
        userId,
        eligibility.subscriptionId,
        config.version,
        config.sha256,
        config.bucket,
        config.key,
        requestedAt,
        expiresAt,
        req.ip || null,
        clean(req.get?.("user-agent")).slice(0, 500) || null,
        JSON.stringify({
          distribution: "private_s3_presigned_get",
          ttlSeconds,
        }),
      ],
    ).then((result) => result.rows[0]);
    return {
      ...eligibility,
      issuanceId: issuance.id,
      requestedAt,
      expiresAt,
      ttlSeconds,
      userId,
    };
  });
}

export async function issueTrialPackageDownload(req, res) {
  const config = trialPackageDownloadConfiguration();
  if (!config.enabled) {
    throw httpError(
      503,
      "Trial package downloads are not configured",
      "trial_package_not_configured",
    );
  }
  const claim = await claimTrialPackageDownload(req, config);
  let url;
  try {
    url = await signTrialPackageDownload(config, claim.ttlSeconds);
    if (new URL(url).protocol !== "https:") {
      throw new Error("The trial package signer returned a non-HTTPS URL");
    }
  } catch (error) {
    const message = String(error?.message || error).slice(0, 2000);
    await withTransaction(async (client) => {
      await client.query(
        `update trial_package_download_issuances
         set status = 'failed', last_error = $2
         where id = $1 and status = 'requested'`,
        [claim.issuanceId, message],
      );
    }).catch((recordingError) => {
      console.error(JSON.stringify({
        event: "trial_package_download_failure_recording_failed",
        issuanceId: claim.issuanceId,
        error: String(recordingError?.message || recordingError),
      }));
    });
    console.error(JSON.stringify({
      event: "trial_package_download_signing_failed",
      issuanceId: claim.issuanceId,
      error: message,
    }));
    throw httpError(
      503,
      "The trial package link could not be created",
      "trial_package_signing_failed",
    );
  }
  await withTransaction(async (client) => {
    const issued = await client.query(
      `update trial_package_download_issuances
       set status = 'issued', issued_at = now()
       where id = $1 and status = 'requested'
       returning issued_at as "issuedAt"`,
      [claim.issuanceId],
    ).then((result) => result.rows[0]);
    if (!issued) {
      throw httpError(
        409,
        "The trial package issuance is no longer claimable",
        "trial_package_issuance_conflict",
      );
    }
    await auditRequest(client, req, {
      organizationId: claim.organizationId,
      action: "trial_package_download.issued",
      resourceType: "trial_package_download_issuance",
      resourceId: claim.issuanceId,
      afterState: {
        artifactVersion: config.version,
        artifactSha256: config.sha256,
        issuedAt: issued.issuedAt,
        expiresAt: claim.expiresAt,
        distribution: "private_s3_presigned_get",
      },
    });
  });
  res.set("cache-control", "no-store");
  res.status(201).json({
    download: {
      url,
      method: "GET",
      version: config.version,
      sha256: config.sha256,
      filename: config.filename,
      expiresAt: claim.expiresAt,
      installCommand: `npm install ./${config.filename}`,
    },
  });
}
