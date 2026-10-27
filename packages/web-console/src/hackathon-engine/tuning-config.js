// SPDX-License-Identifier: Apache-2.0
// Public data contract; the tuning implementation remains in the private engine.
export const TUNING_FIELDS = Object.freeze(['excludePatterns', 'excludeCallees', 'excludeFields', 'denyProps', 'ignoredGlobs', 'fixtureGlobs', 'identifierAllowlist', 'keyShapes']);
export function tuningSettings(raw, { strict = true } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Extraction settings must be a JSON object.');
  const settings = {}, ignoredFields = [];
  for (const key of Object.keys(raw)) {
    if (!TUNING_FIELDS.includes(key)) { if (strict) throw new Error('Unsupported extraction setting.'); ignoredFields.push(key); continue; }
    const values = raw[key];
    if (!Array.isArray(values) || values.length > 100 || values.some(v => typeof v !== 'string' || !v || v.length > 256 || /[\x00-\x1f\x7f]/.test(v))) throw new Error('Each extraction setting accepts up to 100 nonempty strings of at most 256 characters.');
    settings[key] = [...new Set(values)];
  }
  if (JSON.stringify(settings).length > 8192) throw new Error('Extraction settings exceed 8 KiB.');
  return { settings, ignoredFields };
}
export function tuningConfigPath(value) {
  return typeof value === 'string' && value.length <= 512 && !/[\\\x00-\x20\x7f:*?\[\]{}]/.test(value)
    && value.split('/').every(p => p && p !== '.' && p !== '..')
    && (value === '.hedgeling/extract.config.json' || value.endsWith('/.hedgeling/extract.config.json'));
}
