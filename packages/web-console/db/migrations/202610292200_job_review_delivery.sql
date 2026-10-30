-- SPDX-License-Identifier: Apache-2.0
alter table localization_jobs drop constraint localization_jobs_status_check;
alter table localization_jobs add constraint localization_jobs_status_check
  check(status in ('draft','queued','running','awaiting_review','needs_attention','canceled','completed','partially_translated'));

create table job_quality_runs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references localization_jobs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  proposal_id uuid unique references agent_proposals(id) on delete set null,
  created_by_user_id uuid references users(id),
  actor jsonb not null,
  source_locale text not null,
  selection text not null check(selection in ('all','in_review')),
  status text not null check(status in ('queued','running','ready','applied','failed','uncertain','cancelled')),
  snapshot jsonb not null,
  guidance jsonb not null,
  provider_plan jsonb not null,
  results jsonb not null default '[]',
  accepted_ids uuid[] not null default '{}',
  next_batch integer not null default 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index job_quality_queue on job_quality_runs(created_at,id) where status in ('queued','running');
create index job_quality_job on job_quality_runs(job_id,created_at desc,id);

create table job_pull_requests (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references localization_jobs(id) on delete cascade,
  proposal_id uuid unique references agent_proposals(id) on delete set null,
  created_by_user_id uuid references users(id),
  repository_id bigint not null,
  receipt jsonb not null,
  created_at timestamptz not null default now()
);
