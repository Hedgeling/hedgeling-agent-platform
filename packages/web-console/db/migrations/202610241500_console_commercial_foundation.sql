-- Chat is an included platform capability. Translation credits stay separate.
insert into entitlement_definitions(key,name,description,access_class) values
  ('agent_chat','Included assistant','Platform chat with fair-use limits, without translation-credit charges','paid_write'),
  ('ai_byok','Organization AI keys','Use an organization Gemini key for translation','paid_write')
on conflict do nothing;
insert into usage_metric_definitions(key,name,unit,description) values
  ('agent_chat_tokens','Included chat tokens','token','Assistant fair-use accounting; never billed as translation credits')
on conflict do nothing;
insert into feature_flags(key,name,description,default_enabled) values
  ('agent_chat','Included assistant','Commercial access to console conversations',true),
  ('ai_byok','Organization AI keys','Organization-owned translation credentials',true)
on conflict do nothing;
insert into plan_entitlements(plan_id,entitlement_key,enabled,limits)
select id,'agent_chat',true,'{"dailyUserTokens":500000,"periodOrganizationTokens":2000000}'::jsonb
from product_plans where key in ('legacy-v1','self-service-trial-v1','starter-v1','business-v1','enterprise-v1')
on conflict do nothing;
insert into plan_entitlements(plan_id,entitlement_key,enabled)
select id,'ai_byok',true from product_plans where key in ('starter-v1','business-v1','enterprise-v1')
on conflict do nothing;

insert into permissions(key) values ('ai_providers.view'),('ai_providers.manage') on conflict do nothing;
insert into role_permissions(role_id,permission_id)
select r.id,p.id from roles r cross join permissions p
where r.organization_id is null and (
  (r.key in ('platform_super_admin','organization_owner','organization_admin') and p.key in ('ai_providers.view','ai_providers.manage'))
  or (r.key='billing_admin' and p.key='ai_providers.view')
) on conflict do nothing;

create table organization_ai_settings (
  organization_id uuid primary key references organizations(id) on delete restrict,
  translation_mode text not null default 'managed' check(translation_mode in ('managed','byok')),
  revision integer not null default 0,
  updated_at timestamptz not null default now()
);
create table organization_ai_credentials (
  organization_id uuid primary key references organizations(id) on delete restrict,
  provider text not null check(provider='gemini'),
  encrypted_secret jsonb not null,
  last_four text not null,
  validated_at timestamptz,
  created_by_user_id uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
-- Pending secrets are encrypted too. Expired/discarded/confirmed proposals are
-- scrubbed; a scheduled cleanup is required for proposals never visited again.
create table organization_ai_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  user_id uuid not null references users(id) on delete cascade,
  action text not null check(action in ('connect','remove','translation_mode')),
  expected_revision integer not null,
  payload jsonb not null,
  preview jsonb not null,
  status text not null default 'pending' check(status in ('pending','confirmed','rejected','expired')),
  expires_at timestamptz not null default now()+interval '15 minutes',
  created_at timestamptz not null default now()
);
create index on organization_ai_proposals(user_id,created_at);
