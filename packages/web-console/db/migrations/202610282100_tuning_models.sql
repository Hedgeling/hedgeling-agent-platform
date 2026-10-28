-- SPDX-License-Identifier: Apache-2.0
create table if not exists extraction_model_runs (
  extraction_id uuid primary key references extraction_requests(id) on delete cascade,
  actor jsonb not null, provider_plan jsonb not null,
  status text not null default 'active' check(status in ('active','completed','failed')),
  created_at timestamptz not null default now(), last_polled_at timestamptz,
  error_code text
);
create table if not exists extraction_model_calls (
  id uuid primary key, extraction_id uuid not null references extraction_model_runs(extraction_id) on delete cascade,
  input_hash text not null, status text not null check(status in ('running','succeeded','failed')),
  response_text text, usage jsonb, created_at timestamptz not null default now(), finished_at timestamptz
);
create index if not exists extraction_model_active on extraction_model_runs(last_polled_at) where status='active';
