create extension if not exists pgcrypto;

create table if not exists schema_migrations (
  key text primary key,
  applied_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  organization_type text not null default 'customer'
    check (organization_type in ('customer', 'agency', 'internal_platform', 'individual_vendor')),
  status text not null default 'active'
    check (status in ('active', 'suspended', 'closed')),
  default_currency char(3) not null default 'USD',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists business_units (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  slug text not null,
  name text not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, slug)
);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  source_locale text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table projects add column if not exists business_unit_id uuid references business_units(id) on delete restrict;
alter table projects add column if not exists source_locale text;

insert into organizations(slug, name, organization_type, metadata)
values ('hedgeling-bootstrap', 'Hedgeling Bootstrap', 'customer', '{"bootstrap": true}'::jsonb)
on conflict(slug) do nothing;

insert into business_units(organization_id, slug, name, metadata)
select id, 'default', 'Default', '{"bootstrap": true}'::jsonb
from organizations
where slug = 'hedgeling-bootstrap'
on conflict(organization_id, slug) do nothing;

update projects
set business_unit_id = (
  select bu.id
  from business_units bu
  join organizations o on o.id = bu.organization_id
  where o.slug = 'hedgeling-bootstrap' and bu.slug = 'default'
)
where business_unit_id is null;

create or replace function hedgeling_bootstrap_business_unit_id()
returns uuid
language sql
stable
as $$
  select bu.id
  from business_units bu
  join organizations o on o.id = bu.organization_id
  where o.slug = 'hedgeling-bootstrap' and bu.slug = 'default'
  limit 1
$$;

alter table projects alter column business_unit_id set not null;
alter table projects alter column business_unit_id set default hedgeling_bootstrap_business_unit_id();

comment on column projects.business_unit_id is
  'Tenant owner. The bootstrap default preserves legacy importers; tenant-aware APIs must always provide this value explicitly.';

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  display_name text,
  status text not null default 'active' check (status in ('invited', 'active', 'suspended', 'closed')),
  platform_staff boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_users_email_lower on users(lower(email));

create table if not exists user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  provider_subject text not null,
  email_verified boolean not null default false,
  last_authenticated_at timestamptz,
  created_at timestamptz not null default now(),
  unique(provider, provider_subject)
);

create table if not exists organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  membership_type text not null default 'internal' check (membership_type in ('internal', 'external')),
  status text not null default 'invited' check (status in ('invited', 'active', 'suspended', 'removed')),
  invited_by_user_id uuid references users(id) on delete set null,
  activated_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, user_id)
);

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  slug text not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, slug)
);

create table if not exists team_memberships (
  team_id uuid not null references teams(id) on delete cascade,
  organization_membership_id uuid not null references organization_memberships(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(team_id, organization_membership_id)
);

create table if not exists service_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  name text not null,
  status text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
  owner_user_id uuid references users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  key text not null,
  name text not null,
  description text,
  system_role boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_roles_system_key on roles(key) where organization_id is null;
create unique index if not exists idx_roles_org_key on roles(organization_id, key) where organization_id is not null;

create table if not exists permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  description text,
  created_at timestamptz not null default now()
);

create table if not exists role_permissions (
  role_id uuid not null references roles(id) on delete cascade,
  permission_id uuid not null references permissions(id) on delete cascade,
  primary key(role_id, permission_id)
);

insert into permissions(key)
select key from unnest(array[
  'organization.view', 'organization.update', 'organization.delete', 'organization.transfer_ownership',
  'members.view', 'members.invite', 'members.manage', 'teams.manage', 'business_units.create',
  'business_units.manage', 'projects.create', 'projects.manage', 'roles.assign', 'audit.view',
  'security.manage', 'locales.view', 'locales.manage', 'prompts.view', 'prompts.propose',
  'prompts.approve', 'prompts.manage', 'personas.view', 'personas.propose', 'personas.approve',
  'personas.manage', 'glossary.view', 'glossary.propose', 'glossary.approve', 'glossary.manage',
  'strings.view', 'translations.view', 'translations.edit', 'translations.submit',
  'translations.approve', 'translations.publish', 'jobs.view', 'jobs.create', 'jobs.assign',
  'jobs.cancel', 'work_orders.view', 'work_orders.manage', 'quality.approve', 'imports.run',
  'exports.run', 'api_credentials.manage', 'webhooks.manage', 'usage.view', 'budgets.manage',
  'billing.view', 'billing.manage', 'vendors.view', 'vendors.invite', 'vendors.manage',
  'vendor_linguists.approve', 'rate_cards.view', 'rate_cards.propose', 'rate_cards.approve',
  'payables.view', 'payables.approve', 'disputes.open', 'payment_records.manage',
  'identity.manage', 'provisioning.manage', 'access_requests.approve',
  'access_reviews.manage', 'support_access.manage', 'audit.export',
  'payout_accounts.view', 'payout_accounts.manage',
  'facilitated_payments.view', 'facilitated_payments.initiate',
  'facilitated_payments.refund', 'facilitated_transfers.release'
]) as key
on conflict(key) do nothing;

insert into roles(key, name, system_role)
select seed.key, seed.name, true
from (values
  ('platform_super_admin', 'Platform super-admin'),
  ('organization_owner', 'Organization owner'),
  ('organization_admin', 'Organization admin'),
  ('billing_admin', 'Billing admin'),
  ('security_admin', 'Security admin'),
  ('vendor_manager', 'Vendor manager'),
  ('organization_viewer', 'Organization viewer'),
  ('business_unit_admin', 'Business unit admin'),
  ('project_admin', 'Project admin'),
  ('localization_manager', 'Localization manager'),
  ('developer', 'Developer'),
  ('translator', 'Translator'),
  ('lead_translator', 'Lead translator'),
  ('reviewer', 'Reviewer'),
  ('lead_reviewer', 'Lead reviewer'),
  ('language_owner', 'Language owner'),
  ('terminologist', 'Terminologist'),
  ('requester', 'Requester'),
  ('viewer', 'Viewer'),
  ('agency_owner', 'Agency owner'),
  ('agency_admin', 'Agency admin'),
  ('agency_operations', 'Agency operations'),
  ('agency_finance', 'Agency finance'),
  ('agency_lead_linguist', 'Agency lead linguist'),
  ('agency_linguist', 'Agency linguist')
) as seed(key, name)
where not exists (select 1 from roles r where r.organization_id is null and r.key = seed.key);

insert into role_permissions(role_id, permission_id)
select r.id, p.id from roles r cross join permissions p
where r.organization_id is null
  and (
    r.key = 'platform_super_admin'
    or (
      r.key = 'organization_owner'
      and p.key not in (
        'payout_accounts.view',
        'payout_accounts.manage',
        'facilitated_transfers.release'
      )
    )
  )
on conflict do nothing;

with grants(role_key, permission_key) as (values
  ('organization_admin', 'organization.view'), ('organization_admin', 'organization.update'),
  ('organization_admin', 'members.view'), ('organization_admin', 'members.invite'),
  ('organization_admin', 'members.manage'), ('organization_admin', 'teams.manage'),
  ('organization_admin', 'business_units.create'), ('organization_admin', 'business_units.manage'),
  ('organization_admin', 'projects.create'), ('organization_admin', 'projects.manage'),
  ('organization_admin', 'roles.assign'), ('organization_admin', 'audit.view'),
  ('organization_admin', 'identity.manage'), ('organization_admin', 'provisioning.manage'),
  ('organization_admin', 'access_requests.approve'),
  ('organization_admin', 'access_reviews.manage'), ('organization_admin', 'audit.export'),
  ('organization_admin', 'api_credentials.manage'),
  ('organization_admin', 'vendors.view'), ('organization_admin', 'vendors.invite'),
  ('organization_admin', 'vendors.manage'), ('organization_admin', 'vendor_linguists.approve'),
  ('organization_admin', 'rate_cards.view'), ('organization_admin', 'rate_cards.approve'),
  ('organization_admin', 'work_orders.view'), ('organization_admin', 'work_orders.manage'),
  ('organization_admin', 'quality.approve'), ('organization_admin', 'payables.view'),
  ('organization_admin', 'payables.approve'), ('organization_admin', 'disputes.open'),
  ('organization_admin', 'payment_records.manage'),
  ('organization_admin', 'facilitated_payments.view'),
  ('organization_admin', 'facilitated_payments.initiate'),
  ('organization_admin', 'facilitated_payments.refund'),
  ('billing_admin', 'organization.view'), ('billing_admin', 'vendors.view'),
  ('billing_admin', 'billing.view'),
  ('billing_admin', 'billing.manage'), ('billing_admin', 'usage.view'), ('billing_admin', 'budgets.manage'),
  ('billing_admin', 'work_orders.view'),
  ('billing_admin', 'payables.view'), ('billing_admin', 'payables.approve'),
  ('billing_admin', 'disputes.open'), ('billing_admin', 'payment_records.manage'),
  ('billing_admin', 'facilitated_payments.view'),
  ('billing_admin', 'facilitated_payments.initiate'),
  ('billing_admin', 'facilitated_payments.refund'),
  ('security_admin', 'organization.view'), ('security_admin', 'members.view'),
  ('security_admin', 'security.manage'), ('security_admin', 'audit.view'),
  ('security_admin', 'identity.manage'), ('security_admin', 'provisioning.manage'),
  ('security_admin', 'access_requests.approve'), ('security_admin', 'access_reviews.manage'),
  ('security_admin', 'audit.export'), ('security_admin', 'api_credentials.manage'),
  ('vendor_manager', 'organization.view'), ('vendor_manager', 'vendors.view'),
  ('vendor_manager', 'vendors.invite'),
  ('vendor_manager', 'vendors.manage'), ('vendor_manager', 'vendor_linguists.approve'),
  ('vendor_manager', 'rate_cards.view'), ('vendor_manager', 'rate_cards.approve'),
  ('vendor_manager', 'work_orders.view'), ('vendor_manager', 'work_orders.manage'),
  ('organization_viewer', 'organization.view'), ('organization_viewer', 'usage.view'),
  ('business_unit_admin', 'organization.view'), ('business_unit_admin', 'members.view'),
  ('business_unit_admin', 'projects.create'), ('business_unit_admin', 'projects.manage'),
  ('business_unit_admin', 'locales.manage'), ('business_unit_admin', 'prompts.manage'),
  ('business_unit_admin', 'personas.manage'), ('business_unit_admin', 'glossary.manage'),
  ('project_admin', 'strings.view'), ('project_admin', 'translations.view'),
  ('project_admin', 'translations.edit'), ('project_admin', 'translations.approve'),
  ('project_admin', 'locales.manage'), ('project_admin', 'prompts.manage'),
  ('project_admin', 'personas.manage'), ('project_admin', 'glossary.manage'),
  ('localization_manager', 'strings.view'), ('localization_manager', 'translations.view'),
  ('localization_manager', 'translations.edit'), ('localization_manager', 'translations.approve'),
  ('localization_manager', 'jobs.view'), ('localization_manager', 'jobs.create'),
  ('localization_manager', 'jobs.assign'), ('localization_manager', 'prompts.view'),
  ('localization_manager', 'work_orders.view'), ('localization_manager', 'work_orders.manage'),
  ('localization_manager', 'personas.view'), ('localization_manager', 'glossary.view'),
  ('developer', 'strings.view'), ('developer', 'translations.view'), ('developer', 'imports.run'),
  ('developer', 'exports.run'), ('developer', 'api_credentials.manage'), ('developer', 'webhooks.manage'),
  ('translator', 'strings.view'), ('translator', 'translations.view'),
  ('translator', 'translations.edit'), ('translator', 'translations.submit'),
  ('lead_translator', 'strings.view'), ('lead_translator', 'translations.view'),
  ('lead_translator', 'translations.edit'), ('lead_translator', 'translations.submit'),
  ('lead_translator', 'translations.approve'), ('lead_translator', 'glossary.propose'),
  ('reviewer', 'strings.view'), ('reviewer', 'translations.view'),
  ('reviewer', 'translations.edit'), ('reviewer', 'translations.submit'),
  ('lead_reviewer', 'strings.view'), ('lead_reviewer', 'translations.view'),
  ('lead_reviewer', 'translations.edit'), ('lead_reviewer', 'translations.approve'),
  ('lead_reviewer', 'quality.approve'),
  ('lead_reviewer', 'work_orders.view'),
  ('language_owner', 'strings.view'), ('language_owner', 'translations.view'),
  ('language_owner', 'translations.approve'), ('language_owner', 'glossary.approve'),
  ('language_owner', 'personas.approve'), ('language_owner', 'prompts.approve'),
  ('terminologist', 'strings.view'), ('terminologist', 'glossary.view'),
  ('terminologist', 'glossary.propose'), ('terminologist', 'glossary.manage'),
  ('requester', 'strings.view'), ('requester', 'translations.view'),
  ('requester', 'jobs.view'), ('requester', 'jobs.create'),
  ('viewer', 'strings.view'), ('viewer', 'translations.view'),
  ('agency_operations', 'jobs.view'), ('agency_operations', 'jobs.assign'),
  ('agency_operations', 'work_orders.view'), ('agency_operations', 'work_orders.manage'),
  ('agency_finance', 'rate_cards.view'), ('agency_finance', 'rate_cards.propose'),
  ('agency_finance', 'work_orders.view'), ('agency_finance', 'payables.view'),
  ('agency_finance', 'disputes.open'), ('agency_finance', 'payment_records.manage'),
  ('agency_lead_linguist', 'strings.view'), ('agency_lead_linguist', 'translations.view'),
  ('agency_lead_linguist', 'translations.edit'), ('agency_lead_linguist', 'translations.approve'),
  ('agency_linguist', 'strings.view'), ('agency_linguist', 'translations.view'),
  ('agency_linguist', 'translations.edit'), ('agency_linguist', 'translations.submit')
)
insert into role_permissions(role_id, permission_id)
select r.id, p.id
from grants g
join roles r on r.organization_id is null and r.key = g.role_key
join permissions p on p.key = g.permission_key
on conflict do nothing;

with agency_grants(role_key, permission_key) as (values
  ('agency_owner', 'organization.view'), ('agency_owner', 'organization.update'),
  ('agency_owner', 'organization.delete'), ('agency_owner', 'organization.transfer_ownership'),
  ('agency_owner', 'members.view'), ('agency_owner', 'members.invite'),
  ('agency_owner', 'members.manage'), ('agency_owner', 'teams.manage'),
  ('agency_owner', 'roles.assign'), ('agency_owner', 'audit.view'),
  ('agency_owner', 'identity.manage'), ('agency_owner', 'provisioning.manage'),
  ('agency_owner', 'access_requests.approve'), ('agency_owner', 'access_reviews.manage'),
  ('agency_owner', 'audit.export'), ('agency_owner', 'api_credentials.manage'),
  ('agency_owner', 'vendors.view'), ('agency_owner', 'vendors.manage'),
  ('agency_owner', 'rate_cards.view'), ('agency_owner', 'rate_cards.propose'),
  ('agency_owner', 'work_orders.view'), ('agency_owner', 'work_orders.manage'),
  ('agency_owner', 'payables.view'), ('agency_owner', 'disputes.open'),
  ('agency_owner', 'payment_records.manage'), ('agency_owner', 'payout_accounts.view'),
  ('agency_owner', 'payout_accounts.manage'),
  ('agency_owner', 'facilitated_payments.view'),
  ('agency_admin', 'organization.view'), ('agency_admin', 'organization.update'),
  ('agency_admin', 'members.view'), ('agency_admin', 'members.invite'),
  ('agency_admin', 'members.manage'), ('agency_admin', 'teams.manage'),
  ('agency_admin', 'roles.assign'), ('agency_admin', 'audit.view'),
  ('agency_admin', 'identity.manage'), ('agency_admin', 'provisioning.manage'),
  ('agency_admin', 'access_requests.approve'), ('agency_admin', 'access_reviews.manage'),
  ('agency_admin', 'audit.export'), ('agency_admin', 'api_credentials.manage'),
  ('agency_admin', 'vendors.view'), ('agency_admin', 'vendors.manage'),
  ('agency_admin', 'rate_cards.view'), ('agency_admin', 'work_orders.view'),
  ('agency_admin', 'work_orders.manage'), ('agency_admin', 'payout_accounts.view'),
  ('agency_admin', 'payout_accounts.manage'),
  ('agency_admin', 'facilitated_payments.view'),
  ('agency_operations', 'organization.view'), ('agency_operations', 'members.view'),
  ('agency_operations', 'vendors.view'), ('agency_operations', 'vendors.manage'),
  ('agency_finance', 'vendors.view'), ('agency_finance', 'payout_accounts.view'),
  ('agency_finance', 'facilitated_payments.view'),
  ('agency_lead_linguist', 'vendors.view')
)
insert into role_permissions(role_id, permission_id)
select r.id, p.id
from agency_grants g
join roles r on r.organization_id is null and r.key = g.role_key
join permissions p on p.key = g.permission_key
on conflict do nothing;

-- Individual agency linguists receive customer context only through the
-- assignment-scoped personal API. Relationship and commercial work-order
-- discovery remain agency governance capabilities.
delete from role_permissions rp
using roles r, permissions permission
where rp.role_id = r.id
  and rp.permission_id = permission.id
  and r.organization_id is null
  and (
    (r.key = 'agency_linguist' and permission.key = 'vendors.view')
    or (
      r.key in ('agency_linguist', 'agency_lead_linguist')
      and permission.key = 'work_orders.view'
    )
  );

with reader_roles(role_key) as (values
  ('organization_admin'), ('business_unit_admin'), ('project_admin'), ('localization_manager'),
  ('developer'), ('translator'), ('lead_translator'), ('reviewer'), ('lead_reviewer'),
  ('language_owner'), ('terminologist'), ('requester'), ('viewer'),
  ('agency_operations'), ('agency_lead_linguist'), ('agency_linguist')
), read_permissions(permission_key) as (values
  ('strings.view'), ('translations.view'), ('locales.view'), ('prompts.view'),
  ('personas.view'), ('glossary.view')
)
insert into role_permissions(role_id, permission_id)
select r.id, p.id
from reader_roles rr
cross join read_permissions permission_seed
join roles r on r.organization_id is null and r.key = rr.role_key
join permissions p on p.key = permission_seed.permission_key
on conflict do nothing;

create table if not exists role_assignments (
  id uuid primary key default gen_random_uuid(),
  principal_type text not null check (principal_type in ('user', 'team', 'service_account', 'system_agent')),
  principal_id uuid not null,
  role_id uuid not null references roles(id) on delete cascade,
  scope_type text not null check (scope_type in ('platform', 'organization', 'business_unit', 'project', 'vendor_relationship', 'work_order', 'job')),
  scope_id uuid,
  inherit_to_children boolean not null default false,
  conditions jsonb not null default '{}'::jsonb,
  granted_by_user_id uuid references users(id) on delete set null,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check ((scope_type = 'platform' and scope_id is null) or (scope_type <> 'platform' and scope_id is not null))
);

create table if not exists invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  token_digest text not null unique,
  membership_type text not null default 'internal' check (membership_type in ('internal', 'external')),
  invited_by_user_id uuid references users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete set null,
  actor_type text not null check (actor_type in ('user', 'service_account', 'system_agent', 'platform')),
  actor_id uuid,
  effective_user_id uuid references users(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id uuid,
  request_id text,
  ip_address inet,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Phase 6 enterprise identity and governance. Cognito remains the identity
-- broker; this database owns tenant policy, provisioning state, machine
-- credentials, and review evidence. Provider and API secrets are never stored
-- in plaintext.
create table if not exists organization_identity_policies (
  organization_id uuid primary key references organizations(id) on delete cascade,
  password_login_enabled boolean not null default true,
  sso_required boolean not null default false,
  jit_membership_enabled boolean not null default false,
  jit_membership_type text not null default 'internal'
    check (jit_membership_type in ('internal', 'external')),
  updated_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not sso_required or not password_login_enabled)
);

insert into organization_identity_policies(organization_id)
select id from organizations
on conflict(organization_id) do nothing;

create table if not exists organization_verified_domains (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  domain text not null,
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'revoked')),
  verification_digest text not null,
  verified_at timestamptz,
  verified_by_user_id uuid references users(id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (domain = lower(domain)),
  unique(organization_id, domain)
);

create unique index if not exists idx_verified_domains_active_domain
  on organization_verified_domains(domain)
  where status in ('pending', 'verified');

create table if not exists identity_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  connection_type text not null check (connection_type in ('saml', 'oidc')),
  display_name text not null,
  cognito_provider_name text not null,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'disabled')),
  metadata jsonb not null default '{}'::jsonb,
  created_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, cognito_provider_name)
);

alter table user_identities
  add column if not exists identity_connection_id uuid
    references identity_connections(id) on delete set null;

create table if not exists recovery_login_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  reason text not null,
  expires_at timestamptz not null,
  granted_by_user_id uuid references users(id) on delete restrict,
  revoked_at timestamptz,
  revoked_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (char_length(reason) between 1 and 1000)
);

create unique index if not exists idx_recovery_login_current
  on recovery_login_grants(organization_id, user_id)
  where revoked_at is null;

create table if not exists scim_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  token_prefix text not null unique,
  token_digest text not null unique,
  status text not null default 'active' check (status in ('active', 'revoked')),
  expires_at timestamptz,
  last_used_at timestamptz,
  created_by_user_id uuid references users(id) on delete set null,
  revoked_by_user_id uuid references users(id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists scim_user_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  external_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, external_id),
  unique(organization_id, user_id)
);

create table if not exists scim_group_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  external_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, external_id),
  unique(organization_id, team_id)
);

create table if not exists service_account_credentials (
  id uuid primary key default gen_random_uuid(),
  service_account_id uuid not null references service_accounts(id) on delete cascade,
  token_prefix text not null unique,
  token_digest text not null unique,
  status text not null default 'active' check (status in ('active', 'revoked')),
  expires_at timestamptz,
  last_used_at timestamptz,
  created_by_user_id uuid references users(id) on delete set null,
  revoked_by_user_id uuid references users(id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists access_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  requested_by_user_id uuid not null references users(id) on delete cascade,
  role_id uuid not null references roles(id) on delete restrict,
  scope_type text not null check (scope_type in ('organization', 'business_unit', 'project')),
  scope_id uuid not null,
  inherit_to_children boolean not null default false,
  conditions jsonb not null default '{}'::jsonb,
  requested_expires_at timestamptz,
  reason text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'canceled')),
  decided_by_user_id uuid references users(id) on delete set null,
  decision_reason text,
  decided_at timestamptz,
  role_assignment_id uuid references role_assignments(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(reason) between 1 and 2000)
);

