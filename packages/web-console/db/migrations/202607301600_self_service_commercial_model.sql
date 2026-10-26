-- Self-service commercial model: public plans, immutable AI-credit rates,
-- monthly spend controls, mixed-interval subscription items, private npm
-- seats, provider-meter outbox, and signed parser-lease evidence.

alter table usage_metric_definitions
  drop constraint if exists usage_metric_definitions_unit_check;

alter table usage_metric_definitions
  add constraint usage_metric_definitions_unit_check
  check (unit in ('word', 'character', 'token', 'action', 'credit')) not valid;

alter table usage_metric_definitions
  validate constraint usage_metric_definitions_unit_check;

insert into usage_metric_definitions(key, name, unit, description)
values(
  'ai_credits',
  'AI credits',
  'credit',
  'Customer-billable AI credits computed from an immutable provider/model rate version. Failed requests and internal retries consume provider tokens but not AI credits.'
)
on conflict(key) do update
set name = excluded.name,
    unit = excluded.unit,
    description = excluded.description;

insert into entitlement_definitions(key, name, description, access_class)
values
  (
    'local_extraction',
    'Local extraction',
    'Issue a signed lease permitting local string extraction.',
    'paid_write'
  ),
  (
    'local_diagnostics',
    'Local diagnostics',
    'Issue a signed lease permitting local diagnostic analysis.',
    'paid_write'
  ),
  (
    'frontier_models',
    'Frontier models',
    'Use premium hosted AI models governed by a model-specific AI-credit rate.',
    'paid_write'
  )
on conflict(key) do update
set name = excluded.name,
    description = excluded.description,
    access_class = excluded.access_class;

insert into feature_flags(key, name, description, default_enabled)
values
  ('local_extraction', 'Local extraction', 'Controls parser extraction leases.', true),
  ('local_diagnostics', 'Local diagnostics', 'Controls parser diagnostic leases.', true),
  ('frontier_models', 'Frontier models', 'Controls premium hosted model access.', true)
on conflict(key) do update
set name = excluded.name,
    description = excluded.description;

create table if not exists ai_credit_rate_cards (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  version integer not null check (version > 0),
  name text not null,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'retired')),
  currency char(3) not null default 'USD',
  credits_per_billing_block bigint not null default 10000
    check (credits_per_billing_block > 0),
  billing_block_amount_minor bigint not null default 1000
    check (billing_block_amount_minor > 0),
  effective_at timestamptz not null,
  retired_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(key, version),
  check (retired_at is null or retired_at > effective_at)
);

create unique index if not exists idx_ai_credit_rate_cards_one_active
  on ai_credit_rate_cards(key) where status = 'active';

create table if not exists ai_credit_rates (
  id uuid primary key default gen_random_uuid(),
  rate_card_id uuid not null
    references ai_credit_rate_cards(id) on delete restrict,
  provider text not null,
  model text not null,
  operation text not null,
  input_credits_per_million bigint not null
    check (input_credits_per_million >= 0),
  output_credits_per_million bigint not null
    check (output_credits_per_million >= 0),
  cached_input_credits_per_million bigint not null default 0
    check (cached_input_credits_per_million >= 0),
  reasoning_credits_per_million bigint not null default 0
    check (reasoning_credits_per_million >= 0),
  fixed_credits bigint not null default 0 check (fixed_credits >= 0),
  provider_input_cost_usd_per_million numeric(18, 6),
  provider_output_cost_usd_per_million numeric(18, 6),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(rate_card_id, provider, model, operation)
);

insert into ai_credit_rate_cards(
  key, version, name, status, currency, credits_per_billing_block,
  billing_block_amount_minor, effective_at, metadata
)
values(
  'managed-gemini',
  1,
  'Managed Gemini launch rate',
  'active',
  'USD',
  10000,
  1000,
  '2026-07-30T00:00:00Z',
  '{
    "marginPolicy":"trial and Starter managed-model COGS ceiling",
    "providerPricingRetrievedAt":"2026-07-30",
    "providerPricingSource":"https://ai.google.dev/gemini-api/docs/pricing"
  }'::jsonb
)
on conflict(key, version) do nothing;

