-- Event-authored Library history and review workflow. Existing assets remain in place.
alter table glossary_terms add column active boolean not null default true;
create table library_revisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null check(kind in ('prompt','persona','glossary')),
  asset_key text not null,
  locale text,
  before_state jsonb,
  after_state jsonb not null,
  created_by_user_id uuid references users(id) on delete set null,
  proposal_id uuid unique references agent_proposals(id) on delete set null,
  restored_from_id uuid references library_revisions(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on library_revisions(project_id,kind,asset_key,id);
create table library_suggestions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null check(kind in ('prompt','persona','glossary')),
  asset_key text not null,
  locale text,
  expected_version text,
  before_state jsonb,
  after_state jsonb not null,
  restored_from_id uuid references library_revisions(id) on delete set null,
  created_by_user_id uuid references users(id) on delete set null,
  proposal_id uuid unique references agent_proposals(id) on delete set null,
  status text not null default 'pending' check(status in ('pending','approved','rejected')),
  reviewed_by_user_id uuid references users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index on library_suggestions(project_id,kind,status,id);
