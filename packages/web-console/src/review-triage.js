// dynamic-data spec 08: console review triage at dynamic volume. The first
// full sync-data run pushes thousands of listing-remark templates into the
// console; review for dynamic content is TRIAGE — spend human minutes where
// the reach is. This module holds the pure logic:
//
// - Derivation: is_dynamic + data_source come from the pseudo-file scheme
//   (`<sourceName>://`) of the state document's file key at push/import time —
//   DERIVED, never client-supplied. `reach` is the entry's bounded location
//   count + locationOverflow (spec 02) and updates on every push (repo-owned
//   truth under the sync field-ownership law). `dynamic_enum`/`enum_field`
//   flag enum-tier entries for the grid view; `mask_names` carries spec 06's
//   per-placeholder mask names for chip rendering.
// - Facets: the review queue gains `All | UI strings | <each data source>`;
//   the DEFAULT is UI strings only — dynamic volume must never bury the
//   strings a human MUST review.
// - Enum grid: entries flagged dynamic_enum render as one compact
//   source×locale grid per field with bulk verify (same humanStatus lifecycle
//   as single approve — triage changes what a reviewer SEES, never what
//   verification MEANS).
// - Chips: masked templates render placeholders as typed chips ({0:currency}),
//   with mismatch detection; chips are atomic tokens that round-trip
//   byte-exact through an edit.
//
// Pure over injected query functions so route tests run without a database
// (web-console test conventions — see repo-sync.test.js).

// Mirrors the CLI's DYNAMIC_FILE_KEY_RE (packages/i18n dynamicState.ts): a
// dynamic file group's key is the source's pseudo-file scheme root.
const DYNAMIC_FILE_KEY_RE = /^([a-z][a-z0-9-]*):\/\/$/i;

