// v1.3.0 spec 10: console ↔ repo state sync — the console side of the ONE
// sanctioned transport (`hedgeling sync push|pull`). The console stays
// passive storage + review UI: the CLI initiates everything, payloads are
// versioned ({ version: 1, … }) like the check JSON contract. The only sync
// schema beyond what bulk upsert needs is project_sync_status (one row per
// project: last push/pull bookkeeping for the status endpoint + the
// last-writer pin).
//
// Contract:
// - POST /api/sync/push  (manage-tier: imports.run + state_imports entitlement)
//   body { version: 1, projectSlug, projectName?, stateHash?, baseStateHash?,
//   state } where
//   `state` is the repo's hedgeling_package.json document. Upserts repo-owned
//   truth (sources, contexts, analysis, machine translations) via the same
//   importer as /api/import-state, ALWAYS pruning console rows for keys
//   absent from the pushed state (pruneMissingProjectSources semantics,
//   work-order conflict handling included) and NEVER overwriting console
//   human truth (overwriteHuman is not accepted from the payload). Revisions
//   are recorded with revision_source "sync". `baseStateHash` (optional,
//   additive) is the hash the CLI's committed cursor says this push builds
//   on; when it mismatches the hash this console last accepted, the response
//   carries staleBase: true (+ previousStateHash) — a warning, never a 409.
//   → { version: 1, ok, counts, projectId, stateHash, staleBase?, previousStateHash? }
// - GET /api/sync/pull   (strings.view)
//   query project, since? (watermark cursor), locales? (csv). Returns every
//   row carrying console human truth — a review decision (verified /
//   rejected / needs-review) or human-edited text — updated after `since`.
//   → { version: 1, projectId, cursor, translations: [{ sourceHash,
//      sourceText, locale, text, source, humanStatus, reviewNote, updatedAt }] }
//   `cursor` is the max updatedAt of the returned rows (or `since` when
//   nothing changed) — the CLI commits it to .hedgeling/sync.json so pulls
//   stay incremental and conflicts well-defined.
// - GET /api/sync/status (strings.view)
//   query project. → { version: 1, projectId, lastPushAt, lastPushStateHash,
//   lastPushActor, lastPullAt, lastPullActor } (nulls for a direction that
//   never ran) — the operational-visibility read for "is this repo's sync
//   loop alive?".

export const SYNC_CONTRACT_VERSION = 1;

