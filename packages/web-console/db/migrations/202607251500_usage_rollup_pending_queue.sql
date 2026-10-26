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
values(true, false)
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

create index if not exists idx_usage_rollup_pending_organization
  on usage_rollup_pending_events(organization_id, occurred_at, usage_event_id);
