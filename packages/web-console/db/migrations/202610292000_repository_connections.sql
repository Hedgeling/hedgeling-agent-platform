-- SPDX-License-Identifier: Apache-2.0
alter table extraction_connections add column if not exists source_mode text not null default 'github-app';
alter table extraction_connections add column if not exists visibility text;
create table if not exists github_user_connections (
  user_id uuid primary key references users(id) on delete cascade,
  github_user_id bigint not null,
  login text not null,
  credential jsonb not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create table if not exists github_oauth_states (
  state_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  verifier jsonb not null,
  redirect_uri text not null,
  expires_at timestamptz not null default now()+interval '10 minutes'
);
