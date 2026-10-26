// dynamic-data spec 08: console review triage at dynamic volume — derivation
// of the dynamic columns from the pseudo-file scheme (never client-supplied),
// reach upsert on every push, source facets (the default queue excludes
// dynamic rows), the enum grid + bulk verify, and the typed placeholder chips.
// Same conventions as repo-sync.test.js: fake query functions, no DB.
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEnumGrid,
  bulkVerifyTranslations,
  chipMismatch,
  deriveDynamicSourceFields,
  deriveStateDynamicFields,
  facetCondition,
  isDataSourceFacet,
  normalizeSourceFacet,
  serializeChips,
  tokenizeChips,
  upsertDynamicSourceFields,
} from "../src/review-triage.js";

// ---- derivation ------------------------------------------------------------------

test("dynamic fields derive from the pseudo-file scheme of the file key", () => {
  const entry = {
    sourceText: "Stunning {0} apartment near {1}",
    dynamic: {
      source: "listings",
      lastSeenAt: "2026-10-15T00:00:00.000Z",
      masked: true,
      maskNames: ["currency", "landmark"],
      retention: "git",
      locations: ["listings://l-1#remark", "listings://l-2#remark"],
      locationOverflow: 398,
    },
  };
  assert.deepEqual(deriveDynamicSourceFields("listings://", entry), {
    isDynamic: true,
    dataSource: "listings",
    reach: 400,
    dynamicEnum: false,
    enumField: null,
    maskNames: ["currency", "landmark"],
  });
});

test("derivation ignores client-supplied isDynamic/dataSource-style fields", () => {
  // A real file key is never dynamic, whatever the entry claims — the columns
  // are DERIVED, not accepted from the payload.
  const spoofed = {
    sourceText: "Delete account",
    isDynamic: true,
    dataSource: "evil",
    reach: 999999,
    dynamic: { source: "evil", locations: ["evil://x#y"] },
  };
  assert.deepEqual(deriveDynamicSourceFields("src/components/Settings.tsx", spoofed), {
    isDynamic: false,
    dataSource: null,
    reach: null,
    dynamicEnum: false,
    enumField: null,
    maskNames: null,
  });
  // And under a dynamic file key, the data source is the FILE KEY's name even
  // when entry metadata disagrees.
  const mismatched = { sourceText: "x", dynamic: { source: "other-name", locations: [] } };
  assert.equal(deriveDynamicSourceFields("listings://", mismatched).dataSource, "listings");
});

test("non-pseudo file keys (including URL-ish paths) are not dynamic", () => {
  for (const fileKey of ["src/app.ts", "listings://l-1", "listings:/", "1bad://", ""]) {
    assert.equal(deriveDynamicSourceFields(fileKey, { sourceText: "x" }).isDynamic, false, fileKey);
  }
});

test("enum entries derive the grid field from their pseudo-file locations", () => {
  const entry = {
    sourceText: "Detached house",
    dynamic: {
      source: "listings",
      lastSeenAt: "2026-10-15T00:00:00.000Z",
      enum: true,
      retention: "git",
      locations: ["listings://l-1#propertyType", "listings://l-9#propertyType"],
    },
  };
  const derived = deriveDynamicSourceFields("listings://", entry);
  assert.equal(derived.dynamicEnum, true);
  assert.equal(derived.enumField, "propertyType");
  assert.equal(derived.reach, 2);
});

// ---- sync interop pin ------------------------------------------------------------

test("interop pin: a pre-08 state without dynamic metadata still derives safe defaults", () => {
  // Old CLI pushing a dynamic file group without spec 02/06 metadata: no
  // throw, server-side defaults — additive evolution, contract stays v1.
  assert.deepEqual(deriveDynamicSourceFields("listings://", { sourceText: "Hello" }), {
    isDynamic: true,
    dataSource: "listings",
    reach: 0,
    dynamicEnum: false,
    enumField: null,
    maskNames: null,
  });
  // And plain UI entries (the pre-dynamic world) derive the column defaults
  // the migration declares.
  assert.deepEqual(deriveDynamicSourceFields("src/App.tsx", { sourceText: "Hello" }), {
    isDynamic: false,
    dataSource: null,
    reach: null,
    dynamicEnum: false,
    enumField: null,
    maskNames: null,
  });
});

