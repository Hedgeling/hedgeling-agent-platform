alter table billing_meter_period_summaries
  add column if not exists updated_at timestamptz not null default now();

create table if not exists billing_meter_period_adjustments (
  id uuid primary key default gen_random_uuid(),
  period_summary_id uuid not null
    references billing_meter_period_summaries(id) on delete restrict,
  observed_quantity bigint not null check (observed_quantity >= 0),
  billable_quantity bigint not null check (billable_quantity >= 0),
  previous_provider_event_quantity bigint not null
    check (previous_provider_event_quantity >= 0),
  target_provider_event_quantity bigint not null
    check (target_provider_event_quantity > 0),
  delta_provider_event_quantity bigint not null
    check (delta_provider_event_quantity > 0),
  reason text not null check (reason in ('late_usage')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(period_summary_id, target_provider_event_quantity),
  check (
    target_provider_event_quantity =
      previous_provider_event_quantity + delta_provider_event_quantity
  )
);

alter table billing_meter_outbox
  drop constraint if exists billing_meter_outbox_source_type_check;

alter table billing_meter_outbox
  add constraint billing_meter_outbox_source_type_check
  check (
    source_type in (
      'usage_event',
      'resource_high_water',
      'npm_seat_high_water',
      'period_summary',
      'period_adjustment'
    )
  ) not valid;

alter table billing_meter_outbox
  validate constraint billing_meter_outbox_source_type_check;
