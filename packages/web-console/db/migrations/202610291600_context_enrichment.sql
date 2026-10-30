-- SPDX-License-Identifier: Apache-2.0
create table context_enrichment_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  created_by_user_id uuid not null references users(id),
  proposal_id uuid not null references agent_proposals(id),
  status text not null check(status in ('queued','running','awaiting_review','applied','failed','uncertain')),
  actor jsonb not null,
  source_locale text not null,
  snapshot jsonb not null,
  provider_plan jsonb not null,
  results jsonb not null default '[]',
  accepted_ids uuid[] not null default '{}',
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index context_enrichment_project on context_enrichment_runs(project_id,created_at,id);
create unique index context_enrichment_active on context_enrichment_runs(project_id) where status in ('queued','running');
create table source_context_enrichments (
  source_string_id uuid primary key references source_strings(id) on delete cascade,
  run_id uuid not null references context_enrichment_runs(id) on delete cascade,
  evidence_fingerprint text not null,
  data jsonb not null,
  model text not null,
  provider text not null,
  prompt_version text not null,
  accepted_by_user_id uuid not null references users(id),
  updated_at timestamptz not null default now()
);
