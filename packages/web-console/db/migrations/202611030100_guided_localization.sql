alter table localization_jobs add column workflow_preset text
  check (workflow_preset in ('ai_only','ai_quality','human_review'));
alter table translations add column approval_basis text check (approval_basis in ('ai_assessment','human_review'));
alter table translations add column approved_text_hash text;
alter table translations add column approved_source_hash text;
create function clear_outdated_translation_approval() returns trigger language plpgsql as $$
begin
  if new.human_status is distinct from 'verified' or new.approved_text_hash is distinct from md5(new.text) or new.approved_source_hash is null then
    new.approval_basis := null; new.approved_text_hash := null; new.approved_source_hash := null;
  end if;
  return new;
end;
$$;
create trigger translation_approval_freshness before insert or update on translations
  for each row execute function clear_outdated_translation_approval();
-- Legacy verification has unknown provenance. Do not invent a human review.
create table localization_flows (
  project_id uuid primary key references projects(id) on delete cascade,
  context_choice text check (context_choice in ('enrich','skip')),
  workflow_preset text check (workflow_preset in ('ai_only','ai_quality','human_review')),
  job_id uuid references localization_jobs(id) on delete set null,
  revision integer not null default 1,
  updated_by_user_id uuid references users(id),
  updated_at timestamptz not null default now()
);
