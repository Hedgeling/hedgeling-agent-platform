-- v1.3.0 spec 10 follow-up: server-side sync observability. The console never
-- recorded WHEN a repo last pushed or pulled, or WHICH stateHash the last push
-- carried — it only echoed the hash back. That left two gaps: a dead token or
-- forgotten workflow was only discoverable via translation drift, and two
-- repos (or a misconfigured fork) pushing into the same project interleaved
-- silently. One row per project, upserted by /api/sync/push and
-- /api/sync/pull, read by GET /api/sync/status.
--
-- last_push_state_hash is also the last-writer pin: a push whose
-- baseStateHash (the hash the CLI's cursor says it is building on) does not
-- match it gets a staleBase warning in the response — a warning, not a 409,
-- because racing cursor commits are documented-harmless and older CLIs send
-- no baseStateHash at all (the sync contract stays version 1, additive).
create table if not exists project_sync_status (
  project_id uuid primary key references projects(id) on delete cascade,
  last_push_at timestamptz,
  last_push_state_hash text,
  last_push_actor text,
  last_pull_at timestamptz,
  last_pull_actor text,
  updated_at timestamptz not null default now()
);