insert into ai_credit_rates(
  rate_card_id, provider, model, operation,
  input_credits_per_million, output_credits_per_million,
  cached_input_credits_per_million, reasoning_credits_per_million,
  provider_input_cost_usd_per_million,
  provider_output_cost_usd_per_million,
  metadata
)
select
  card.id,
  'gemini',
  'gemini-3.5-flash-lite',
  'translation',
  4000,
  32000,
  4000,
  32000,
  0.30,
  2.50,
  '{
    "systemPrompts":"included in provider prompt/input tokens",
    "failedRequests":"provider COGS only; zero customer credits",
    "internalRetries":"provider COGS only; only the successful final attempt earns customer credits"
  }'::jsonb
from ai_credit_rate_cards card
where card.key = 'managed-gemini' and card.version = 1
on conflict(rate_card_id, provider, model, operation) do nothing;

create or replace function enforce_ai_credit_rate_card_immutability()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'New AI credit rate cards must begin as drafts'
        using errcode = '23514',
              constraint = 'ai_credit_rate_card_immutable';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Published AI credit rate cards cannot be deleted'
        using errcode = '23514',
              constraint = 'ai_credit_rate_card_immutable';
    end if;
    return old;
  end if;
  if old.status = 'retired' then
    raise exception 'Retired AI credit rate cards are immutable'
      using errcode = '23514',
            constraint = 'ai_credit_rate_card_immutable';
  end if;
  if old.status = 'active' then
    if not (
      new.status = 'retired'
      and new.retired_at is not null
      and (to_jsonb(new) - 'status' - 'retired_at')
        = (to_jsonb(old) - 'status' - 'retired_at')
    ) then
      raise exception 'Active AI credit rate cards may only be retired'
        using errcode = '23514',
              constraint = 'ai_credit_rate_card_immutable';
    end if;
    return new;
  end if;
  if new.status = 'active' and not exists (
    select 1 from ai_credit_rates where rate_card_id = old.id
  ) then
    raise exception 'An AI credit rate card must contain a rate before activation'
      using errcode = '23514',
            constraint = 'ai_credit_rate_card_immutable';
  end if;
  return new;
end
$$;

drop trigger if exists ai_credit_rate_card_immutability
  on ai_credit_rate_cards;
create trigger ai_credit_rate_card_immutability
before insert or update or delete on ai_credit_rate_cards
for each row execute function enforce_ai_credit_rate_card_immutability();

create or replace function enforce_ai_credit_rate_immutability()
returns trigger
language plpgsql
as $$
declare
  card_status text;
begin
  select status into card_status
  from ai_credit_rate_cards
  where id = coalesce(new.rate_card_id, old.rate_card_id);
  if card_status is distinct from 'draft' then
    raise exception 'Rates on a published AI credit rate card are immutable'
      using errcode = '23514',
            constraint = 'ai_credit_rate_immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

drop trigger if exists ai_credit_rate_immutability on ai_credit_rates;
create trigger ai_credit_rate_immutability
before insert or update or delete on ai_credit_rates
for each row execute function enforce_ai_credit_rate_immutability();

create table if not exists organization_spend_controls (
  organization_id uuid primary key
    references organizations(id) on delete restrict,
  ai_credit_overage_cap_minor bigint not null default 0
    check (ai_credit_overage_cap_minor >= 0),
  currency char(3) not null default 'USD',
  changed_by_user_id uuid references users(id) on delete set null,
  changed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

alter table billing_prices
  add column if not exists component text not null default 'base';
alter table billing_prices
  add column if not exists meter_event_name text;
alter table billing_prices
  add column if not exists included_quantity bigint;
alter table billing_prices
  add column if not exists billing_block_size bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'billing_prices'::regclass
      and conname = 'billing_prices_component_check'
  ) then
    alter table billing_prices
      add constraint billing_prices_component_check
      check (
        component in (
          'base',
          'ai_credit_overage',
          'managed_string_overage',
          'npm_seat'
        )
      ) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'billing_prices'::regclass
      and conname = 'billing_prices_included_quantity_check'
  ) then
    alter table billing_prices
      add constraint billing_prices_included_quantity_check
      check (included_quantity is null or included_quantity >= 0) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'billing_prices'::regclass
      and conname = 'billing_prices_block_size_check'
  ) then
    alter table billing_prices
      add constraint billing_prices_block_size_check
      check (billing_block_size is null or billing_block_size > 0) not valid;
  end if;