function badRequest(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

function enumFieldOf(locations) {
  // Pseudo-file locations are `<name>://<id>#<field>` — the enum's vocabulary
  // shares one field name, so the first location's fragment identifies it.
  for (const location of locations) {
    const hash = typeof location === "string" ? location.indexOf("#") : -1;
    if (hash >= 0 && hash < location.length - 1) return location.slice(hash + 1);
  }
  return null;
}

/**
 * Derive the review-triage columns for one imported entry. `fileKey` is the
 * key of the state document's `files` map; only the pseudo-file scheme makes
 * a row dynamic — any client-supplied isDynamic/dataSource-style fields on
 * the entry itself are ignored. Entries pushed by a pre-08 CLI (no `dynamic`
 * metadata) derive safe defaults — additive evolution, sync contract stays
 * version 1.
 */
export function deriveDynamicSourceFields(fileKey, entry) {
  const match = DYNAMIC_FILE_KEY_RE.exec(typeof fileKey === "string" ? fileKey : "");
  if (!match) {
    return { isDynamic: false, dataSource: null, reach: null, dynamicEnum: false, enumField: null, maskNames: null };
  }
  const dynamic = entry?.dynamic && typeof entry.dynamic === "object" ? entry.dynamic : {};
  const locations = Array.isArray(dynamic.locations)
    ? dynamic.locations.filter((location) => typeof location === "string")
    : [];
  const overflow = Number.isSafeInteger(dynamic.locationOverflow) && dynamic.locationOverflow > 0
    ? dynamic.locationOverflow
    : 0;
  const maskNames = Array.isArray(dynamic.maskNames)
    ? dynamic.maskNames.filter((name) => typeof name === "string")
    : [];
  return {
    isDynamic: true,
    // The data source name comes from the FILE KEY, not entry metadata.
    dataSource: match[1],
    reach: locations.length + overflow,
    dynamicEnum: dynamic.enum === true,
    enumField: dynamic.enum === true ? enumFieldOf(locations) : null,
    maskNames: maskNames.length > 0 ? maskNames : null,
  };
}

/**
 * Derive the triage columns once per source hash across the WHOLE state
 * document. Entry keys are content hashes, so the same hash can appear in a
 * real file AND a dynamic group (an enum value that is also a UI label, e.g.
 * "House"); console rows are keyed (project, source_hash), so one derivation
 * must win. Non-dynamic wins: the default queue must never lose a string a
 * human MUST review because a data source happens to serve the same text.
 * Among multiple dynamic groups sharing a hash, the first file key in
 * document order wins (deterministic within and across pushes).
 */
export function deriveStateDynamicFields(files) {
  const byHash = new Map();
  for (const [fileKey, file] of Object.entries(files || {})) {
    for (const [sourceHash, entry] of Object.entries(file?.entries || {})) {
      const derived = deriveDynamicSourceFields(fileKey, entry);
      const existing = byHash.get(sourceHash);
      if (!existing || (existing.isDynamic && !derived.isDynamic)) byHash.set(sourceHash, derived);
    }
  }
  return byHash;
}

/**
 * Upsert the derived columns for an already-imported source row. Separate
 * from the text-field upsert on purpose: reach must refresh on EVERY push,
 * but a reach-only change must not look like a source-text change to the
 * import metering. The `is distinct from` guard keeps an unchanged re-push a
 * row-level no-op.
 */
export async function upsertDynamicSourceFields(queryFn, { sourceId, fields }) {
  const result = await queryFn(
    `update source_strings
     set is_dynamic = $2,
         data_source = $3,
         reach = $4,
         dynamic_enum = $5,
         enum_field = $6,
         mask_names = $7::text[]
     where id = $1
       and (is_dynamic, data_source, reach, dynamic_enum, enum_field, mask_names)
         is distinct from ($2::boolean, $3::text, $4::integer, $5::boolean, $6::text, $7::text[])`,
    [
      sourceId,
      fields.isDynamic,
      fields.dataSource,
      fields.reach,
      fields.dynamicEnum,
      fields.enumField,
      fields.maskNames,
    ],
  );
  return (result?.rowCount ?? 0) > 0;
}

/**
 * Normalize the review queue's source facet into a structured value:
 * `{ kind: "ui" }` | `{ kind: "all" }` | `{ kind: "source", name }`. The
 * DEFAULT is "ui" — the strings a human MUST review (the legal/policy set)
 * are never buried under dynamic volume. A data source is addressed as
 * `source:<name>` (the CLI's source-name grammar permits sources literally
 * named "ui" or "all", so the prefix keeps every source reachable); a bare
 * unrecognized value is accepted as a source name for convenience.
 */
export function normalizeSourceFacet(raw) {
  // Already-normalized objects pass through (the route normalizes once); a
  // crafted query object (Express parses ?facet[kind]=… into one) that does
  // not fully match the shape falls back to the safe default.
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (raw.kind === "ui" || raw.kind === "all") return { kind: raw.kind };
    if (raw.kind === "source" && typeof raw.name === "string") return { kind: "source", name: raw.name };
    return { kind: "ui" };
  }
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value === "ui") return { kind: "ui" };
  if (value === "all") return { kind: "all" };
  const name = value.startsWith("source:") ? value.slice("source:".length) : value;
  return { kind: "source", name };
}

/**
 * The facet's SQL condition over the `s` (source_strings) alias.
 * `nextParamIndex` is the 1-based position the first appended parameter will
 * take. Enum-tier rows are excluded from a data source's QUEUE — they render
 * in the grid view instead (a 30-value enum is one review sitting, not 30
 * queue items).
 */
export function facetCondition(facet, nextParamIndex) {
  const normalized = normalizeSourceFacet(facet);
  if (normalized.kind === "ui") return { clause: "and s.is_dynamic = false", params: [] };
  if (normalized.kind === "all") return { clause: "", params: [] };
  return {
    clause: `and s.is_dynamic = true and s.data_source = $${nextParamIndex} and s.dynamic_enum = false`,
    params: [normalized.name],
  };
}

/** True when the facet is a specific data source (reach-sorted dynamic queue). */
export function isDataSourceFacet(facet) {
  return normalizeSourceFacet(facet).kind === "source";
}

// ---- spec 06 chips: typed placeholder tokens -----------------------------------

const CHIP_RE = /\{(\d+)\}/g;

/**
 * Split a masked template into atomic tokens: plain text runs and `{N}` chips
 * (annotated with the spec 06 mask name when known). serializeChips of the
 * result is byte-exact the input — chips are opaque tokens, never rewritten.
 */
