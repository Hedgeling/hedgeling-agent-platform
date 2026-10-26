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