create table if not exists access_review_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  status text not null default 'draft'
    check (status in ('draft', 'open', 'completed', 'canceled')),
  due_at timestamptz,
  created_by_user_id uuid references users(id) on delete set null,
  opened_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists access_review_items (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references access_review_campaigns(id) on delete cascade,
  role_assignment_id uuid not null references role_assignments(id) on delete restrict,
  reviewer_user_id uuid not null references users(id) on delete restrict,
  decision text not null default 'pending'
    check (decision in ('pending', 'retain', 'revoke')),
  decision_reason text,
  decided_at timestamptz,
  assignment_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique(campaign_id, role_assignment_id)
);

create table if not exists support_access_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  access_type text not null check (access_type in ('support', 'break_glass')),
  permission_keys text[] not null,
  reason text not null,
  ticket_reference text,
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  approved_by_user_id uuid references users(id) on delete restrict,
  revoked_at timestamptz,
  revoked_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (cardinality(permission_keys) > 0),
  check (char_length(reason) between 1 and 2000)
);

create index if not exists idx_identity_connections_organization
  on identity_connections(organization_id, status);
create index if not exists idx_recovery_login_lookup
  on recovery_login_grants(organization_id, user_id, expires_at)
  where revoked_at is null;
create index if not exists idx_scim_tokens_lookup
  on scim_tokens(token_prefix, status);
create index if not exists idx_service_credentials_lookup
  on service_account_credentials(token_prefix, status);
create index if not exists idx_access_requests_organization
  on access_requests(organization_id, status, created_at desc);
create index if not exists idx_review_campaigns_organization
  on access_review_campaigns(organization_id, status);
create index if not exists idx_review_items_reviewer
  on access_review_items(reviewer_user_id, decision);
create index if not exists idx_support_access_active
  on support_access_grants(organization_id, user_id, starts_at, expires_at)
  where revoked_at is null;

-- Phase 3A commercial access foundation. Provider synchronization, usage
-- metering, and budgets build on these local records; request authorization
-- never calls a payment provider synchronously.
create table if not exists entitlement_definitions (
  key text primary key,
  name text not null,
  description text not null,
  access_class text not null check (access_class in ('retention', 'export', 'paid_write')),
  created_at timestamptz not null default now()
);

create table if not exists product_plans (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  version integer not null default 1 check (version > 0),
  status text not null default 'active' check (status in ('draft', 'active', 'retired')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists plan_entitlements (
  plan_id uuid not null references product_plans(id) on delete restrict,
  entitlement_key text not null references entitlement_definitions(key) on delete restrict,
  enabled boolean not null default true,
  limits jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key(plan_id, entitlement_key)
);

create table if not exists billing_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references organizations(id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  provider text,
  provider_customer_id text,
  billing_email text,
  currency char(3) not null default 'USD',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_billing_accounts_provider_customer
  on billing_accounts(provider, provider_customer_id)
  where provider is not null and provider_customer_id is not null;

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  billing_account_id uuid not null references billing_accounts(id) on delete restrict,
  plan_id uuid not null references product_plans(id) on delete restrict,
  provider text,
  provider_subscription_id text,
  state text not null check (
    state in ('trialing', 'active', 'past_due', 'paused', 'unpaid', 'canceled')
  ),
  current_period_start timestamptz,
  current_period_end timestamptz,
  usage_period_start timestamptz,
  usage_period_end timestamptz,
  grace_ends_at timestamptz,
  cancel_at_period_end boolean not null default false,
  provider_state_updated_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_subscriptions_provider_subscription
  on subscriptions(provider, provider_subscription_id)
  where provider is not null and provider_subscription_id is not null;
create unique index if not exists idx_subscriptions_one_current
  on subscriptions(billing_account_id)
  where state <> 'canceled';

create table if not exists organization_entitlement_overrides (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  entitlement_key text not null references entitlement_definitions(key) on delete restrict,
  enabled boolean not null,
  limits jsonb not null default '{}'::jsonb,
  reason text not null,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  superseded_at timestamptz,
  granted_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (expires_at is null or expires_at > starts_at)
);

create unique index if not exists idx_org_entitlement_overrides_current
  on organization_entitlement_overrides(organization_id, entitlement_key)
  where superseded_at is null;

create table if not exists feature_flags (
  key text primary key,
  name text not null,
  description text not null,
  default_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists organization_feature_flag_overrides (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  feature_key text not null references feature_flags(key) on delete restrict,
  enabled boolean not null,
  reason text not null,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  superseded_at timestamptz,
  changed_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (expires_at is null or expires_at > starts_at)
);

create unique index if not exists idx_org_feature_overrides_current
  on organization_feature_flag_overrides(organization_id, feature_key)
  where superseded_at is null;

create table if not exists billing_prices (
  key text primary key,
  plan_id uuid not null references product_plans(id) on delete restrict,
  provider text not null,
  provider_price_id text not null,
  currency char(3) not null,
  billing_interval text not null check (billing_interval in ('month', 'year')),
  unit_amount_minor bigint check (unit_amount_minor is null or unit_amount_minor >= 0),
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(provider, provider_price_id)
);

alter table billing_prices
  add column if not exists unit_amount_minor bigint;

create table if not exists billing_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  api_version text,
  livemode boolean not null default false,
  provider_created_at timestamptz,
  status text not null default 'processing'
    check (status in ('processing', 'processed', 'ignored', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  payload jsonb not null,
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(provider, provider_event_id)
);

create index if not exists idx_billing_provider_events_status_received
  on billing_provider_events(status, received_at);

create table if not exists billing_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  billing_account_id uuid not null references billing_accounts(id) on delete restrict,
  price_key text not null references billing_prices(key) on delete restrict,
  provider text not null,
  provider_session_id text not null,
  status text not null default 'open'
    check (status in ('open', 'completed', 'expired')),
  url text not null,
  expires_at timestamptz not null,
  created_by_user_id uuid references users(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(provider, provider_session_id)
);

create unique index if not exists idx_billing_checkout_one_open
  on billing_checkout_sessions(billing_account_id)
  where status = 'open';

insert into entitlement_definitions(key, name, description, access_class)
values
  ('verified_exports', 'Verified exports', 'Export verified human translations.', 'export'),
  ('state_imports', 'State imports', 'Import source catalogs and translation state.', 'paid_write'),
  ('ai_revision', 'AI revision', 'Generate AI-assisted translation revisions.', 'paid_write')
on conflict(key) do nothing;

insert into feature_flags(key, name, description, default_enabled)
values
  ('verified_exports', 'Verified exports', 'Controls verified translation exports.', true),
  ('state_imports', 'State imports', 'Controls state import processing.', true),
  ('ai_revision', 'AI revision', 'Controls AI-assisted single-string revision.', true),
  (
    'facilitated_payments',
    'Facilitated agency payments',
    'Controls the gated Stripe Connect agency-payment program.',
    false
  )
on conflict(key) do nothing;

insert into product_plans(key, name, version, status, metadata)
values (
  'legacy-v1',
  'Legacy access',
  1,
  'active',
  '{"migrationPlan":true}'::jsonb
)
on conflict(key) do nothing;

insert into plan_entitlements(plan_id, entitlement_key, enabled)
select plan.id, entitlement.key, true
from product_plans plan
cross join entitlement_definitions entitlement
where plan.key = 'legacy-v1'
on conflict(plan_id, entitlement_key) do nothing;

-- Installations that ran the original Phase 3 schema already have at least one
-- migration subscription. Record that fact before the guarded migration so the
-- first deployment of this fix cannot grant legacy access to newer organizations.
insert into schema_migrations(key, metadata)
select
  '2026-07-legacy-billing-backfill',
  '{"recognizedExistingBackfill":true}'::jsonb
where exists (
  select 1
  from subscriptions
  where metadata->>'migrationSubscription' = 'true'
)
on conflict(key) do nothing;

do $$
declare
  claimed_migration text;
begin
  perform pg_advisory_xact_lock(hashtext('hedgeling:2026-07-legacy-billing-backfill'));

  insert into schema_migrations(key, metadata)
  values (
    '2026-07-legacy-billing-backfill',
    '{"legacyPlan":"legacy-v1"}'::jsonb
  )
  on conflict(key) do nothing
  returning key into claimed_migration;

  if claimed_migration is not null then
    insert into billing_accounts(organization_id, status, currency, metadata)
    select
      organization.id,
      'active',
      organization.default_currency,
      '{"migrationAccount":true}'::jsonb
    from organizations organization
    where organization.organization_type in ('customer', 'internal_platform')
    on conflict(organization_id) do nothing;

    insert into subscriptions(
      billing_account_id,
      plan_id,
      state,
      current_period_start,
      metadata
    )
    select
      account.id,
      plan.id,
      'active',
      now(),
      '{"migrationSubscription":true}'::jsonb
    from billing_accounts account
    join organizations organization on organization.id = account.organization_id
    cross join product_plans plan
    where organization.organization_type in ('customer', 'internal_platform')
      and plan.key = 'legacy-v1'
      and not exists (
        select 1
        from subscriptions existing
        where existing.billing_account_id = account.id
      )
    on conflict do nothing;
  end if;
end
$$;

-- Agency and vendor-relationship boundaries establish eligibility. Customer
-- content remains protected by the Phase 5 active work-assignment evaluator.
create table if not exists vendor_relationships (
  id uuid primary key default gen_random_uuid(),
  customer_organization_id uuid not null references organizations(id) on delete restrict,
  agency_organization_id uuid not null references organizations(id) on delete restrict,
  status text not null default 'invited'
    check (status in ('invited', 'onboarding', 'active', 'suspended', 'terminated')),
  default_currency char(3) not null default 'USD',
  payment_terms_days integer check (payment_terms_days is null or payment_terms_days >= 0),
  customer_vendor_number text,
  requires_linguist_approval boolean not null default true,
  agency_may_assign_linguists boolean not null default false,
  maximum_subcontracting_depth integer not null default 0 check (maximum_subcontracting_depth >= 0),
  effective_from date,
  effective_to date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (customer_organization_id <> agency_organization_id),
  check (effective_to is null or effective_from is null or effective_to >= effective_from),
  unique(customer_organization_id, agency_organization_id)
);

create table if not exists vendor_relationship_scopes (
  id uuid primary key default gen_random_uuid(),
  vendor_relationship_id uuid not null references vendor_relationships(id) on delete cascade,
  scope_type text not null check (scope_type in ('business_unit', 'project', 'locale', 'service_type', 'content_classification')),
  scope_id uuid,
  scope_value text,
  created_at timestamptz not null default now(),
  check ((scope_id is not null)::integer + (scope_value is not null)::integer = 1)
);

create table if not exists vendor_approved_linguists (
  id uuid primary key default gen_random_uuid(),
  vendor_relationship_id uuid not null references vendor_relationships(id) on delete cascade,
  agency_membership_id uuid not null references organization_memberships(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'revoked')),
  approved_by_user_id uuid references users(id) on delete set null,
  approved_at timestamptz,
  expires_at timestamptz,
  conditions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(vendor_relationship_id, agency_membership_id)
);

create table if not exists rate_cards (
  id uuid primary key default gen_random_uuid(),
  vendor_relationship_id uuid not null references vendor_relationships(id) on delete cascade,
  version integer not null check (version > 0),
  currency char(3) not null,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected', 'superseded')),
  effective_from date,
  effective_to date,
  payment_terms_days integer check (payment_terms_days is null or payment_terms_days >= 0),
  minimum_charge_minor bigint check (minimum_charge_minor is null or minimum_charge_minor >= 0),
  notes text,
  submitted_by_user_id uuid references users(id) on delete set null,
  approved_by_user_id uuid references users(id) on delete set null,
  rejected_by_user_id uuid references users(id) on delete set null,
  submitted_at timestamptz,
  approved_at timestamptz,
  rejected_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_from is null or effective_to >= effective_from),
  unique(vendor_relationship_id, version)
);

alter table rate_cards
  add column if not exists rejected_by_user_id uuid references users(id) on delete set null,
  add column if not exists rejected_at timestamptz,
  add column if not exists rejection_reason text;

create table if not exists rate_card_lines (
  id uuid primary key default gen_random_uuid(),
  rate_card_id uuid not null references rate_cards(id) on delete cascade,
  service_type text not null,
  unit_type text not null check (unit_type in ('source_word', 'target_word', 'character', 'string', 'hour', 'fixed_job')),
  unit_rate numeric(20, 8) not null check (unit_rate >= 0),
  source_locale text,
  target_locale text,
  business_unit_id uuid references business_units(id) on delete restrict,
  project_id uuid references projects(id) on delete restrict,
  content_type text,
  match_band text,
  minimum_units numeric(20, 4) check (minimum_units is null or minimum_units >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists work_orders (
  id uuid primary key default gen_random_uuid(),
  vendor_relationship_id uuid not null references vendor_relationships(id) on delete restrict,
  work_order_number integer not null check (work_order_number > 0),
  project_id uuid not null references projects(id) on delete restrict,
  title text not null check (char_length(title) between 1 and 200),
  description text check (description is null or char_length(description) <= 5000),
  service_type text not null check (char_length(service_type) between 1 and 100),
  source_locale text,
  target_locale text,
  content_classification text,
  match_band text,
  unit_type text not null check (unit_type in ('source_word', 'target_word', 'character', 'string', 'hour', 'fixed_job')),
  estimated_units numeric(20, 4) check (estimated_units is null or estimated_units >= 0),
  due_at timestamptz,
  status text not null default 'draft' check (status in (
    'draft', 'offered', 'accepted', 'in_progress', 'submitted',
    'quality_approved', 'payable_approved', 'included_in_statement',
    'paid', 'canceled'
  )),
  rate_card_id uuid references rate_cards(id) on delete restrict,
  rate_card_line_id uuid references rate_card_lines(id) on delete restrict,
  snapshot_currency char(3),
  snapshot_currency_exponent integer check (snapshot_currency_exponent between 0 and 3),
  snapshot_unit_rate numeric(20, 8) check (snapshot_unit_rate is null or snapshot_unit_rate >= 0),
  snapshot_minimum_units numeric(20, 4) check (snapshot_minimum_units is null or snapshot_minimum_units >= 0),
  snapshot_minimum_charge_minor bigint check (
    snapshot_minimum_charge_minor is null or snapshot_minimum_charge_minor >= 0
  ),
  snapshot_payment_terms_days integer check (
    snapshot_payment_terms_days is null or snapshot_payment_terms_days >= 0
  ),
  created_by_user_id uuid references users(id) on delete set null,
  offered_by_user_id uuid references users(id) on delete set null,
  accepted_by_user_id uuid references users(id) on delete set null,
  quality_approved_by_user_id uuid references users(id) on delete set null,
  payable_approved_by_user_id uuid references users(id) on delete set null,
  canceled_by_user_id uuid references users(id) on delete set null,
  offered_at timestamptz,
  accepted_at timestamptz,
  started_at timestamptz,
  submitted_at timestamptz,
  quality_approved_at timestamptz,
  payable_approved_at timestamptz,
  canceled_at timestamptz,
  cancellation_reason text check (
    cancellation_reason is null or char_length(cancellation_reason) between 1 and 1000
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(vendor_relationship_id, work_order_number)
);

create table if not exists work_order_items (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references work_orders(id) on delete restrict,
  source_string_id uuid not null,
  created_at timestamptz not null default now(),
  unique(work_order_id, source_string_id)
);

create table if not exists work_assignments (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references work_orders(id) on delete restrict,
  agency_membership_id uuid not null references organization_memberships(id) on delete restrict,
  assignment_role text not null default 'translator' check (
    assignment_role in ('translator', 'reviewer', 'lead')
  ),
  status text not null default 'active' check (status in ('active', 'completed', 'revoked')),
  assigned_by_party text not null check (assigned_by_party in ('customer', 'agency')),
  assigned_by_user_id uuid references users(id) on delete set null,
  revoked_by_user_id uuid references users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  revoked_at timestamptz,
  revocation_reason text check (
    revocation_reason is null or char_length(revocation_reason) between 1 and 1000
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists work_submissions (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references work_orders(id) on delete restrict,
  work_assignment_id uuid not null references work_assignments(id) on delete restrict,
  delivered_units numeric(20, 4) not null check (delivered_units >= 0),
  notes text check (notes is null or char_length(notes) <= 5000),
  quality_status text not null default 'pending' check (
    quality_status in ('pending', 'approved', 'rejected')
  ),
  quality_reason text check (
    quality_reason is null or char_length(quality_reason) between 1 and 2000
  ),
  quality_decided_by_user_id uuid references users(id) on delete set null,
  quality_decided_at timestamptz,
  submitted_by_user_id uuid references users(id) on delete set null,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  created_at timestamptz not null default now(),
  unique(work_order_id, idempotency_key)
);

create table if not exists work_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references work_orders(id) on delete restrict,
  work_submission_id uuid references work_submissions(id) on delete restrict,
  entry_type text not null check (entry_type in ('approved_delivery', 'adjustment', 'reversal')),
  quantity numeric(20, 4),
  unit_type text check (
    unit_type is null or unit_type in ('source_word', 'target_word', 'character', 'string', 'hour', 'fixed_job')
  ),
  unit_rate numeric(20, 8),
  amount_minor bigint not null,
  currency char(3) not null,
  reason text check (reason is null or char_length(reason) between 1 and 2000),
  reversal_of_entry_id uuid references work_ledger_entries(id) on delete restrict,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  created_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(work_order_id, idempotency_key),
  check (
    (entry_type = 'approved_delivery' and work_submission_id is not null and quantity is not null and unit_type is not null and unit_rate is not null)
    or (entry_type = 'adjustment' and work_submission_id is null and quantity is null and unit_type is null and unit_rate is null and amount_minor <> 0 and reason is not null)
    or (entry_type = 'reversal' and reversal_of_entry_id is not null and amount_minor <> 0 and reason is not null)
  )
);

create unique index if not exists idx_work_ledger_approved_submission
  on work_ledger_entries(work_submission_id)
  where entry_type = 'approved_delivery';
create unique index if not exists idx_work_ledger_reversal
  on work_ledger_entries(reversal_of_entry_id)
  where reversal_of_entry_id is not null;

create table if not exists work_order_disputes (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references work_orders(id) on delete restrict,
  opened_by_party text not null check (opened_by_party in ('customer', 'agency')),
  opened_by_user_id uuid references users(id) on delete set null,
  reason text not null check (char_length(reason) between 1 and 2000),
  status text not null default 'open' check (status in ('open', 'resolved', 'rejected')),
  resolution text check (resolution is null or char_length(resolution) between 1 and 2000),
  resolved_by_user_id uuid references users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_work_order_open_dispute
  on work_order_disputes(work_order_id)
  where status = 'open';

create table if not exists payable_statements (
  id uuid primary key default gen_random_uuid(),
  vendor_relationship_id uuid not null references vendor_relationships(id) on delete restrict,
  statement_number integer not null check (statement_number > 0),
  currency char(3) not null,
  period_start date not null,
  period_end date not null,
  status text not null default 'draft' check (status in ('draft', 'finalized', 'paid', 'void')),
  subtotal_minor bigint not null default 0,
  due_date date,
  notes text check (notes is null or char_length(notes) <= 5000),
  created_by_user_id uuid references users(id) on delete set null,
  finalized_by_user_id uuid references users(id) on delete set null,
  voided_by_user_id uuid references users(id) on delete set null,
  finalized_at timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,
  void_reason text check (void_reason is null or char_length(void_reason) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start),
  unique(vendor_relationship_id, statement_number)
);

create table if not exists payable_statement_items (
  id uuid primary key default gen_random_uuid(),
  payable_statement_id uuid not null references payable_statements(id) on delete restrict,
  work_order_id uuid not null references work_orders(id) on delete restrict,
  amount_minor bigint not null,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  unique(payable_statement_id, work_order_id)
);

create table if not exists payment_records (
  id uuid primary key default gen_random_uuid(),
  payable_statement_id uuid not null references payable_statements(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  status text not null default 'reported' check (status in ('reported', 'confirmed', 'rejected')),
  payment_method text not null check (char_length(payment_method) between 1 and 100),
  external_reference text not null check (char_length(external_reference) between 1 and 200),
  paid_at timestamptz not null,
  reported_by_party text not null check (reported_by_party in ('customer', 'agency')),
  reported_by_user_id uuid references users(id) on delete set null,
  confirmed_by_user_id uuid references users(id) on delete set null,
  confirmed_at timestamptz,
  rejection_reason text check (
    rejection_reason is null or char_length(rejection_reason) between 1 and 1000
  ),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  created_at timestamptz not null default now(),
  unique(payable_statement_id, idempotency_key),
  unique(payable_statement_id, external_reference)
);

-- Phase 7B Connect foundation. This models legal/program enrollment and
-- connected-account readiness only. Customer collection, transfers, refunds,
-- and payouts remain disabled until their later Phase 7 slices ship.
create table if not exists facilitated_payment_program_enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  provider text not null default 'stripe' check (provider = 'stripe'),
  program_version text not null check (char_length(program_version) between 1 and 100),
  party_type text not null check (party_type in ('customer', 'agency')),
  provider_mode text not null check (provider_mode in ('test', 'live')),
  status text not null check (status in ('approved', 'suspended', 'terminated')),
  country char(2) not null default 'US' check (country = 'US'),
  currencies text[] not null default array['USD']::text[]
    check (currencies = array['USD']::text[]),
  payment_methods text[] not null default '{}'::text[],
  per_payment_cap_minor bigint not null check (per_payment_cap_minor > 0),
  rolling_cap_minor bigint not null check (
    rolling_cap_minor > 0 and rolling_cap_minor >= per_payment_cap_minor
  ),
  rolling_period_days integer not null default 30
    check (rolling_period_days between 1 and 366),
  manual_transfer_required boolean not null default true,
  terms_version text not null check (char_length(terms_version) between 1 and 100),
  policy_version text not null check (char_length(policy_version) between 1 and 100),
  acceptance_evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(acceptance_evidence) = 'object'),
  status_reason text not null check (char_length(status_reason) between 1 and 2000),
  approved_by_user_id uuid references users(id) on delete restrict,
  approved_at timestamptz,
  changed_by_user_id uuid not null references users(id) on delete restrict,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'approved' and approved_by_user_id is not null and approved_at is not null)
    or (status <> 'approved' and approved_by_user_id is null and approved_at is null)
  )
);

create unique index if not exists idx_facilitated_enrollment_current
  on facilitated_payment_program_enrollments(organization_id, provider, provider_mode)
  where superseded_at is null;
create index if not exists idx_facilitated_enrollment_status
  on facilitated_payment_program_enrollments(provider_mode, status, created_at desc);

create table if not exists agency_connected_accounts (
  id uuid primary key default gen_random_uuid(),
  agency_organization_id uuid not null references organizations(id) on delete restrict,
  provider text not null default 'stripe' check (provider = 'stripe'),
  provider_mode text not null check (provider_mode in ('test', 'live')),
  provider_account_id text,
  account_controller text not null default 'express' check (account_controller = 'express'),
  country char(2) not null default 'US' check (country = 'US'),
  default_currency char(3) not null default 'USD' check (default_currency = 'USD'),
  onboarding_state text not null default 'not_started'
    check (onboarding_state in ('not_started', 'pending', 'ready', 'restricted', 'disabled')),
  transfers_capability text not null default 'inactive'
    check (transfers_capability in ('inactive', 'pending', 'active')),
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  requirements_due jsonb not null default '[]'::jsonb
    check (jsonb_typeof(requirements_due) = 'array'),
  requirements_pending_verification jsonb not null default '[]'::jsonb
    check (jsonb_typeof(requirements_pending_verification) = 'array'),
  future_requirements_due jsonb not null default '[]'::jsonb
    check (jsonb_typeof(future_requirements_due) = 'array'),
  requirements_deadline timestamptz,
  disabled_reason text,
  provider_state_updated_at timestamptz,
  last_webhook_at timestamptz,
  created_by_user_id uuid not null references users(id) on delete restrict,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (provider_account_id is null and onboarding_state = 'not_started')
    or provider_account_id is not null
  )
);

create unique index if not exists idx_agency_connected_account_provider
  on agency_connected_accounts(provider, provider_mode, provider_account_id)
  where provider_account_id is not null;
create unique index if not exists idx_agency_connected_account_current
  on agency_connected_accounts(agency_organization_id, provider, provider_mode)
  where superseded_at is null;
create index if not exists idx_agency_connected_account_state
  on agency_connected_accounts(provider_mode, onboarding_state, updated_at);

create table if not exists connected_account_onboarding_links (
  id uuid primary key default gen_random_uuid(),
  connected_account_id uuid not null references agency_connected_accounts(id) on delete restrict,
  status text not null default 'creating'
    check (status in ('creating', 'issued', 'failed', 'expired')),
  provider_created_at timestamptz,
  expires_at timestamptz,
  created_by_user_id uuid not null references users(id) on delete restrict,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at is null or provider_created_at is null or expires_at > provider_created_at)
);

create index if not exists idx_connected_onboarding_links_account
  on connected_account_onboarding_links(connected_account_id, created_at desc);

create table if not exists facilitated_payment_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'stripe' check (provider = 'stripe'),
  provider_event_id text not null,
  connected_account_context text,
  event_type text not null,
  api_version text,
  livemode boolean not null default false,
  provider_created_at timestamptz,
  target_resource_type text,
  target_resource_id uuid,
  status text not null default 'processing'
    check (status in ('processing', 'processed', 'ignored', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  payload jsonb not null,
  last_error text,
  replay_status text not null default 'not_requested'
    constraint facilitated_provider_event_replay_status
    check (replay_status in ('not_requested', 'processing', 'succeeded', 'failed')),
  replay_started_at timestamptz,
  last_replayed_at timestamptz,
  last_replayed_by_user_id uuid references users(id) on delete set null,
  last_replay_reason text,
  last_replay_correlation_id text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(provider, provider_event_id)
);

alter table facilitated_payment_provider_events
  add column if not exists replay_status text not null default 'not_requested';
alter table facilitated_payment_provider_events
  add column if not exists replay_started_at timestamptz;
alter table facilitated_payment_provider_events
  add column if not exists last_replayed_at timestamptz;
alter table facilitated_payment_provider_events
  add column if not exists last_replayed_by_user_id uuid references users(id) on delete set null;
alter table facilitated_payment_provider_events
  add column if not exists last_replay_reason text;
alter table facilitated_payment_provider_events
  add column if not exists last_replay_correlation_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'facilitated_payment_provider_events'::regclass
      and conname = 'facilitated_provider_event_replay_status'
  ) then
    alter table facilitated_payment_provider_events
      add constraint facilitated_provider_event_replay_status
      check (replay_status in ('not_requested', 'processing', 'succeeded', 'failed'));
  end if;
end
$$;

create index if not exists idx_facilitated_provider_events_status
  on facilitated_payment_provider_events(status, received_at);
create index if not exists idx_facilitated_provider_events_account
  on facilitated_payment_provider_events(connected_account_context, received_at desc);

create or replace function enforce_facilitated_payment_enrollment_party()
returns trigger
language plpgsql
as $$
declare
  organization_type_value text;
begin
  select organization_type into organization_type_value
  from organizations
  where id = new.organization_id;

  if organization_type_value is null then
    raise exception 'Facilitated payment enrollment organization does not exist'
      using errcode = '23514', constraint = 'facilitated_enrollment_organization_type';
  end if;
  if (
    (new.party_type = 'agency' and organization_type_value <> 'agency')
    or (new.party_type = 'customer' and organization_type_value <> 'customer')
  ) then
    raise exception 'Facilitated payment party type must match the organization type'
      using errcode = '23514', constraint = 'facilitated_enrollment_organization_type';
  end if;
  if (
    (new.party_type = 'customer'
      and new.payment_methods <> array['card', 'us_bank_account']::text[])
    or (new.party_type = 'agency' and cardinality(new.payment_methods) <> 0)
  ) then
    raise exception 'Facilitated payment methods do not match the party type'
      using errcode = '23514', constraint = 'facilitated_enrollment_payment_methods';
  end if;
  return new;
end
$$;

drop trigger if exists facilitated_payment_enrollment_party_guard
  on facilitated_payment_program_enrollments;
create trigger facilitated_payment_enrollment_party_guard
before insert or update of organization_id, party_type, payment_methods
on facilitated_payment_program_enrollments
for each row execute function enforce_facilitated_payment_enrollment_party();

create or replace function enforce_agency_connected_account_owner()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from organizations
    where id = new.agency_organization_id and organization_type = 'agency'
  ) then
    raise exception 'Connected accounts must belong to agency organizations'
      using errcode = '23514', constraint = 'agency_connected_account_owner';
  end if;
  return new;
end
$$;

drop trigger if exists agency_connected_account_owner_guard on agency_connected_accounts;
create trigger agency_connected_account_owner_guard
before insert or update of agency_organization_id
on agency_connected_accounts
for each row execute function enforce_agency_connected_account_owner();

-- Phase 7C-7F money state. Provider mutations remain independently gated at
-- runtime; these tables preserve the facts needed to reconcile any operation
-- that was accepted by Stripe.
alter table payment_records
  add column if not exists record_source text not null default 'external';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'payment_records'::regclass
      and conname = 'payment_record_source'
  ) then
    alter table payment_records
      add constraint payment_record_source
      check (record_source in ('external', 'facilitated')) not valid;
  end if;
  alter table payment_records validate constraint payment_record_source;
end
$$;

create table if not exists facilitated_payment_customers (
  id uuid primary key default gen_random_uuid(),
  customer_organization_id uuid not null references organizations(id) on delete restrict,
  provider text not null default 'stripe' check (provider = 'stripe'),
  provider_mode text not null check (provider_mode in ('test', 'live')),
  provider_customer_id text,
  created_by_user_id uuid not null references users(id) on delete restrict,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_facilitated_customer_current
  on facilitated_payment_customers(customer_organization_id, provider, provider_mode)
  where superseded_at is null;
create unique index if not exists idx_facilitated_customer_provider
  on facilitated_payment_customers(provider, provider_mode, provider_customer_id)
  where provider_customer_id is not null;

create table if not exists facilitated_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  payable_statement_id uuid not null references payable_statements(id) on delete restrict,
  vendor_relationship_id uuid not null references vendor_relationships(id) on delete restrict,
  customer_organization_id uuid not null references organizations(id) on delete restrict,
  agency_organization_id uuid not null references organizations(id) on delete restrict,
  connected_account_id uuid not null references agency_connected_accounts(id) on delete restrict,
  payment_customer_id uuid references facilitated_payment_customers(id) on delete restrict,
  provider text not null default 'stripe' check (provider = 'stripe'),
  provider_mode text not null check (provider_mode in ('test', 'live')),
  attempt_number integer not null check (attempt_number > 0),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency = 'USD'),
  state text not null default 'created'
    check (state in (
      'created', 'requires_action', 'processing', 'succeeded', 'failed', 'canceled'
    )),
  checkout_status text not null default 'creating'
    check (checkout_status in ('creating', 'open', 'complete', 'expired', 'failed')),
  provider_session_id text,
  provider_session_url text,
  provider_session_expires_at timestamptz,
  provider_payment_intent_id text,
  provider_charge_id text,
  provider_balance_transaction_id text,
  payment_method_type text
    check (payment_method_type is null or payment_method_type in ('card', 'us_bank_account')),
  provider_state_updated_at timestamptz,
  funds_available_at timestamptz,
  transfer_releasable_at timestamptz,
  failure_code text,
  failure_message text,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  request_fingerprint text not null check (char_length(request_fingerprint) = 64),
  created_by_user_id uuid not null references users(id) on delete restrict,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(payable_statement_id, attempt_number),
  unique(payable_statement_id, idempotency_key)
);