function badRequest(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

export function validateSyncPushPayload(body) {
  if (!body || typeof body !== "object") {
    throw badRequest("sync_push_invalid", "sync push expects a JSON body { version: 1, projectSlug, state }");
  }
  if (body.version !== SYNC_CONTRACT_VERSION) {
    throw badRequest(
      "sync_contract_version",
      `unsupported sync contract version ${JSON.stringify(body.version)} (this console speaks version ${SYNC_CONTRACT_VERSION})`,
    );
  }
  const state = body.state;
  if (!state || typeof state !== "object" || !state.files || typeof state.files !== "object") {
    throw badRequest("sync_push_state_required", "sync push requires `state` (a hedgeling_package.json document)");
  }
  return {
    state,
    projectSlug: typeof body.projectSlug === "string" && body.projectSlug.trim() ? body.projectSlug.trim() : null,
    projectName: typeof body.projectName === "string" && body.projectName.trim() ? body.projectName.trim() : null,
    stateHash: typeof body.stateHash === "string" && body.stateHash.trim() ? body.stateHash.trim() : null,
    // The hash the CLI's committed cursor says this push BUILDS ON (the last
    // stateHash it pushed here). Optional and additive — contract stays
    // version 1; a CLI that never sent it gets no lineage check.
    baseStateHash: typeof body.baseStateHash === "string" && body.baseStateHash.trim() ? body.baseStateHash.trim() : null,
  };
}

/**
 * Resolve the project slug a push targets. Production contract: NO default
 * project — an API caller omitting the slug must get a 400, never a silent
 * import into the seed project. And the slug the import runs against must be
 * the one the authorization middleware resolved (it prefers `?project=` over
 * the body): a body slug differing from the authorized slug is a 400, not a
 * confused-deputy import into a project the caller was never checked against.
 */
export function resolveSyncPushProjectSlug(payload, { queryProject, authorizedSlug }) {
  const queried = typeof queryProject === "string" ? queryProject.trim() : "";
  const projectSlug = payload.projectSlug || queried;
  if (!projectSlug) {
    throw badRequest(
      "sync_project_required",
      "sync push requires a project slug (`projectSlug` in the body or `?project=`) — there is no default project",
    );
  }
  if (authorizedSlug && projectSlug !== authorizedSlug) {
    throw badRequest(
      "sync_project_mismatch",
      `sync push was authorized for project ${JSON.stringify(authorizedSlug)} but the payload targets ${JSON.stringify(projectSlug)} — send one slug`,
    );
  }
  return projectSlug;
}

/**
 * The pull query: console human truth only (review decisions + human-edited
 * text), incrementally after `since`. Pure over the injected query function
 * so route tests run without a database (web-console test conventions).
 */
export async function pullSyncRows(queryFn, { projectId, since = null, locales = [] }) {
  // An unparseable watermark must be a 400, not a Postgres cast error 500 —
  // the CLI treats 4xx/5xx alike (exit 2), but the message should say why.
  if (since && Number.isNaN(Date.parse(since))) {
    throw badRequest("sync_invalid_since", `invalid \`since\` cursor ${JSON.stringify(since)} — expected an ISO-8601 timestamp`);
  }
  const params = [projectId];
  const filters = [
    "s.project_id = $1",
    // Console human truth: a review decision, or human-edited text awaiting
    // one. Plain machine rows are repo-owned and never travel on pull.
    "(t.human_status in ('verified', 'rejected', 'needs-review') or t.source = 'human')",
  ];
  if (since) {
    params.push(since);
    filters.push(`t.updated_at > $${params.length}::timestamptz`);
  }
  if (locales.length > 0) {
    params.push(locales);
    filters.push(`t.locale = any($${params.length}::text[])`);
  }

  const result = await queryFn(
    `
      select
        s.source_hash as "sourceHash",
        s.source_text as "sourceText",
        t.locale,
        t.text,
        t.source,
        t.human_status as "humanStatus",
        t.review_note as "reviewNote",
        t.updated_at as "updatedAt"
      from translations t
      join source_strings s on s.id = t.source_string_id
      where ${filters.join(" and ")}
      order by t.locale, s.source_hash
    `,
    params,
  );

  // Note on precision: Postgres keeps microseconds, toISOString() keeps
  // milliseconds — a row sitting exactly on the truncated cursor boundary may
  // be re-delivered on the next pull. That is safe by design: the CLI merge
  // engine is idempotent (re-delivered rows classify as unchanged/no-op).
  const translations = result.rows.map((row) => ({
    ...row,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  }));
  let cursor = since;
  for (const row of translations) {
    if (!cursor || row.updatedAt > cursor) cursor = row.updatedAt;
  }
  return { cursor: cursor || null, translations };
}

// ---- per-project sync status (project_sync_status) ---------------------------------
//
// The operational-visibility gap: the console used to only ECHO the pushed
// stateHash back — nothing recorded when a repo last pushed or pulled. A dead
// token or forgotten workflow was discoverable only via translation drift.
// One row per project; push and pull each upsert their half.

/** Compact actor label for the status row ("user:<id>" / "service_account:<id>" / "platform"). */
export function syncActorLabel(actor) {
  if (actor?.actorUserId) return `user:${actor.actorUserId}`;
  if (actor?.actorServiceAccountId) return `service_account:${actor.actorServiceAccountId}`;
  return "platform";
}

/**
 * Record a completed push and classify its lineage against the previously
 * recorded hash. Returns { staleBase, previousStateHash }: staleBase is true
 * when the CLI declared a baseStateHash (the hash its committed cursor says
 * it built on) that is NOT what this console last accepted — two repos (or a
 * fork with a stale cursor) are interleaving pushes into one project. A
 * WARNING, not a 409: racing cursor commits are documented-harmless, retries
 * must stay safe, and older CLIs send no baseStateHash at all.
 */
export async function recordSyncPushStatus(queryFn, { projectId, stateHash = null, baseStateHash = null, actor = null }) {
  const result = await queryFn(
    `
      insert into project_sync_status(project_id, last_push_at, last_push_state_hash, last_push_actor, updated_at)
      values($1, now(), $2, $3, now())
      on conflict(project_id) do update
        set last_push_at = now(),
            last_push_state_hash = excluded.last_push_state_hash,
            last_push_actor = excluded.last_push_actor,
            updated_at = now()
      returning (
        select prior.last_push_state_hash
        from project_sync_status prior
        where prior.project_id = $1
      ) as "previousStateHash"
    `,
    [projectId, stateHash, syncActorLabel(actor)],
  );
  const previousStateHash = result.rows[0]?.previousStateHash ?? null;
  const staleBase = Boolean(baseStateHash && previousStateHash && baseStateHash !== previousStateHash);
  return { staleBase, previousStateHash };
}

/** Record a completed pull (read-side bookkeeping — the caller's tier stays strings.view). */
export async function recordSyncPullStatus(queryFn, { projectId, actor = null }) {
  await queryFn(
    `
      insert into project_sync_status(project_id, last_pull_at, last_pull_actor, updated_at)
      values($1, now(), $2, now())
      on conflict(project_id) do update
        set last_pull_at = now(),
            last_pull_actor = excluded.last_pull_actor,
            updated_at = now()
    `,
    [projectId, syncActorLabel(actor)],
  );
}

/** The status read: last push/pull per project, nulls when a direction never ran. */
export async function readSyncStatus(queryFn, { projectId }) {
  const result = await queryFn(
    `
      select
        last_push_at as "lastPushAt",
        last_push_state_hash as "lastPushStateHash",
        last_push_actor as "lastPushActor",
        last_pull_at as "lastPullAt",
        last_pull_actor as "lastPullActor"
      from project_sync_status
      where project_id = $1
    `,
    [projectId],
  );
  const row = result.rows[0];
  if (!row) {
    return { lastPushAt: null, lastPushStateHash: null, lastPushActor: null, lastPullAt: null, lastPullActor: null };
  }
  const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? null);
  return {
    lastPushAt: iso(row.lastPushAt),
    lastPushStateHash: row.lastPushStateHash ?? null,
    lastPushActor: row.lastPushActor ?? null,
    lastPullAt: iso(row.lastPullAt),
    lastPullActor: row.lastPullActor ?? null,
  };
}
