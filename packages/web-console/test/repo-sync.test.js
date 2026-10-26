// v1.3.0 spec 10: the console side of `hedgeling sync push|pull` — payload
// validation for the bulk push route and the pull query (console human truth
// only, incremental after the `since` watermark, cursor = max updatedAt).
// Same conventions as import-pruning.test.js: fake query functions, no DB.
import assert from "node:assert/strict";
import test from "node:test";
import {
  SYNC_CONTRACT_VERSION,
  pullSyncRows,
  readSyncStatus,
  recordSyncPullStatus,
  recordSyncPushStatus,
  resolveSyncPushProjectSlug,
  syncActorLabel,
  validateSyncPushPayload,
} from "../src/repo-sync.js";

test("push payload must carry the versioned contract", () => {
  assert.equal(SYNC_CONTRACT_VERSION, 1);
  for (const body of [null, "x", {}, { version: 2, state: { files: {} } }, { version: "1", state: { files: {} } }]) {
    assert.throws(
      () => validateSyncPushPayload(body),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.code, /^sync_/);
        return true;
      },
      JSON.stringify(body),
    );
  }
});

test("push payload requires a state document with files", () => {
  assert.throws(
    () => validateSyncPushPayload({ version: 1 }),
    (error) => error.code === "sync_push_state_required",
  );
  assert.throws(
    () => validateSyncPushPayload({ version: 1, state: { files: "nope" } }),
    (error) => error.code === "sync_push_state_required",
  );
});

test("push payload normalizes slug/name/hash fields", () => {
  const state = { files: {} };
  assert.deepEqual(validateSyncPushPayload({ version: 1, state }), {
    state,
    projectSlug: null,
    projectName: null,
    stateHash: null,
    baseStateHash: null,
  });
  assert.deepEqual(
    validateSyncPushPayload({
      version: 1,
      state,
      projectSlug: " web-marketing ",
      projectName: "Web",
      stateHash: "abc",
      baseStateHash: " prev ",
    }),
    { state, projectSlug: "web-marketing", projectName: "Web", stateHash: "abc", baseStateHash: "prev" },
  );
});

// Production contract: push has NO default project. An omitted slug was a
// silent import into the seed project ("scroll-goblin") — now a 400.
test("push with no project slug anywhere is a 400, never the seed project", () => {
  assert.throws(
    () => resolveSyncPushProjectSlug({ projectSlug: null }, { queryProject: "", authorizedSlug: "" }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "sync_project_required");
      return true;
    },
  );
  assert.throws(
    () => resolveSyncPushProjectSlug({ projectSlug: null }, { queryProject: "   ", authorizedSlug: undefined }),
    (error) => error.code === "sync_project_required",
  );
});

test("push slug resolves from body, then ?project=, and must match the authorized slug", () => {
  assert.equal(
    resolveSyncPushProjectSlug({ projectSlug: "web-marketing" }, { queryProject: "", authorizedSlug: "web-marketing" }),
    "web-marketing",
  );
  assert.equal(
    resolveSyncPushProjectSlug({ projectSlug: null }, { queryProject: "web-marketing", authorizedSlug: "web-marketing" }),
    "web-marketing",
  );
  // The authorization middleware prefers ?project= — a DIFFERENT body slug
  // must never route the import into a project the caller was not checked
  // against (confused deputy).
  assert.throws(
    () => resolveSyncPushProjectSlug({ projectSlug: "other-project" }, { queryProject: "web-marketing", authorizedSlug: "web-marketing" }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "sync_project_mismatch");
      return true;
    },
  );
});

test("pull selects console human truth only, scoped by since + locales", async () => {
  const statements = [];
  const queryFn = async (sql, params) => {
    statements.push({ sql, params });
    return { rows: [] };
  };
  await pullSyncRows(queryFn, {
    projectId: "p-1",
    since: "2026-10-01T00:00:00.000Z",
    locales: ["fr-FR", "de-DE"],
  });
  assert.equal(statements.length, 1);
  const { sql, params } = statements[0];
  assert.match(sql, /human_status in \('verified', 'rejected', 'needs-review'\) or t\.source = 'human'/);
  assert.match(sql, /t\.updated_at > \$2::timestamptz/);
  assert.match(sql, /t\.locale = any\(\$3::text\[\]\)/);
  assert.deepEqual(params, ["p-1", "2026-10-01T00:00:00.000Z", ["fr-FR", "de-DE"]]);
});

test("pull cursor is the max updatedAt of the returned rows (Dates become ISO)", async () => {
  const queryFn = async () => ({
    rows: [
      {
        sourceHash: "k1",
        sourceText: "Hello",
        locale: "fr-FR",
        text: "Bonjour",
        source: "human",
        humanStatus: "verified",
        reviewNote: null,
        updatedAt: new Date("2026-10-02T00:00:00.000Z"),
      },
      {
        sourceHash: "k2",
        sourceText: "Bye",
        locale: "fr-FR",
        text: "Au revoir",
        source: "gemini",
        humanStatus: "rejected",
        reviewNote: "tone",
        updatedAt: new Date("2026-10-03T00:00:00.000Z"),
      },
    ],
  });
  const { cursor, translations } = await pullSyncRows(queryFn, { projectId: "p-1" });
  assert.equal(cursor, "2026-10-03T00:00:00.000Z");
  assert.equal(translations[0].updatedAt, "2026-10-02T00:00:00.000Z");
  assert.equal(translations[1].reviewNote, "tone");
});

