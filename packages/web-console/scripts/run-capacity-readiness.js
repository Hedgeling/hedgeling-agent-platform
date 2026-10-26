import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import pg from "pg";

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");
}
const profileName = process.env.HEDGELING_CAPACITY_PROFILE || "ci";
const profiles = {
  ci: {
    usageEvents: 10_000,
    workOrders: 500,
    providerEvents: 5_000,
    liveIterations: 20,
    liveConcurrency: 4,
    objectives: {
      backfillMs: 15_000,
      comparisonMs: 5_000,
      liveUsageP95Ms: 250,
      authorizationP95Ms: 100,
      providerSeedMs: 5_000,
      rollupPlanMs: 100,
      workListPlanMs: 250,
      providerQueuePlanMs: 250,
    },
  },
  pilot: {
    usageEvents: 250_000,
    workOrders: 10_000,
    providerEvents: 100_000,
    liveIterations: 100,
    liveConcurrency: 10,
    objectives: {
      backfillMs: 120_000,
      comparisonMs: 30_000,
      liveUsageP95Ms: 500,
      authorizationP95Ms: 250,
      providerSeedMs: 30_000,
      rollupPlanMs: 100,
      workListPlanMs: 500,
      providerQueuePlanMs: 500,
    },
  },
};
const profile = profiles[profileName];
if (!profile) throw new Error("HEDGELING_CAPACITY_PROFILE must be ci or pilot");

