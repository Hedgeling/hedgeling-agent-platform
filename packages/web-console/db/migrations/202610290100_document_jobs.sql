-- SPDX-License-Identifier: Apache-2.0
create table uploaded_documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  created_by_user_id uuid not null references users(id),
  filename text not null,
  format text not null,
  sha256 text not null,
  bytes integer not null check(bytes between 1 and 5242880),
  source_locale text not null,
  segments jsonb not null check(jsonb_array_length(segments) between 1 and 200),
  warnings jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '7 days',
  imported_at timestamptz,
  unique(project_id,created_by_user_id,sha256)
);
alter table localization_jobs add column source_document_id uuid references uploaded_documents(id);
create index uploaded_documents_project on uploaded_documents(project_id,created_at,id);
