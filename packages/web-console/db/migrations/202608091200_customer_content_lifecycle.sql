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