// ---- reach upsert ----------------------------------------------------------------

test("reach upserts on every push, guarded so an unchanged re-push is a row no-op", async () => {
  const statements = [];
  const queryFn = async (sql, params) => {
    statements.push({ sql, params });
    return { rowCount: 1 };
  };
  const fields = deriveDynamicSourceFields("listings://", {
    sourceText: "x",
    dynamic: { source: "listings", lastSeenAt: "t", retention: "git", locations: ["listings://l-1#remark"], locationOverflow: 41 },
  });
  const changed = await upsertDynamicSourceFields(queryFn, { sourceId: "s-1", fields });
  assert.equal(changed, true);
  const { sql, params } = statements[0];
  // Separate from the metered text upsert, guarded by is-distinct-from.
  assert.match(sql, /update source_strings/);
  assert.match(sql, /is distinct from/);
  assert.deepEqual(params, ["s-1", true, "listings", 42, false, null, null]);

  // Re-push with identical fields: the guard makes it rowCount 0 (no churn).
  const noop = await upsertDynamicSourceFields(async () => ({ rowCount: 0 }), { sourceId: "s-1", fields });
  assert.equal(noop, false);
});

// ---- facets ----------------------------------------------------------------------

test("the default view is UI strings only — dynamic rows are excluded", () => {
  for (const raw of [undefined, null, "", "  ", "ui"]) {
    assert.deepEqual(normalizeSourceFacet(raw), { kind: "ui" });
  }
  assert.deepEqual(facetCondition(undefined, 5), { clause: "and s.is_dynamic = false", params: [] });
});

test("facet filtering: all is unfiltered, a data source scopes to its non-enum rows", () => {
  assert.deepEqual(facetCondition("all", 5), { clause: "", params: [] });
  assert.deepEqual(facetCondition("listings", 5), {
    clause: "and s.is_dynamic = true and s.data_source = $5 and s.dynamic_enum = false",
    params: ["listings"],
  });
  assert.equal(isDataSourceFacet("listings"), true);
  assert.equal(isDataSourceFacet("ui"), false);
  assert.equal(isDataSourceFacet("all"), false);
  // Normalized objects pass through unchanged (route normalizes once).
  assert.equal(isDataSourceFacet({ kind: "source", name: "listings" }), true);
  assert.deepEqual(facetCondition({ kind: "all" }, 5), { clause: "", params: [] });
});

test("the source: prefix keeps sources literally named ui/all reachable", () => {
  // The CLI's source-name grammar allows "ui" and "all" — the prefixed form
  // must address them as data sources, never collapse into the reserved
  // facets (a double-normalization here would silently flip the view).
  assert.deepEqual(normalizeSourceFacet("source:ui"), { kind: "source", name: "ui" });
  assert.deepEqual(normalizeSourceFacet("source:all"), { kind: "source", name: "all" });
  assert.deepEqual(facetCondition("source:ui", 5), {
    clause: "and s.is_dynamic = true and s.data_source = $5 and s.dynamic_enum = false",
    params: ["ui"],
  });
  assert.deepEqual(facetCondition(normalizeSourceFacet("source:all"), 5).params, ["all"]);
  assert.equal(isDataSourceFacet("source:ui"), true);
});