create unique index if not exists idx_facilitated_attempt_session
  on facilitated_payment_attempts(provider, provider_mode, provider_session_id)
  where provider_session_id is not null;
create unique index if not exists idx_facilitated_attempt_intent
  on facilitated_payment_attempts(provider, provider_mode, provider_payment_intent_id)
  where provider_payment_intent_id is not null;
create unique index if not exists idx_facilitated_attempt_charge
  on facilitated_payment_attempts(provider, provider_mode, provider_charge_id)
  where provider_charge_id is not null;
create unique index if not exists idx_facilitated_attempt_one_active
  on facilitated_payment_attempts(payable_statement_id)
  where state in ('created', 'requires_action', 'processing', 'succeeded');
create unique index if not exists idx_facilitated_attempt_one_open_session
  on facilitated_payment_attempts(payable_statement_id)
  where checkout_status in ('creating', 'open');
create index if not exists idx_facilitated_attempt_state
  on facilitated_payment_attempts(provider_mode, state, updated_at);

create table if not exists facilitated_payments (
  id uuid primary key default gen_random_uuid(),
  payment_attempt_id uuid not null unique
    references facilitated_payment_attempts(id) on delete restrict,
  payable_statement_id uuid not null references payable_statements(id) on delete restrict,
  vendor_relationship_id uuid not null references vendor_relationships(id) on delete restrict,
  customer_organization_id uuid not null references organizations(id) on delete restrict,
  agency_organization_id uuid not null references organizations(id) on delete restrict,
  connected_account_id uuid not null references agency_connected_accounts(id) on delete restrict,
  payment_record_id uuid unique references payment_records(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency = 'USD'),
  platform_fee_minor bigint not null default 0 check (platform_fee_minor = 0),
  provider text not null default 'stripe' check (provider = 'stripe'),
  provider_mode text not null check (provider_mode in ('test', 'live')),
  provider_payment_intent_id text not null,
  provider_charge_id text not null,
  application_state text not null check (application_state in ('applied', 'unapplied')),
  unapplied_reason text,
  succeeded_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (application_state = 'applied' and unapplied_reason is null)
    or (application_state = 'unapplied' and unapplied_reason is not null)
  ),
  unique(provider, provider_mode, provider_payment_intent_id),
  unique(provider, provider_mode, provider_charge_id)
);

create index if not exists idx_facilitated_payment_statement
  on facilitated_payments(payable_statement_id, created_at desc);

