-- SPDX-License-Identifier: Apache-2.0
alter table localization_jobs drop constraint localization_jobs_status_check;
alter table localization_jobs add constraint localization_jobs_status_check
  check(status in ('draft','queued','running','awaiting_review','needs_attention','canceled'));
alter table localization_jobs add column execution jsonb;
alter table localization_jobs add column started_at timestamptz;
alter table localization_jobs add column finished_at timestamptz;
create table localization_job_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references localization_jobs(id) on delete cascade,
  source_string_id uuid references source_strings(id) on delete set null,
  locale text not null,
  ordinal integer not null,
  expected_fingerprint text not null,
  credit_ceiling bigint not null check(credit_ceiling>=0),
  status text not null default 'queued' check(status in ('queued','running','succeeded','failed','canceled','uncertain')),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text,
  error_message text,
  finished_at timestamptz,
  unique(job_id,ordinal), unique(job_id,source_string_id,locale)
);
create index localization_job_items_queue on localization_job_items(job_id,ordinal) where status in ('queued','running');
