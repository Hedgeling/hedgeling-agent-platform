// SPDX-License-Identifier: Apache-2.0
import { AgentError } from './errors.js';
const invalid = () => { throw new AgentError(422, 'The extracted catalog is unsupported or exceeds the import limits.', 'catalog_invalid'); };
export function sourcePaths(values, allowed) {
  if (!Array.isArray(values) || !values.length || values.length > 20) invalid();
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 512 || /[\\:*?\[\]{}\x00-\x1f\x7f]/.test(value)
      || value.split('/').some(segment => !segment || segment === '.' || segment === '..')
      || !allowed.some(root => value === root || value.startsWith(root + '/'))) throw new AgentError(400, 'Choose source paths inside this project’s connected roots.', 'source_path_denied');
  }
  return [...new Set(values)].sort();
}
function text(value, limit = 8192) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > limit) invalid();
  return value;
}
export function catalogState(artifact, expected) {
  const catalog = artifact?.catalog;
  // Catalog v2 adds optional select metadata; its source/context fields retain
  // the v1 shape. Only explicitly supported versions cross the import boundary.
  if (artifact?.version !== 1 || ![1, 2].includes(catalog?.schemaVersion) || !Array.isArray(catalog.entries)
    || catalog.entries.length > 10000 || catalog.sourceLocale !== expected.sourceLocale
    || artifact.provenance?.commitSha !== expected.commitSha || artifact.provenance?.repositoryId !== expected.repositoryId
    || artifact.provenance?.operation !== 'extract') invalid();
  const entries = Object.create(null);
  for (const item of catalog.entries) {
    if (!item || typeof item.key !== 'string' || !item.key || item.key.length > 256 || Object.hasOwn(entries, item.key)
      || ['__proto__', 'constructor', 'prototype'].includes(item.key) || typeof item.source !== 'string' || !item.source || item.source.length > 65536) invalid();
    const contexts = item.contexts ?? [];
    if (!Array.isArray(contexts) || contexts.length > 100) invalid();
    const variants = [];
    for (const context of contexts) {
      if (!context || typeof context !== 'object') invalid();
      const locations = context.locations ?? [];
      if (!Array.isArray(locations) || locations.length > 1000) invalid();
      for (const location of locations.length ? locations : [{}]) {
        const file = text(location.file, 512);
        const snippet = location.snippet;
        if (snippet && (typeof snippet !== 'object' || typeof snippet.text !== 'string' || Buffer.byteLength(snippet.text) > 2048
          || !Number.isSafeInteger(snippet.startLine) || snippet.startLine < 1 || !Number.isSafeInteger(snippet.endLine)
          || snippet.endLine < snippet.startLine || snippet.endLine - snippet.startLine > 6)) invalid();
        variants.push({ shape: text(context.shape), purpose: text(context.purpose), visualContext: text(context.visualContext), file,
          codeContext: snippet ? snippet.text : file ? file + (Number.isSafeInteger(location.line) ? ':' + location.line : '') : null,
          ...(snippet ? { codeEvidence: { text: snippet.text, startLine: snippet.startLine, endLine: snippet.endLine, commitSha: expected.commitSha } } : {}),
          uiContext: text(context.purpose), appStateContext: null });
      }
      if (variants.length > 1000) invalid();
    }
    const first = contexts[0] || {};
    entries[item.key] = { sourceText: item.source, shape: text(first.shape), purpose: text(first.purpose), visualContext: text(first.visualContext),
      limit: null, contextVariants: variants, analysis: {}, translations: {} };
  }
  return { schemaVersion: 2, sourceLocale: expected.sourceLocale, locales: [], files: { 'extracted-source': { entries } } };
}
export function catalogSummary(state, existing) {
  const rows = new Map(existing.map(row => [row.source_hash, row]));
  const counts = { total: 0, added: 0, updated: 0, unchanged: 0 };
  for (const [key, entry] of Object.entries(state.files['extracted-source'].entries)) {
    counts.total++;
    const old = rows.get(key);
    if (!old) counts.added++;
    else if (old.source_text !== entry.sourceText || old.shape !== entry.shape || old.purpose !== entry.purpose
      || old.visual_context !== entry.visualContext || old.limit_chars != null) counts.updated++;
    else counts.unchanged++;
  }
  return counts;
}