create table if not exists facilitated_transfer_instructions (
  id uuid primary key default gen_random_uuid(),
  facilitated_payment_id uuid not null unique
    references facilitated_payments(id) on delete restrict,
  connected_account_id uuid not null references agency_connected_accounts(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency = 'USD'),
  platform_fee_minor bigint not null default 0 check (platform_fee_minor = 0),
  state text not null default 'held'
    check (state in (
      'held', 'submitting', 'transferred', 'failed', 'partially_reversed', 'reversed'
    )),
  transfer_group text not null,
  provider_transfer_id text,
  provider_state_updated_at timestamptz,
  funds_available_at timestamptz,
  transfer_releasable_at timestamptz,
  released_by_user_id uuid references users(id) on delete restrict,
  release_claimed_at timestamptz,
  transferred_at timestamptz,
  failure_code text,
  failure_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_facilitated_transfer_provider
  on facilitated_transfer_instructions(provider_transfer_id)
  where provider_transfer_id is not null;
create index if not exists idx_facilitated_transfer_state
  on facilitated_transfer_instructions(state, transfer_releasable_at, created_at);

create table if not exists facilitated_refunds (
  id uuid primary key default gen_random_uuid(),
  facilitated_payment_id uuid not null references facilitated_payments(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency = 'USD'),
  status text not null default 'requested'
    check (status in (
      'requested', 'submitting', 'pending', 'requires_action',
      'succeeded', 'failed', 'canceled'
    )),
  reason text not null check (char_length(reason) between 1 and 2000),
  reference text not null check (char_length(reference) between 1 and 500),
  provider_refund_id text,
  provider_state_updated_at timestamptz,
  requested_by_organization_id uuid references organizations(id) on delete restrict,
  requested_by_user_id uuid references users(id) on delete restrict,
  approved_by_user_id uuid references users(id) on delete restrict,
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  succeeded_at timestamptz,
  failure_code text,
  failure_message text,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  request_fingerprint text not null check (char_length(request_fingerprint) = 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(facilitated_payment_id, idempotency_key)
);

create unique index if not exists idx_facilitated_refund_provider
  on facilitated_refunds(provider_refund_id)
  where provider_refund_id is not null;
create index if not exists idx_facilitated_refund_status
  on facilitated_refunds(status, created_at);

create table if not exists facilitated_transfer_reversals (
  id uuid primary key default gen_random_uuid(),
  transfer_instruction_id uuid not null
    references facilitated_transfer_instructions(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency = 'USD'),
  status text not null default 'submitting'
    check (status in ('submitting', 'succeeded', 'failed')),
  reason text not null check (char_length(reason) between 1 and 2000),
  reference text not null check (char_length(reference) between 1 and 500),
  provider_reversal_id text,
  approved_by_user_id uuid not null references users(id) on delete restrict,
  succeeded_at timestamptz,
  failure_code text,
  failure_message text,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  request_fingerprint text not null check (char_length(request_fingerprint) = 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(transfer_instruction_id, idempotency_key)
);

create unique index if not exists idx_facilitated_reversal_provider
  on facilitated_transfer_reversals(provider_reversal_id)
  where provider_reversal_id is not null;

create table if not exists facilitated_provider_disputes (
  id uuid primary key default gen_random_uuid(),
  facilitated_payment_id uuid not null references facilitated_payments(id) on delete restrict,
  provider_dispute_id text not null unique,
  classification text not null check (classification in ('return', 'dispute')),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency = 'USD'),
  status text not null
    check (status in (
      'warning_needs_response', 'warning_under_review', 'warning_closed',
      'needs_response', 'under_review', 'won', 'lost'
    )),
  reason text,
  evidence_due_at timestamptz,
  provider_state_updated_at timestamptz not null,
  opened_at timestamptz not null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table facilitated_provider_disputes
  drop constraint if exists facilitated_provider_disputes_status_check;
alter table facilitated_provider_disputes
  add constraint facilitated_provider_disputes_status_check check (status in (
    'warning_needs_response', 'warning_under_review', 'warning_closed',
    'needs_response', 'under_review', 'won', 'lost'
  ));

create index if not exists idx_facilitated_dispute_payment
  on facilitated_provider_disputes(facilitated_payment_id, status);

create table if not exists facilitated_funding_facts (
  id uuid primary key default gen_random_uuid(),
  facilitated_payment_id uuid not null references facilitated_payments(id) on delete restrict,
  fact_type text not null check (fact_type in (
    'payment_succeeded', 'refund_succeeded', 'return_recorded',
    'dispute_opened', 'dispute_warning_closed', 'funds_reinstated',
    'dispute_lost'
  )),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency = 'USD'),
  provider_object_id text,
  provider_event_id text,
  occurred_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

alter table facilitated_funding_facts
  drop constraint if exists facilitated_funding_facts_fact_type_check;
alter table facilitated_funding_facts
  add constraint facilitated_funding_facts_fact_type_check check (fact_type in (
    'payment_succeeded', 'refund_succeeded', 'return_recorded',
    'dispute_opened', 'dispute_warning_closed', 'funds_reinstated',
    'dispute_lost'
  ));

create unique index if not exists idx_facilitated_funding_fact_event
  on facilitated_funding_facts(provider_event_id, fact_type)
  where provider_event_id is not null;
create unique index if not exists idx_facilitated_funding_fact_object
  on facilitated_funding_facts(
    facilitated_payment_id, fact_type, provider_object_id
  )
  where provider_object_id is not null;
create index if not exists idx_facilitated_funding_fact_payment
  on facilitated_funding_facts(facilitated_payment_id, occurred_at);

create table if not exists facilitated_payouts (
  id uuid primary key default gen_random_uuid(),
  connected_account_id uuid not null references agency_connected_accounts(id) on delete restrict,
  provider_payout_id text not null unique,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency = 'USD'),
  status text not null check (status in ('pending', 'in_transit', 'paid', 'failed', 'canceled')),
  arrival_at timestamptz,
  provider_state_updated_at timestamptz not null,
  paid_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  failure_message text,
  last_reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table facilitated_payouts
  add column if not exists last_reconciled_at timestamptz;

create index if not exists idx_facilitated_payout_account
  on facilitated_payouts(connected_account_id, created_at desc);
create index if not exists idx_facilitated_payout_status
  on facilitated_payouts(status, updated_at);

create table if not exists facilitated_payout_reconciliation_checkpoints (
  connected_account_id uuid primary key
    references agency_connected_accounts(id) on delete restrict,
  provider_mode text not null check (provider_mode in ('test', 'live')),
  scan_status text not null default 'idle'
    check (scan_status in ('idle', 'running', 'partial', 'failed')),
  scan_id uuid,
  lease_id uuid,
  scan_range_start timestamptz,
  scan_range_end timestamptz,
  next_page_cursor text,
  local_candidates_completed_at timestamptz,
  provider_pages_completed_at timestamptz,
  last_provider_request_id text,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_successful_scan_at timestamptz,
  last_failure_at timestamptz,
  observed_count integer not null default 0 check (observed_count >= 0),
  changed_count integer not null default 0 check (changed_count >= 0),
  unchanged_count integer not null default 0 check (unchanged_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint facilitated_payout_reconciliation_state check (
    (scan_status = 'running' and scan_id is not null and lease_id is not null
      and scan_range_start is not null and scan_range_end is not null)
    or (scan_status = 'partial' and scan_id is not null
      and scan_range_start is not null and scan_range_end is not null)
    or scan_status in ('idle', 'failed')
  )
);

alter table facilitated_payout_reconciliation_checkpoints
  add column if not exists lease_id uuid;
alter table facilitated_payout_reconciliation_checkpoints
  add column if not exists local_candidates_completed_at timestamptz;
alter table facilitated_payout_reconciliation_checkpoints
  add column if not exists provider_pages_completed_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'facilitated_payout_reconciliation_checkpoints'::regclass
      and conname = 'facilitated_payout_reconciliation_state'
  ) then
    alter table facilitated_payout_reconciliation_checkpoints
      drop constraint if exists facilitated_payout_reconciliation_checkpoints_check;
    alter table facilitated_payout_reconciliation_checkpoints
      add constraint facilitated_payout_reconciliation_state check (
        (scan_status = 'running' and scan_id is not null and lease_id is not null
          and scan_range_start is not null and scan_range_end is not null)
        or (scan_status = 'partial' and scan_id is not null
          and scan_range_start is not null and scan_range_end is not null)
        or scan_status in ('idle', 'failed')
      );
  end if;
end
$$;

create index if not exists idx_payout_reconciliation_freshness
  on facilitated_payout_reconciliation_checkpoints(
    provider_mode, last_successful_scan_at, updated_at
  );

create table if not exists facilitated_payment_exceptions (
  id uuid primary key default gen_random_uuid(),
  exception_type text not null,
  severity text not null default 'high' check (severity in ('medium', 'high', 'critical')),
  organization_id uuid references organizations(id) on delete restrict,
  resource_type text not null,
  resource_id uuid not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  resolution text,
  resolved_by_user_id uuid references users(id) on delete restrict,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_facilitated_exception_open
  on facilitated_payment_exceptions(exception_type, resource_type, resource_id)
  where status = 'open';
create index if not exists idx_facilitated_exception_status
  on facilitated_payment_exceptions(status, severity, created_at);

create table if not exists facilitated_recovery_cases (
  id uuid primary key default gen_random_uuid(),
  facilitated_payment_id uuid references facilitated_payments(id) on delete restrict,
  payout_id uuid references facilitated_payouts(id) on delete restrict,
  case_type text not null check (case_type in (
    'return_after_transfer', 'dispute_after_transfer',
    'refund_after_transfer', 'payout_failure'
  )),
  exposure_minor bigint not null check (exposure_minor >= 0),
  currency char(3) not null check (currency = 'USD'),
  status text not null default 'open'
    check (status in ('open', 'recovering', 'resolved', 'written_off')),
  resolution text,
  resolved_by_user_id uuid references users(id) on delete restrict,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((facilitated_payment_id is not null) <> (payout_id is not null))
);

create unique index if not exists idx_facilitated_recovery_open_payment
  on facilitated_recovery_cases(facilitated_payment_id, case_type)
  where facilitated_payment_id is not null and status in ('open', 'recovering');
create unique index if not exists idx_facilitated_recovery_open_payout
  on facilitated_recovery_cases(payout_id, case_type)
  where payout_id is not null and status in ('open', 'recovering');

create table if not exists facilitated_payment_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  notification_type text not null,
  resource_type text not null,
  resource_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_facilitated_notification_once
  on facilitated_payment_notifications(
    organization_id, notification_type, resource_type, resource_id
  );
create index if not exists idx_facilitated_notification_pending
  on facilitated_payment_notifications(status, created_at);

create table if not exists facilitated_payment_certifications (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'stripe' check (provider = 'stripe'),
  provider_mode text not null check (provider_mode in ('test', 'live')),
  check_key text not null,
  status text not null check (status in ('pending', 'passed', 'failed')),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  notes text check (notes is null or char_length(notes) <= 5000),
  certified_by_user_id uuid not null references users(id) on delete restrict,
  certified_at timestamptz not null default now(),
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_facilitated_certification_current
  on facilitated_payment_certifications(provider, provider_mode, check_key)
  where superseded_at is null;

create or replace function preserve_facilitated_payment_certification()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Payment certifications are retained as rollout history'
      using errcode = '23514', constraint = 'facilitated_certification_immutable';
  end if;
  if old.superseded_at is null
     and new.superseded_at is not null
     and to_jsonb(new) - 'superseded_at' = to_jsonb(old) - 'superseded_at' then
    return new;
  end if;
  raise exception 'Payment certification facts are immutable'
    using errcode = '23514', constraint = 'facilitated_certification_immutable';
end
$$;

drop trigger if exists facilitated_payment_certification_guard
  on facilitated_payment_certifications;
create trigger facilitated_payment_certification_guard
before update or delete
on facilitated_payment_certifications
for each row execute function preserve_facilitated_payment_certification();

create or replace function enforce_facilitated_payment_customer_owner()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Facilitated payment customers are retained as commercial history'
      using errcode = '23514', constraint = 'facilitated_payment_customer_immutable';
  end if;
  if not exists (
    select 1 from organizations
    where id = new.customer_organization_id and organization_type = 'customer'
  ) then
    raise exception 'Facilitated payment customers must belong to customer organizations'
      using errcode = '23514', constraint = 'facilitated_payment_customer_owner';
  end if;
  if tg_op = 'UPDATE' and (
    new.customer_organization_id is distinct from old.customer_organization_id
    or new.provider is distinct from old.provider
    or new.provider_mode is distinct from old.provider_mode
    or new.created_by_user_id is distinct from old.created_by_user_id
    or not (
      new.provider_customer_id is not distinct from old.provider_customer_id
      or (old.provider_customer_id is null and new.provider_customer_id is not null)
    )
  ) then
    raise exception 'Facilitated payment customer ownership is immutable'
      using errcode = '23514', constraint = 'facilitated_payment_customer_immutable';
  end if;
  return new;
end
$$;

drop trigger if exists facilitated_payment_customer_owner_guard
  on facilitated_payment_customers;
create trigger facilitated_payment_customer_owner_guard
before insert or update or delete
on facilitated_payment_customers
for each row execute function enforce_facilitated_payment_customer_owner();

create or replace function enforce_facilitated_attempt_integrity()
returns trigger
language plpgsql
as $$
declare
  statement_row record;
begin
  if tg_op = 'DELETE' then
    raise exception 'Facilitated payment attempts are retained as commercial history'
      using errcode = '23514', constraint = 'facilitated_attempt_immutable';
  end if;
  if tg_op = 'UPDATE' then
    if new.payable_statement_id is distinct from old.payable_statement_id
       or new.vendor_relationship_id is distinct from old.vendor_relationship_id
       or new.customer_organization_id is distinct from old.customer_organization_id
       or new.agency_organization_id is distinct from old.agency_organization_id
       or new.connected_account_id is distinct from old.connected_account_id
       or new.payment_customer_id is distinct from old.payment_customer_id
       or new.provider is distinct from old.provider
       or new.provider_mode is distinct from old.provider_mode
       or new.attempt_number is distinct from old.attempt_number
       or new.amount_minor is distinct from old.amount_minor
       or new.currency is distinct from old.currency
       or new.idempotency_key is distinct from old.idempotency_key
       or new.request_fingerprint is distinct from old.request_fingerprint
       or new.created_by_user_id is distinct from old.created_by_user_id then
      raise exception 'Facilitated payment attempt ownership and amount are immutable'
        using errcode = '23514', constraint = 'facilitated_attempt_immutable';
    end if;
    if not (
      new.provider_session_id is not distinct from old.provider_session_id
      or (old.provider_session_id is null and new.provider_session_id is not null)
    ) or not (
      new.provider_payment_intent_id is not distinct from old.provider_payment_intent_id
      or (old.provider_payment_intent_id is null and new.provider_payment_intent_id is not null)
    ) or not (
      new.provider_charge_id is not distinct from old.provider_charge_id
      or (old.provider_charge_id is null and new.provider_charge_id is not null)
    ) or not (
      new.provider_balance_transaction_id
        is not distinct from old.provider_balance_transaction_id
      or (
        old.provider_balance_transaction_id is null
        and new.provider_balance_transaction_id is not null
      )
    ) or not (
      new.payment_method_type is not distinct from old.payment_method_type
      or (old.payment_method_type is null and new.payment_method_type is not null)
    ) then
      raise exception 'Facilitated payment provider identities are immutable once observed'
        using errcode = '23514', constraint = 'facilitated_attempt_immutable';
    end if;
    if new.state is distinct from old.state and not (
      (old.state = 'created' and new.state in (
        'requires_action', 'processing', 'succeeded', 'failed', 'canceled'
      ))
      or (old.state = 'requires_action' and new.state in (
        'processing', 'succeeded', 'failed', 'canceled'
      ))
      or (old.state = 'processing' and new.state in ('succeeded', 'failed', 'canceled'))
    ) then
      raise exception 'Facilitated payment attempt transition is invalid'
        using errcode = '23514', constraint = 'facilitated_attempt_lifecycle';
    end if;
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtext('statement-settlement:' || new.payable_statement_id::text)
  );
  select statement.id, statement.status, statement.subtotal_minor, statement.currency,
         statement.vendor_relationship_id,
         relationship.customer_organization_id,
         relationship.agency_organization_id
  into statement_row
  from payable_statements statement
  join vendor_relationships relationship
    on relationship.id = statement.vendor_relationship_id
  where statement.id = new.payable_statement_id
  for share;
  if statement_row.id is null
     or statement_row.status <> 'finalized'
     or statement_row.subtotal_minor <> new.amount_minor
     or statement_row.currency is distinct from new.currency
     or statement_row.vendor_relationship_id is distinct from new.vendor_relationship_id
     or statement_row.customer_organization_id is distinct from new.customer_organization_id
     or statement_row.agency_organization_id is distinct from new.agency_organization_id
     or exists(
       select 1 from payment_records
       where payable_statement_id = new.payable_statement_id
     )
     or not exists(
       select 1 from agency_connected_accounts account
       where account.id = new.connected_account_id
         and account.agency_organization_id = new.agency_organization_id
         and account.provider_mode = new.provider_mode
         and account.superseded_at is null
     ) then
    raise exception 'Facilitated payment attempt does not match an eligible statement'
      using errcode = '23514', constraint = 'facilitated_attempt_statement';
  end if;
  return new;
end
$$;

drop trigger if exists facilitated_attempt_integrity_guard
  on facilitated_payment_attempts;
create trigger facilitated_attempt_integrity_guard
before insert or update or delete
on facilitated_payment_attempts
for each row execute function enforce_facilitated_attempt_integrity();

create or replace function enforce_facilitated_payment_integrity()
returns trigger
language plpgsql
as $$
declare
  attempt_row facilitated_payment_attempts%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'Facilitated payments are retained as commercial history'
      using errcode = '23514', constraint = 'facilitated_payment_immutable';
  end if;
  if tg_op = 'UPDATE' then
    if new.payment_attempt_id is distinct from old.payment_attempt_id
       or new.payable_statement_id is distinct from old.payable_statement_id
       or new.vendor_relationship_id is distinct from old.vendor_relationship_id
       or new.customer_organization_id is distinct from old.customer_organization_id
       or new.agency_organization_id is distinct from old.agency_organization_id
       or new.connected_account_id is distinct from old.connected_account_id
       or new.amount_minor is distinct from old.amount_minor
       or new.currency is distinct from old.currency
       or new.platform_fee_minor is distinct from old.platform_fee_minor
       or new.provider is distinct from old.provider
       or new.provider_mode is distinct from old.provider_mode
       or new.provider_payment_intent_id is distinct from old.provider_payment_intent_id
       or new.provider_charge_id is distinct from old.provider_charge_id
       or new.application_state is distinct from old.application_state
       or new.unapplied_reason is distinct from old.unapplied_reason
       or new.succeeded_at is distinct from old.succeeded_at then
      raise exception 'Facilitated payment facts are immutable'
        using errcode = '23514', constraint = 'facilitated_payment_immutable';
    end if;
    if not (
      new.payment_record_id is not distinct from old.payment_record_id
      or (old.payment_record_id is null and new.payment_record_id is not null)
    ) then
      raise exception 'Facilitated payment application transition is invalid'
        using errcode = '23514', constraint = 'facilitated_payment_lifecycle';
    end if;
    if old.payment_record_id is null and new.payment_record_id is not null
       and not exists(
         select 1 from payment_records record
         where record.id = new.payment_record_id
           and record.payable_statement_id = new.payable_statement_id
           and record.amount_minor = new.amount_minor
           and record.currency = new.currency
           and record.status = 'confirmed'
           and record.record_source = 'facilitated'
       ) then
      raise exception 'Facilitated payment record does not match its payment'
        using errcode = '23514', constraint = 'facilitated_payment_record';
    end if;
    return new;
  end if;
  select * into attempt_row from facilitated_payment_attempts
  where id = new.payment_attempt_id for share;
  if attempt_row.id is null or attempt_row.state <> 'succeeded'
     or attempt_row.payable_statement_id is distinct from new.payable_statement_id
     or attempt_row.vendor_relationship_id is distinct from new.vendor_relationship_id
     or attempt_row.customer_organization_id is distinct from new.customer_organization_id
     or attempt_row.agency_organization_id is distinct from new.agency_organization_id
     or attempt_row.connected_account_id is distinct from new.connected_account_id
     or attempt_row.amount_minor is distinct from new.amount_minor
     or attempt_row.currency is distinct from new.currency
     or attempt_row.provider_mode is distinct from new.provider_mode
     or attempt_row.provider_payment_intent_id is distinct from new.provider_payment_intent_id
     or attempt_row.provider_charge_id is distinct from new.provider_charge_id then
    raise exception 'Facilitated payment does not match its succeeded attempt'
      using errcode = '23514', constraint = 'facilitated_payment_attempt';
  end if;
  if new.payment_record_id is not null then
    raise exception 'Facilitated payment records are attached after payment creation'
      using errcode = '23514', constraint = 'facilitated_payment_record';
  end if;
  return new;
end
$$;

drop trigger if exists facilitated_payment_integrity_guard on facilitated_payments;
create trigger facilitated_payment_integrity_guard
before insert or update or delete
on facilitated_payments
for each row execute function enforce_facilitated_payment_integrity();

create or replace function enforce_facilitated_transfer_integrity()
returns trigger
language plpgsql
as $$
declare
  payment_row facilitated_payments%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'Facilitated transfer instructions are retained as commercial history'
      using errcode = '23514', constraint = 'facilitated_transfer_immutable';
  end if;
  if tg_op = 'UPDATE' then
    if new.facilitated_payment_id is distinct from old.facilitated_payment_id
       or new.connected_account_id is distinct from old.connected_account_id
       or new.amount_minor is distinct from old.amount_minor
       or new.currency is distinct from old.currency
       or new.platform_fee_minor is distinct from old.platform_fee_minor
       or new.transfer_group is distinct from old.transfer_group then
      raise exception 'Facilitated transfer ownership and amount are immutable'
        using errcode = '23514', constraint = 'facilitated_transfer_immutable';
    end if;
    if not (
      new.provider_transfer_id is not distinct from old.provider_transfer_id
      or (old.provider_transfer_id is null and new.provider_transfer_id is not null)
    ) then
      raise exception 'Facilitated transfer provider identity is immutable'
        using errcode = '23514', constraint = 'facilitated_transfer_immutable';
    end if;
    if new.state is distinct from old.state and not (
      (old.state = 'held' and new.state = 'submitting')
      or (old.state = 'submitting' and new.state in ('transferred', 'failed'))
      or (old.state = 'failed' and new.state = 'held')
      or (old.state = 'transferred' and new.state in ('partially_reversed', 'reversed'))
      or (old.state = 'partially_reversed'
          and new.state in ('partially_reversed', 'reversed'))
    ) then
      raise exception 'Facilitated transfer transition is invalid'
        using errcode = '23514', constraint = 'facilitated_transfer_lifecycle';
    end if;
    return new;
  end if;
  select * into payment_row from facilitated_payments
  where id = new.facilitated_payment_id for share;
  if payment_row.id is null or payment_row.application_state <> 'applied'
     or payment_row.connected_account_id is distinct from new.connected_account_id
     or payment_row.amount_minor is distinct from new.amount_minor
     or payment_row.currency is distinct from new.currency then
    raise exception 'Transfer instruction must match an applied facilitated payment'
      using errcode = '23514', constraint = 'facilitated_transfer_payment';
  end if;
  return new;
end
$$;

drop trigger if exists facilitated_transfer_integrity_guard
  on facilitated_transfer_instructions;
create trigger facilitated_transfer_integrity_guard
before insert or update or delete
on facilitated_transfer_instructions
for each row execute function enforce_facilitated_transfer_integrity();

create or replace function enforce_facilitated_refund_integrity()
returns trigger
language plpgsql
as $$
declare
  payment_row facilitated_payments%rowtype;
  active_total bigint;
begin
  if tg_op = 'DELETE' then
    raise exception 'Facilitated refunds are retained as commercial history'
      using errcode = '23514', constraint = 'facilitated_refund_immutable';
  end if;
  select * into payment_row from facilitated_payments
  where id = new.facilitated_payment_id for update;
  if payment_row.id is null
     or payment_row.currency is distinct from new.currency then
    raise exception 'Refund must match its facilitated payment'
      using errcode = '23514', constraint = 'facilitated_refund_payment';
  end if;
  if tg_op = 'INSERT' then
    select coalesce(sum(amount_minor) filter(
      where status not in ('failed', 'canceled')
    ), 0)::bigint into active_total
    from facilitated_refunds
    where facilitated_payment_id = new.facilitated_payment_id;
    if active_total + new.amount_minor > payment_row.amount_minor then
      raise exception 'Refund total cannot exceed the facilitated payment'
        using errcode = '23514', constraint = 'facilitated_refund_total';
    end if;
    return new;
  end if;
  if new.facilitated_payment_id is distinct from old.facilitated_payment_id
     or new.amount_minor is distinct from old.amount_minor
     or new.currency is distinct from old.currency
     or new.reason is distinct from old.reason
     or new.reference is distinct from old.reference
     or new.requested_by_organization_id is distinct from old.requested_by_organization_id
     or new.requested_by_user_id is distinct from old.requested_by_user_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.request_fingerprint is distinct from old.request_fingerprint
     or new.requested_at is distinct from old.requested_at
     or not (
       new.provider_refund_id is not distinct from old.provider_refund_id
       or (old.provider_refund_id is null and new.provider_refund_id is not null)
     )
     or not (
       new.approved_by_user_id is not distinct from old.approved_by_user_id
       or (old.approved_by_user_id is null and new.approved_by_user_id is not null)
     ) then
    raise exception 'Facilitated refund request facts are immutable'
      using errcode = '23514', constraint = 'facilitated_refund_immutable';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'requested' and new.status = 'submitting')
    or (old.status = 'submitting' and new.status in (
      'pending', 'requires_action', 'succeeded', 'failed', 'canceled'
    ))
    or (old.status in ('pending', 'requires_action')
        and new.status in ('succeeded', 'failed', 'canceled'))
    or (old.status = 'failed' and new.status = 'submitting')
  ) then
    raise exception 'Facilitated refund transition is invalid'
      using errcode = '23514', constraint = 'facilitated_refund_lifecycle';
  end if;
  if old.status = 'failed' and new.status = 'submitting' then
    select coalesce(sum(amount_minor) filter(
      where status not in ('failed', 'canceled')
    ), 0)::bigint into active_total
    from facilitated_refunds
    where facilitated_payment_id = new.facilitated_payment_id
      and id <> new.id;
    if active_total + new.amount_minor > payment_row.amount_minor then
      raise exception 'Refund retry would exceed the facilitated payment'
        using errcode = '23514', constraint = 'facilitated_refund_total';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists facilitated_refund_integrity_guard on facilitated_refunds;
create trigger facilitated_refund_integrity_guard
before insert or update or delete
on facilitated_refunds
for each row execute function enforce_facilitated_refund_integrity();

create or replace function enforce_facilitated_reversal_integrity()
returns trigger
language plpgsql
as $$
declare
  transfer_row facilitated_transfer_instructions%rowtype;
  active_total bigint;
begin
  if tg_op = 'DELETE' then
    raise exception 'Transfer reversals are retained as commercial history'
      using errcode = '23514', constraint = 'facilitated_reversal_immutable';
  end if;
  select * into transfer_row from facilitated_transfer_instructions
  where id = new.transfer_instruction_id for update;
  if transfer_row.id is null
     or transfer_row.currency is distinct from new.currency
     or transfer_row.state not in ('transferred', 'partially_reversed', 'reversed') then
    raise exception 'Reversal must match a transferred instruction'
      using errcode = '23514', constraint = 'facilitated_reversal_transfer';
  end if;
  if tg_op = 'INSERT' then
    select coalesce(sum(amount_minor) filter(
      where status in ('submitting', 'succeeded')
    ), 0)::bigint into active_total
    from facilitated_transfer_reversals
    where transfer_instruction_id = new.transfer_instruction_id;
    if active_total + new.amount_minor > transfer_row.amount_minor then
      raise exception 'Transfer reversal total cannot exceed the transfer'
        using errcode = '23514', constraint = 'facilitated_reversal_total';
    end if;
    return new;
  end if;
  if new.transfer_instruction_id is distinct from old.transfer_instruction_id
     or new.amount_minor is distinct from old.amount_minor
     or new.currency is distinct from old.currency
     or new.reason is distinct from old.reason
     or new.reference is distinct from old.reference
     or new.approved_by_user_id is distinct from old.approved_by_user_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.request_fingerprint is distinct from old.request_fingerprint
     or not (
       new.provider_reversal_id is not distinct from old.provider_reversal_id
       or (old.provider_reversal_id is null and new.provider_reversal_id is not null)
     ) then
    raise exception 'Transfer reversal facts are immutable'
      using errcode = '23514', constraint = 'facilitated_reversal_immutable';
  end if;
  if new.status is distinct from old.status
     and not (
       (old.status = 'submitting' and new.status in ('succeeded', 'failed'))
       or (old.status = 'failed' and new.status = 'submitting')
     ) then
    raise exception 'Transfer reversal transition is invalid'
      using errcode = '23514', constraint = 'facilitated_reversal_lifecycle';
  end if;
  if old.status = 'failed' and new.status = 'submitting' then
    select coalesce(sum(amount_minor) filter(
      where status in ('submitting', 'succeeded')
    ), 0)::bigint into active_total
    from facilitated_transfer_reversals
    where transfer_instruction_id = new.transfer_instruction_id
      and id <> new.id;
    if active_total + new.amount_minor > transfer_row.amount_minor then
      raise exception 'Transfer reversal retry would exceed the transfer'
        using errcode = '23514', constraint = 'facilitated_reversal_total';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists facilitated_reversal_integrity_guard
  on facilitated_transfer_reversals;
create trigger facilitated_reversal_integrity_guard
before insert or update or delete
on facilitated_transfer_reversals
for each row execute function enforce_facilitated_reversal_integrity();

create or replace function enforce_facilitated_provider_dispute_lifecycle()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Provider disputes and returns are retained as commercial history'
      using errcode = '23514', constraint = 'facilitated_provider_dispute_immutable';
  end if;
  if tg_op = 'UPDATE' then
    if new.facilitated_payment_id is distinct from old.facilitated_payment_id
       or new.provider_dispute_id is distinct from old.provider_dispute_id
       or new.classification is distinct from old.classification
       or new.amount_minor is distinct from old.amount_minor
       or new.currency is distinct from old.currency
       or new.opened_at is distinct from old.opened_at then
      raise exception 'Provider dispute ownership and amount are immutable'
        using errcode = '23514', constraint = 'facilitated_provider_dispute_immutable';
    end if;
    if new.provider_state_updated_at < old.provider_state_updated_at then
      raise exception 'Older provider dispute state cannot replace newer state'
        using errcode = '23514', constraint = 'facilitated_provider_dispute_out_of_order';
    end if;
    if new.status is distinct from old.status and not (
      (old.status = 'warning_needs_response' and new.status in (
        'warning_under_review', 'warning_closed', 'needs_response',
        'under_review', 'won', 'lost'
      ))
      or (old.status = 'warning_under_review' and new.status in (
        'warning_closed', 'needs_response', 'under_review', 'won', 'lost'
      ))
      or (old.status = 'warning_closed'
          and new.status in ('needs_response', 'under_review', 'won', 'lost'))
      or (old.status = 'needs_response'
          and new.status in ('under_review', 'won', 'lost'))
      or (old.status = 'under_review' and new.status in ('won', 'lost'))
    ) then
      raise exception 'Provider dispute transition is invalid'
        using errcode = '23514', constraint = 'facilitated_provider_dispute_lifecycle';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists facilitated_provider_dispute_lifecycle_guard
  on facilitated_provider_disputes;
create trigger facilitated_provider_dispute_lifecycle_guard
before update or delete
on facilitated_provider_disputes
for each row execute function enforce_facilitated_provider_dispute_lifecycle();

create or replace function preserve_facilitated_funding_fact()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Facilitated funding facts are append-only'
    using errcode = '23514', constraint = 'facilitated_funding_fact_append_only';
end
$$;

drop trigger if exists facilitated_funding_fact_append_only_guard
  on facilitated_funding_facts;
create trigger facilitated_funding_fact_append_only_guard
before update or delete
on facilitated_funding_facts
for each row execute function preserve_facilitated_funding_fact();

create or replace function enforce_facilitated_payout_lifecycle()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Facilitated payouts are retained as provider history'
      using errcode = '23514', constraint = 'facilitated_payout_immutable';
  end if;
  if tg_op = 'UPDATE' then
    if new.connected_account_id is distinct from old.connected_account_id
       or new.provider_payout_id is distinct from old.provider_payout_id
       or new.amount_minor is distinct from old.amount_minor
       or new.currency is distinct from old.currency then
      raise exception 'Facilitated payout ownership and amount are immutable'
        using errcode = '23514', constraint = 'facilitated_payout_immutable';
    end if;
    if new.provider_state_updated_at < old.provider_state_updated_at then
      raise exception 'Older provider payout state cannot replace newer state'
        using errcode = '23514', constraint = 'facilitated_payout_out_of_order';
    end if;
    if new.status is distinct from old.status and not (
      (old.status = 'pending'
       and new.status in ('in_transit', 'paid', 'failed', 'canceled'))
      or (old.status = 'in_transit'
          and new.status in ('paid', 'failed', 'canceled'))
      or (old.status = 'paid' and new.status = 'failed')
    ) then
      raise exception 'Facilitated payout transition is invalid'
        using errcode = '23514', constraint = 'facilitated_payout_lifecycle';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists facilitated_payout_lifecycle_guard on facilitated_payouts;
create trigger facilitated_payout_lifecycle_guard
before update or delete
on facilitated_payouts
for each row execute function enforce_facilitated_payout_lifecycle();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'rate_cards'::regclass
      and conname = 'rate_card_lifecycle_shape'
  ) then
    alter table rate_cards
      add constraint rate_card_lifecycle_shape
      check (
        char_length(currency) = 3
        and (notes is null or char_length(notes) <= 2000)
        and (
          (
            status = 'draft'
            and submitted_by_user_id is null
            and approved_by_user_id is null
            and rejected_by_user_id is null
            and submitted_at is null
            and approved_at is null
            and rejected_at is null
            and rejection_reason is null
          )
          or (
            status = 'submitted'
            and approved_by_user_id is null
            and rejected_by_user_id is null
            and submitted_at is not null
            and approved_at is null
            and rejected_at is null
            and rejection_reason is null
          )
          or (
            status in ('approved', 'superseded')
            and rejected_by_user_id is null
            and submitted_at is not null
            and approved_at is not null
            and rejected_at is null
            and rejection_reason is null
          )
          or (
            status = 'rejected'
            and approved_by_user_id is null
            and submitted_at is not null
            and approved_at is null
            and rejected_at is not null
            and nullif(btrim(rejection_reason), '') is not null
            and char_length(rejection_reason) <= 1000
          )
        )
      ) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'rate_card_lines'::regclass
      and conname = 'rate_card_line_scope_shape'
  ) then
    alter table rate_card_lines
      add constraint rate_card_line_scope_shape
      check (
        (project_id is null or business_unit_id is not null)
        and char_length(service_type) between 1 and 100
        and (source_locale is null or char_length(source_locale) between 2 and 100)
        and (target_locale is null or char_length(target_locale) between 2 and 100)
        and (content_type is null or char_length(content_type) between 1 and 100)
        and (match_band is null or char_length(match_band) between 1 and 100)
      ) not valid;
  end if;

  alter table rate_cards validate constraint rate_card_lifecycle_shape;
  alter table rate_card_lines validate constraint rate_card_line_scope_shape;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'vendor_relationship_scopes'::regclass
      and conname = 'vendor_relationship_scopes_shape'
  ) then
    alter table vendor_relationship_scopes
      add constraint vendor_relationship_scopes_shape
      check (
        (
          scope_type in ('business_unit', 'project')
          and scope_id is not null
          and scope_value is null
        )
        or (
          scope_type in ('locale', 'service_type', 'content_classification')
          and scope_id is null
          and nullif(btrim(scope_value), '') is not null
        )
      ) not valid;
  end if;

  if exists (
    select 1
    from pg_constraint
    where conrelid = 'vendor_relationship_scopes'::regclass
      and conname = 'vendor_relationship_scopes_shape'
      and not convalidated
  ) then
    alter table vendor_relationship_scopes
      validate constraint vendor_relationship_scopes_shape;
  end if;
