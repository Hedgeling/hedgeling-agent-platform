import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import { isUuid } from "./validation.js";

const nodeMajor = String(process.versions.node || "unknown").split(".")[0];
const icuVersion = String(process.versions.icu || "unknown");
export const USAGE_COUNTING_VERSION =
  `intl-word-unicode-codepoint-v1-node${nodeMajor}-icu${icuVersion}`;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function normalizedLocale(locale) {
  const value = String(locale || "").trim();
  if (!value) return "und";
  try {
    return Intl.getCanonicalLocales(value)[0] || "und";
  } catch {
    return "und";
  }
}

export function measureText(text, locale) {
  const value = String(text || "");
  const characterCount = Array.from(value).length;
  let wordCount = 0;
  try {
    const segmenter = new Intl.Segmenter(normalizedLocale(locale), { granularity: "word" });
    for (const segment of segmenter.segment(value)) {
      if (segment.isWordLike) wordCount += 1;
    }
  } catch {
    wordCount = value.match(/[\p{L}\p{N}\p{M}]+/gu)?.length || 0;
  }
  return {
    words: wordCount,
    characters: characterCount,
    countingVersion: USAGE_COUNTING_VERSION,
  };
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function geminiTokenMeasurements(usageMetadata = {}) {
  return {
    llm_input_tokens: nonNegativeInteger(
      usageMetadata.promptTokenCount ?? usageMetadata.inputTokenCount,
    ),
    llm_output_tokens: nonNegativeInteger(
      usageMetadata.candidatesTokenCount ?? usageMetadata.outputTokenCount,
    ),
    llm_cached_input_tokens: nonNegativeInteger(
      usageMetadata.cachedContentTokenCount ?? usageMetadata.cachedInputTokenCount,
    ),
    llm_reasoning_tokens: nonNegativeInteger(
      usageMetadata.thoughtsTokenCount ?? usageMetadata.reasoningTokenCount,
    ),
    llm_total_tokens: nonNegativeInteger(usageMetadata.totalTokenCount),
  };
}

export function mergeMeasurements(...measurementSets) {
  const merged = {};
  for (const measurements of measurementSets) {
    for (const [key, rawQuantity] of Object.entries(measurements || {})) {
      const quantity = Number(rawQuantity);
      if (!Number.isSafeInteger(quantity)) {
        throw new Error(`Usage measurement ${key} must be a safe integer`);
      }
      merged[key] = (merged[key] || 0) + quantity;
    }
  }
  return merged;
}

export function usageIdentity(req, operation, payload) {
  const suppliedKey = String(
    req.get("idempotency-key") || req.get("x-request-id") || crypto.randomUUID(),
  ).trim();
  if (!suppliedKey || suppliedKey.length > 200) {
    throw httpError(400, "Idempotency-Key must contain 1 to 200 characters");
  }
  const serialized = JSON.stringify(payload ?? null);
  return {
    idempotencyKey: `${operation}:${suppliedKey}`,
    idempotencyFingerprint: crypto
      .createHash("sha256")
      .update(`${operation}\0${serialized}`)
      .digest("hex"),
    requestId: String(req.get("x-request-id") || "").trim() || null,
  };
}

export function usageActor(auth) {
  if (auth?.user?.id) {
    return { actorType: "user", actorUserId: auth.user.id, actorServiceAccountId: null };
  }
  if (auth?.serviceAccount?.id) {
    return {
      actorType: "service_account",
      actorUserId: null,
      actorServiceAccountId: auth.serviceAccount.id,
    };
  }
  return { actorType: "platform", actorUserId: null, actorServiceAccountId: null };
}

function normalizedMeasurements(measurements, eventKind) {
  return Object.entries(measurements || {})
    .map(([metricKey, rawQuantity]) => ({
      metricKey,
      quantity: Number(rawQuantity),
    }))
    .filter(({ quantity }) => quantity !== 0)
    .map((measurement) => {
      if (!Number.isSafeInteger(measurement.quantity)) {
        throw new Error(`Usage measurement ${measurement.metricKey} must be a safe integer`);
      }
      if (eventKind === "usage" && measurement.quantity < 0) {
        throw new Error(`Usage measurement ${measurement.metricKey} cannot be negative`);
      }
      return measurement;
    });
}

function usageRollupProjectionCtes(eventPredicate) {
  return `
    event_context as (
      select event.id, event.organization_id, event.business_unit_id,
             event.project_id, event.counting_version, event.occurred_at,
             measurement.metric_key, measurement.quantity,
             coalesce(
               billing_period.period_start,
               date_trunc('month', event.occurred_at)
             ) as subscription_period_start,
             coalesce(
               billing_period.period_end,
               date_trunc('month', event.occurred_at) + interval '1 month'
             ) as subscription_period_end
      from usage_events event
      join usage_event_measurements measurement
        on measurement.usage_event_id = event.id
      left join usage_event_billing_periods billing_period
        on billing_period.usage_event_id = event.id
      where ${eventPredicate}
    ),
    projected_events as (
      select event_context.*
      from event_context
    ),
    projected_rows as (
      select projected.organization_id, scope.scope_type, scope.scope_id,
             scope.business_unit_id, scope.project_id,
             projected.metric_key, projected.counting_version,
             period.period_type, period.period_start, period.period_end,
             projected.quantity, projected.id as usage_event_id
      from projected_events projected
      cross join lateral (
        values
          (
            'organization'::text,
            projected.organization_id,
            null::uuid,
            null::uuid
          ),
          (
            'business_unit'::text,
            projected.business_unit_id,
            projected.business_unit_id,
            null::uuid
          ),
          (
            'project'::text,
            projected.project_id,
            projected.business_unit_id,
            projected.project_id
          )
      ) scope(scope_type, scope_id, business_unit_id, project_id)
      cross join lateral (
        values
          (
            'calendar_month'::text,
            date_trunc('month', projected.occurred_at),
            date_trunc('month', projected.occurred_at) + interval '1 month'
          ),
          (
            'subscription'::text,
            projected.subscription_period_start,
            projected.subscription_period_end
          )
      ) period(period_type, period_start, period_end)
      where scope.scope_id is not null
    )`;
}

async function ensureUsageEventBillingPeriods(client, eventPredicate, params) {
  return client.query(
    `insert into usage_event_billing_periods(
       usage_event_id, period_start, period_end, period_source
     )
     select event.id,
            coalesce(
              subscription.current_period_start,
              date_trunc('month', event.occurred_at)
            ),
            coalesce(
              subscription.current_period_end,
              coalesce(
                subscription.current_period_start,
                date_trunc('month', event.occurred_at)
              ) + interval '1 month'
            ),
            case when subscription.current_period_start is null
              then 'calendar_fallback'
              else 'subscription'
            end
     from usage_events event
     left join lateral (
       select
              coalesce(
                current_subscription.usage_period_start,
                current_subscription.current_period_start
              ) as current_period_start,
              coalesce(
                current_subscription.usage_period_end,
                current_subscription.current_period_end
              ) as current_period_end
       from billing_accounts account
       join subscriptions current_subscription
         on current_subscription.billing_account_id = account.id
       where account.organization_id = event.organization_id
         and coalesce(
           current_subscription.usage_period_start,
           current_subscription.current_period_start
         ) is not null
         and coalesce(
           current_subscription.usage_period_start,
           current_subscription.current_period_start
         ) <= event.occurred_at
         and (
           coalesce(
             current_subscription.usage_period_end,
             current_subscription.current_period_end
           ) is null
           or event.occurred_at < coalesce(
             current_subscription.usage_period_end,
             current_subscription.current_period_end
           )
         )
       order by
         (current_subscription.state <> 'canceled') desc,
         coalesce(
           current_subscription.usage_period_start,
           current_subscription.current_period_start
         ) desc,
         current_subscription.created_at desc
       limit 1
     ) subscription on true
     where ${eventPredicate}
     on conflict(usage_event_id) do nothing
     returning usage_event_id`,
    params,
  );
}

async function applyUsageEventsRollups(client, usageEventIds) {
  const uniqueIds = [...new Set(usageEventIds)];
  if (!uniqueIds.length) return { appliedEventIds: [], rowCount: 0 };
  const events = await client.query(
    `select id, organization_id as "organizationId"
     from usage_events where id = any($1::uuid[])
     order by organization_id, id`,
    [uniqueIds],
  );
  if (events.rowCount !== uniqueIds.length) {
    throw new Error("One or more usage events do not exist");
  }
  const organizationIds = [...new Set(events.rows.map((event) => event.organizationId))].sort();
  for (const organizationId of organizationIds) {
    await client.query(
      "select pg_advisory_xact_lock(hashtext($1))",
      [`usage-rollup:${organizationId}`],
    );
  }
  await ensureUsageEventBillingPeriods(
    client,
    "event.id = any($1::uuid[])",
    [uniqueIds],
  );
  const markers = await client.query(
    `insert into usage_rollup_applied_events(usage_event_id)
     select unnest($1::uuid[])
     on conflict(usage_event_id) do nothing
     returning usage_event_id as "usageEventId"`,
    [uniqueIds],
  );
  const appliedEventIds = markers.rows.map((marker) => marker.usageEventId);
  if (!appliedEventIds.length) return { appliedEventIds, rowCount: 0 };
  const projected = await client.query(
    `with
     ${usageRollupProjectionCtes("event.id = any($1::uuid[])")},
     aggregate_rows as (
       select organization_id, scope_type, scope_id, business_unit_id, project_id,
              metric_key, counting_version, period_type, period_start,
              max(period_end) as period_end,
              sum(quantity)::bigint as quantity,
              count(*)::bigint as event_count
       from projected_rows
       group by organization_id, scope_type, scope_id, business_unit_id, project_id,
                metric_key, counting_version, period_type, period_start
     )
     insert into usage_period_rollups(
       organization_id, scope_type, scope_id, business_unit_id, project_id,
       metric_key, counting_version, period_type, period_start, period_end,
       quantity, event_count
     )
     select organization_id, scope_type, scope_id, business_unit_id, project_id,
            metric_key, counting_version, period_type, period_start, period_end,
            quantity, event_count
     from aggregate_rows
     on conflict(
       organization_id, scope_type, scope_id, metric_key, counting_version,
       period_type, period_start
     ) do update set
       quantity = usage_period_rollups.quantity + excluded.quantity,
       event_count = usage_period_rollups.event_count + excluded.event_count,
       period_end = greatest(usage_period_rollups.period_end, excluded.period_end),
       updated_at = now()
     returning 1`,
    [appliedEventIds],
  );
  return { appliedEventIds, rowCount: projected.rowCount };
}

export async function applyUsageEventRollups(client, usageEventId) {
  const result = await applyUsageEventsRollups(client, [usageEventId]);
  return {
    applied: result.appliedEventIds.includes(usageEventId),
    rowCount: result.rowCount,
  };
}

async function insertUsageEvent(client, input) {
  const actor = input.actor || { actorType: "platform" };
  const eventKind = input.eventKind || "usage";
  await client.query(
    "select pg_advisory_xact_lock(hashtext($1))",
    [`usage-event:${input.organizationId}:${input.idempotencyKey}`],
  );
  const existing = await client.query(
    `select id, idempotency_fingerprint as "idempotencyFingerprint",
            attempt_number as "attemptNumber", outcome,
            response_status as "responseStatus", response_body as "responseBody"
     from usage_events
     where organization_id = $1 and idempotency_key = $2
     order by attempt_number desc
     limit 1`,
    [input.organizationId, input.idempotencyKey],
  );
  const previousAttempt = existing.rows[0] || null;
  if (
    previousAttempt
    && previousAttempt.idempotencyFingerprint !== input.idempotencyFingerprint
  ) {
    throw httpError(409, "Idempotency-Key was already used with a different request");
  }
  if (previousAttempt?.outcome === "succeeded") {
    return {
      id: previousAttempt.id,
      duplicate: true,
      attemptNumber: previousAttempt.attemptNumber,
      replay: {
        eventId: previousAttempt.id,
        outcome: previousAttempt.outcome,
        responseStatus: previousAttempt.responseStatus,
        responseBody: previousAttempt.responseBody,
      },
    };
  }
  if (
    input.attemptNumber
    && Number(previousAttempt?.attemptNumber || 0) >= Number(input.attemptNumber)
  ) {
    if (Number(previousAttempt.attemptNumber) === Number(input.attemptNumber)) {
      return {
        id: previousAttempt.id,
        duplicate: true,
        attemptNumber: previousAttempt.attemptNumber,
      };
    }
    throw httpError(409, "A newer usage attempt already exists for this request");
  }
  const attemptNumber = input.attemptNumber
    || Number(previousAttempt?.attemptNumber || 0) + 1;
  const inserted = await client.query(
    `insert into usage_events(
       organization_id, business_unit_id, project_id,
       actor_type, actor_user_id, actor_service_account_id,
       operation, event_kind, outcome, idempotency_key, idempotency_fingerprint,
       attempt_number, response_status, response_body, reverses_event_id,
       provider, model, provider_request_id, request_id, counting_version,
       occurred_at, metadata
     ) values(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12, $13, $14, $15, $16, $17, $18, $19, $20,
       coalesce($21, now()), $22
     )
     returning id, attempt_number as "attemptNumber"`,
    [
      input.organizationId,
      input.businessUnitId || null,
      input.projectId || null,
      actor.actorType,
      actor.actorUserId || null,
      actor.actorServiceAccountId || null,
      input.operation,
      eventKind,
      input.outcome || "succeeded",
      input.idempotencyKey,
      input.idempotencyFingerprint,
      attemptNumber,
      input.responseStatus || null,
      input.responseBody == null ? null : JSON.stringify(input.responseBody),
      input.reversesEventId || null,
      input.provider || null,
      input.model || null,
      input.providerRequestId || null,
      input.requestId || null,
      input.countingVersion || USAGE_COUNTING_VERSION,
      input.occurredAt || null,
      JSON.stringify(input.metadata || {}),
    ],
  );

  const eventId = inserted.rows[0].id;
  const eventMeasurements = normalizedMeasurements(input.measurements, eventKind);
  for (const measurement of eventMeasurements) {
    await client.query(
      `insert into usage_event_measurements(
         usage_event_id, metric_key, quantity, accuracy, metadata
       ) values($1, $2, $3, $4, $5)`,
      [
        eventId,
        measurement.metricKey,
        measurement.quantity,
        input.measurementAccuracy || "exact",
        JSON.stringify({}),
      ],
    );
  }
  for (const [itemIndex, item] of (input.items || []).entries()) {
    await client.query(
      `insert into usage_event_items(
         usage_event_id, item_index, source_string_id, translation_revision_id,
         source_locale, target_locale, source_word_count, source_character_count,
         output_word_count, output_character_count, counting_version, metadata
       ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        eventId,
        itemIndex,
        item.sourceStringId || null,
        item.translationRevisionId || null,
        item.sourceLocale || null,
        item.targetLocale || null,
        nonNegativeInteger(item.sourceWords),
        nonNegativeInteger(item.sourceCharacters),
        nonNegativeInteger(item.outputWords),
        nonNegativeInteger(item.outputCharacters),
        input.countingVersion || USAGE_COUNTING_VERSION,
        JSON.stringify(item.metadata || {}),
      ],
    );
  }
  await applyUsageEventRollups(client, eventId);
  if (input.reservationId) {
    const consumed = await client.query(
      `update usage_reservations
       set status = 'consumed', usage_event_id = $2, updated_at = now()
       where id = $1 and organization_id = $3
         and idempotency_key = $4
         and idempotency_fingerprint = $5
         and attempt_number = $6
         and status in ('held', 'expired')`,
      [
        input.reservationId,
        eventId,
        input.organizationId,
        input.idempotencyKey,
        input.idempotencyFingerprint,
        attemptNumber,
      ],
    );
    if (!consumed.rowCount) {
      throw httpError(409, "Usage reservation does not match this request");
    }
  }
  await createBudgetAlerts(client, {
    organizationId: input.organizationId,
    businessUnitId: input.businessUnitId || null,
    projectId: input.projectId || null,
    usageEventId: eventId,
    metricKeys: eventMeasurements.map((measurement) => measurement.metricKey),
  });
  return {
    id: eventId,
    duplicate: false,
    attemptNumber: inserted.rows[0].attemptNumber,
  };
}

export async function recordUsageEvent(input) {
  if (!input?.organizationId || !input?.operation || !input?.idempotencyKey) {
    throw new Error("Usage event requires organizationId, operation, and idempotencyKey");
  }
  if (!input.idempotencyFingerprint) {
    throw new Error("Usage event requires an idempotency fingerprint");
  }
  if (input.client) return insertUsageEvent(input.client, input);
  return withTransaction((client) => insertUsageEvent(client, input));
}

function budgetState(used, held, limit, warningPercent) {
  const observed = used + held;
  if (observed >= limit) return "exceeded";
  if (observed * 100n >= limit * BigInt(warningPercent)) return "warning";
  return "within";
}

async function loadBudgetStatuses(
  db,
  organizationId,
  {
    metricKeys = null,
    businessUnitId = null,
    projectId = null,
    applicableScopesOnly = false,
  } = {},
) {
  const selectedMetricKeys = Array.isArray(metricKeys) && metricKeys.length
    ? [...new Set(metricKeys)]
    : null;
  const result = await db.query(
    `with subscription_period as (
       select account.organization_id, subscription.current_period_start
       from billing_accounts account
       left join lateral (
         select coalesce(
           current_subscription.usage_period_start,
           current_subscription.current_period_start
         ) as current_period_start
         from subscriptions current_subscription
         where current_subscription.billing_account_id = account.id
         order by
           (current_subscription.state <> 'canceled') desc,
           current_subscription.created_at desc
         limit 1
       ) subscription on true
       where account.organization_id = $1
     )
     select
       budget.id,
       budget.scope_type as "scopeType",
       budget.business_unit_id as "businessUnitId",
       unit.name as "businessUnitName",
       budget.project_id as "projectId",
       project.name as "projectName",
       budget.metric_key as "metricKey",
       metric.name as "metricName",
       metric.unit,
       budget.limit_quantity::text as "limitQuantity",
       budget.warning_percent as "warningPercent",
       budget.enforcement,
       budget.period,
       budget.reason,
       budget.starts_at as "startsAt",
       budget.expires_at as "expiresAt",
       budget_window.period_start as "periodStart",
       (
         coalesce(rollup.quantity, 0)
         + coalesce(unprojected.quantity, 0)
       )::text as "usedQuantity",
       coalesce(held.quantity, 0)::text as "heldQuantity"
     from usage_budgets budget
     join usage_metric_definitions metric on metric.key = budget.metric_key
     left join business_units unit on unit.id = budget.business_unit_id
     left join projects project on project.id = budget.project_id
     cross join lateral (
       select base_period_start,
              greatest(budget.starts_at, base_period_start) as period_start
       from (
         select case budget.period
           when 'calendar_month' then date_trunc('month', now())
           else coalesce(
             (select current_period_start from subscription_period),
             date_trunc('month', now())
           )
         end as base_period_start
       ) selected_period
     ) budget_window
     left join lateral (
       select sum(period_rollup.quantity) as quantity
       from usage_period_rollups period_rollup
       where period_rollup.organization_id = budget.organization_id
         and period_rollup.scope_type = budget.scope_type
         and period_rollup.scope_id = case budget.scope_type
           when 'organization' then budget.organization_id
           when 'business_unit' then budget.business_unit_id
           else budget.project_id
         end
         and period_rollup.metric_key = budget.metric_key
         and period_rollup.period_type = budget.period
         and period_rollup.period_start = budget_window.base_period_start
         and budget.starts_at <= budget_window.base_period_start
     ) rollup on true
     left join lateral (
       select sum(candidate.quantity) as quantity
       from (
         select event.business_unit_id, event.project_id, measurement.quantity
         from usage_events event
         join usage_event_measurements measurement
           on measurement.usage_event_id = event.id
         where budget.starts_at > budget_window.base_period_start
           and event.organization_id = budget.organization_id
           and measurement.metric_key = budget.metric_key
           and event.occurred_at >= budget_window.period_start
         union all
         select event.business_unit_id, event.project_id, measurement.quantity
         from usage_rollup_pending_events pending
         join usage_events event on event.id = pending.usage_event_id
         join usage_event_measurements measurement
           on measurement.usage_event_id = event.id
         where budget.starts_at <= budget_window.base_period_start
           and coalesce((
             select legacy_seed_complete
             from usage_rollup_queue_state
             where singleton = true
           ), false)
           and pending.organization_id = budget.organization_id
           and measurement.metric_key = budget.metric_key
           and event.occurred_at >= budget_window.period_start
         union all
         select event.business_unit_id, event.project_id, measurement.quantity
         from usage_events event
         join usage_event_measurements measurement
           on measurement.usage_event_id = event.id
         where budget.starts_at <= budget_window.base_period_start
           and not coalesce((
             select legacy_seed_complete
             from usage_rollup_queue_state
             where singleton = true
           ), false)
           and event.organization_id = budget.organization_id
           and measurement.metric_key = budget.metric_key
           and event.occurred_at >= budget_window.period_start
           and not exists(
             select 1 from usage_rollup_applied_events applied
             where applied.usage_event_id = event.id
           )
       ) candidate
       where (
         budget.scope_type = 'organization'
         or (
           budget.scope_type = 'business_unit'
           and candidate.business_unit_id = budget.business_unit_id
         )
         or (
           budget.scope_type = 'project'
           and candidate.project_id = budget.project_id
         )
       )
     ) unprojected on true
     left join lateral (
       select sum(measurement.quantity) as quantity
       from usage_reservations reservation
       join usage_reservation_measurements measurement
         on measurement.reservation_id = reservation.id
       where reservation.organization_id = budget.organization_id
         and reservation.status = 'held'
         and reservation.expires_at > now()
         and measurement.metric_key = budget.metric_key
         and (
           budget.scope_type = 'organization'
           or (
             budget.scope_type = 'business_unit'
             and reservation.business_unit_id = budget.business_unit_id
           )
           or (
             budget.scope_type = 'project'
             and reservation.project_id = budget.project_id
           )
         )
     ) held on true
     where budget.organization_id = $1
       and budget.superseded_at is null
       and budget.starts_at <= now()
       and (budget.expires_at is null or budget.expires_at > now())
       and ($2::text[] is null or budget.metric_key = any($2))
       and (
         not $5::boolean
         or budget.scope_type = 'organization'
         or (
           budget.scope_type = 'business_unit'
           and budget.business_unit_id = $3
         )
         or (
           budget.scope_type = 'project'
           and budget.project_id = $4
         )
       )
     order by budget.scope_type, coalesce(unit.name, ''), coalesce(project.name, ''),
              budget.metric_key`,
    [
      organizationId,
      selectedMetricKeys,
      businessUnitId,
      projectId,
      applicableScopesOnly,
    ],
  );
  return result.rows.map((row) => {
    const used = BigInt(row.usedQuantity);
    const held = BigInt(row.heldQuantity);
    const limit = BigInt(row.limitQuantity);
    const state = budgetState(used, held, limit, row.warningPercent);
    const observed = used + held;
    return {
      ...row,
      observedQuantity: observed.toString(),
      remainingQuantity: (limit > observed ? limit - observed : 0n).toString(),
      percentUsed: limit > 0n
        ? Math.min(100, Number((observed * 10_000n) / limit) / 100)
        : 100,
      state,
    };
  });
}

async function createBudgetAlerts(
  client,
  { organizationId, businessUnitId, projectId, usageEventId, metricKeys },
) {
  if (!metricKeys.length) return;
  const statuses = await loadBudgetStatuses(client, organizationId, {
    metricKeys,
    businessUnitId,
    projectId,
    applicableScopesOnly: true,
  });
  for (const budget of statuses) {
    if (!["warning", "exceeded"].includes(budget.state)) continue;
    await client.query(
      `insert into usage_budget_alerts(
         budget_id, usage_event_id, threshold, period_start, observed_quantity
       ) values($1, $2, $3, $4, $5)
       on conflict(budget_id, threshold, period_start) do nothing`,
      [
        budget.id,
        usageEventId,
        budget.state,
        budget.periodStart,
        budget.observedQuantity,
      ],
    );
  }
}

function planUsagePolicies(limits) {
  const configured = limits?.usage && typeof limits.usage === "object" ? limits.usage : {};
  return Object.entries(configured).flatMap(([metricKey, policy]) => {
    const explicitPolicy = policy !== null && typeof policy === "object";
    const limit = explicitPolicy ? policy.limit : policy;
    const parsed = Number(limit);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return [];
    const configuredWarning = Number(policy?.warningPercent);
    return [{
      metricKey,
      limitQuantity: BigInt(parsed),
      warningPercent: Number.isInteger(configuredWarning)
        && configuredWarning >= 1
        && configuredWarning <= 100
        ? configuredWarning
        : 80,
      enforcement: ["observe", "warn", "block"].includes(policy?.enforcement)
        ? policy.enforcement
        : "block",
    }];
  });
}

export async function reserveUsage(input) {
  const measurements = normalizedMeasurements(input.measurements, "usage")
    .filter((measurement) => measurement.quantity > 0);
  const relevantMetrics = [...new Set([
    ...measurements.map((measurement) => measurement.metricKey),
    ...(input.relevantMetrics || []),
  ])].sort();

  const result = await withTransaction(async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtext($1))",
      [`usage-reservation-key:${input.organizationId}:${input.idempotencyKey}`],
    );
    const existing = await client.query(
      `select reservation.id,
              reservation.idempotency_fingerprint as "idempotencyFingerprint",
              reservation.status,
              (
                reservation.status = 'held' and reservation.expires_at > now()
              ) as "activeHold",
              reservation.attempt_number as "attemptNumber"
       from usage_reservations reservation
       where reservation.organization_id = $1
         and reservation.idempotency_key = $2
       order by reservation.attempt_number desc
       limit 1`,
      [input.organizationId, input.idempotencyKey],
    );
    const existingEventResult = await client.query(
      `select id as "eventId",
              idempotency_fingerprint as "idempotencyFingerprint",
              attempt_number as "attemptNumber", outcome,
              response_status as "responseStatus",
              response_body as "responseBody"
       from usage_events
       where organization_id = $1 and idempotency_key = $2
       order by attempt_number desc
       limit 1`,
      [input.organizationId, input.idempotencyKey],
    );
    const previousReservation = existing.rows[0] || null;
    const previousEvent = existingEventResult.rows[0] || null;
    if (
      [previousReservation, previousEvent].some((attempt) => (
        attempt && attempt.idempotencyFingerprint !== input.idempotencyFingerprint
      ))
    ) {
      throw httpError(409, "Idempotency-Key was already used with a different request");
    }
    if (previousEvent?.outcome === "succeeded") {
      return {
        id: previousReservation?.id || null,
        warnings: [],
        duplicate: true,
        attemptNumber: previousEvent.attemptNumber,
        replay: {
          eventId: previousEvent.eventId,
          outcome: previousEvent.outcome,
          responseStatus: previousEvent.responseStatus,
          responseBody: previousEvent.responseBody,
        },
      };
    }
    if (previousReservation?.activeHold) {
      return {
        id: previousReservation.id,
        warnings: [],
        duplicate: true,
        pending: true,
        attemptNumber: previousReservation.attemptNumber,
      };
    }

    await client.query(
      "select pg_advisory_xact_lock(hashtext($1))",
      [`usage-reservation:${input.organizationId}`],
    );
    await client.query(
      `update usage_reservations
       set status = 'expired', updated_at = now()
       where organization_id = $1 and status = 'held' and expires_at <= now()`,
      [input.organizationId],
    );
    const attemptNumber = Math.max(
      Number(previousReservation?.attemptNumber || 0),
      Number(previousEvent?.attemptNumber || 0),
    ) + 1;
    const statuses = relevantMetrics.length
      ? await loadBudgetStatuses(client, input.organizationId, {
        metricKeys: relevantMetrics,
        businessUnitId: input.businessUnitId || null,
        projectId: input.projectId || null,
        applicableScopesOnly: true,
      })
      : [];
    const proposed = new Map(
      measurements.map((measurement) => [measurement.metricKey, BigInt(measurement.quantity)]),
    );
    const reserved = new Map(proposed);
    const applicableBudgets = statuses.filter((budget) => (
      relevantMetrics.includes(budget.metricKey)
      && (
        budget.scopeType === "organization"
        || (
          budget.scopeType === "business_unit"
          && budget.businessUnitId === input.businessUnitId
        )
        || (
          budget.scopeType === "project"
          && budget.projectId === input.projectId
        )
      )
    ));
    const warnings = [];
    let denial = null;
    for (const budget of applicableBudgets) {
      if (!reserved.has(budget.metricKey)) reserved.set(budget.metricKey, 1n);
      const projected = BigInt(budget.observedQuantity) + reserved.get(budget.metricKey);
      const limit = BigInt(budget.limitQuantity);
      if (projected * 100n >= limit * BigInt(budget.warningPercent)) {
        warnings.push({
          type: "budget",
          budgetId: budget.id,
          metricKey: budget.metricKey,
          projectedQuantity: projected.toString(),
          limitQuantity: budget.limitQuantity,
          enforcement: budget.enforcement,
        });
      }
      if (budget.enforcement === "block" && projected > limit) {
        denial = warnings.at(-1);
        await client.query(
          `insert into usage_budget_alerts(
             budget_id, threshold, period_start, observed_quantity
           ) values($1, 'blocked', $2, $3)
           on conflict(budget_id, threshold, period_start) do nothing`,
          [budget.id, budget.periodStart, projected.toString()],
        );
        break;
      }
    }

    const planPolicies = planUsagePolicies(input.planLimits);
    for (const policy of planPolicies) {
      if (!relevantMetrics.includes(policy.metricKey)) continue;
      if (!reserved.has(policy.metricKey)) reserved.set(policy.metricKey, 1n);
      const used = await client.query(
        `with period as (
           select coalesce(
             (
               select subscription.current_period_start
               from billing_accounts account
               join lateral (
                 select coalesce(
                   current_subscription.usage_period_start,
                   current_subscription.current_period_start
                 ) as current_period_start
                 from subscriptions current_subscription
                 where current_subscription.billing_account_id = account.id
                 order by
                   (current_subscription.state <> 'canceled') desc,
                   current_subscription.created_at desc
                 limit 1
               ) subscription on true
               where account.organization_id = $1
             ),
             date_trunc('month', now())
           ) as starts_at
         )
         select (
           coalesce((
             select sum(period_rollup.quantity)
             from usage_period_rollups period_rollup
             where period_rollup.organization_id = $1
               and period_rollup.scope_type = 'organization'
               and period_rollup.scope_id = $1
               and period_rollup.metric_key = $2
               and period_rollup.period_type = 'subscription'
               and period_rollup.period_start = (select starts_at from period)
           ), 0)
           +
           coalesce((
             select sum(unprojected.quantity)
             from (
               select measurement.quantity
               from usage_rollup_pending_events pending
               join usage_events event on event.id = pending.usage_event_id
               join usage_event_measurements measurement
                 on measurement.usage_event_id = event.id
               where coalesce((
                       select legacy_seed_complete
                       from usage_rollup_queue_state
                       where singleton = true
                     ), false)
                 and pending.organization_id = $1
                 and measurement.metric_key = $2
                 and event.occurred_at >= (select starts_at from period)
               union all
               select measurement.quantity
               from usage_events event
               join usage_event_measurements measurement
                 on measurement.usage_event_id = event.id
               where not coalesce((
                       select legacy_seed_complete
                       from usage_rollup_queue_state
                       where singleton = true
                     ), false)
                 and event.organization_id = $1
                 and measurement.metric_key = $2
                 and event.occurred_at >= (select starts_at from period)
                 and not exists(
                   select 1 from usage_rollup_applied_events applied
                   where applied.usage_event_id = event.id
                 )
             ) unprojected
           ), 0)
           +
           coalesce((
             select sum(measurement.quantity)
             from usage_reservations reservation
             join usage_reservation_measurements measurement
               on measurement.reservation_id = reservation.id
             where reservation.organization_id = $1
               and reservation.status = 'held'
               and reservation.expires_at > now()
               and measurement.metric_key = $2
               and reservation.created_at >= (select starts_at from period)
           ), 0)
         )::text as quantity`,
        [input.organizationId, policy.metricKey],
      );
      const projected = BigInt(used.rows[0].quantity) + reserved.get(policy.metricKey);
      if (
        projected * 100n
        >= policy.limitQuantity * BigInt(policy.warningPercent)
      ) {
        warnings.push({
          type: "plan_limit",
          metricKey: policy.metricKey,
          projectedQuantity: projected.toString(),
          limitQuantity: policy.limitQuantity.toString(),
          enforcement: policy.enforcement,
        });
      }
      if (policy.enforcement === "block" && projected > policy.limitQuantity) {
        denial = {
          type: "plan_limit",
          metricKey: policy.metricKey,
          projectedQuantity: projected.toString(),
          limitQuantity: policy.limitQuantity.toString(),
          enforcement: policy.enforcement,
        };
        break;
      }
    }
    if (denial) return { denied: denial };

    const reservation = await client.query(
      `insert into usage_reservations(
         organization_id, business_unit_id, project_id, idempotency_key,
         idempotency_fingerprint, attempt_number, operation, expires_at
       ) values($1, $2, $3, $4, $5, $6, $7, now() + interval '15 minutes')
       returning id, attempt_number as "attemptNumber"`,
      [
        input.organizationId,
        input.businessUnitId || null,
        input.projectId || null,
        input.idempotencyKey,
        input.idempotencyFingerprint,
        attemptNumber,
        input.operation,
      ],
    );
    for (const [metricKey, quantity] of reserved) {
      await client.query(
        `insert into usage_reservation_measurements(
           reservation_id, metric_key, quantity
         ) values($1, $2, $3)`,
        [reservation.rows[0].id, metricKey, quantity.toString()],
      );
    }
    return {
      id: reservation.rows[0].id,
      warnings,
      duplicate: false,
      attemptNumber: reservation.rows[0].attemptNumber,
    };
  });
  if (result.denied) {
    throw Object.assign(new Error("The requested operation exceeds a usage limit or budget"), {
      status: 402,
      code: "usage_limit_exceeded",
      details: result.denied,
    });
  }
  return result;
}

export async function releaseUsageReservation(reservationId) {
  if (!reservationId) return;
  await query(
    `update usage_reservations
     set status = 'released', updated_at = now()
     where id = $1 and status = 'held'`,
    [reservationId],
  );
}

function boundedPositiveOption(value, fallback, maximum, label) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

export async function backfillUsageRollups({ batchSize = 500, maxBatches = 100 } = {}) {
  const boundedBatchSize = boundedPositiveOption(batchSize, 500, 2000, "batchSize");
  const boundedMaxBatches = boundedPositiveOption(maxBatches, 100, 10_000, "maxBatches");
  let batches = 0;
  let visitedEvents = 0;
  let appliedEvents = 0;
  let projectedRows = 0;
  let queueSeedComplete = await query(
    `select legacy_seed_complete as "legacySeedComplete"
     from usage_rollup_queue_state where singleton = true`,
  ).then((result) => result.rows[0]?.legacySeedComplete === true);
  while (batches < boundedMaxBatches) {
    const candidates = queueSeedComplete
      ? await query(
        `select usage_event_id as id
         from usage_rollup_pending_events
         order by occurred_at, usage_event_id
         limit $1`,
        [boundedBatchSize],
      )
      : await query(
        `select event.id
         from usage_events event
         left join usage_rollup_applied_events applied
           on applied.usage_event_id = event.id
         where applied.usage_event_id is null
         order by event.occurred_at, event.id
         limit $1`,
        [boundedBatchSize],
      );
    if (!candidates.rowCount) {
      if (!queueSeedComplete) {
        await query(
          `insert into usage_rollup_queue_state(
             singleton, legacy_seed_complete, updated_at
           ) values(true, true, now())
           on conflict(singleton) do update set
             legacy_seed_complete = true,
             updated_at = now()`,
        );
        queueSeedComplete = true;
        continue;
      }
      break;
    }
    const batch = await withTransaction((client) => (
      applyUsageEventsRollups(client, candidates.rows.map((event) => event.id))
    ));
    batches += 1;
    visitedEvents += candidates.rowCount;
    appliedEvents += batch.appliedEventIds.length;
    projectedRows += batch.rowCount;
  }
  const remainingEvents = queueSeedComplete
    ? await query(
      "select count(*)::int as count from usage_rollup_pending_events",
    ).then((result) => result.rows[0].count)
    : await query(
      `select count(*)::int as count
       from usage_events event
       left join usage_rollup_applied_events applied
         on applied.usage_event_id = event.id
       where applied.usage_event_id is null`,
    ).then((result) => result.rows[0].count);
  if (!queueSeedComplete && remainingEvents === 0) {
    await query(
      `insert into usage_rollup_queue_state(
         singleton, legacy_seed_complete, updated_at
       ) values(true, true, now())
       on conflict(singleton) do update set
         legacy_seed_complete = true,
         updated_at = now()`,
    );
    queueSeedComplete = true;
  }
  return {
    batches,
    visitedEvents,
    appliedEvents,
    projectedRows,
    remainingEvents,
    queueSeedComplete,
    complete: remainingEvents === 0,
  };
}

function validateRollupOrganizationId(organizationId, { required = false } = {}) {
  const normalized = String(organizationId || "").trim() || null;
  if ((required || normalized) && !isUuid(normalized)) {
    throw new Error("A valid organization UUID is required");
  }
  return normalized;
}

export async function compareUsageRollups({ organizationId = null, limit = 1000 } = {}) {
  const selectedOrganizationId = validateRollupOrganizationId(organizationId);
  const boundedLimit = boundedPositiveOption(limit, 1000, 10_000, "limit");
  const mismatches = await query(
    `with
     ${usageRollupProjectionCtes("($1::uuid is null or event.organization_id = $1)")},
     expected as (
       select organization_id, scope_type, scope_id, business_unit_id, project_id,
              metric_key, counting_version, period_type, period_start,
              max(period_end) as period_end,
              sum(quantity)::bigint as quantity,
              count(*)::bigint as event_count
       from projected_rows
       group by organization_id, scope_type, scope_id, business_unit_id, project_id,
                metric_key, counting_version, period_type, period_start
     ),
     actual as (
       select *
       from usage_period_rollups
       where ($1::uuid is null or organization_id = $1)
     )
     select coalesce(expected.organization_id, actual.organization_id) as "organizationId",
            coalesce(expected.scope_type, actual.scope_type) as "scopeType",
            coalesce(expected.scope_id, actual.scope_id) as "scopeId",
            coalesce(expected.metric_key, actual.metric_key) as "metricKey",
            coalesce(expected.counting_version, actual.counting_version) as "countingVersion",
            coalesce(expected.period_type, actual.period_type) as "periodType",
            coalesce(expected.period_start, actual.period_start) as "periodStart",
            expected.period_end as "expectedPeriodEnd",
            actual.period_end as "actualPeriodEnd",
            expected.quantity::text as "expectedQuantity",
            actual.quantity::text as "actualQuantity",
            expected.event_count::text as "expectedEventCount",
            actual.event_count::text as "actualEventCount"
     from expected
     full join actual using(
       organization_id, scope_type, scope_id, metric_key, counting_version,
       period_type, period_start
     )
     where expected.quantity is distinct from actual.quantity
        or expected.event_count is distinct from actual.event_count
        or expected.period_end is distinct from actual.period_end
        or expected.business_unit_id is distinct from actual.business_unit_id
        or expected.project_id is distinct from actual.project_id
     order by 1, 2, 3, 4, 5, 6, 7
     limit $2`,
    [selectedOrganizationId, boundedLimit],
  );
  const projection = await query(
    `select
       count(*) filter (where applied.usage_event_id is null)::int as "unappliedEvents",
       count(*) filter (
         where applied.usage_event_id is not null
           and billing_period.usage_event_id is null
       )::int as "appliedEventsWithoutPeriod",
       count(*)::int as "ledgerEvents"
     from usage_events event
     left join usage_rollup_applied_events applied
       on applied.usage_event_id = event.id
     left join usage_event_billing_periods billing_period
       on billing_period.usage_event_id = event.id
     where ($1::uuid is null or event.organization_id = $1)`,
    [selectedOrganizationId],
  ).then((result) => result.rows[0]);
  return {
    organizationId: selectedOrganizationId,
    checkedAt: new Date().toISOString(),
    ...projection,
    mismatchCount: mismatches.rowCount,
    truncated: mismatches.rowCount === boundedLimit,
    mismatches: mismatches.rows,
    exact: projection.unappliedEvents === 0
      && projection.appliedEventsWithoutPeriod === 0
      && mismatches.rowCount === 0,
  };
}

export async function repairUsageRollups({ organizationId } = {}) {
  const selectedOrganizationId = validateRollupOrganizationId(
    organizationId,
    { required: true },
  );
  return withTransaction(async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtext($1))",
      [`usage-rollup:${selectedOrganizationId}`],
    );
    const organization = await client.query(
      "select id from organizations where id = $1",
      [selectedOrganizationId],
    );
    if (!organization.rows[0]) throw new Error("Organization does not exist");
    await ensureUsageEventBillingPeriods(
      client,
      "event.organization_id = $1",
      [selectedOrganizationId],
    );
    await client.query(
      "delete from usage_period_rollups where organization_id = $1",
      [selectedOrganizationId],
    );
    await client.query(
      `delete from usage_rollup_applied_events applied
       using usage_events event
       where applied.usage_event_id = event.id and event.organization_id = $1`,
      [selectedOrganizationId],
    );
    const rebuilt = await client.query(
      `with
       ${usageRollupProjectionCtes("event.organization_id = $1")},
       aggregate_rows as (
         select organization_id, scope_type, scope_id, business_unit_id, project_id,
                metric_key, counting_version, period_type, period_start,
                max(period_end) as period_end,
                sum(quantity)::bigint as quantity,
                count(*)::bigint as event_count
         from projected_rows
         group by organization_id, scope_type, scope_id, business_unit_id, project_id,
                  metric_key, counting_version, period_type, period_start
       )
       insert into usage_period_rollups(
         organization_id, scope_type, scope_id, business_unit_id, project_id,
         metric_key, counting_version, period_type, period_start, period_end,
         quantity, event_count
       )
       select organization_id, scope_type, scope_id, business_unit_id, project_id,
              metric_key, counting_version, period_type, period_start, period_end,
              quantity, event_count
       from aggregate_rows
       returning 1`,
      [selectedOrganizationId],
    );
    const marked = await client.query(
      `insert into usage_rollup_applied_events(usage_event_id)
       select id from usage_events where organization_id = $1
       on conflict(usage_event_id) do nothing
       returning usage_event_id`,
      [selectedOrganizationId],
    );
    return {
      organizationId: selectedOrganizationId,
      rebuiltAt: new Date().toISOString(),
      rollupRows: rebuilt.rowCount,
      markedEvents: marked.rowCount,
    };
  });
}

export async function organizationBudgetStatus(organizationId) {
  return loadBudgetStatuses({ query }, organizationId);
}

function usageWindowValue(value, fallback, label) {
  if (value == null || value === "") return fallback;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw httpError(400, `${label} must be an ISO timestamp`);
  return parsed;
}

export async function organizationUsageSummary(
  organizationId,
  { from, to, businessUnitId, projectId } = {},
) {
  const now = new Date();
  const subscriptionPeriod = await query(
    `select subscription.current_period_start as "currentPeriodStart"
     from billing_accounts account
     join lateral (
       select
         coalesce(
           current_subscription.usage_period_start,
           current_subscription.current_period_start
         ) as current_period_start,
         current_subscription.created_at
       from subscriptions current_subscription
       where current_subscription.billing_account_id = account.id
       order by
         (current_subscription.state <> 'canceled') desc,
         current_subscription.created_at desc
       limit 1
     ) subscription on true
     where account.organization_id = $1`,
    [organizationId],
  );
  const periodStart = subscriptionPeriod.rows[0]?.currentPeriodStart
    ? new Date(subscriptionPeriod.rows[0].currentPeriodStart)
    : null;
  const defaultFrom = periodStart && periodStart <= now
    ? periodStart
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fromDate = usageWindowValue(from, defaultFrom, "from");
  const toDate = usageWindowValue(to, now, "to");
  if (fromDate >= toDate) throw httpError(400, "from must be earlier than to");
  if (toDate.getTime() - fromDate.getTime() > 366 * 24 * 60 * 60 * 1000) {
    throw httpError(400, "Usage windows cannot exceed 366 days");
  }

  const params = [organizationId, fromDate.toISOString(), toDate.toISOString()];
  const filters = [
    "event.organization_id = $1",
    "event.occurred_at >= $2",
    "event.occurred_at < $3",
  ];
  if (businessUnitId) {
    params.push(businessUnitId);
    filters.push(`event.business_unit_id = $${params.length}`);
  }
  if (projectId) {
    params.push(projectId);
    filters.push(`event.project_id = $${params.length}`);
  }
  const where = filters.join(" and ");

  const [totals, operations, daily, businessUnits, projects, recent] = await Promise.all([
    query(
      `select measurement.metric_key as "metricKey",
              sum(measurement.quantity)::text as quantity
       from usage_events event
       join usage_event_measurements measurement on measurement.usage_event_id = event.id
       where ${where}
       group by measurement.metric_key
       order by measurement.metric_key`,
      params,
    ),
    query(
      `select event.operation, count(*)::int as events
       from usage_events event
       where ${where}
       group by event.operation
       order by event.operation`,
      params,
    ),
    query(
      `select (event.occurred_at at time zone 'UTC')::date::text as date,
              measurement.metric_key as "metricKey",
              sum(measurement.quantity)::text as quantity
       from usage_events event
       join usage_event_measurements measurement on measurement.usage_event_id = event.id
       where ${where}
       group by date, measurement.metric_key
       order by date, measurement.metric_key`,
      params,
    ),
    query(
      `select unit.id, unit.name, measurement.metric_key as "metricKey",
              sum(measurement.quantity)::text as quantity
       from usage_events event
       join business_units unit on unit.id = event.business_unit_id
       join usage_event_measurements measurement on measurement.usage_event_id = event.id
       where ${where}
       group by unit.id, unit.name, measurement.metric_key
       order by lower(unit.name), measurement.metric_key`,
      params,
    ),
    query(
      `select project.id, project.name, measurement.metric_key as "metricKey",
              sum(measurement.quantity)::text as quantity
       from usage_events event
       join projects project on project.id = event.project_id
       join usage_event_measurements measurement on measurement.usage_event_id = event.id
       where ${where}
       group by project.id, project.name, measurement.metric_key
       order by lower(project.name), measurement.metric_key`,
      params,
    ),
    query(
      `select event.id, event.operation, event.outcome, event.provider, event.model,
              event.occurred_at as "occurredAt", count(item.id)::int as "itemCount"
       from usage_events event
       left join usage_event_items item on item.usage_event_id = event.id
       where ${where}
       group by event.id
       order by event.occurred_at desc, event.id desc
       limit 50`,
      params,
    ),
  ]);

  return {
    window: {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      basis: from
        ? "requested"
        : periodStart && periodStart <= now
          ? "subscription_period"
          : "calendar_month",
    },
    filters: {
      businessUnitId: businessUnitId || null,
      projectId: projectId || null,
    },
    totals: totals.rows,
    operations: operations.rows,
    daily: daily.rows,
    businessUnits: businessUnits.rows,
    projects: projects.rows,
    recentEvents: recent.rows,
  };
}