end
$$;

alter table billing_prices validate constraint billing_prices_component_check;
alter table billing_prices
  validate constraint billing_prices_included_quantity_check;
alter table billing_prices validate constraint billing_prices_block_size_check;

create unique index if not exists idx_billing_prices_one_active_component
  on billing_prices(plan_id, component, currency, billing_interval)
  where active = true;

create or replace function enforce_billing_price_immutability()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Billing price mappings cannot be deleted; deactivate them'
      using errcode = '23514',
            constraint = 'billing_price_immutable';
  end if;
  if (to_jsonb(new) - 'active' - 'metadata')
    <> (to_jsonb(old) - 'active' - 'metadata') then
    raise exception 'Published billing price fields are immutable; create a new versioned key'
      using errcode = '23514',
            constraint = 'billing_price_immutable';
  end if;
  return new;
end
$$;

drop trigger if exists billing_price_immutability on billing_prices;
create trigger billing_price_immutability
before update or delete on billing_prices
for each row execute function enforce_billing_price_immutability();

alter table subscriptions
  add column if not exists usage_period_start timestamptz;
alter table subscriptions
  add column if not exists usage_period_end timestamptz;

alter table billing_checkout_sessions
  add column if not exists checkout_mode text not null default 'subscription';
alter table billing_checkout_sessions
  add column if not exists metadata jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'billing_checkout_sessions'::regclass
      and conname = 'billing_checkout_sessions_mode_check'
  ) then
    alter table billing_checkout_sessions
      add constraint billing_checkout_sessions_mode_check
      check (checkout_mode in ('subscription', 'setup')) not valid;
  end if;
end
$$;

alter table billing_checkout_sessions
  validate constraint billing_checkout_sessions_mode_check;

create table if not exists subscription_items (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id) on delete restrict,
  billing_price_key text not null
    references billing_prices(key) on delete restrict,
  provider text not null,
  provider_subscription_item_id text not null,
  component text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  status text not null default 'active'
    check (status in ('active', 'removed')),
  provider_state_updated_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, provider_subscription_item_id),
  unique(subscription_id, billing_price_key)
);

create index if not exists idx_subscription_items_subscription
  on subscription_items(subscription_id, status, component);

create table if not exists billing_subscription_provisioning (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  billing_account_id uuid not null references billing_accounts(id) on delete restrict,
  plan_id uuid not null references product_plans(id) on delete restrict,
  base_price_key text not null references billing_prices(key) on delete restrict,
  checkout_session_id uuid not null
    references billing_checkout_sessions(id) on delete restrict,
  provider text not null default 'stripe',
  provider_setup_intent_id text,
  provider_subscription_id text,
  status text not null default 'pending'
    check (
      status in (
        'pending',
        'processing',
        'succeeded',
        'requires_action',
        'failed',
        'canceled'
      )
    ),
  idempotency_key text not null unique,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, checkout_session_id)
);

create index if not exists idx_billing_subscription_provisioning_ready
  on billing_subscription_provisioning(status, next_attempt_at, created_at)
  where status in ('pending', 'failed');

create table if not exists billing_meter_period_summaries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  subscription_id uuid not null references subscriptions(id) on delete restrict,
  billing_price_key text not null references billing_prices(key) on delete restrict,
  meter_key text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  observed_quantity bigint not null check (observed_quantity >= 0),
  included_quantity bigint not null check (included_quantity >= 0),
  billable_quantity bigint not null check (billable_quantity >= 0),
  billing_block_size bigint not null check (billing_block_size > 0),
  provider_event_quantity bigint not null check (provider_event_quantity >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(subscription_id, billing_price_key, period_start),
  check (period_end > period_start)
);

create table if not exists billing_meter_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  source_type text not null
    check (source_type in ('usage_event', 'resource_high_water', 'npm_seat_high_water')),
  source_id uuid not null,
  meter_key text not null,
  provider text not null default 'stripe',
  provider_customer_id text,
  provider_event_name text,
  period_start timestamptz not null,
  period_end timestamptz not null,
  quantity bigint not null check (quantity >= 0),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'delivered', 'failed', 'canceled')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  provider_event_id text,
  last_error text,
  delivered_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_type, source_id, meter_key),
  check (period_end > period_start)
);

