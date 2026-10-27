-- SPDX-License-Identifier: Apache-2.0
-- Event-created tables integrated with the separately hosted console schema.
create table if not exists extraction_connections (
  project_id uuid not null references projects(id) on delete cascade,
  connection_id text not null,
  repository_id bigint not null check(repository_id > 0),
  repository_owner text not null,
  repository_name text not null,
  allowed_roots text[] not null check(cardinality(allowed_roots) between 1 and 20),
  default_ref text not null default 'main',
  active boolean not null default true,
  primary key(project_id, connection_id)
);
create table if not exists extraction_requests (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  proposal_id uuid not null unique references agent_proposals(id),
  created_by_user_id uuid not null references users(id),
  binding jsonb not null,
  request jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  imported_at timestamptz,
  import_result jsonb
);
create index if not exists extraction_requests_project_created on extraction_requests(project_id,created_at desc,id);
