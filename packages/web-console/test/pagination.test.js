import test from "node:test";
import assert from "node:assert/strict";
import { pageRows } from "../src/pagination.js";
import { CONSOLE_ACTIONS, validateActionInput } from "@hedgeling/api-contract";
const auth = { principalType: "user", user: { id: "alice" } };
test("cursors bind principal and query, traverse ties by unique identity, and survive deletion of their anchor", (t) => {
  const rows = Array.from({ length: 125 }, (_, i) => ({ id: String(i).padStart(4, "0"), name: "Same name" }));
  const first = pageRows(rows, { limit: 100, search: "same" }, auth, "projects");
  assert.equal(first.items.length, 100); assert.equal(first.page.total, 125); assert.equal(first.page.hasMore, true);
  const next = { limit: 100, search: "same", cursor: first.page.nextCursor };
  const second = pageRows(rows.filter((r) => r.id !== "0099"), next, auth, "projects");
  assert.equal(second.items.length, 25); assert.equal(second.page.hasMore, false); assert.equal(second.page.nextCursor, null);
  for (const [input, principal, action] of [[{ ...next, search: "different" }, auth, "projects"], [next, { user: { id: "bob" } }, "projects"], [next, auth, "jobs"], [{ ...next, cursor: next.cursor + "tamper" }, auth, "projects"]]) {
    assert.throws(() => pageRows(rows, input, principal, action), (error) => error.code === "invalid_cursor");
  }
  t.mock.method(Date, "now", () => 9999999999999);
  assert.throws(() => pageRows(rows, next, auth, "projects"), (error) => error.code === "invalid_cursor");
});
test("read schemas bound pages and reject arbitrary report dimensions and SQL", () => {
  const action = (name) => CONSOLE_ACTIONS.find((a) => a.name === name);
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal(validateActionInput(action("reports.jobs.summary"), { organizationId: id, groupBy: "target_locale", limit: 100 }), null);
  for (const input of [{ organizationId: id, limit: 101 }, { organizationId: id, groupBy: "source_snapshot" }, { organizationId: id, sql: "select * from users" }]) assert.ok(validateActionInput(action("reports.jobs.summary"), input));
  assert.ok(validateActionInput(action("localization_jobs.list"), {}));
  assert.equal(validateActionInput(action("localization_jobs.list"), { organizationId: id, targetLocale: "fr" }), null);
});
