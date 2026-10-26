import assert from "node:assert/strict";
import test from "node:test";
import {
  geminiTokenMeasurements,
  measureText,
  mergeMeasurements,
  USAGE_COUNTING_VERSION,
  usageIdentity,
} from "../src/usage.js";

test("measureText counts locale-aware words and Unicode code points", () => {
  assert.deepEqual(measureText("Hello, brave world! 👩🏽‍💻", "en-US"), {
    words: 3,
    characters: 24,
    countingVersion: USAGE_COUNTING_VERSION,
  });
  assert.match(
    USAGE_COUNTING_VERSION,
    /^intl-word-unicode-codepoint-v1-node\d+-icu[\w.-]+$/,
  );
  assert.equal(measureText("你好世界", "zh-CN").words, 2);
});

test("Gemini usage metadata maps to normalized LLM token metrics", () => {
  assert.deepEqual(geminiTokenMeasurements({
    promptTokenCount: 120,
    candidatesTokenCount: 30,
    cachedContentTokenCount: 40,
    thoughtsTokenCount: 8,
    totalTokenCount: 158,
  }), {
    llm_input_tokens: 120,
    llm_output_tokens: 30,
    llm_cached_input_tokens: 40,
    llm_reasoning_tokens: 8,
    llm_total_tokens: 158,
  });
});

test("measurement merging preserves exact integer totals", () => {
  assert.deepEqual(
    mergeMeasurements(
      { llm_input_tokens: 10, llm_output_tokens: 4 },
      { llm_input_tokens: 12, llm_output_tokens: 5 },
    ),
    { llm_input_tokens: 22, llm_output_tokens: 9 },
  );
  assert.throws(
    () => mergeMeasurements({ llm_input_tokens: 1.5 }),
    /safe integer/,
  );
});

test("usage identities namespace keys and fingerprint request content", () => {
  const req = {
    get(name) {
      return name.toLowerCase() === "idempotency-key" ? "request-123" : "";
    },
  };
  const first = usageIdentity(req, "state_import", { value: 1 });
  const repeated = usageIdentity(req, "state_import", { value: 1 });
  const changed = usageIdentity(req, "state_import", { value: 2 });
  assert.equal(first.idempotencyKey, "state_import:request-123");
  assert.equal(first.idempotencyFingerprint, repeated.idempotencyFingerprint);
  assert.notEqual(first.idempotencyFingerprint, changed.idempotencyFingerprint);
});