end
$$;

-- Cross-table vendor invariants cannot be expressed as ordinary CHECK
-- constraints. Validate existing rows once before installing triggers so an
-- upgrade fails loudly instead of preserving or rewriting tenant-invalid
-- records.
do $$
declare
  claimed_migration text;
begin
  insert into schema_migrations(key, metadata)
  values (
    '2026-07-vendor-tenant-integrity',
    '{"phase":"4D"}'::jsonb
  )
  on conflict(key) do nothing
  returning key into claimed_migration;

  if claimed_migration is not null then
    if exists (
      select 1
      from vendor_relationships relationship
      join organizations customer
        on customer.id = relationship.customer_organization_id
      join organizations agency
        on agency.id = relationship.agency_organization_id
      where customer.organization_type <> 'customer'
         or agency.organization_type <> 'agency'
    ) then
      raise exception 'Existing vendor relationship has invalid organization party types'
        using errcode = '23514',
              constraint = 'vendor_relationship_party_types';
    end if;

    if exists (
      select 1
      from vendor_relationship_scopes scope
      join vendor_relationships relationship
        on relationship.id = scope.vendor_relationship_id
      left join business_units business_unit
        on scope.scope_type = 'business_unit'
       and business_unit.id = scope.scope_id
      left join projects project
        on scope.scope_type = 'project'
       and project.id = scope.scope_id
      left join business_units project_business_unit
        on project_business_unit.id = project.business_unit_id
      where (
        scope.scope_type = 'business_unit'
        and business_unit.organization_id is distinct from relationship.customer_organization_id
      ) or (
        scope.scope_type = 'project'
        and project_business_unit.organization_id is distinct from relationship.customer_organization_id
      )
    ) then
      raise exception 'Existing vendor relationship scope crosses the customer tenant boundary'
        using errcode = '23514',
              constraint = 'vendor_relationship_scope_customer_owner';
    end if;

    if exists (
      select 1
      from vendor_approved_linguists approved_linguist
      join vendor_relationships relationship
        on relationship.id = approved_linguist.vendor_relationship_id
      join organization_memberships membership
        on membership.id = approved_linguist.agency_membership_id
      where membership.organization_id <> relationship.agency_organization_id
    ) then
      raise exception 'Existing approved linguist membership does not belong to the relationship agency'
        using errcode = '23514',
              constraint = 'vendor_approved_linguist_agency_owner';
    end if;
  end if;
end
$$;

-- Rate-card scopes carry customer-owned resource identifiers. Validate the
-- pre-Phase-5 stub rows once before installing the ownership triggers.
do $$
declare
  claimed_migration text;
begin
  insert into schema_migrations(key, metadata)
  values (
    '2026-07-rate-card-tenant-integrity',
    '{"phase":"5A"}'::jsonb
  )
  on conflict(key) do nothing
  returning key into claimed_migration;

  if claimed_migration is not null and exists (
    select 1
    from rate_card_lines line
    join rate_cards card on card.id = line.rate_card_id
    join vendor_relationships relationship on relationship.id = card.vendor_relationship_id
    left join business_units business_unit on business_unit.id = line.business_unit_id
    left join projects project on project.id = line.project_id
    left join business_units project_business_unit
      on project_business_unit.id = project.business_unit_id
    where (
      line.business_unit_id is not null
      and business_unit.organization_id is distinct from relationship.customer_organization_id
    ) or (
      line.project_id is not null
      and (
        project_business_unit.organization_id is distinct from relationship.customer_organization_id
        or project.business_unit_id is distinct from line.business_unit_id
      )
    )
  ) then
    raise exception 'Existing rate-card line crosses the customer tenant boundary'
      using errcode = '23514',
            constraint = 'rate_card_line_customer_owner';
  end if;
end
$$;

create or replace function enforce_vendor_relationship_parties()
returns trigger
language plpgsql
as $$
declare
  customer_type text;
  agency_type text;
begin
  select organization_type
  into customer_type
  from organizations
  where id = new.customer_organization_id
  for share;

  select organization_type
  into agency_type
  from organizations
  where id = new.agency_organization_id
  for share;

  if customer_type is distinct from 'customer'
     or agency_type is distinct from 'agency' then
    raise exception 'Vendor relationships require a customer organization and an agency organization'
      using errcode = '23514',
            constraint = 'vendor_relationship_party_types';
  end if;

  if tg_op = 'UPDATE'
     and new.customer_organization_id is distinct from old.customer_organization_id
     and exists (
       select 1
       from vendor_relationship_scopes scope
       left join business_units business_unit
         on scope.scope_type = 'business_unit'
        and business_unit.id = scope.scope_id
       left join projects project
         on scope.scope_type = 'project'
        and project.id = scope.scope_id
       left join business_units project_business_unit
         on project_business_unit.id = project.business_unit_id
       where scope.vendor_relationship_id = old.id
         and (
           (
             scope.scope_type = 'business_unit'
             and business_unit.organization_id is distinct from new.customer_organization_id
           )
           or (
             scope.scope_type = 'project'
             and project_business_unit.organization_id is distinct from new.customer_organization_id
           )
         )
     ) then
    raise exception 'Vendor relationship customer change would orphan existing scopes'
      using errcode = '23514',
            constraint = 'vendor_relationship_scope_customer_owner';
  end if;

  if tg_op = 'UPDATE'
     and new.agency_organization_id is distinct from old.agency_organization_id
     and exists (
       select 1
       from vendor_approved_linguists approved_linguist
       join organization_memberships membership
         on membership.id = approved_linguist.agency_membership_id
       where approved_linguist.vendor_relationship_id = old.id
         and membership.organization_id <> new.agency_organization_id
     ) then
    raise exception 'Vendor relationship agency change would orphan approved linguists'
      using errcode = '23514',
            constraint = 'vendor_approved_linguist_agency_owner';
  end if;

  return new;
end
$$;

drop trigger if exists vendor_relationship_parties_guard on vendor_relationships;
create trigger vendor_relationship_parties_guard
before insert or update of customer_organization_id, agency_organization_id
on vendor_relationships
for each row execute function enforce_vendor_relationship_parties();

create or replace function enforce_vendor_organization_type()
returns trigger
language plpgsql
as $$
begin
  if new.organization_type is distinct from old.organization_type
     and (
       (
         new.organization_type <> 'customer'
         and exists (
           select 1
           from vendor_relationships
           where customer_organization_id = old.id
         )
       )
       or (
         new.organization_type <> 'agency'
         and exists (
           select 1
           from vendor_relationships
           where agency_organization_id = old.id
         )
       )
     ) then
    raise exception 'Organization type change would invalidate a vendor relationship party'
      using errcode = '23514',
            constraint = 'vendor_relationship_party_types';
  end if;

  return new;
end
$$;

drop trigger if exists vendor_organization_type_guard on organizations;
create trigger vendor_organization_type_guard
before update of organization_type
on organizations
for each row execute function enforce_vendor_organization_type();

create or replace function enforce_vendor_relationship_scope_owner()
returns trigger
language plpgsql
as $$
declare
  customer_organization_id uuid;
  scope_organization_id uuid;
begin
  if new.scope_type not in ('business_unit', 'project') then
    return new;
  end if;

  select relationship.customer_organization_id
  into customer_organization_id
  from vendor_relationships relationship
  where relationship.id = new.vendor_relationship_id
  for share;

  if new.scope_type = 'business_unit' then
    select business_unit.organization_id
    into scope_organization_id
    from business_units business_unit
    where business_unit.id = new.scope_id
    for share;
  else
    select business_unit.organization_id
    into scope_organization_id
    from projects project
    join business_units business_unit
      on business_unit.id = project.business_unit_id
    where project.id = new.scope_id
    for share of project, business_unit;
  end if;

  if scope_organization_id is distinct from customer_organization_id then
    raise exception 'Vendor relationship resource scope must belong to the customer organization'
      using errcode = '23514',
            constraint = 'vendor_relationship_scope_customer_owner';
  end if;

  return new;
end
$$;

drop trigger if exists vendor_relationship_scope_owner_guard on vendor_relationship_scopes;
create trigger vendor_relationship_scope_owner_guard
before insert or update of vendor_relationship_id, scope_type, scope_id
on vendor_relationship_scopes
for each row execute function enforce_vendor_relationship_scope_owner();

create or replace function enforce_vendor_business_unit_owner_change()
returns trigger
language plpgsql
as $$
begin
  if new.organization_id is distinct from old.organization_id
     and exists (
       select 1
       from vendor_relationship_scopes scope
       join vendor_relationships relationship
         on relationship.id = scope.vendor_relationship_id
       left join projects project
         on scope.scope_type = 'project'
        and project.id = scope.scope_id
       where relationship.customer_organization_id <> new.organization_id
         and (
           (scope.scope_type = 'business_unit' and scope.scope_id = old.id)
           or (scope.scope_type = 'project' and project.business_unit_id = old.id)
         )
     ) then
    raise exception 'Business-unit move would invalidate a vendor relationship scope'
      using errcode = '23514',
            constraint = 'vendor_relationship_scope_customer_owner';
  end if;

  return new;
end
$$;

drop trigger if exists vendor_business_unit_owner_guard on business_units;
create trigger vendor_business_unit_owner_guard
before update of organization_id
on business_units
for each row execute function enforce_vendor_business_unit_owner_change();

create or replace function enforce_vendor_project_owner_change()
returns trigger
language plpgsql
as $$
declare
  new_organization_id uuid;
begin
  if new.business_unit_id is not distinct from old.business_unit_id then
    return new;
  end if;

  select organization_id
  into new_organization_id
  from business_units
  where id = new.business_unit_id
  for share;

  if exists (
    select 1
    from vendor_relationship_scopes scope
    join vendor_relationships relationship
      on relationship.id = scope.vendor_relationship_id
    where scope.scope_type = 'project'
      and scope.scope_id = old.id
      and relationship.customer_organization_id <> new_organization_id
  ) then
    raise exception 'Project move would invalidate a vendor relationship scope'
      using errcode = '23514',
            constraint = 'vendor_relationship_scope_customer_owner';
  end if;

  return new;
end
$$;

drop trigger if exists vendor_project_owner_guard on projects;
create trigger vendor_project_owner_guard
before update of business_unit_id
on projects
for each row execute function enforce_vendor_project_owner_change();

create or replace function enforce_rate_card_line_customer_owner()
returns trigger
language plpgsql
as $$
declare
  customer_organization_id uuid;
  business_unit_organization_id uuid;
  project_organization_id uuid;
  project_business_unit_id uuid;
begin
  select relationship.customer_organization_id
  into customer_organization_id
  from rate_cards card
  join vendor_relationships relationship
    on relationship.id = card.vendor_relationship_id
  where card.id = new.rate_card_id
  for share of card, relationship;

  if new.business_unit_id is not null then
    select organization_id
    into business_unit_organization_id
    from business_units
    where id = new.business_unit_id
    for share;

    if business_unit_organization_id is distinct from customer_organization_id then
      raise exception 'Rate-card business unit must belong to the relationship customer'
        using errcode = '23514',
              constraint = 'rate_card_line_customer_owner';
    end if;
  end if;

  if new.project_id is not null then
    select business_unit.organization_id, project.business_unit_id
    into project_organization_id, project_business_unit_id
    from projects project
    join business_units business_unit
      on business_unit.id = project.business_unit_id
    where project.id = new.project_id
    for share of project, business_unit;

    if project_organization_id is distinct from customer_organization_id
       or project_business_unit_id is distinct from new.business_unit_id then
      raise exception 'Rate-card project and business unit must belong to the relationship customer'
        using errcode = '23514',
              constraint = 'rate_card_line_customer_owner';
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists rate_card_line_customer_owner_guard on rate_card_lines;
create trigger rate_card_line_customer_owner_guard
before insert or update of rate_card_id, business_unit_id, project_id
on rate_card_lines
for each row execute function enforce_rate_card_line_customer_owner();

create or replace function enforce_rate_card_lifecycle()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Submitted and historical rate cards are immutable'
        using errcode = '23514',
              constraint = 'rate_card_immutable';
    end if;
    return old;
  end if;

  if old.status = 'draft' and new.status = 'draft'
     and new.id is not distinct from old.id
     and new.vendor_relationship_id is not distinct from old.vendor_relationship_id
     and new.version is not distinct from old.version
     and new.created_at is not distinct from old.created_at then
    return new;
  end if;

  -- Actor foreign keys use ON DELETE SET NULL so identity retention policies
  -- can remove a user without rewriting commercial or lifecycle facts.
  if old.status <> 'draft'
     and new.status = old.status
     and (
       to_jsonb(new)
         - array['submitted_by_user_id', 'approved_by_user_id', 'rejected_by_user_id']
       =
       to_jsonb(old)
         - array['submitted_by_user_id', 'approved_by_user_id', 'rejected_by_user_id']
     )
     and (
       new.submitted_by_user_id is not distinct from old.submitted_by_user_id
       or new.submitted_by_user_id is null
     )
     and (
       new.approved_by_user_id is not distinct from old.approved_by_user_id
       or new.approved_by_user_id is null
     )
     and (
       new.rejected_by_user_id is not distinct from old.rejected_by_user_id
       or new.rejected_by_user_id is null
     ) then
    return new;
  end if;

  if old.status = 'draft' and new.status = 'submitted'
     and (
       to_jsonb(new)
         - array['status', 'submitted_by_user_id', 'submitted_at', 'updated_at']
       =
       to_jsonb(old)
         - array['status', 'submitted_by_user_id', 'submitted_at', 'updated_at']
     ) then
    return new;
  end if;

  if old.status = 'submitted' and new.status = 'approved'
     and (
       to_jsonb(new)
         - array['status', 'effective_from', 'approved_by_user_id', 'approved_at', 'updated_at']
       =
       to_jsonb(old)
         - array['status', 'effective_from', 'approved_by_user_id', 'approved_at', 'updated_at']
     )
     and new.effective_from is not distinct from coalesce(old.effective_from, current_date) then
    return new;
  end if;

  if old.status = 'submitted' and new.status = 'rejected'
     and (
       to_jsonb(new)
         - array['status', 'rejected_by_user_id', 'rejected_at', 'rejection_reason', 'updated_at']
       =
       to_jsonb(old)
         - array['status', 'rejected_by_user_id', 'rejected_at', 'rejection_reason', 'updated_at']
     ) then
    return new;
  end if;

  if old.status = 'approved' and new.status = 'superseded'
     and (
       to_jsonb(new) - array['status', 'updated_at']
       =
       to_jsonb(old) - array['status', 'updated_at']
     ) then
    return new;
  end if;

  raise exception 'Rate-card state or commercial terms cannot be changed in this lifecycle state'
    using errcode = '23514',
          constraint = 'rate_card_immutable';
end
$$;

drop trigger if exists rate_card_lifecycle_guard on rate_cards;
create trigger rate_card_lifecycle_guard
before update or delete
on rate_cards
for each row execute function enforce_rate_card_lifecycle();

create or replace function enforce_rate_card_line_mutability()
returns trigger
language plpgsql
as $$
declare
  card_status text;
  card_id uuid;
begin
  if tg_op = 'UPDATE'
     and (
       new.id is distinct from old.id
       or new.rate_card_id is distinct from old.rate_card_id
       or new.created_at is distinct from old.created_at
     ) then
    raise exception 'Rate-card line identity cannot be changed'
      using errcode = '23514',
            constraint = 'rate_card_immutable';
  end if;

  card_id := case when tg_op = 'DELETE' then old.rate_card_id else new.rate_card_id end;
  select status
  into card_status
  from rate_cards
  where id = card_id
  for share;

  if card_status is distinct from 'draft' then
    raise exception 'Rate-card lines can only be changed while the card is a draft'
      using errcode = '23514',
            constraint = 'rate_card_immutable';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

drop trigger if exists rate_card_line_mutability_guard on rate_card_lines;
create trigger rate_card_line_mutability_guard
before insert or update or delete
on rate_card_lines
for each row execute function enforce_rate_card_line_mutability();

create or replace function enforce_rate_card_business_unit_owner_change()
returns trigger
language plpgsql
as $$
begin
  if new.organization_id is distinct from old.organization_id
     and exists (
       select 1
       from rate_card_lines line
       join rate_cards card on card.id = line.rate_card_id
       join vendor_relationships relationship
         on relationship.id = card.vendor_relationship_id
       left join projects project on project.id = line.project_id
       where relationship.customer_organization_id <> new.organization_id
         and (
           line.business_unit_id = old.id
           or project.business_unit_id = old.id
         )
     ) then
    raise exception 'Business-unit move would invalidate a rate-card line'
      using errcode = '23514',
            constraint = 'rate_card_line_customer_owner';
  end if;

  return new;
end
$$;

drop trigger if exists rate_card_business_unit_owner_guard on business_units;
drop trigger if exists vendor_z_rate_card_business_unit_owner_guard on business_units;
create trigger vendor_z_rate_card_business_unit_owner_guard
before update of organization_id
on business_units
for each row execute function enforce_rate_card_business_unit_owner_change();

create or replace function enforce_rate_card_project_owner_change()
returns trigger
language plpgsql
as $$
declare
  new_organization_id uuid;
begin
  if new.business_unit_id is not distinct from old.business_unit_id then
    return new;
  end if;

  select organization_id
  into new_organization_id
  from business_units
  where id = new.business_unit_id
  for share;

  if exists (
    select 1
    from rate_card_lines line
    join rate_cards card on card.id = line.rate_card_id
    join vendor_relationships relationship
      on relationship.id = card.vendor_relationship_id
    where line.project_id = old.id
      and (
        line.business_unit_id <> new.business_unit_id
        or relationship.customer_organization_id <> new_organization_id
      )
  ) then
    raise exception 'Project move would invalidate a rate-card line'
      using errcode = '23514',
            constraint = 'rate_card_line_customer_owner';
  end if;

  return new;
end
$$;

drop trigger if exists rate_card_project_owner_guard on projects;
drop trigger if exists vendor_z_rate_card_project_owner_guard on projects;
create trigger vendor_z_rate_card_project_owner_guard
before update of business_unit_id
on projects
for each row execute function enforce_rate_card_project_owner_change();

create or replace function enforce_rate_card_relationship_customer_change()
returns trigger
language plpgsql
as $$
begin
  if (
    new.customer_organization_id is distinct from old.customer_organization_id
    or new.agency_organization_id is distinct from old.agency_organization_id
  ) and exists (
    select 1
    from rate_cards
    where vendor_relationship_id = old.id
  ) then
    raise exception 'Vendor relationship parties cannot change after a rate card exists'
      using errcode = '23514',
            constraint = 'rate_card_party_immutable';
  end if;

  return new;
end
$$;

drop trigger if exists rate_card_relationship_customer_guard on vendor_relationships;
create trigger rate_card_relationship_customer_guard
before update of customer_organization_id, agency_organization_id
on vendor_relationships
for each row execute function enforce_rate_card_relationship_customer_change();

create or replace function enforce_work_order_owner_and_snapshot()
returns trigger
language plpgsql
as $$
declare
  relationship_customer_id uuid;
  project_organization_id uuid;
  project_business_unit_id uuid;
  selected_rate record;
