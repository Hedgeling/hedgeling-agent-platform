-- SPDX-License-Identifier: Apache-2.0
create table if not exists extraction_settings (
  project_id uuid not null,
  connection_id text not null,
  settings jsonb not null,
  scan_roots text[] not null,
  binding_hash text not null,
  source_commit text not null,
  tuning_request_id uuid not null references extraction_requests(id),
  updated_at timestamptz not null default now(),
  primary key(project_id, connection_id),
  foreign key(project_id, connection_id) references extraction_connections(project_id, connection_id) on delete cascade
);