export function tokenizeChips(text, maskNames = []) {
  const value = String(text ?? "");
  const tokens = [];
  let last = 0;
  for (const match of value.matchAll(CHIP_RE)) {
    if (match.index > last) tokens.push({ type: "text", value: value.slice(last, match.index) });
    const index = Number(match[1]);
    tokens.push({ type: "chip", value: match[0], index, mask: maskNames[index] ?? null });
    last = match.index + match[0].length;
  }
  if (last < value.length) tokens.push({ type: "text", value: value.slice(last) });
  return tokens;
}

export function serializeChips(tokens) {
  return tokens.map((token) => token.value).join("");
}

/**
 * Chip mismatch between a source template and a translation: chips the
 * translation is missing (visually obvious before the validator even runs)
 * and chips it added that the source never had.
 */
export function chipMismatch(sourceText, translationText) {
  const counts = (text) => {
    const map = new Map();
    for (const token of tokenizeChips(text)) {
      if (token.type === "chip") map.set(token.value, (map.get(token.value) ?? 0) + 1);
    }
    return map;
  };
  const expected = counts(sourceText);
  const actual = counts(translationText);
  const missing = [...expected.keys()].filter((chip) => (actual.get(chip) ?? 0) < expected.get(chip)).sort();
  const extra = [...actual.keys()].filter((chip) => (expected.get(chip) ?? 0) < actual.get(chip)).sort();
  return { missing, extra, ok: missing.length === 0 && extra.length === 0 };
}

// ---- enum grid -----------------------------------------------------------------

/**
 * Group the flat enum-row query result (one row per source × locale, locale
 * columns null for untranslated sources) into one grid per enum field: the
 * whole vocabulary on one screen. Rows sort by reach descending within a
 * field (same triage law as the queue), fields alphabetically.
 */
export function buildEnumGrid(rows) {
  const fields = new Map();
  for (const row of rows) {
    const field = row.enumField || "(field unknown)";
    let group = fields.get(field);
    if (!group) {
      group = { field, locales: new Set(), entries: new Map() };
      fields.set(field, group);
    }
    let entry = group.entries.get(row.sourceId);
    if (!entry) {
      entry = {
        sourceId: row.sourceId,
        sourceHash: row.sourceHash,
        sourceText: row.sourceText,
        reach: row.reach ?? 0,
        translations: {},
      };
      group.entries.set(row.sourceId, entry);
    }
    if (row.locale) {
      group.locales.add(row.locale);
      entry.translations[row.locale] = { text: row.text, humanStatus: row.humanStatus };
    }
  }
  return [...fields.values()]
    .sort((a, b) => a.field.localeCompare(b.field))
    .map((group) => ({
      field: group.field,
      locales: [...group.locales].sort(),
      entries: [...group.entries.values()].sort(
        (a, b) => b.reach - a.reach || a.sourceText.localeCompare(b.sourceText),
      ),
    }));
}

/**
 * Bulk verify for the enum grid: the SAME humanStatus lifecycle as the
 * single-row approve route (verified + cleared review note, provenance kept so
 * "verified mt" stays distinguishable), written per row and scoped to the
 * authorized project. Rows that do not exist are reported, never invented —
 * no fabricated "reviewed" signals.
 */
export async function bulkVerifyTranslations(queryFn, { projectId, items }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw badRequest("bulk_verify_items_required", "bulk verify expects { items: [{ sourceId, locale }, …] }");
  }
  let verified = 0;
  const missing = [];
  for (const item of items) {
    const sourceId = typeof item?.sourceId === "string" ? item.sourceId.trim() : "";
    const locale = typeof item?.locale === "string" ? item.locale.trim() : "";
    if (!sourceId || !locale) {
      throw badRequest("bulk_verify_item_invalid", "every bulk-verify item needs a sourceId and a locale");
    }
    const result = await queryFn(
      `update translations t
       set human_status = 'verified', review_note = null, updated_at = now()
       from source_strings s
       where s.id = t.source_string_id
         and t.source_string_id = $1
         and t.locale = $2
         and s.project_id = $3`,
      [sourceId, locale, projectId],
    );
    if ((result?.rowCount ?? 0) > 0) verified += result.rowCount;
    else missing.push({ sourceId, locale });
  }
  return { verified, missing };
}