begin
  select customer_organization_id
  into relationship_customer_id
  from vendor_relationships
  where id = new.vendor_relationship_id
  for share;

  select business_unit.organization_id, project.business_unit_id
  into project_organization_id, project_business_unit_id
  from projects project
  join business_units business_unit on business_unit.id = project.business_unit_id
  where project.id = new.project_id
  for share of project, business_unit;

  if relationship_customer_id is null
     or project_organization_id is distinct from relationship_customer_id then
    raise exception 'Work-order project must belong to the relationship customer'
      using errcode = '23514',
            constraint = 'work_order_customer_owner';
  end if;

  if tg_op = 'INSERT' and new.status <> 'draft' then
    raise exception 'New work orders must begin as drafts'
      using errcode = '23514',
            constraint = 'work_order_lifecycle';
  end if;

  if new.status = 'draft' then
    if new.rate_card_id is not null
       or new.rate_card_line_id is not null
       or new.snapshot_currency is not null
       or new.snapshot_currency_exponent is not null
       or new.snapshot_unit_rate is not null
       or new.snapshot_minimum_units is not null
       or new.snapshot_minimum_charge_minor is not null
       or new.snapshot_payment_terms_days is not null then
      raise exception 'Draft work orders cannot contain a commercial snapshot'
        using errcode = '23514',
              constraint = 'work_order_rate_snapshot';
    end if;
    return new;
  end if;

  -- A draft can be canceled before it has ever acquired a rate snapshot.
  if new.status = 'canceled'
     and new.rate_card_id is null
     and new.rate_card_line_id is null
     and new.snapshot_currency is null
     and new.snapshot_currency_exponent is null
     and new.snapshot_unit_rate is null
     and new.snapshot_minimum_units is null
     and new.snapshot_minimum_charge_minor is null
     and new.snapshot_payment_terms_days is null then
    return new;
  end if;

  if new.rate_card_id is null
     or new.rate_card_line_id is null
     or new.snapshot_currency is null
     or new.snapshot_currency_exponent is null
     or new.snapshot_unit_rate is null then
    raise exception 'Offered work orders require a complete commercial snapshot'
      using errcode = '23514',
            constraint = 'work_order_rate_snapshot';
  end if;

  select card.vendor_relationship_id, card.currency, card.payment_terms_days,
         card.minimum_charge_minor, card.status,
         line.rate_card_id, line.unit_rate, line.minimum_units,
         line.service_type, line.unit_type, line.source_locale,
         line.target_locale, line.business_unit_id, line.project_id,
         line.content_type, line.match_band
  into selected_rate
  from rate_cards card
  join rate_card_lines line on line.rate_card_id = card.id
  where card.id = new.rate_card_id
    and line.id = new.rate_card_line_id
  for share of card, line;

  if selected_rate.vendor_relationship_id is distinct from new.vendor_relationship_id
     or selected_rate.status not in ('approved', 'superseded')
     or selected_rate.currency is distinct from new.snapshot_currency
     or selected_rate.unit_rate is distinct from new.snapshot_unit_rate
     or selected_rate.minimum_units is distinct from new.snapshot_minimum_units
     or selected_rate.minimum_charge_minor is distinct from new.snapshot_minimum_charge_minor
     or selected_rate.payment_terms_days is distinct from new.snapshot_payment_terms_days
     or lower(selected_rate.service_type) is distinct from lower(new.service_type)
     or selected_rate.unit_type is distinct from new.unit_type
     or (
       selected_rate.source_locale is not null
       and lower(selected_rate.source_locale) is distinct from lower(new.source_locale)
     )
     or (
       selected_rate.target_locale is not null
       and lower(selected_rate.target_locale) is distinct from lower(new.target_locale)
     )
     or (
       selected_rate.business_unit_id is not null
       and selected_rate.business_unit_id is distinct from project_business_unit_id
     )
     or (
       selected_rate.project_id is not null
       and selected_rate.project_id is distinct from new.project_id
     )
     or (
       selected_rate.content_type is not null
       and lower(selected_rate.content_type) is distinct from lower(new.content_classification)
     )
     or (
       selected_rate.match_band is not null
       and lower(selected_rate.match_band) is distinct from lower(new.match_band)
     ) then
    raise exception 'Work-order snapshot must match a rate line for this relationship'
      using errcode = '23514',
            constraint = 'work_order_rate_snapshot';
  end if;

  return new;
end
$$;

drop trigger if exists work_order_owner_snapshot_guard on work_orders;
create trigger work_order_owner_snapshot_guard
before insert or update of
  vendor_relationship_id, project_id, status, service_type, unit_type,
  rate_card_id, rate_card_line_id, snapshot_currency,
  snapshot_currency_exponent, snapshot_unit_rate, snapshot_minimum_units,
  snapshot_minimum_charge_minor, snapshot_payment_terms_days
on work_orders
for each row execute function enforce_work_order_owner_and_snapshot();

create or replace function enforce_work_order_lifecycle()
returns trigger
language plpgsql
as $$
declare
  actors text[] := array[
    'created_by_user_id', 'offered_by_user_id', 'accepted_by_user_id',
    'quality_approved_by_user_id', 'payable_approved_by_user_id',
    'canceled_by_user_id'
  ];
begin
  if tg_op = 'DELETE' then
    raise exception 'Work orders are retained as immutable commercial history'
      using errcode = '23514',
            constraint = 'work_order_immutable';
  end if;

  -- Actor references may be nulled by FK retention policy without changing facts.
  if new.status = old.status
     and to_jsonb(new) - actors = to_jsonb(old) - actors
     and (new.created_by_user_id is not distinct from old.created_by_user_id or new.created_by_user_id is null)
     and (new.offered_by_user_id is not distinct from old.offered_by_user_id or new.offered_by_user_id is null)
     and (new.accepted_by_user_id is not distinct from old.accepted_by_user_id or new.accepted_by_user_id is null)
     and (new.quality_approved_by_user_id is not distinct from old.quality_approved_by_user_id or new.quality_approved_by_user_id is null)
     and (new.payable_approved_by_user_id is not distinct from old.payable_approved_by_user_id or new.payable_approved_by_user_id is null)
     and (new.canceled_by_user_id is not distinct from old.canceled_by_user_id or new.canceled_by_user_id is null) then
    return new;
  end if;

  if old.status = 'draft' and new.status = 'draft'
     and to_jsonb(new) - array[
       'project_id', 'title', 'description', 'service_type', 'source_locale',
       'target_locale', 'content_classification', 'match_band', 'unit_type',
       'estimated_units', 'due_at', 'updated_at'
     ] = to_jsonb(old) - array[
       'project_id', 'title', 'description', 'service_type', 'source_locale',
       'target_locale', 'content_classification', 'match_band', 'unit_type',
       'estimated_units', 'due_at', 'updated_at'
     ] then
    return new;
  end if;

  if old.status = 'draft' and new.status = 'offered'
     and new.offered_at is not null
     and to_jsonb(new) - array[
       'status', 'rate_card_id', 'rate_card_line_id', 'snapshot_currency',
       'snapshot_currency_exponent', 'snapshot_unit_rate',
       'snapshot_minimum_units', 'snapshot_minimum_charge_minor',
       'snapshot_payment_terms_days', 'offered_by_user_id', 'offered_at',
       'updated_at'
     ] = to_jsonb(old) - array[
       'status', 'rate_card_id', 'rate_card_line_id', 'snapshot_currency',
       'snapshot_currency_exponent', 'snapshot_unit_rate',
       'snapshot_minimum_units', 'snapshot_minimum_charge_minor',
       'snapshot_payment_terms_days', 'offered_by_user_id', 'offered_at',
       'updated_at'
     ] then
    return new;
  end if;

  if old.status = 'offered' and new.status = 'accepted'
     and new.accepted_at is not null
     and to_jsonb(new) - array['status', 'accepted_by_user_id', 'accepted_at', 'updated_at']
       = to_jsonb(old) - array['status', 'accepted_by_user_id', 'accepted_at', 'updated_at'] then
    return new;
  end if;

  if old.status = 'accepted' and new.status = 'in_progress'
     and new.started_at is not null
     and to_jsonb(new) - array['status', 'started_at', 'updated_at']
       = to_jsonb(old) - array['status', 'started_at', 'updated_at'] then
    return new;
  end if;

  if old.status in ('accepted', 'in_progress') and new.status = 'submitted'
     and new.submitted_at is not null
     and to_jsonb(new) - array['status', 'submitted_at', 'updated_at']
       = to_jsonb(old) - array['status', 'submitted_at', 'updated_at'] then
    return new;
  end if;

  if old.status = 'submitted' and new.status = 'in_progress'
     and new.submitted_at is null
     and to_jsonb(new) - array['status', 'submitted_at', 'updated_at']
       = to_jsonb(old) - array['status', 'submitted_at', 'updated_at'] then
    return new;
  end if;

  if old.status = 'submitted' and new.status = 'quality_approved'
     and new.quality_approved_at is not null
     and to_jsonb(new) - array[
       'status', 'quality_approved_by_user_id', 'quality_approved_at', 'updated_at'
     ] = to_jsonb(old) - array[
       'status', 'quality_approved_by_user_id', 'quality_approved_at', 'updated_at'
     ] then
    return new;
  end if;

  if old.status = 'quality_approved' and new.status = 'payable_approved'
     and new.payable_approved_at is not null
     and to_jsonb(new) - array[
       'status', 'payable_approved_by_user_id', 'payable_approved_at', 'updated_at'
     ] = to_jsonb(old) - array[
       'status', 'payable_approved_by_user_id', 'payable_approved_at', 'updated_at'
     ] then
    return new;
  end if;

  if (
       (old.status = 'payable_approved' and new.status = 'included_in_statement')
       or (old.status = 'included_in_statement' and new.status in ('payable_approved', 'paid'))
     )
     and to_jsonb(new) - array['status', 'updated_at']
       = to_jsonb(old) - array['status', 'updated_at'] then
    return new;
  end if;

  if old.status in ('draft', 'offered', 'accepted', 'in_progress')
     and new.status = 'canceled'
     and new.canceled_at is not null
     and new.cancellation_reason is not null
     and to_jsonb(new) - array[
       'status', 'canceled_by_user_id', 'canceled_at', 'cancellation_reason', 'updated_at'
     ] = to_jsonb(old) - array[
       'status', 'canceled_by_user_id', 'canceled_at', 'cancellation_reason', 'updated_at'
     ] then
    return new;
  end if;

  raise exception 'Work-order state or commercial facts cannot be changed in this lifecycle state'
    using errcode = '23514',
          constraint = 'work_order_immutable';
end
$$;

drop trigger if exists work_order_lifecycle_guard on work_orders;
create trigger work_order_lifecycle_guard
before update or delete
on work_orders
for each row execute function enforce_work_order_lifecycle();

create or replace function enforce_work_assignment_integrity()
returns trigger
language plpgsql
as $$
declare
  relationship_agency_id uuid;
  relationship_status text;
  membership_organization_id uuid;
  work_order_status text;
begin
  if tg_op = 'DELETE' then
    raise exception 'Work assignments are retained as commercial history'
      using errcode = '23514',
            constraint = 'work_assignment_immutable';
  end if;

  select relationship.agency_organization_id, relationship.status, work_order.status
  into relationship_agency_id, relationship_status, work_order_status
  from work_orders work_order
  join vendor_relationships relationship
    on relationship.id = work_order.vendor_relationship_id
  where work_order.id = new.work_order_id
  for share of work_order, relationship;

  select organization_id
  into membership_organization_id
  from organization_memberships
  where id = new.agency_membership_id
  for share;

  if membership_organization_id is distinct from relationship_agency_id then
    raise exception 'Work assignment membership must belong to the relationship agency'
      using errcode = '23514',
            constraint = 'work_assignment_agency_owner';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'active'
       or relationship_status <> 'active'
       or work_order_status not in ('accepted', 'in_progress') then
      raise exception 'New work assignments require active, accepted work'
        using errcode = '23514',
              constraint = 'work_assignment_lifecycle';
    end if;
    return new;
  end if;

  if new.status = old.status
     and to_jsonb(new) - array['assigned_by_user_id', 'revoked_by_user_id']
       = to_jsonb(old) - array['assigned_by_user_id', 'revoked_by_user_id']
     and (new.assigned_by_user_id is not distinct from old.assigned_by_user_id or new.assigned_by_user_id is null)
     and (new.revoked_by_user_id is not distinct from old.revoked_by_user_id or new.revoked_by_user_id is null) then
    return new;
  end if;

  if old.status = 'active' and new.status = 'completed'
     and to_jsonb(new) - array['status', 'updated_at']
       = to_jsonb(old) - array['status', 'updated_at'] then
    return new;
  end if;

  if old.status = 'active' and new.status = 'revoked'
     and new.revoked_at is not null
     and new.revocation_reason is not null
     and to_jsonb(new) - array[
       'status', 'revoked_by_user_id', 'revoked_at', 'revocation_reason', 'updated_at'
     ] = to_jsonb(old) - array[
       'status', 'revoked_by_user_id', 'revoked_at', 'revocation_reason', 'updated_at'
     ] then
    return new;
  end if;

  raise exception 'Work assignment cannot be changed in this lifecycle state'
    using errcode = '23514',
          constraint = 'work_assignment_immutable';
end
$$;

drop trigger if exists work_assignment_integrity_guard on work_assignments;
create trigger work_assignment_integrity_guard
before insert or update or delete
on work_assignments
for each row execute function enforce_work_assignment_integrity();

create or replace function enforce_work_submission_lifecycle()
returns trigger
language plpgsql
as $$
declare
  assignment_order_id uuid;
  assignment_status text;
  order_status text;
begin
  if tg_op = 'DELETE' then
    raise exception 'Work submissions are immutable delivery facts'
      using errcode = '23514',
            constraint = 'work_submission_immutable';
  end if;

  if tg_op = 'INSERT' then
    select assignment.work_order_id, assignment.status, work_order.status
    into assignment_order_id, assignment_status, order_status
    from work_assignments assignment
    join work_orders work_order on work_order.id = assignment.work_order_id
    where assignment.id = new.work_assignment_id
    for share of assignment, work_order;
    if assignment_order_id is distinct from new.work_order_id
       or assignment_status <> 'active'
       or order_status not in ('accepted', 'in_progress')
       or new.quality_status <> 'pending'
       or new.quality_reason is not null
       or new.quality_decided_by_user_id is not null
       or new.quality_decided_at is not null then
      raise exception 'New submissions must be pending and belong to their assignment'
        using errcode = '23514',
              constraint = 'work_submission_lifecycle';
    end if;
    return new;
  end if;

  if new.quality_status = old.quality_status
     and to_jsonb(new) - array['quality_decided_by_user_id', 'submitted_by_user_id']
       = to_jsonb(old) - array['quality_decided_by_user_id', 'submitted_by_user_id']
     and (new.quality_decided_by_user_id is not distinct from old.quality_decided_by_user_id or new.quality_decided_by_user_id is null)
     and (new.submitted_by_user_id is not distinct from old.submitted_by_user_id or new.submitted_by_user_id is null) then
    return new;
  end if;

  if old.quality_status = 'pending'
     and new.quality_status in ('approved', 'rejected')
     and new.quality_decided_at is not null
     and (
       (new.quality_status = 'approved' and new.quality_reason is null)
       or (new.quality_status = 'rejected' and new.quality_reason is not null)
     )
     and to_jsonb(new) - array[
       'quality_status', 'quality_reason', 'quality_decided_by_user_id',
       'quality_decided_at'
     ] = to_jsonb(old) - array[
       'quality_status', 'quality_reason', 'quality_decided_by_user_id',
       'quality_decided_at'
     ] then
    return new;
  end if;

  raise exception 'Work submissions can only receive one quality decision'
    using errcode = '23514',
          constraint = 'work_submission_immutable';
end
$$;

drop trigger if exists work_submission_lifecycle_guard on work_submissions;
create trigger work_submission_lifecycle_guard
before insert or update or delete
on work_submissions
for each row execute function enforce_work_submission_lifecycle();

create or replace function enforce_work_ledger_integrity()
returns trigger
language plpgsql
as $$
declare
  work_order_row work_orders%rowtype;
  submission_order_id uuid;
  submission_quality_status text;
  original_entry record;
begin
  -- Actor references use ON DELETE SET NULL so immutable commercial history
  -- can outlive a deleted user without permitting any fact to change.
  if tg_op = 'UPDATE'
     and new.created_by_user_id is null
     and old.created_by_user_id is not null
     and to_jsonb(new) - 'created_by_user_id'
       = to_jsonb(old) - 'created_by_user_id' then
    return new;
  end if;

  if tg_op <> 'INSERT' then
    raise exception 'Work ledger entries are append-only'
      using errcode = '23514',
            constraint = 'work_ledger_append_only';
  end if;

  select * into work_order_row
  from work_orders
  where id = new.work_order_id
  for share;

  if new.currency is distinct from work_order_row.snapshot_currency then
    raise exception 'Work ledger currency must match the work-order snapshot'
      using errcode = '23514',
            constraint = 'work_ledger_currency';
  end if;

  if new.entry_type = 'approved_delivery' then
    select work_order_id, quality_status
    into submission_order_id, submission_quality_status
    from work_submissions
    where id = new.work_submission_id
    for share;
    if submission_order_id is distinct from new.work_order_id
       or submission_quality_status <> 'approved'
       or work_order_row.status <> 'submitted'
       or new.unit_type is distinct from work_order_row.unit_type
       or new.unit_rate is distinct from work_order_row.snapshot_unit_rate then
      raise exception 'Approved delivery must match a submitted work order and its snapshot'
        using errcode = '23514',
              constraint = 'work_ledger_delivery';
    end if;
  elsif new.entry_type = 'adjustment' then
    if work_order_row.status not in ('quality_approved', 'payable_approved') then
      raise exception 'Adjustments require approved work outside a statement'
        using errcode = '23514',
              constraint = 'work_ledger_adjustment';
    end if;
  else
    select work_order_id, amount_minor
    into original_entry
    from work_ledger_entries
    where id = new.reversal_of_entry_id
    for share;
    if original_entry.work_order_id is distinct from new.work_order_id
       or new.amount_minor <> -original_entry.amount_minor then
      raise exception 'A reversal must negate an entry on the same work order'
        using errcode = '23514',
              constraint = 'work_ledger_reversal';
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists work_ledger_integrity_guard on work_ledger_entries;
create trigger work_ledger_integrity_guard
before insert or update or delete
on work_ledger_entries
for each row execute function enforce_work_ledger_integrity();

create or replace function enforce_work_dispute_lifecycle()
returns trigger
language plpgsql
as $$
declare
  work_order_status text;
begin
  if tg_op = 'DELETE' then
    raise exception 'Work disputes are retained as commercial history'
      using errcode = '23514',
            constraint = 'work_dispute_immutable';
  end if;
  if tg_op = 'INSERT' then
    select status into work_order_status
    from work_orders where id = new.work_order_id
    for share;
    if work_order_status not in (
         'quality_approved', 'payable_approved', 'included_in_statement'
       )
       or new.status <> 'open'
       or new.resolution is not null
       or new.resolved_at is not null then
      raise exception 'New work disputes must begin open'
        using errcode = '23514',
              constraint = 'work_dispute_lifecycle';
    end if;
    return new;
  end if;
  if new.status = old.status
     and to_jsonb(new) - array['opened_by_user_id', 'resolved_by_user_id']
       = to_jsonb(old) - array['opened_by_user_id', 'resolved_by_user_id']
     and (
       new.opened_by_user_id is not distinct from old.opened_by_user_id
       or new.opened_by_user_id is null
     )
     and (
       new.resolved_by_user_id is not distinct from old.resolved_by_user_id
       or new.resolved_by_user_id is null
     ) then
    return new;
  end if;
  if old.status = 'open' and new.status in ('resolved', 'rejected')
     and new.resolution is not null and new.resolved_at is not null
     and to_jsonb(new) - array[
       'status', 'resolution', 'resolved_by_user_id', 'resolved_at', 'updated_at'
     ] = to_jsonb(old) - array[
       'status', 'resolution', 'resolved_by_user_id', 'resolved_at', 'updated_at'
     ] then
    return new;
  end if;
  raise exception 'Work dispute cannot be changed in this lifecycle state'
    using errcode = '23514',
          constraint = 'work_dispute_immutable';
end
$$;

drop trigger if exists work_dispute_lifecycle_guard on work_order_disputes;
create trigger work_dispute_lifecycle_guard
before insert or update or delete
on work_order_disputes
for each row execute function enforce_work_dispute_lifecycle();

create or replace function enforce_payable_statement_lifecycle()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Payable statements are retained as commercial history'
      using errcode = '23514',
            constraint = 'payable_statement_immutable';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.subtotal_minor <> 0
       or new.finalized_at is not null or new.paid_at is not null
       or new.voided_at is not null then
      raise exception 'New payable statements must begin as empty drafts'
        using errcode = '23514',
              constraint = 'payable_statement_lifecycle';
    end if;
    return new;
  end if;
  if new.status = old.status
     and to_jsonb(new) - array[
       'created_by_user_id', 'finalized_by_user_id', 'voided_by_user_id'
     ] = to_jsonb(old) - array[
       'created_by_user_id', 'finalized_by_user_id', 'voided_by_user_id'
     ]
     and (
       new.created_by_user_id is not distinct from old.created_by_user_id
       or new.created_by_user_id is null
     )
     and (
       new.finalized_by_user_id is not distinct from old.finalized_by_user_id
       or new.finalized_by_user_id is null
     )
     and (
       new.voided_by_user_id is not distinct from old.voided_by_user_id
       or new.voided_by_user_id is null
     ) then
    return new;
  end if;
  if old.status = 'draft' and new.status = 'finalized'
     and new.finalized_at is not null
     and exists(
       select 1 from payable_statement_items
       where payable_statement_id = old.id
     )
     and not exists(
       select 1
       from payable_statement_items item
       join work_orders work_order on work_order.id = item.work_order_id
       left join work_order_disputes dispute
         on dispute.work_order_id = work_order.id and dispute.status = 'open'
       where item.payable_statement_id = old.id
         and (work_order.status <> 'payable_approved' or dispute.id is not null)
     )
     and new.subtotal_minor = (
       select coalesce(sum(amount_minor), 0)::bigint
       from payable_statement_items
       where payable_statement_id = old.id
     )
     and to_jsonb(new) - array[
       'status', 'subtotal_minor', 'due_date', 'finalized_by_user_id',
       'finalized_at', 'updated_at'
     ] = to_jsonb(old) - array[
       'status', 'subtotal_minor', 'due_date', 'finalized_by_user_id',
       'finalized_at', 'updated_at'
     ] then
    return new;
  end if;
  if old.status = 'finalized' and new.status = 'paid'
     and new.paid_at is not null
     and old.subtotal_minor = (
       select coalesce(sum(amount_minor), 0)::bigint
       from payment_records
       where payable_statement_id = old.id and status = 'confirmed'
     )
     and to_jsonb(new) - array['status', 'paid_at', 'updated_at']
       = to_jsonb(old) - array['status', 'paid_at', 'updated_at'] then
    return new;
  end if;
  if old.status in ('draft', 'finalized') and new.status = 'void'
     and new.voided_at is not null and new.void_reason is not null
     and not exists(
       select 1 from payment_records where payable_statement_id = old.id
     )
     and not exists(
       select 1 from facilitated_payment_attempts
       where payable_statement_id = old.id
         and (
           state in ('created', 'requires_action', 'processing', 'succeeded')
           or checkout_status in ('creating', 'open')
         )
     )
     and not exists(
       select 1 from facilitated_payments
       where payable_statement_id = old.id
     )
     and to_jsonb(new) - array[
       'status', 'voided_by_user_id', 'voided_at', 'void_reason', 'updated_at'
     ] = to_jsonb(old) - array[
       'status', 'voided_by_user_id', 'voided_at', 'void_reason', 'updated_at'
     ] then
    return new;
  end if;
  raise exception 'Payable statement cannot be changed in this lifecycle state'
    using errcode = '23514',
          constraint = 'payable_statement_immutable';
