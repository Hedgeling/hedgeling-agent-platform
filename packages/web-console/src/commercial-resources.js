export async function recordOrganizationResourceHighWater(
  client,
  {
    organizationId,
    resourceKey,
    observedQuantity,
    metadata = {},
  },
) {
  if (!["managed_strings", "npm_seats"].includes(resourceKey)) {
    throw new Error(`Unsupported commercial resource: ${resourceKey}`);
  }
  if (!Number.isSafeInteger(observedQuantity) || observedQuantity < 0) {
    throw new Error("Resource high-water quantity must be a non-negative integer");
  }
  const period = await client.query(
    `select
       coalesce(
         subscription.usage_period_start,
         subscription.current_period_start,
         date_trunc('month', now())
       ) as "periodStart",
       coalesce(
         subscription.usage_period_end,
         case
           when subscription.current_period_start is not null
             then subscription.current_period_start + interval '1 month'
           else date_trunc('month', now()) + interval '1 month'
         end
       ) as "periodEnd",
       plan.key as "planKey"
     from billing_accounts account
     join lateral (
       select current_subscription.*
       from subscriptions current_subscription
       where current_subscription.billing_account_id = account.id
       order by
         (current_subscription.state <> 'canceled') desc,
         current_subscription.created_at desc
       limit 1
     ) subscription on true
     join product_plans plan on plan.id = subscription.plan_id
     where account.organization_id = $1`,
    [organizationId],
  );
  const current = period.rows[0];
  if (!current?.periodStart || !current?.periodEnd) {
    throw new Error("The current commercial resource period is unavailable");
  }
  return client.query(
    `insert into organization_resource_high_water(
       organization_id, resource_key, period_start, period_end,
       observed_quantity, source_metadata
     ) values($1, $2, $3, $4, $5, $6)
     on conflict(organization_id, resource_key, period_start) do update
     set observed_quantity = greatest(
           organization_resource_high_water.observed_quantity,
           excluded.observed_quantity
         ),
         period_end = greatest(
           organization_resource_high_water.period_end,
           excluded.period_end
         ),
         source_metadata = organization_resource_high_water.source_metadata
           || excluded.source_metadata,
         updated_at = now()
     returning id, observed_quantity as "observedQuantity",
               period_start as "periodStart", period_end as "periodEnd"`,
    [
      organizationId,
      resourceKey,
      current.periodStart,
      current.periodEnd,
      observedQuantity,
      JSON.stringify({ ...metadata, planKey: current.planKey }),
    ],
  ).then((result) => result.rows[0]);
}

export async function seedOrganizationResourceHighWaterPeriod(
  client,
  {
    organizationId,
    periodStart,
    periodEnd,
    planKey,
  },
) {
  if (!periodStart || !periodEnd) return [];
  const quantities = await client.query(
    `select
       (
         select count(*)::bigint
         from source_strings source
         join projects project on project.id = source.project_id
         join business_units unit on unit.id = project.business_unit_id
         where unit.organization_id = $1 and project.data_purged_at is null
       ) as managed_strings,
       (
         select count(*)::bigint
         from npm_seat_assignments seat
         where seat.organization_id = $1 and seat.status <> 'revoked'
       ) as npm_seats`,
    [organizationId],
  ).then((result) => result.rows[0]);
  const seeded = [];
  for (const resourceKey of ["managed_strings", "npm_seats"]) {
    const observedQuantity = String(quantities?.[resourceKey] || 0);
    await client.query(
      `insert into organization_resource_high_water(
         organization_id, resource_key, period_start, period_end,
         observed_quantity, source_metadata
       ) values($1, $2, $3, $4, $5, $6)
       on conflict(organization_id, resource_key, period_start) do update
       set observed_quantity = greatest(
             organization_resource_high_water.observed_quantity,
             excluded.observed_quantity
           ),
           period_end = greatest(
             organization_resource_high_water.period_end,
             excluded.period_end
           ),
           source_metadata = organization_resource_high_water.source_metadata
             || excluded.source_metadata,
           updated_at = now()`,
      [
        organizationId,
        resourceKey,
        periodStart,
        periodEnd,
        observedQuantity,
        JSON.stringify({
          planKey,
          method: "period_opening_baseline",
          source: "subscription_reconciliation",
        }),
      ],
    );
    seeded.push({ resourceKey, observedQuantity });
  }
  return seeded;
}