test("an unparseable since cursor is a 400, not a database cast error", async () => {
  const queryFn = () => {
    throw new Error("query should not run");
  };
  await assert.rejects(
    pullSyncRows(queryFn, { projectId: "p-1", since: "not-a-timestamp" }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "sync_invalid_since");
      return true;
    },
  );
});

test("pull with no new rows keeps the caller's watermark as the cursor", async () => {
  const queryFn = async () => ({ rows: [] });
  const since = "2026-10-01T00:00:00.000Z";
  assert.deepEqual(await pullSyncRows(queryFn, { projectId: "p-1", since }), {
    cursor: since,
    translations: [],
  });
  // First-ever pull with an empty project: cursor stays null (the CLI falls
  // back to its own timestamp).
  assert.deepEqual(await pullSyncRows(queryFn, { projectId: "p-1" }), { cursor: null, translations: [] });
});

// ---- project_sync_status: operational visibility + last-writer detection ----

test("sync actor labels are compact and stable", () => {
  assert.equal(syncActorLabel({ actorType: "user", actorUserId: "u-1", actorServiceAccountId: null }), "user:u-1");
  assert.equal(
    syncActorLabel({ actorType: "service_account", actorUserId: null, actorServiceAccountId: "sa-1" }),
    "service_account:sa-1",
  );
  assert.equal(syncActorLabel(null), "platform");
  assert.equal(syncActorLabel({ actorType: "platform", actorUserId: null, actorServiceAccountId: null }), "platform");
});

test("push status upserts the row and classifies lineage against the PRIOR hash", async () => {
  const statements = [];
  const queryFn = async (sql, params) => {
    statements.push({ sql, params });
    return { rows: [{ previousStateHash: "hash-old" }] };
  };
  // Base matches what the console last accepted: clean lineage.
  assert.deepEqual(
    await recordSyncPushStatus(queryFn, {
      projectId: "p-1",
      stateHash: "hash-new",
      baseStateHash: "hash-old",
      actor: { actorType: "service_account", actorUserId: null, actorServiceAccountId: "sa-1" },
    }),
    { staleBase: false, previousStateHash: "hash-old" },
  );
  const { sql, params } = statements[0];
  assert.match(sql, /insert into project_sync_status/);
  assert.match(sql, /on conflict\(project_id\) do update/);
  assert.deepEqual(params, ["p-1", "hash-new", "service_account:sa-1"]);
  // Base mismatches: another writer pushed in between — staleBase, a warning
  // the route surfaces in the response, never a 409.
  assert.deepEqual(
    await recordSyncPushStatus(queryFn, { projectId: "p-1", stateHash: "hash-new", baseStateHash: "hash-other" }),
    { staleBase: true, previousStateHash: "hash-old" },
  );
});

test("push status without lineage never flags staleBase (older CLIs, first push)", async () => {
  // Older CLI: no baseStateHash declared.
  const withPrior = async () => ({ rows: [{ previousStateHash: "hash-old" }] });
  assert.deepEqual(await recordSyncPushStatus(withPrior, { projectId: "p-1", stateHash: "h" }), {
    staleBase: false,
    previousStateHash: "hash-old",
  });
  // First-ever push: no prior row to be stale against.
  const noPrior = async () => ({ rows: [{ previousStateHash: null }] });
  assert.deepEqual(
    await recordSyncPushStatus(noPrior, { projectId: "p-1", stateHash: "h", baseStateHash: "anything" }),
    { staleBase: false, previousStateHash: null },
  );
});

test("pull status records the pull side only", async () => {
  const statements = [];
  const queryFn = async (sql, params) => {
    statements.push({ sql, params });
    return { rows: [] };
  };
  await recordSyncPullStatus(queryFn, {
    projectId: "p-1",
    actor: { actorType: "user", actorUserId: "u-1", actorServiceAccountId: null },
  });
  const { sql, params } = statements[0];
  assert.match(sql, /insert into project_sync_status/);
  assert.match(sql, /last_pull_at = now\(\)/);
  assert.doesNotMatch(sql, /last_push_state_hash/);
  assert.deepEqual(params, ["p-1", "user:u-1"]);
});

test("status read returns nulls for a project that never synced, ISO strings otherwise", async () => {
  assert.deepEqual(await readSyncStatus(async () => ({ rows: [] }), { projectId: "p-1" }), {
    lastPushAt: null,
    lastPushStateHash: null,
    lastPushActor: null,
    lastPullAt: null,
    lastPullActor: null,
  });
  const row = {
    lastPushAt: new Date("2026-10-04T00:00:00.000Z"),
    lastPushStateHash: "hash-1",
    lastPushActor: "service_account:sa-1",
    lastPullAt: new Date("2026-10-05T00:00:00.000Z"),
    lastPullActor: "service_account:sa-2",
  };
  assert.deepEqual(await readSyncStatus(async () => ({ rows: [row] }), { projectId: "p-1" }), {
    lastPushAt: "2026-10-04T00:00:00.000Z",
    lastPushStateHash: "hash-1",
    lastPushActor: "service_account:sa-1",
    lastPullAt: "2026-10-05T00:00:00.000Z",
    lastPullActor: "service_account:sa-2",
  });
});