create index if not exists idx_billing_meter_outbox_ready
  on billing_meter_outbox(status, next_attempt_at, created_at)
  where status in ('pending', 'failed');

alter table billing_meter_outbox
  drop constraint if exists billing_meter_outbox_source_type_check;

alter table billing_meter_outbox
  add constraint billing_meter_outbox_source_type_check
  check (
    source_type in (
      'usage_event',
      'resource_high_water',
      'npm_seat_high_water',
      'period_summary'
    )
  ) not valid;

alter table billing_meter_outbox
  validate constraint billing_meter_outbox_source_type_check;

create table if not exists organization_resource_high_water (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  resource_key text not null
    check (resource_key in ('managed_strings', 'npm_seats')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  observed_quantity bigint not null check (observed_quantity >= 0),
  source_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, resource_key, period_start),
  check (period_end > period_start)
);

create table if not exists npm_seat_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  npm_username text not null,
  status text not null default 'requested'
    check (
      status in (
        'requested',
        'inviting',
        'invited',
        'active',
        'revoking',
        'revoked',
        'failed'
      )
    ),
  requested_by_user_id uuid references users(id) on delete set null,
  requested_at timestamptz not null default now(),
  provisioned_at timestamptz,
  revoked_at timestamptz,
  provider_membership_role text,
  provider_state jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_npm_seat_assignments_one_current
  on npm_seat_assignments(organization_id, lower(npm_username))
  where status <> 'revoked';

create index if not exists idx_npm_seat_assignments_organization
  on npm_seat_assignments(organization_id, status, created_at);

create table if not exists npm_provisioning_outbox (
  id uuid primary key default gen_random_uuid(),
  seat_assignment_id uuid not null
    references npm_seat_assignments(id) on delete restrict,
  operation text not null check (operation in ('invite', 'revoke', 'reconcile')),
  idempotency_key text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'succeeded', 'failed', 'canceled')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  last_error text,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_npm_provisioning_outbox_ready
  on npm_provisioning_outbox(status, next_attempt_at, created_at)
  where status in ('pending', 'failed');

create table if not exists entitlement_lease_issuances (
  id uuid primary key default gen_random_uuid(),
  jti uuid not null unique,
  organization_id uuid not null references organizations(id) on delete restrict,
  project_id uuid not null references projects(id) on delete restrict,
  service_account_id uuid not null references service_accounts(id) on delete restrict,
  service_account_credential_id uuid
    references service_account_credentials(id) on delete set null,
  plan_key text,
  key_id text not null,
  capabilities jsonb not null,
  commercial_state text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (expires_at > issued_at)
);

create index if not exists idx_entitlement_lease_issuances_account
  on entitlement_lease_issuances(service_account_id, issued_at desc);