end
$$;

drop trigger if exists payable_statement_lifecycle_guard on payable_statements;
create trigger payable_statement_lifecycle_guard
before insert or update or delete
on payable_statements
for each row execute function enforce_payable_statement_lifecycle();

create or replace function enforce_payable_statement_item_integrity()
returns trigger
language plpgsql
as $$
declare
  statement_row payable_statements%rowtype;
  work_order_row work_orders%rowtype;
begin
  select * into statement_row
  from payable_statements
  where id = coalesce(new.payable_statement_id, old.payable_statement_id)
  for share;
  if tg_op = 'UPDATE'
     and statement_row.status = 'void'
     and old.released_at is null
     and new.released_at is not null
     and to_jsonb(new) - 'released_at' = to_jsonb(old) - 'released_at' then
    return new;
  end if;
  if statement_row.status <> 'draft' then
    raise exception 'Statement items can only change while the statement is a draft'
      using errcode = '23514',
            constraint = 'payable_statement_item_immutable';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'Statement-item snapshots cannot be changed'
      using errcode = '23514',
            constraint = 'payable_statement_item_immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  select * into work_order_row
  from work_orders
  where id = new.work_order_id
  for share;
  if work_order_row.vendor_relationship_id is distinct from statement_row.vendor_relationship_id
     or work_order_row.snapshot_currency is distinct from statement_row.currency
     or work_order_row.status <> 'payable_approved' then
    raise exception 'Statement item must reference payable work for the same relationship and currency'
      using errcode = '23514',
            constraint = 'payable_statement_item_owner';
  end if;
  if exists(
    select 1
    from payable_statement_items existing_item
    join payable_statements existing_statement
      on existing_statement.id = existing_item.payable_statement_id
    where existing_item.work_order_id = new.work_order_id
      and existing_item.payable_statement_id <> new.payable_statement_id
      and existing_statement.status <> 'void'
  ) then
    raise exception 'A work order can belong to only one non-void statement'
      using errcode = '23514',
            constraint = 'payable_statement_item_current_unique';
  end if;
  return new;
end
$$;

drop trigger if exists payable_statement_item_integrity_guard on payable_statement_items;
create trigger payable_statement_item_integrity_guard
before insert or update or delete
on payable_statement_items
for each row execute function enforce_payable_statement_item_integrity();

create or replace function enforce_payment_record_lifecycle()
returns trigger
language plpgsql
as $$
declare
  statement_row payable_statements%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'Payment records are retained as commercial history'
      using errcode = '23514',
            constraint = 'payment_record_immutable';
  end if;

  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(
      hashtext('statement-settlement:' || new.payable_statement_id::text)
    );
  end if;

  -- Preserve settled payment history when an actor user is deleted. Only the
  -- FK-managed actor reference may become null; all payment facts stay fixed.
  if tg_op = 'UPDATE'
     and to_jsonb(new) - array['reported_by_user_id', 'confirmed_by_user_id']
       = to_jsonb(old) - array['reported_by_user_id', 'confirmed_by_user_id']
     and (
       new.reported_by_user_id is not distinct from old.reported_by_user_id
       or new.reported_by_user_id is null
     )
     and (
       new.confirmed_by_user_id is not distinct from old.confirmed_by_user_id
       or new.confirmed_by_user_id is null
     ) then
    return new;
  end if;

  select * into statement_row
  from payable_statements
  where id = new.payable_statement_id
  for share;
  if statement_row.status <> 'finalized'
     or new.currency is distinct from statement_row.currency then
    raise exception 'Payment records require a finalized statement in the same currency'
      using errcode = '23514',
            constraint = 'payment_record_statement';
  end if;
  if tg_op = 'INSERT' then
    if new.record_source = 'external' and (
      exists(
        select 1 from facilitated_payment_attempts
        where payable_statement_id = new.payable_statement_id
          and (
            state in ('created', 'requires_action', 'processing', 'succeeded')
            or checkout_status in ('creating', 'open')
          )
      )
      or exists(
        select 1 from facilitated_payments
        where payable_statement_id = new.payable_statement_id
      )
    ) then
      raise exception 'External payment records cannot follow facilitated payment activity'
        using errcode = '23514',
              constraint = 'payment_record_source_exclusive';
    end if;
    if new.record_source = 'facilitated' and (
      new.status <> 'confirmed'
      or new.reported_by_user_id is not null
      or new.confirmed_by_user_id is not null
      or new.confirmed_at is null
    ) then
      raise exception 'Facilitated payment records must be confirmed system facts'
        using errcode = '23514',
              constraint = 'payment_record_facilitated_fact';
    end if;
    if new.status = 'reported'
       and (new.confirmed_by_user_id is not null or new.confirmed_at is not null) then
      raise exception 'Reported payments cannot contain confirmation facts'
        using errcode = '23514',
              constraint = 'payment_record_lifecycle';
    end if;
    if new.status = 'confirmed' and new.confirmed_at is null then
      raise exception 'Confirmed payments require a confirmation timestamp'
        using errcode = '23514',
              constraint = 'payment_record_lifecycle';
    end if;
    return new;
  end if;
  if old.status = 'reported' and new.status in ('confirmed', 'rejected')
     and (
       (new.status = 'confirmed' and new.confirmed_at is not null and new.rejection_reason is null)
       or (new.status = 'rejected' and new.rejection_reason is not null)
     )
     and to_jsonb(new) - array[
       'status', 'confirmed_by_user_id', 'confirmed_at', 'rejection_reason'
     ] = to_jsonb(old) - array[
       'status', 'confirmed_by_user_id', 'confirmed_at', 'rejection_reason'
     ] then
    return new;
  end if;
  raise exception 'Payment record cannot be changed in this lifecycle state'
    using errcode = '23514',
          constraint = 'payment_record_immutable';
end
$$;

drop trigger if exists payment_record_lifecycle_guard on payment_records;
create trigger payment_record_lifecycle_guard
before insert or update or delete
on payment_records
for each row execute function enforce_payment_record_lifecycle();

create or replace function enforce_work_project_owner_change()
returns trigger
language plpgsql
as $$
begin
  if new.business_unit_id is distinct from old.business_unit_id
     and exists(select 1 from work_orders where project_id = old.id) then
    raise exception 'Projects referenced by work orders cannot move between business units'
      using errcode = '23514',
            constraint = 'work_order_project_immutable';
  end if;
  return new;
end
$$;

drop trigger if exists work_project_owner_guard on projects;
create trigger work_project_owner_guard
before update of business_unit_id
on projects
for each row execute function enforce_work_project_owner_change();

create or replace function enforce_work_membership_owner_change()
returns trigger
language plpgsql
as $$
begin
  if new.organization_id is distinct from old.organization_id
     and exists(
       select 1
       from work_assignments assignment
       join work_orders work_order on work_order.id = assignment.work_order_id
       join vendor_relationships relationship
         on relationship.id = work_order.vendor_relationship_id
       where assignment.agency_membership_id = old.id
         and relationship.agency_organization_id <> new.organization_id
     ) then
    raise exception 'Membership move would invalidate a work assignment'
      using errcode = '23514',
            constraint = 'work_assignment_agency_owner';
  end if;
  return new;
end
$$;

drop trigger if exists work_membership_owner_guard on organization_memberships;
create trigger work_membership_owner_guard
before update of organization_id
on organization_memberships
for each row execute function enforce_work_membership_owner_change();

create or replace function enforce_vendor_approved_linguist_owner()
returns trigger
language plpgsql
as $$
declare
  relationship_agency_id uuid;
  membership_organization_id uuid;
begin
  select agency_organization_id
  into relationship_agency_id
  from vendor_relationships
  where id = new.vendor_relationship_id
  for share;

  select organization_id
  into membership_organization_id
  from organization_memberships
  where id = new.agency_membership_id
  for share;

  if membership_organization_id is distinct from relationship_agency_id then
    raise exception 'Approved linguist membership must belong to the relationship agency'
      using errcode = '23514',
            constraint = 'vendor_approved_linguist_agency_owner';
  end if;

  return new;
end
$$;

drop trigger if exists vendor_approved_linguist_owner_guard on vendor_approved_linguists;
create trigger vendor_approved_linguist_owner_guard
before insert or update of vendor_relationship_id, agency_membership_id
on vendor_approved_linguists
for each row execute function enforce_vendor_approved_linguist_owner();

create or replace function enforce_vendor_membership_owner_change()
returns trigger
language plpgsql
as $$
begin
  if new.organization_id is distinct from old.organization_id
     and exists (
       select 1
       from vendor_approved_linguists approved_linguist
       join vendor_relationships relationship
         on relationship.id = approved_linguist.vendor_relationship_id
       where approved_linguist.agency_membership_id = old.id
         and relationship.agency_organization_id <> new.organization_id
     ) then
    raise exception 'Membership move would invalidate an approved vendor linguist'
      using errcode = '23514',
            constraint = 'vendor_approved_linguist_agency_owner';
  end if;

  return new;
end
$$;

drop trigger if exists vendor_membership_owner_guard on organization_memberships;
create trigger vendor_membership_owner_guard
before update of organization_id
on organization_memberships
for each row execute function enforce_vendor_membership_owner_change();

create index if not exists idx_business_units_organization on business_units(organization_id);
create index if not exists idx_projects_business_unit on projects(business_unit_id);
create index if not exists idx_memberships_user on organization_memberships(user_id);
create index if not exists idx_memberships_organization on organization_memberships(organization_id);
create index if not exists idx_role_assignments_principal on role_assignments(principal_type, principal_id);
create index if not exists idx_role_assignments_scope on role_assignments(scope_type, scope_id);
create or replace function canonical_role_assignment_conditions(conditions_value jsonb)
returns jsonb
language sql
immutable
strict
parallel safe
as $$
  select case
    when jsonb_typeof(conditions_value -> 'locales') = 'array' then
      jsonb_set(
        conditions_value,
        '{locales}',
        coalesce(
          (
            select jsonb_agg(locale order by locale)
            from (
              select distinct jsonb_array_elements_text(conditions_value -> 'locales') as locale
            ) locale_values
          ),
          '[]'::jsonb
        )
      )
    else conditions_value
  end
$$;
do $$
declare
  active_unique_definition text;
begin
  select pg_get_indexdef(indexrelid)
  into active_unique_definition
  from pg_index
  where indexrelid = to_regclass(
    format('%I.%I', current_schema(), 'idx_role_assignments_active_unique')
  );

  if active_unique_definition is not null
     and (
       active_unique_definition not like '%inherit_to_children%'
       or active_unique_definition not like '%canonical_role_assignment_conditions%'
     ) then
    execute format(
      'drop index %I.%I',
      current_schema(),
      'idx_role_assignments_active_unique'
    );
  end if;
end
$$;
with duplicate_grants as (
  select
    id,
    first_value(id) over (
      partition by
        principal_type,
        principal_id,
        role_id,
        scope_type,
        scope_id,
        inherit_to_children,
        canonical_role_assignment_conditions(conditions)
      order by created_at desc, id desc
    ) as retained_assignment_id,
    row_number() over (
      partition by
        principal_type,
        principal_id,
        role_id,
        scope_type,
        scope_id,
        inherit_to_children,
        canonical_role_assignment_conditions(conditions)
      order by created_at desc, id desc
    ) as duplicate_rank
  from role_assignments
  where revoked_at is null
), revoked_duplicates as (
  update role_assignments ra
  set revoked_at = now()
  from duplicate_grants duplicate
  where ra.id = duplicate.id and duplicate.duplicate_rank > 1
  returning ra.*, duplicate.retained_assignment_id
)
insert into audit_events(
  organization_id,
  actor_type,
  action,
  resource_type,
  resource_id,
  before_state,
  after_state,
  metadata
)
select
  case revoked.scope_type
    when 'organization' then revoked.scope_id
    when 'business_unit' then (
      select bu.organization_id from business_units bu where bu.id = revoked.scope_id
    )
    when 'project' then (
      select bu.organization_id
      from projects p
      join business_units bu on bu.id = p.business_unit_id
      where p.id = revoked.scope_id
    )
    when 'vendor_relationship' then (
      select vr.customer_organization_id
      from vendor_relationships vr
      where vr.id = revoked.scope_id
    )
    else null
  end,
  'platform',
  'migration.role_assignment_duplicate_revoked',
  'role_assignment',
  revoked.id,
  (to_jsonb(revoked) - 'retained_assignment_id') || jsonb_build_object('revoked_at', null),
  to_jsonb(revoked) - 'retained_assignment_id',
  jsonb_build_object(
    'migration', 'role_assignment_active_uniqueness_v2',
    'retainedAssignmentId', revoked.retained_assignment_id
  )
from revoked_duplicates revoked;
create unique index if not exists idx_role_assignments_active_unique
  on role_assignments(
    principal_type,
    principal_id,
    role_id,
    scope_type,
    coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    inherit_to_children,
    canonical_role_assignment_conditions(conditions)
  )
  where revoked_at is null;
create index if not exists idx_audit_events_organization_created on audit_events(organization_id, created_at desc);
create index if not exists idx_vendor_relationships_customer on vendor_relationships(customer_organization_id);
create index if not exists idx_vendor_relationships_agency on vendor_relationships(agency_organization_id);
create index if not exists idx_vendor_scopes_relationship on vendor_relationship_scopes(vendor_relationship_id);
create unique index if not exists idx_vendor_scopes_resource_unique
  on vendor_relationship_scopes(vendor_relationship_id, scope_type, scope_id)
  where scope_id is not null;
create unique index if not exists idx_vendor_scopes_value_unique
  on vendor_relationship_scopes(vendor_relationship_id, scope_type, lower(scope_value))
  where scope_value is not null;
create index if not exists idx_vendor_approved_linguists_relationship
  on vendor_approved_linguists(vendor_relationship_id, status);
create index if not exists idx_rate_cards_relationship on rate_cards(vendor_relationship_id);
create unique index if not exists idx_rate_cards_open_relationship
  on rate_cards(vendor_relationship_id)
  where status in ('draft', 'submitted');
create unique index if not exists idx_rate_cards_approved_relationship
  on rate_cards(vendor_relationship_id)
  where status = 'approved';
create unique index if not exists idx_rate_card_lines_selector_unique
  on rate_card_lines(
    rate_card_id,
    lower(service_type),
    unit_type,
    coalesce(lower(source_locale), ''),
    coalesce(lower(target_locale), ''),
    coalesce(business_unit_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(lower(content_type), ''),
    coalesce(lower(match_band), '')
  );
create index if not exists idx_work_orders_relationship_status
  on work_orders(vendor_relationship_id, status, created_at desc);
create index if not exists idx_work_orders_project
  on work_orders(project_id, created_at desc);
create index if not exists idx_work_order_items_order
  on work_order_items(work_order_id);
create index if not exists idx_work_order_items_source
  on work_order_items(source_string_id);
create index if not exists idx_work_assignments_order_status
  on work_assignments(work_order_id, status);
create index if not exists idx_work_assignments_membership_status
  on work_assignments(agency_membership_id, status);
create unique index if not exists idx_work_assignments_active_member
  on work_assignments(work_order_id, agency_membership_id)
  where status = 'active';
create index if not exists idx_work_submissions_order_created
  on work_submissions(work_order_id, created_at desc);
create index if not exists idx_work_ledger_order_created
  on work_ledger_entries(work_order_id, created_at);
create index if not exists idx_work_disputes_order_status
  on work_order_disputes(work_order_id, status);
create index if not exists idx_payable_statements_relationship_status
  on payable_statements(vendor_relationship_id, status, created_at desc);
create index if not exists idx_payable_statement_items_order
  on payable_statement_items(work_order_id);
create unique index if not exists idx_payable_statement_items_current_order
  on payable_statement_items(work_order_id)
  where released_at is null;
create index if not exists idx_payment_records_statement_status
  on payment_records(payable_statement_id, status, created_at);

create table if not exists locales (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  locale text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique(project_id, locale)
);

create table if not exists pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  workspace_root text,
  filename text,
  status text not null default 'running' check (status in ('running', 'complete', 'failed')),
  model text,
  locales text[] not null default '{}'::text[],
  total_strings integer not null default 0,
  analyzed_strings integer not null default 0,
  translated_strings integer not null default 0,
  cache_hits integer not null default 0,
  warnings jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists gemini_calls (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  pipeline_run_id uuid references pipeline_runs(id) on delete set null,
  operation text not null,
  cache_key text not null,
  prompt_version text,
  model text,
  api_version text,
  input_hash text,
  locale_group text[] not null default '{}'::text[],
  item_count integer not null default 0,
  cache_hit boolean not null default false,
  finish_reason text,
  usage_metadata jsonb not null default '{}'::jsonb,
  response_json jsonb,
  error text,
  created_at timestamptz not null default now(),
  unique(operation, cache_key)
);

create table if not exists source_strings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  source_hash text not null,
  source_text text not null,
  shape text,
  purpose text,
  visual_context text,
  limit_chars integer,
  -- dynamic-data spec 08: review-triage columns, DERIVED from the pseudo-file
  -- scheme (<sourceName>://…) at push/import time — never client-supplied.
  is_dynamic boolean not null default false,
  data_source text,
  reach integer,
  dynamic_enum boolean not null default false,
  enum_field text,
  mask_names text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, source_hash)
);

create index if not exists idx_source_strings_dynamic_facet
  on source_strings(project_id, is_dynamic, data_source);
create index if not exists idx_source_strings_dynamic_reach
  on source_strings(project_id, data_source, reach desc)
  where is_dynamic;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'work_order_items'::regclass
      and conname = 'work_order_items_source_string_fk'
  ) then
    alter table work_order_items
      add constraint work_order_items_source_string_fk
      foreign key(source_string_id) references source_strings(id) on delete restrict
      not valid;
  end if;
  alter table work_order_items validate constraint work_order_items_source_string_fk;
end
$$;

create or replace function enforce_work_order_item_integrity()
returns trigger
language plpgsql
as $$
declare
  work_order_project_id uuid;
  work_order_status text;
  source_project_id uuid;
begin
  select project_id, status
  into work_order_project_id, work_order_status
  from work_orders
  where id = coalesce(new.work_order_id, old.work_order_id)
  for share;
  if work_order_status <> 'draft' then
    raise exception 'Work-order items can only change while the order is a draft'
      using errcode = '23514',
            constraint = 'work_order_item_immutable';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'Work-order item identity cannot be changed'
      using errcode = '23514',
            constraint = 'work_order_item_immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  select project_id into source_project_id
  from source_strings
  where id = new.source_string_id
  for share;
  if source_project_id is distinct from work_order_project_id then
    raise exception 'Work-order source string must belong to its project'
      using errcode = '23514',
            constraint = 'work_order_item_project_owner';
  end if;
  return new;
end
$$;

drop trigger if exists work_order_item_integrity_guard on work_order_items;
create trigger work_order_item_integrity_guard
before insert or update or delete
on work_order_items
for each row execute function enforce_work_order_item_integrity();

create or replace function enforce_work_source_project_change()
returns trigger
language plpgsql
as $$
begin
  if new.project_id is distinct from old.project_id
     and exists(
       select 1 from work_order_items where source_string_id = old.id
     ) then
    raise exception 'Source strings attached to work orders cannot move projects'
      using errcode = '23514',
            constraint = 'work_order_item_project_owner';
  end if;
  return new;
end
$$;

drop trigger if exists work_source_project_guard on source_strings;
create trigger work_source_project_guard
before update of project_id
on source_strings
for each row execute function enforce_work_source_project_change();

create table if not exists context_variants (
  id uuid primary key default gen_random_uuid(),
  source_string_id uuid not null references source_strings(id) on delete cascade,
  shape text,
  purpose text,
  visual_context text,
  file_path text,
  code_context text,
  ui_context text,
  app_state_context text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists analysis_passes (
  id uuid primary key default gen_random_uuid(),
  source_string_id uuid not null references source_strings(id) on delete cascade,
  pass_name text not null check (pass_name in ('pass1', 'pass2')),
  status text not null check (status in ('ready', 'degraded')),
  prompt_version text not null,
  data jsonb not null,
  warning text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_string_id, pass_name)
);

create table if not exists translations (
  id uuid primary key default gen_random_uuid(),
  source_string_id uuid not null references source_strings(id) on delete cascade,
  locale text not null,
  text text not null,
  mt_status text not null default 'ready',
  human_status text not null default 'pending',
  -- P-06: 'mt' / 'mt-carryover' preserve P-02 non-Gemini provider provenance.
  source text not null check (source in ('gemini', 'mt', 'mt-carryover', 'human', 'stub')),
  -- P-06: P-02 provider metadata for the confidence-fed review queue.
  provider text,
  model text,
  confidence double precision,
  -- P-06: reviewer note attached with human_status 'rejected'.
  review_note text,
  updated_at timestamptz not null default now(),
  unique(source_string_id, locale)
);

