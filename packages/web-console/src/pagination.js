import crypto from "node:crypto";
import { fail } from "./action-errors.js";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
const configuredKey = process.env.HEDGELING_CURSOR_SECRET;
if (configuredKey && Buffer.byteLength(configuredKey) < 32) throw new Error("HEDGELING_CURSOR_SECRET must contain at least 32 bytes");
// Set a shared server-side secret for multiple instances. A process-local key
// otherwise deliberately invalidates continuations on restart.
const key = configuredKey || crypto.randomBytes(32);
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((name) => [name, canonical(value[name])])) : value;
const signature = (data) => crypto.createHmac("sha256", key).update(data).digest("base64url");
export function cursorBinding(auth, action, input) {
  const { cursor, projectCursor, businessUnitCursor, ...filters } = input;
  return crypto.createHash("sha256").update(JSON.stringify(canonical({
    principal: [auth.principalType || "user", auth.user?.id || auth.serviceAccount?.id || auth.principalId || null, auth.identityConnectionId || null], action, filters,
  }))).digest("hex");
}
export function readCursor(token, binding) {
  if (!token) return null;
  const invalid = () => fail(400, "This page cursor is invalid, expired, or belongs to a different query. Start from the first page.", "invalid_cursor");
  if (typeof token !== "string" || token.length > 4096) throw invalid();
  const [payload, mac, extra] = token.split(".");
  if (!payload || !mac || extra) throw invalid();
  const actual = Buffer.from(mac), expected = Buffer.from(signature(payload));
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw invalid();
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (data.v !== 1 || data.binding !== binding || !Number.isFinite(data.expires) || data.expires <= Date.now() || !Object.hasOwn(data, "after")) throw invalid();
    return data;
  } catch { throw invalid(); }
}
export function nextCursor(binding, after, previous = null) {
  const payload = Buffer.from(JSON.stringify({ v: 1, binding, after, expires: previous?.expires || Date.now() + 60 * 60 * 1000 })).toString("base64url");
  return `${payload}.${signature(payload)}`;
}
export function pageSize(input) {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw fail(400, "Page size must be between 1 and 100", "action_input_invalid");
  return limit;
}
export function pageRows(rows, input, auth, action, keyOf = (row) => row.id || row.slug) {
  const limit = pageSize(input), binding = cursorBinding(auth, action, input), previous = readCursor(input.cursor, binding);
  if (previous && typeof previous.after !== "string") throw fail(400, "Invalid page cursor", "invalid_cursor");
  const ordered = [...rows].sort((a, b) => keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);
  const remaining = previous ? ordered.filter((row) => keyOf(row) > previous.after) : ordered;
  const items = remaining.slice(0, limit), hasMore = remaining.length > limit;
  return { items, page: { limit, returned: items.length, total: rows.length, hasMore,
    nextCursor: hasMore ? nextCursor(binding, keyOf(items.at(-1)), previous) : null } };
}
