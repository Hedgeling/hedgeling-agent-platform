alter table projects add column if not exists source_locale text;

alter table billing_prices
  add column if not exists unit_amount_minor bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'billing_prices'::regclass
      and conname = 'billing_prices_unit_amount_minor_check'
  ) then
    alter table billing_prices
      add constraint billing_prices_unit_amount_minor_check
      check (unit_amount_minor is null or unit_amount_minor >= 0)
      not valid;
  end if;
end
$$;

alter table billing_prices
  validate constraint billing_prices_unit_amount_minor_check;

alter table usage_metric_definitions
  drop constraint if exists usage_metric_definitions_unit_check;

alter table usage_metric_definitions
  add constraint usage_metric_definitions_unit_check
  check (unit in ('word', 'character', 'token', 'action')) not valid;

alter table usage_metric_definitions
  validate constraint usage_metric_definitions_unit_check;

insert into usage_metric_definitions(key, name, unit, description)
values(
  'ai_generation_actions',
  'AI generation actions',
  'action',
  'Successful logical AI generation operations, independent of provider retry count.'
)
on conflict(key) do nothing;

create table if not exists workflow_presets (
  key text not null,
  version integer not null check (version > 0),
  name text not null,
  description text not null,
  definition jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),
  primary key(key, version)
);

insert into workflow_presets(key, version, name, description, definition)
values
  (
    'ai_publish', 1, 'AI → Publish',
    'Generate translations with AI and publish without a required human gate.',
    '{"steps":["ai_generate","publish"]}'::jsonb
  ),
  (
    'ai_human_review', 1, 'AI → Human review → Publish',
    'Generate with AI, then require human review before publication.',
    '{"steps":["ai_generate","human_review","publish"]}'::jsonb
  ),
  (
    'ai_translator_lead', 1, 'AI → Translator edit → Lead approval → Publish',
    'Use a two-stage linguistic workflow after AI generation.',
    '{"steps":["ai_generate","translator_edit","lead_approval","publish"]}'::jsonb
  ),
  (
    'human_reviewer', 1, 'Human translation → Reviewer approval → Publish',
    'Use a fully human translation and review workflow.',
    '{"steps":["human_translate","reviewer_approval","publish"]}'::jsonb
  )
on conflict(key, version) do nothing;

create table if not exists project_workflows (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  preset_key text not null,
  preset_version integer not null,
  status text not null default 'active' check (status in ('active', 'superseded')),
  configuration jsonb not null default '{}'::jsonb,
  activated_by_user_id uuid references users(id) on delete set null,
  activated_at timestamptz not null default now(),
  superseded_at timestamptz,
  foreign key(preset_key, preset_version)
    references workflow_presets(key, version) on delete restrict
);

create unique index if not exists idx_project_workflows_one_active
  on project_workflows(project_id) where status = 'active';

create table if not exists user_legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  document_type text not null check (
    document_type in ('terms_of_service', 'privacy_policy')
  ),
  document_version text not null,
  accepted_at timestamptz not null,
  ip_address inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  unique(user_id, document_type, document_version)
);

create table if not exists self_service_trial_claims (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references users(id) on delete restrict,
  organization_id uuid not null unique references organizations(id) on delete restrict,
  owner_email text not null,
  email_domain text,
  trial_started_at timestamptz not null,
  trial_ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (trial_ends_at > trial_started_at)
);

create index if not exists idx_self_service_trial_claims_domain
  on self_service_trial_claims(email_domain)
  where email_domain is not null;

create unique index if not exists idx_service_accounts_id_organization
  on service_accounts(id, organization_id);

create table if not exists organization_onboarding (
  organization_id uuid primary key references organizations(id) on delete restrict,
  owner_user_id uuid not null references users(id) on delete restrict,
  business_unit_id uuid not null references business_units(id) on delete restrict,
  project_id uuid not null references projects(id) on delete restrict,
  service_account_id uuid references service_accounts(id) on delete set null,
  state text not null default 'complete' check (state in ('in_progress', 'complete')),
  source_locale text not null,
  target_locales text[] not null,
  workflow_preset_key text not null,
  workflow_version integer not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(workflow_preset_key, workflow_version)
    references workflow_presets(key, version) on delete restrict,
  foreign key(business_unit_id, organization_id)
    references business_units(id, organization_id) on delete restrict,
  foreign key(project_id, business_unit_id)
    references projects(id, business_unit_id) on delete restrict,
  foreign key(service_account_id, organization_id)
    references service_accounts(id, organization_id) on delete restrict,
  check (cardinality(target_locales) between 1 and 3)
);

insert into product_plans(key, name, version, status, metadata)
values(
  'self-service-trial-v1',
  'Free trial',
  1,
  'active',
  '{
    "public": true,
    "kind": "trial",
    "displayOrder": 0,
    "trialDays": 14,
    "description": "Explore a production-shaped Hedgeling workspace with strict trial limits."
  }'::jsonb
)
on conflict(key) do update
set name = excluded.name,
    status = excluded.status,
    metadata = product_plans.metadata || excluded.metadata;

insert into plan_entitlements(plan_id, entitlement_key, enabled, limits)
select plan.id, entitlement.key, true, entitlement.limits
from product_plans plan
cross join lateral (
  values
    (
      'verified_exports'::text,
      '{"resources":{"retentionDays":30}}'::jsonb
    ),
    (
      'state_imports'::text,
      '{
        "usage":{"source_words_processed":{"limit":50000,"warningPercent":80,"enforcement":"block"}},
        "resources":{"activeSourceStrings":2500,"targetLocales":3}
      }'::jsonb
    ),
    (
      'ai_revision'::text,
      '{
        "usage":{
          "source_words_processed":{"limit":50000,"warningPercent":80,"enforcement":"block"},
          "ai_generation_actions":{"limit":1000,"warningPercent":80,"enforcement":"block"},
          "llm_total_tokens":{"limit":2000000,"warningPercent":80,"enforcement":"block"}
        },
        "resources":{"concurrentAiRuns":1}
      }'::jsonb
    )
) entitlement(key, limits)
where plan.key = 'self-service-trial-v1'
on conflict(plan_id, entitlement_key) do update
set enabled = excluded.enabled, limits = excluded.limits;