const schemaName = `hedgeling_capacity_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString });
const scopedUrl = new URL(connectionString);
scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = scopedUrl.toString();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = await fs.readFile(
  path.resolve(__dirname, "..", "db", "schema.sql"),
  "utf8",
);
const evidencePath = path.resolve(
  process.env.HEDGELING_CAPACITY_EVIDENCE_PATH
    || path.join(__dirname, "..", "test-results", "capacity-readiness.json"),
);

function percentile(values, percent) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil((percent / 100) * ordered.length) - 1),
  );
  return ordered[index] || 0;
}

async function measured(operation) {
  const startedAt = performance.now();
  const result = await operation();
  return { result, durationMs: performance.now() - startedAt };
}

function planEvidence(result) {
  const document = result.rows[0]["QUERY PLAN"][0];
  return {
    planningMs: document["Planning Time"],
    executionMs: document["Execution Time"],
    plan: document.Plan,
  };
}

let applicationPool;
try {
  await adminPool.query(`create schema "${schemaName}"`);
  const database = await import("../src/db.js");
  applicationPool = database.pool;
  const {
    backfillUsageRollups,
    compareUsageRollups,
    recordUsageEvent,
    reserveUsage,
  } = await import("../src/usage.js");
  const { organizationAccessForOrganizations } = await import("../src/authorization.js");
  await applicationPool.query(schemaSql);

  const fixtures = await applicationPool.query(
    `with customer as (
       insert into organizations(slug, name, organization_type)
       values($1, 'Capacity Customer', 'customer') returning id
     ),
     agency as (
       insert into organizations(slug, name, organization_type)
       values($2, 'Capacity Agency', 'agency') returning id
     ),
     unit as (
       insert into business_units(organization_id, slug, name)
       select id, 'capacity-unit', 'Capacity Unit' from customer returning id, organization_id
     ),
     project as (
       insert into projects(slug, name, business_unit_id)
       select $3, 'Capacity Project', id from unit returning id, business_unit_id
     ),
     relationship as (
       insert into vendor_relationships(
         customer_organization_id, agency_organization_id, status,
         effective_from, requires_linguist_approval
       )
       select customer.id, agency.id, 'active', current_date, false
       from customer, agency
       returning id, customer_organization_id, agency_organization_id
     ),
     user_account as (
       insert into users(email, display_name, status)
       values($4, 'Capacity Administrator', 'active') returning id
     ),
     membership as (
       insert into organization_memberships(
         organization_id, user_id, status, activated_at
       )
       select customer.id, user_account.id, 'active', now()
       from customer, user_account
       returning id, organization_id, user_id
     ),
     role_assignment as (
       insert into role_assignments(
         principal_type, principal_id, role_id, scope_type, scope_id,
         inherit_to_children
       )
       select 'user', membership.user_id, role.id, 'organization',
              membership.organization_id, true
       from membership
       join roles role
         on role.organization_id is null and role.key = 'organization_admin'
       returning id
     )
     select customer.id as "organizationId", agency.id as "agencyId",
            unit.id as "businessUnitId", project.id as "projectId",
            relationship.id as "relationshipId", user_account.id as "userId"
     from customer, agency, unit, project, relationship, user_account,
          role_assignment`,
    [
      `capacity-customer-${crypto.randomUUID()}`,
      `capacity-agency-${crypto.randomUUID()}`,
      `capacity-project-${crypto.randomUUID()}`,
      `capacity-${crypto.randomUUID()}@example.test`,
    ],
  ).then((result) => result.rows[0]);

  await applicationPool.query(
    `insert into usage_events(
       organization_id, business_unit_id, project_id, actor_type, operation,
       idempotency_key, idempotency_fingerprint, counting_version, occurred_at
     )
     select $1, $2, $3, 'platform', 'capacity_seed',
            'capacity-seed-' || series::text,
            encode(digest('capacity-seed-' || series::text, 'sha256'), 'hex'),
            'capacity-v1',
            date_trunc('month', now()) + (series % 86_400) * interval '1 second'
     from generate_series(1, $4::int) series`,
    [
      fixtures.organizationId,
      fixtures.businessUnitId,
      fixtures.projectId,
      profile.usageEvents,
    ],
  );
  await applicationPool.query(
    `insert into usage_event_measurements(usage_event_id, metric_key, quantity)
     select event.id, metric.metric_key, metric.quantity
     from usage_events event
     cross join lateral (
       values
         ('source_words_processed'::text, 12::bigint),
         ('llm_total_tokens'::text, 40::bigint)
     ) metric(metric_key, quantity)
     where event.organization_id = $1 and event.operation = 'capacity_seed'`,
    [fixtures.organizationId],
  );
  await applicationPool.query(
    `insert into work_orders(
       vendor_relationship_id, work_order_number, project_id, title,
       service_type, source_locale, target_locale, unit_type
     )
     select $1, series, $2, 'Capacity work order ' || series::text,
            'translation', 'en-US', 'fr-FR', 'source_word'
     from generate_series(1, $3::int) series`,
    [fixtures.relationshipId, fixtures.projectId, profile.workOrders],
  );
  const providerSeed = await measured(() => applicationPool.query(
    `insert into facilitated_payment_provider_events(
       provider_event_id, event_type, livemode, status, attempts, payload,
       provider_created_at, received_at
     )
     select 'evt_capacity_' || series::text,
            case when series % 5 = 0 then 'payout.failed' else 'payment_intent.succeeded' end,
            false,
            case when series % 20 = 0 then 'failed' else 'processed' end,
            1, '{}'::jsonb, now() - series * interval '1 second',
            now() - series * interval '1 second'
     from generate_series(1, $1::int) series`,
    [profile.providerEvents],
  ));

  const backfill = await measured(() => backfillUsageRollups({
    batchSize: 2000,
    maxBatches: Math.ceil(profile.usageEvents / 2000) + 2,
  }));
  const comparison = await measured(() => compareUsageRollups({
    organizationId: fixtures.organizationId,
    limit: 100,
  }));
  if (!comparison.result.exact) {
    throw new Error(`Capacity rollup comparison failed: ${JSON.stringify(comparison.result)}`);
  }

  const liveDurations = [];
  let nextLiveIndex = 0;
  await Promise.all(Array.from({ length: profile.liveConcurrency }, async () => {
    while (nextLiveIndex < profile.liveIterations) {
      const index = nextLiveIndex;
      nextLiveIndex += 1;
      const identity = `capacity-live-${index}`;
      const live = await measured(async () => {
        const reservation = await reserveUsage({
          organizationId: fixtures.organizationId,
          businessUnitId: fixtures.businessUnitId,
          projectId: fixtures.projectId,
          operation: "capacity_live_usage",
          idempotencyKey: identity,
          idempotencyFingerprint: crypto.createHash("sha256").update(identity).digest("hex"),
          measurements: { source_words_processed: 1 },
          relevantMetrics: ["source_words_processed"],
          planLimits: { usage: { source_words_processed: 9_000_000_000 } },
        });
        await recordUsageEvent({
          organizationId: fixtures.organizationId,
          businessUnitId: fixtures.businessUnitId,
          projectId: fixtures.projectId,
          actor: { actorType: "platform" },
          operation: "capacity_live_usage",
          idempotencyKey: identity,
          idempotencyFingerprint: crypto.createHash("sha256").update(identity).digest("hex"),
          reservationId: reservation.id,
          attemptNumber: reservation.attemptNumber,
          measurements: { source_words_processed: 1 },
        });
      });
      liveDurations.push(live.durationMs);
    }
  }));

  const authorizationDurations = [];
  for (let index = 0; index < profile.liveIterations; index += 1) {
    const authorization = await measured(() => organizationAccessForOrganizations(
      {
        principalType: "user",
        user: { id: fixtures.userId, platformStaff: false },
        identityConnectionId: null,
      },
      [fixtures.organizationId],
    ));
    if (!authorization.result.get(fixtures.organizationId)?.includes("work_orders.view")) {
      throw new Error("Capacity authorization fixture lost work-order visibility");
    }
    authorizationDurations.push(authorization.durationMs);
  }

  const rollupPlan = planEvidence(await applicationPool.query(
    `explain (analyze, buffers, format json)
     select sum(quantity)
     from usage_period_rollups
     where organization_id = $1 and scope_type = 'organization' and scope_id = $1
       and metric_key = 'source_words_processed'
       and period_type = 'subscription'
       and period_start = date_trunc('month', now())`,
    [fixtures.organizationId],
  ));
  const workListPlan = planEvidence(await applicationPool.query(
    `explain (analyze, buffers, format json)
     select work_order.id
     from work_orders work_order
     where work_order.vendor_relationship_id = $1
     order by work_order.work_order_number desc limit 250`,
    [fixtures.relationshipId],
  ));
  const providerQueuePlan = planEvidence(await applicationPool.query(
    `explain (analyze, buffers, format json)
     select provider_event_id, event_type, status, received_at
     from facilitated_payment_provider_events
     where status = 'failed'
     order by received_at desc limit 250`,
  ));

  const actual = {
    backfillMs: backfill.durationMs,
    comparisonMs: comparison.durationMs,
    liveUsageP95Ms: percentile(liveDurations, 95),
    authorizationP95Ms: percentile(authorizationDurations, 95),
    providerSeedMs: providerSeed.durationMs,
    rollupPlanMs: rollupPlan.executionMs,
    workListPlanMs: workListPlan.executionMs,
    providerQueuePlanMs: providerQueuePlan.executionMs,
  };
  const failures = Object.entries(profile.objectives)
    .filter(([metric, objective]) => actual[metric] > objective)
    .map(([metric, objective]) => ({ metric, actual: actual[metric], objective }));
  const evidence = {
    generatedAt: new Date().toISOString(),
    profile: profileName,
    dataset: {
      usageEvents: profile.usageEvents,
      workOrders: profile.workOrders,
      providerEvents: profile.providerEvents,
      liveIterations: profile.liveIterations,
      liveConcurrency: profile.liveConcurrency,
    },
    objectives: profile.objectives,
    actual,
    failures,
    rollup: {
      backfill: backfill.result,
      comparison: comparison.result,
    },
    plans: { rollupPlan, workListPlan, providerQueuePlan },
  };
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  if (failures.length) {
    const summary = failures
      .map(({ metric, actual: actualValue, objective }) => (
        `${metric}=${actualValue.toFixed(2)}ms (objective <= ${objective}ms)`
      ))
      .join("; ");
    console.error(`[capacity-readiness] Failed: ${summary}`);
    console.error(`[capacity-readiness] Full evidence: ${evidencePath}`);
    process.exitCode = 2;
  } else {
    console.log(`[capacity-readiness] Passed ${Object.keys(profile.objectives).length} objectives`);
    console.log(`[capacity-readiness] Full evidence: ${evidencePath}`);
  }
} catch (error) {
  const evidence = {
    generatedAt: new Date().toISOString(),
    profile: profileName,
    dataset: {
      usageEvents: profile.usageEvents,
      workOrders: profile.workOrders,
      providerEvents: profile.providerEvents,
      liveIterations: profile.liveIterations,
      liveConcurrency: profile.liveConcurrency,
    },
    objectives: profile.objectives,
    fatalError: {
      name: error?.name || "Error",
      message: error?.message || String(error),
      code: error?.code || null,
    },
  };
  try {
    await fs.mkdir(path.dirname(evidencePath), { recursive: true });
    await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  } catch (evidenceError) {
    console.error("Unable to write capacity failure evidence", evidenceError);
  }
  throw error;
} finally {
  if (applicationPool) await applicationPool.end();
  await adminPool.query(`drop schema if exists "${schemaName}" cascade`);
  await adminPool.end();
}