test("crafted query values fall back to the safe default facet", () => {
  // Express can parse ?facet[kind]=… into objects and repeated params into
  // arrays — anything that is not a full, sane facet shape must become "ui",
  // never a half-formed source filter (undefined SQL param) or a bypass.
  for (const raw of [
    ["all", "listings"],
    { kind: "source" },
    { kind: "source", name: 42 },
    { kind: "nope" },
    7,
  ]) {
    assert.deepEqual(normalizeSourceFacet(raw), { kind: "ui" }, JSON.stringify(raw));
  }
  assert.deepEqual(normalizeSourceFacet({ kind: "source", name: "listings" }), { kind: "source", name: "listings" });
});

test("a hash shared by a UI file and a dynamic group stays a UI row", () => {
  // Entry keys are content hashes, so an enum value that is also a UI label
  // ("House") lands on ONE console row — it must keep showing in the default
  // queue regardless of file iteration order.
  const uiEntry = { sourceText: "House" };
  const dynamicEntry = {
    sourceText: "House",
    dynamic: { source: "listings", lastSeenAt: "t", enum: true, retention: "git", locations: ["listings://l-1#propertyType"] },
  };
  for (const files of [
    { "src/App.tsx": { entries: { h1: uiEntry } }, "listings://": { entries: { h1: dynamicEntry } } },
    { "listings://": { entries: { h1: dynamicEntry } }, "src/App.tsx": { entries: { h1: uiEntry } } },
  ]) {
    const derived = deriveStateDynamicFields(files);
    assert.equal(derived.get("h1").isDynamic, false);
  }
  // A hash that only lives in dynamic groups keeps its dynamic derivation.
  const onlyDynamic = deriveStateDynamicFields({ "listings://": { entries: { h2: dynamicEntry } } });
  assert.equal(onlyDynamic.get("h2").isDynamic, true);
  assert.equal(onlyDynamic.get("h2").dataSource, "listings");
});

// ---- enum grid -------------------------------------------------------------------

test("enum grid groups one source×locale table per field, reach-sorted", () => {
  const rows = [
    { sourceId: "a", sourceHash: "ha", sourceText: "Apartment", enumField: "propertyType", reach: 10, locale: "fr-FR", text: "Appartement", humanStatus: "pending" },
    { sourceId: "a", sourceHash: "ha", sourceText: "Apartment", enumField: "propertyType", reach: 10, locale: "de-DE", text: "Wohnung", humanStatus: "verified" },
    { sourceId: "b", sourceHash: "hb", sourceText: "Detached house", enumField: "propertyType", reach: 30, locale: "fr-FR", text: "Maison individuelle", humanStatus: "pending" },
    // Untranslated enum value: locale columns null, still a grid row.
    { sourceId: "c", sourceHash: "hc", sourceText: "Houseboat", enumField: "propertyType", reach: 1, locale: null, text: null, humanStatus: null },
    { sourceId: "d", sourceHash: "hd", sourceText: "North", enumField: "aspect", reach: 5, locale: "fr-FR", text: "Nord", humanStatus: "pending" },
  ];
  const grid = buildEnumGrid(rows);
  assert.deepEqual(grid.map((group) => group.field), ["aspect", "propertyType"]);
  const propertyType = grid[1];
  assert.deepEqual(propertyType.locales, ["de-DE", "fr-FR"]);
  // Reach descending: the 30-listing value before the one-off.
  assert.deepEqual(propertyType.entries.map((entry) => entry.sourceId), ["b", "a", "c"]);
  assert.deepEqual(propertyType.entries[1].translations["de-DE"], { text: "Wohnung", humanStatus: "verified" });
  assert.deepEqual(propertyType.entries[2].translations, {});
});

