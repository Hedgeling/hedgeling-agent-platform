import assert from "node:assert/strict";
import test from "node:test";
import { optionalTimestamp } from "../src/validation.js";

test("optionalTimestamp accepts empty or future ISO timestamps", () => {
  assert.equal(optionalTimestamp(null), null);
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(optionalTimestamp(future), future);
});

test("optionalTimestamp rejects invalid and non-future timestamps", () => {
  assert.throws(() => optionalTimestamp("not-a-date"), /ISO-8601/);
  assert.throws(() => optionalTimestamp(new Date(Date.now() - 60_000).toISOString()), /future/);
});
