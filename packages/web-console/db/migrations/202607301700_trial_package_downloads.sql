-- Auditable, short-lived package distribution for self-service trials.
-- The package remains private in object storage; npm organization membership
-- begins only after a paid Starter or Business subscription is active.

create table if not exists trial_package_download_issuances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references organizations(id) on delete restrict,
  user_id uuid not null references users(id) on delete restrict,
  subscription_id uuid not null references subscriptions(id) on delete restrict,
  artifact_version text not null,
  artifact_sha256 char(64) not null,
  artifact_bucket text not null,
  artifact_key text not null,
  status text not null default 'requested'
    check (status in ('requested', 'issued', 'failed')),
  requested_at timestamptz not null default now(),
  issued_at timestamptz,
  expires_at timestamptz not null,
  ip_address inet,
  user_agent text,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  check (expires_at > requested_at),
  check (
    (status = 'issued' and issued_at is not null and last_error is null)
    or (status = 'failed' and issued_at is null and last_error is not null)
    or (status = 'requested' and issued_at is null and last_error is null)
  )
);

create index if not exists idx_trial_package_downloads_org_requested
  on trial_package_download_issuances(organization_id, requested_at desc);

create index if not exists idx_trial_package_downloads_user_rate
  on trial_package_download_issuances(user_id, requested_at desc)
  where status in ('requested', 'issued');