test("bulk verify writes correct per-row statuses, project-scoped, no invented rows", async () => {
  const statements = [];
  const queryFn = async (sql, params) => {
    statements.push({ sql, params });
    // The (b × de-DE) row does not exist — must be reported, never created.
    return { rowCount: params[0] === "b" && params[1] === "de-DE" ? 0 : 1 };
  };
  const outcome = await bulkVerifyTranslations(queryFn, {
    projectId: "p-1",
    items: [
      { sourceId: "a", locale: "fr-FR" },
      { sourceId: "b", locale: "de-DE" },
      { sourceId: "b", locale: "fr-FR" },
    ],
  });
  assert.deepEqual(outcome, { verified: 2, missing: [{ sourceId: "b", locale: "de-DE" }] });
  assert.equal(statements.length, 3);
  for (const { sql, params } of statements) {
    // Same lifecycle as the single approve route: verified + cleared note,
    // text/source provenance untouched, scoped to the authorized project.
    assert.match(sql, /set human_status = 'verified', review_note = null, updated_at = now\(\)/);
    assert.doesNotMatch(sql, /set[^;]*\btext\s*=/);
    assert.doesNotMatch(sql, /set[^;]*source\s*=\s*'/);
    assert.match(sql, /s\.project_id = \$3/);
    assert.equal(params[2], "p-1");
  }
  assert.deepEqual(statements.map(({ params }) => [params[0], params[1]]), [
    ["a", "fr-FR"],
    ["b", "de-DE"],
    ["b", "fr-FR"],
  ]);
});

test("bulk verify validates its items up front", async () => {
  const queryFn = () => {
    throw new Error("query should not run");
  };
  for (const items of [undefined, [], [{ sourceId: "a" }], [{ locale: "fr-FR" }], [{ sourceId: " ", locale: "fr-FR" }]]) {
    await assert.rejects(
      bulkVerifyTranslations(queryFn, { projectId: "p-1", items }),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.code, /^bulk_verify_/);
        return true;
      },
      JSON.stringify(items ?? null),
    );
  }
});

// ---- chips -----------------------------------------------------------------------

test("chip tokens round-trip byte-exact, annotated with spec 06 mask names", () => {
  const text = "Stunning {0} apartment — only {1} from {2}! {notachip} {10}";
  const maskNames = ["currency", "distance", "landmark"];
  const tokens = tokenizeChips(text, maskNames);
  assert.equal(serializeChips(tokens), text);
  const chips = tokens.filter((token) => token.type === "chip");
  assert.deepEqual(chips.map((chip) => [chip.value, chip.index, chip.mask]), [
    ["{0}", 0, "currency"],
    ["{1}", 1, "distance"],
    ["{2}", 2, "landmark"],
    ["{10}", 10, null],
  ]);
  // {notachip} is plain text, not a chip (masked placeholders are numeric).
  assert.ok(tokens.some((token) => token.type === "text" && token.value.includes("{notachip}")));
});

test("editing around chips preserves every chip token byte-exact", () => {
  const source = "Only {0} — {1} away";
  const tokens = tokenizeChips(source, ["currency", "distance"]);
  // Simulate an edit that rewrites every TEXT run but treats chips as atomic.
  const edited = serializeChips(
    tokens.map((token) => (token.type === "chip" ? token : { ...token, value: token.value.toUpperCase() })),
  );
  assert.equal(edited, "ONLY {0} — {1} AWAY");
  const editedChips = tokenizeChips(edited).filter((token) => token.type === "chip");
  assert.deepEqual(editedChips.map((chip) => chip.value), ["{0}", "{1}"]);
});

test("chip mismatch flags missing and extra chips before any validator runs", () => {
  assert.deepEqual(chipMismatch("{0} near {1}", "{1} près de {0}"), { missing: [], extra: [], ok: true });
  assert.deepEqual(chipMismatch("{0} near {1}", "près de {0}"), { missing: ["{1}"], extra: [], ok: false });
  assert.deepEqual(chipMismatch("{0}", "{0} et {2}"), { missing: [], extra: ["{2}"], ok: false });
  // Duplicates count: a translation dropping one of two {0}s is a mismatch.
  assert.deepEqual(chipMismatch("{0} and {0}", "{0}"), { missing: ["{0}"], extra: [], ok: false });
});