insert into product_plans(key, name, version, status, metadata)
values
  (
    'self-service-trial-v1',
    'Free trial',
    1,
    'active',
    '{
      "public":true,
      "kind":"trial",
      "displayOrder":0,
      "trialDays":14,
      "description":"Explore Hedgeling for 14 days without a card.",
      "paymentFailureGraceDays":0,
      "includedAiCredits":25000,
      "aiCreditBehavior":"hard_stop",
      "managedModelTier":"efficient",
      "managedStrings":2500,
      "targetLocales":3,
      "npmSeatsIncluded":0,
      "npmSeatsMaximum":0
    }'::jsonb
  ),
  (
    'starter-v1',
    'Starter',
    1,
    'active',
    '{
      "public":true,
      "kind":"starter",
      "displayOrder":1,
      "description":"For individual apps and early-stage teams.",
      "paymentFailureGraceDays":0,
      "listPrice":{"currency":"USD","unitAmountMinor":4900,"interval":"month"},
      "includedAiCredits":50000,
      "aiCreditBehavior":"hard_stop",
      "managedModelTier":"efficient",
      "managedStrings":2500,
      "targetLocales":3,
      "npmSeatsIncluded":1,
      "npmSeatsMaximum":2,
      "additionalNpmSeatAmountMinor":1500,
      "repositories":"unlimited",
      "workflows":"unlimited"
    }'::jsonb
  ),
  (
    'business-v1',
    'Business',
    1,
    'active',
    '{
      "public":true,
      "kind":"business",
      "displayOrder":2,
      "description":"For scaling engineering organizations that need advanced diagnostics and frontier models.",
      "paymentFailureGraceDays":0,
      "listPrice":{"currency":"USD","unitAmountMinor":358800,"interval":"year","monthlyEquivalentMinor":29900},
      "nonRefundableAnnualCommit":true,
      "includedAiCredits":100000,
      "aiCreditBehavior":"monthly_overage",
      "aiCreditOverage":{"blockSize":10000,"unitAmountMinor":1000},
      "managedStringsIncluded":15000,
      "managedStringsMaximum":50000,
      "managedStringOverage":{"blockSize":1000,"unitAmountMinor":1500},
      "targetLocales":"unlimited",
      "npmSeatsIncluded":5,
      "npmSeatOverage":{"unitAmountMinor":1500,"billing":"monthly_high_water"},
      "repositories":"unlimited",
      "workflows":"unlimited",
      "models":"frontier"
    }'::jsonb
  ),
  (
    'enterprise-v1',
    'Enterprise',
    1,
    'active',
    '{
      "public":true,
      "kind":"enterprise",
      "displayOrder":3,
      "description":"For multi-repository enterprises with custom compliance, isolation, model, and capacity requirements.",
      "paymentFailureGraceDays":0,
      "salesAssisted":true,
      "startsAt":{"currency":"USD","unitAmountMinor":150000,"interval":"month"},
      "includedAiCredits":"custom",
      "managedStrings":"custom",
      "targetLocales":"unlimited",
      "repositories":"unlimited",
      "workflows":"unlimited"
    }'::jsonb
  )
on conflict(key) do update
set name = excluded.name,
    status = excluded.status,
    metadata = excluded.metadata;

insert into plan_entitlements(plan_id, entitlement_key, enabled, limits)
select plan.id, configured.entitlement_key, configured.enabled, configured.limits
from product_plans plan
cross join lateral (
  values
    ('verified_exports'::text, true, '{"resources":{"retentionDays":30}}'::jsonb),
    (
      'state_imports'::text,
      true,
      case plan.key
        when 'business-v1' then '{"resources":{"activeSourceStrings":50000}}'::jsonb
        when 'enterprise-v1' then '{"resources":{}}'::jsonb
        else '{"resources":{"activeSourceStrings":2500,"targetLocales":3}}'::jsonb
      end
    ),
    (
      'ai_revision'::text,
      true,
      case plan.key
        when 'self-service-trial-v1' then
          '{"usage":{"ai_credits":{"limit":25000,"warningPercent":75,"enforcement":"block"}},"resources":{"concurrentAiRuns":1},"modelTier":"efficient"}'::jsonb
        when 'starter-v1' then
          '{"usage":{"ai_credits":{"limit":50000,"warningPercent":75,"enforcement":"block"}},"resources":{"concurrentAiRuns":1},"modelTier":"efficient"}'::jsonb
        when 'business-v1' then
          '{"usage":{"ai_credits":{"included":100000,"warningPercent":75,"enforcement":"overage"}},"modelTier":"frontier"}'::jsonb
        else '{"usage":{"ai_credits":{"included":"custom","enforcement":"contract"}},"modelTier":"custom"}'::jsonb
      end
    ),
    (
      'local_extraction'::text,
      true,
      case when plan.key in ('self-service-trial-v1', 'starter-v1')
        then '{"suite":"basic"}'::jsonb
        else '{"suite":"full"}'::jsonb
      end
    ),
    (
      'local_diagnostics'::text,
      true,
      case when plan.key in ('self-service-trial-v1', 'starter-v1')
        then '{"suite":"basic"}'::jsonb
        else '{"suite":"full"}'::jsonb
      end
    ),
    (
      'frontier_models'::text,
      plan.key in ('business-v1', 'enterprise-v1'),
      '{}'::jsonb
    )
) configured(entitlement_key, enabled, limits)
where plan.key in (
  'self-service-trial-v1',
  'starter-v1',
  'business-v1',
  'enterprise-v1'
)
on conflict(plan_id, entitlement_key) do update
set enabled = excluded.enabled,
    limits = excluded.limits;