create table if not exists translation_revisions (
  id uuid primary key default gen_random_uuid(),
  translation_id uuid references translations(id) on delete set null,
  source_string_id uuid not null references source_strings(id) on delete cascade,
  locale text not null,
  previous_text text,
  next_text text not null,
  revision_source text not null check (revision_source in ('gemini', 'mt', 'mt-carryover', 'human', 'stub')),
  instruction text,
  prompt_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists usage_metric_definitions (
  key text primary key,
  name text not null,
  unit text not null check (unit in ('word', 'character', 'token', 'action', 'credit')),
  aggregation text not null default 'sum' check (aggregation in ('sum', 'gauge')),
  description text,
  created_at timestamptz not null default now()
);

alter table usage_metric_definitions
  drop constraint if exists usage_metric_definitions_unit_check;
alter table usage_metric_definitions
  add constraint usage_metric_definitions_unit_check
  check (unit in ('word', 'character', 'token', 'action', 'credit')) not valid;
alter table usage_metric_definitions
  validate constraint usage_metric_definitions_unit_check;

create unique index if not exists idx_business_units_id_organization
  on business_units(id, organization_id);
create unique index if not exists idx_projects_id_business_unit
  on projects(id, business_unit_id);

create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  business_unit_id uuid references business_units(id) on delete restrict,
  project_id uuid references projects(id) on delete restrict,
  actor_type text not null check (actor_type in ('user', 'service_account', 'platform')),
  actor_user_id uuid references users(id) on delete restrict,
  actor_service_account_id uuid references service_accounts(id) on delete restrict,
  operation text not null,
  event_kind text not null default 'usage' check (event_kind in ('usage', 'adjustment')),
  outcome text not null default 'succeeded' check (outcome in ('succeeded', 'failed', 'partial')),
  idempotency_key text not null,
  idempotency_fingerprint text not null,
  attempt_number integer not null default 1,
  response_status integer,
  response_body jsonb,
  reverses_event_id uuid references usage_events(id) on delete restrict,
  provider text,
  model text,
  provider_request_id text,
  request_id text,
  counting_version text not null,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key(business_unit_id, organization_id)
    references business_units(id, organization_id) on delete restrict,
  foreign key(project_id, business_unit_id)
    references projects(id, business_unit_id) on delete restrict,
  check (project_id is null or business_unit_id is not null),
  check (
    (actor_type = 'user' and actor_user_id is not null and actor_service_account_id is null)
    or (
      actor_type = 'service_account'
      and actor_service_account_id is not null
      and actor_user_id is null
    )
    or (
      actor_type = 'platform'
      and actor_user_id is null
      and actor_service_account_id is null
    )
  ),
  check (
    (event_kind = 'usage' and reverses_event_id is null)
    or (event_kind = 'adjustment' and reverses_event_id is not null)
  )
);

create table if not exists usage_event_measurements (
  usage_event_id uuid not null references usage_events(id) on delete restrict,
  metric_key text not null references usage_metric_definitions(key) on delete restrict,
  quantity bigint not null check (quantity <> 0),
  accuracy text not null default 'exact' check (accuracy in ('exact', 'estimated')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key(usage_event_id, metric_key)
);

create table if not exists usage_event_items (
  id uuid primary key default gen_random_uuid(),
  usage_event_id uuid not null references usage_events(id) on delete restrict,
  item_index integer not null check (item_index >= 0),
  source_string_id uuid references source_strings(id) on delete set null,
  translation_revision_id uuid references translation_revisions(id) on delete set null,
  source_locale text,
  target_locale text,
  source_word_count integer not null default 0 check (source_word_count >= 0),
  source_character_count integer not null default 0 check (source_character_count >= 0),
  output_word_count integer not null default 0 check (output_word_count >= 0),
  output_character_count integer not null default 0 check (output_character_count >= 0),
  counting_version text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(usage_event_id, item_index)
);

create table if not exists usage_event_billing_periods (
  usage_event_id uuid primary key references usage_events(id) on delete restrict,
  period_start timestamptz not null,
  period_end timestamptz not null,
  period_source text not null
    check (period_source in ('subscription', 'calendar_fallback')),
  created_at timestamptz not null default now(),
  check (period_end > period_start)
);

create or replace function enforce_usage_event_billing_period_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Usage event billing periods are immutable'
    using errcode = '23514',
          constraint = 'usage_event_billing_period_immutable';
  return old;
end
$$;

drop trigger if exists usage_event_billing_period_immutable_guard
  on usage_event_billing_periods;
create trigger usage_event_billing_period_immutable_guard
before update or delete on usage_event_billing_periods
for each row execute function enforce_usage_event_billing_period_immutable();

create table if not exists usage_period_rollups (
  organization_id uuid not null references organizations(id) on delete restrict,
  scope_type text not null
    check (scope_type in ('organization', 'business_unit', 'project')),
  scope_id uuid not null,
  business_unit_id uuid references business_units(id) on delete restrict,
  project_id uuid references projects(id) on delete restrict,
  metric_key text not null references usage_metric_definitions(key) on delete restrict,
  counting_version text not null,
  period_type text not null
    check (period_type in ('subscription', 'calendar_month')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  quantity bigint not null,
  event_count bigint not null check (event_count > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(
    organization_id,
    scope_type,
    scope_id,
    metric_key,
    counting_version,
    period_type,
    period_start
  ),
  foreign key(business_unit_id, organization_id)
    references business_units(id, organization_id) on delete restrict,
  foreign key(project_id, business_unit_id)
    references projects(id, business_unit_id) on delete restrict,
  check (period_end > period_start),
  check (
    (
      scope_type = 'organization'
      and scope_id = organization_id
      and business_unit_id is null
      and project_id is null
    )
    or (
      scope_type = 'business_unit'
      and scope_id = business_unit_id
      and business_unit_id is not null
      and project_id is null
    )
    or (
      scope_type = 'project'
      and scope_id = project_id
      and business_unit_id is not null
      and project_id is not null
    )
  )
);

create table if not exists usage_rollup_applied_events (
  usage_event_id uuid primary key references usage_events(id) on delete restrict,
  applied_at timestamptz not null default now()
);

create or replace function enforce_usage_rollup_marker_period()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from usage_event_billing_periods
    where usage_event_id = new.usage_event_id
  ) then
    raise exception 'A usage rollup marker requires a billing-period snapshot'
      using errcode = '23514',
            constraint = 'usage_rollup_marker_period';
  end if;
  return new;
end
$$;

drop trigger if exists usage_rollup_marker_period_guard
  on usage_rollup_applied_events;
create trigger usage_rollup_marker_period_guard
before insert or update on usage_rollup_applied_events
for each row execute function enforce_usage_rollup_marker_period();

create table if not exists usage_rollup_pending_events (
  usage_event_id uuid primary key references usage_events(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete restrict,
  occurred_at timestamptz not null
);

create table if not exists usage_rollup_queue_state (
  singleton boolean primary key default true check (singleton),
  legacy_seed_complete boolean not null,
  updated_at timestamptz not null default now()
);

insert into usage_rollup_queue_state(singleton, legacy_seed_complete)
values(true, true)
on conflict(singleton) do nothing;

create or replace function queue_usage_event_rollup()
returns trigger
language plpgsql
as $$
begin
  insert into usage_rollup_pending_events(
    usage_event_id, organization_id, occurred_at
  )
  select new.id, new.organization_id, new.occurred_at
  where not exists(
    select 1 from usage_rollup_applied_events
    where usage_event_id = new.id
  )
  on conflict(usage_event_id) do nothing;
  return new;
end
$$;

create or replace function dequeue_applied_usage_rollup()
returns trigger
language plpgsql
as $$
begin
  delete from usage_rollup_pending_events
  where usage_event_id = new.usage_event_id;
  return new;
end
$$;

create or replace function requeue_removed_usage_rollup()
returns trigger
language plpgsql
as $$
begin
  insert into usage_rollup_pending_events(
    usage_event_id, organization_id, occurred_at
  )
  select event.id, event.organization_id, event.occurred_at
  from usage_events event
  where event.id = old.usage_event_id
  on conflict(usage_event_id) do nothing;
  return old;
end
$$;

drop trigger if exists usage_event_rollup_queue_guard on usage_events;
create constraint trigger usage_event_rollup_queue_guard
after insert on usage_events
deferrable initially deferred
for each row execute function queue_usage_event_rollup();

drop trigger if exists usage_rollup_marker_dequeue_guard
  on usage_rollup_applied_events;
create trigger usage_rollup_marker_dequeue_guard
after insert on usage_rollup_applied_events
for each row execute function dequeue_applied_usage_rollup();

drop trigger if exists usage_rollup_marker_requeue_guard
  on usage_rollup_applied_events;
create trigger usage_rollup_marker_requeue_guard
after delete on usage_rollup_applied_events
for each row execute function requeue_removed_usage_rollup();

create table if not exists usage_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  business_unit_id uuid references business_units(id) on delete restrict,
  project_id uuid references projects(id) on delete restrict,
  idempotency_key text not null,
  idempotency_fingerprint text not null,
  attempt_number integer not null default 1,
  operation text not null,
  status text not null default 'held'
    check (status in ('held', 'consumed', 'released', 'expired')),
  usage_event_id uuid references usage_events(id) on delete restrict,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(business_unit_id, organization_id)
    references business_units(id, organization_id) on delete restrict,
  foreign key(project_id, business_unit_id)
    references projects(id, business_unit_id) on delete restrict,
  check (project_id is null or business_unit_id is not null)
);

create table if not exists usage_reservation_measurements (
  reservation_id uuid not null references usage_reservations(id) on delete cascade,
  metric_key text not null references usage_metric_definitions(key) on delete restrict,
  quantity bigint not null check (quantity > 0),
  primary key(reservation_id, metric_key)
);

alter table usage_events
  add column if not exists attempt_number integer not null default 1;
alter table usage_events
  add column if not exists response_status integer;
alter table usage_events
  add column if not exists response_body jsonb;
alter table usage_reservations
  add column if not exists attempt_number integer not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'usage_events'::regclass
      and conname = 'usage_events_attempt_number_positive'
  ) then
    alter table usage_events
      add constraint usage_events_attempt_number_positive
      check (attempt_number > 0) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'usage_events'::regclass
      and conname = 'usage_events_response_status_valid'
  ) then
    alter table usage_events
      add constraint usage_events_response_status_valid
      check (response_status between 100 and 599) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'usage_reservations'::regclass
      and conname = 'usage_reservations_attempt_number_positive'
  ) then
    alter table usage_reservations
      add constraint usage_reservations_attempt_number_positive
      check (attempt_number > 0) not valid;
  end if;
end
$$;

alter table usage_events
  validate constraint usage_events_attempt_number_positive;
alter table usage_events
  validate constraint usage_events_response_status_valid;
alter table usage_reservations
  validate constraint usage_reservations_attempt_number_positive;

alter table usage_events
  drop constraint if exists usage_events_organization_id_idempotency_key_key;
alter table usage_reservations
  drop constraint if exists usage_reservations_organization_id_idempotency_key_key;

create unique index if not exists idx_usage_events_logical_attempt_unique
  on usage_events(organization_id, idempotency_key, attempt_number);
create unique index if not exists idx_usage_events_successful_logical_request
  on usage_events(organization_id, idempotency_key)
  where outcome = 'succeeded';
create unique index if not exists idx_usage_reservations_logical_attempt_unique
  on usage_reservations(organization_id, idempotency_key, attempt_number);

create table if not exists usage_budgets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  scope_type text not null check (scope_type in ('organization', 'business_unit', 'project')),
  business_unit_id uuid references business_units(id) on delete restrict,
  project_id uuid references projects(id) on delete restrict,
  metric_key text not null references usage_metric_definitions(key) on delete restrict,
  limit_quantity bigint not null check (limit_quantity > 0),
  warning_percent integer not null default 80 check (warning_percent between 1 and 100),
  enforcement text not null default 'warn' check (enforcement in ('observe', 'warn', 'block')),
  period text not null default 'subscription'
    check (period in ('subscription', 'calendar_month')),
  reason text,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  superseded_at timestamptz,
  created_by_user_id uuid references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key(business_unit_id, organization_id)
    references business_units(id, organization_id) on delete restrict,
  foreign key(project_id, business_unit_id)
    references projects(id, business_unit_id) on delete restrict,
  check (
    (scope_type = 'organization' and business_unit_id is null and project_id is null)
    or (scope_type = 'business_unit' and business_unit_id is not null and project_id is null)
    or (scope_type = 'project' and business_unit_id is not null and project_id is not null)
  ),
  check (expires_at is null or expires_at > starts_at)
);

create unique index if not exists idx_usage_budgets_one_current
  on usage_budgets(
    organization_id,
    scope_type,
    coalesce(business_unit_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
    metric_key
  )
  where superseded_at is null;

create table if not exists usage_budget_alerts (
  id uuid primary key default gen_random_uuid(),
  budget_id uuid not null references usage_budgets(id) on delete restrict,
  usage_event_id uuid references usage_events(id) on delete restrict,
  threshold text not null check (threshold in ('warning', 'exceeded', 'blocked')),
  period_start timestamptz not null,
  observed_quantity bigint not null check (observed_quantity >= 0),
  acknowledged_at timestamptz,
  acknowledged_by_user_id uuid references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(budget_id, threshold, period_start)
);

insert into usage_metric_definitions(key, name, unit, description)
values
  ('source_words_processed', 'Source words processed', 'word',
   'Locale-aware source words submitted to a metered operation.'),
  ('source_characters_processed', 'Source characters processed', 'character',
   'Unicode code points, including whitespace, submitted as source text.'),
  ('ai_output_words', 'AI output words', 'word',
   'Locale-aware words returned by AI generation, including rejected retry output.'),
  ('ai_output_characters', 'AI output characters', 'character',
   'Unicode code points, including whitespace, returned by AI generation.'),
  ('llm_input_tokens', 'LLM input tokens', 'token',
   'Provider-reported prompt or input tokens.'),
  ('llm_output_tokens', 'LLM output tokens', 'token',
   'Provider-reported candidate or output tokens.'),
  ('llm_cached_input_tokens', 'LLM cached input tokens', 'token',
   'Provider-reported cached input tokens.'),
  ('llm_reasoning_tokens', 'LLM reasoning tokens', 'token',
   'Provider-reported internal reasoning or thought tokens.'),
  ('llm_total_tokens', 'LLM total tokens', 'token',
   'Provider-reported total tokens for the request.'),
  ('ai_generation_actions', 'AI generation actions', 'action',
   'Successful logical AI generation operations, independent of provider retry count.')
on conflict(key) do nothing;

create index if not exists idx_usage_events_organization_occurred
  on usage_events(organization_id, occurred_at desc);
create index if not exists idx_usage_events_business_unit_occurred
  on usage_events(business_unit_id, occurred_at desc)
  where business_unit_id is not null;
create index if not exists idx_usage_events_project_occurred
  on usage_events(project_id, occurred_at desc)
  where project_id is not null;
create index if not exists idx_usage_event_items_source
  on usage_event_items(source_string_id, created_at desc)
  where source_string_id is not null;
create index if not exists idx_usage_event_items_revision
  on usage_event_items(translation_revision_id)
  where translation_revision_id is not null;
create index if not exists idx_usage_period_rollups_budget_lookup
  on usage_period_rollups(
    organization_id, scope_type, scope_id, metric_key, period_type, period_start
  );
create index if not exists idx_usage_rollup_pending_organization
  on usage_rollup_pending_events(organization_id, occurred_at, usage_event_id);
create index if not exists idx_usage_reservations_active
  on usage_reservations(organization_id, expires_at)
  where status = 'held';
create index if not exists idx_usage_budgets_active
  on usage_budgets(organization_id, metric_key)
  where superseded_at is null;
create index if not exists idx_usage_budget_alerts_unacknowledged
  on usage_budget_alerts(budget_id, created_at desc)
  where acknowledged_at is null;

create table if not exists prompts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  key text not null,
  label text not null,
  body text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, key)
);

create table if not exists personas (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  locale text not null,
  body jsonb not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, locale)
);

create table if not exists glossary_terms (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  term text not null,
  locale text,
  translation text,
  description text,
  do_not_translate boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_source_strings_project on source_strings(project_id);
create index if not exists idx_context_variants_source on context_variants(source_string_id);
create index if not exists idx_translations_source on translations(source_string_id);
create index if not exists idx_translations_locale on translations(locale);
create index if not exists idx_pipeline_runs_project on pipeline_runs(project_id);
create index if not exists idx_gemini_calls_project on gemini_calls(project_id);
create index if not exists idx_gemini_calls_cache_key on gemini_calls(cache_key);

-- Self-service customer onboarding. Cognito owns account credentials; these
-- tables own the one-trial claim, legal evidence, versioned workflow choice,
-- and the atomic workspace projection.
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
    "description": "Explore Hedgeling for 14 days without a card.",
    "paymentFailureGraceDays": 0,
    "includedAiCredits": 25000,
    "aiCreditBehavior": "hard_stop",
    "managedModelTier": "efficient",
    "managedStrings": 2500,
    "targetLocales": 3,
    "npmSeatsIncluded": 0,
    "npmSeatsMaximum": 0
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
        "resources":{"activeSourceStrings":2500,"targetLocales":3}
      }'::jsonb
    ),
    (
      'ai_revision'::text,
      '{
        "usage":{"ai_credits":{"limit":25000,"warningPercent":75,"enforcement":"block"}},
        "resources":{"concurrentAiRuns":1},
        "modelTier":"efficient"
      }'::jsonb
    )
) entitlement(key, limits)
where plan.key = 'self-service-trial-v1'
on conflict(plan_id, entitlement_key) do update
set enabled = excluded.enabled, limits = excluded.limits;

-- Customer-content lifecycle. Project/organization rows and commercial facts
-- remain as tombstones; translation payloads are removed after the export
-- window by the separately scheduled lifecycle worker.
alter table projects
  add column if not exists data_purged_at timestamptz;

create table if not exists data_lifecycle_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  target_type text not null check (target_type in ('organization', 'project')),
  project_id uuid references projects(id) on delete restrict,
  state text not null default 'scheduled' check (
    state in ('scheduled', 'processing', 'failed', 'purged', 'canceled')
  ),
  policy_version text not null default 'customer-content-v1',
  reason text not null check (char_length(reason) between 1 and 2000),
  requested_by_user_id uuid not null references users(id) on delete restrict,
  requested_at timestamptz not null default now(),
  export_available_until timestamptz not null,
  purge_after timestamptz not null,
  legal_hold_at timestamptz,
  legal_hold_by_user_id uuid references users(id) on delete restrict,
  legal_hold_reason text check (
    legal_hold_reason is null or char_length(legal_hold_reason) between 1 and 2000
  ),
  canceled_at timestamptz,
  canceled_by_user_id uuid references users(id) on delete restrict,
  cancellation_reason text check (
    cancellation_reason is null or char_length(cancellation_reason) between 1 and 2000
  ),
  lease_id uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  retry_at timestamptz,
  last_error text,
  purge_summary jsonb not null default '{}'::jsonb
    check (jsonb_typeof(purge_summary) = 'object'),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (target_type = 'organization' and project_id is null)
    or (target_type = 'project' and project_id is not null)
  ),
  check (export_available_until <= purge_after),
  check (
    (legal_hold_at is null and legal_hold_by_user_id is null and legal_hold_reason is null)
    or (
      legal_hold_at is not null
      and legal_hold_by_user_id is not null
      and legal_hold_reason is not null
    )
  ),
  check (
    (state = 'canceled' and canceled_at is not null and canceled_by_user_id is not null)
    or (state <> 'canceled')
  ),
  check (
    (state = 'purged' and completed_at is not null)
    or (state <> 'purged')
  )
);

create unique index if not exists idx_data_lifecycle_one_current_organization
  on data_lifecycle_requests(organization_id)
  where target_type = 'organization'
    and state in ('scheduled', 'processing', 'failed');

create unique index if not exists idx_data_lifecycle_one_current_project
  on data_lifecycle_requests(project_id)
  where target_type = 'project'
    and state in ('scheduled', 'processing', 'failed');

create index if not exists idx_data_lifecycle_due
  on data_lifecycle_requests(state, retry_at, purge_after, requested_at)
  where state in ('scheduled', 'processing', 'failed');

create or replace function enforce_data_lifecycle_scope()
returns trigger
language plpgsql
as $$
begin
  if new.target_type = 'project' and not exists (
    select 1
    from projects project
    join business_units business_unit on business_unit.id = project.business_unit_id
    where project.id = new.project_id
      and business_unit.organization_id = new.organization_id
  ) then
    raise exception 'Data-lifecycle project must belong to its organization'
      using errcode = '23514',
            constraint = 'data_lifecycle_project_owner';
  end if;
  return new;
end
$$;

drop trigger if exists data_lifecycle_scope_guard on data_lifecycle_requests;
create trigger data_lifecycle_scope_guard
before insert or update of organization_id, target_type, project_id
on data_lifecycle_requests
for each row execute function enforce_data_lifecycle_scope();

-- v1.3.0 spec 10 follow-up: server-side sync observability. One row per
-- project, upserted by /api/sync/push and /api/sync/pull, read by
-- GET /api/sync/status. last_push_state_hash is also the last-writer pin: a
-- push whose baseStateHash does not match it gets a staleBase warning.
create table if not exists project_sync_status (
  project_id uuid primary key references projects(id) on delete cascade,
  last_push_at timestamptz,
  last_push_state_hash text,
  last_push_actor text,
  last_pull_at timestamptz,
  last_pull_actor text,
  updated_at timestamptz not null default now()
);

-- Agent-console workspace proposals, conversations and localization job drafts.
create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  organization_id uuid references organizations(id) on delete cascade,
  status text not null default 'awaiting_input' check (status in ('awaiting_input','planning','reading','awaiting_confirmation','executing','pausing','paused','completed','failed','cancelled')),
  generation integer not null default 0,
  controller_id uuid,
  lease_expires_at timestamptz,
  model_history jsonb not null default '[]',
  authorization_stamp text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_runs_owner on agent_runs(user_id, updated_at desc);
create table if not exists agent_events (
  sequence bigserial primary key,
  run_id uuid not null references agent_runs(id) on delete cascade,
  kind text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists agent_events_run on agent_events(run_id, sequence);
create table if not exists agent_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  run_id uuid references agent_runs(id) on delete cascade,
  organization_id uuid references organizations(id) on delete cascade,
  action text not null,
  input jsonb not null,
  preview jsonb not null,
  fingerprint text not null,
  status text not null default 'pending' check (status in ('pending','confirmed','rejected','expired')),
  result jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  confirmed_at timestamptz
);
create index if not exists agent_proposals_owner on agent_proposals(user_id, status);
create table if not exists localization_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  status text not null default 'draft' check (status = 'draft'),
  source_locale text not null,
  target_locales text[] not null,
  steps text[] not null,
  source_snapshot jsonb not null default '[]',
  created_by_user_id uuid references users(id) on delete set null,
  proposal_id uuid unique references agent_proposals(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists localization_jobs_project on localization_jobs(project_id, created_at desc);
create table if not exists agent_model_usage (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agent_runs(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  organization_id uuid references organizations(id) on delete cascade,
  model text not null,
  reserved_tokens integer not null,
  actual_tokens integer,
  outcome text not null default 'reserved',
  created_at timestamptz not null default now()
);
create index if not exists agent_model_usage_daily on agent_model_usage(user_id, created_at);
