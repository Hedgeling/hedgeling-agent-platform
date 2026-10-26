import assert from "node:assert/strict";
import test from "node:test";
import {
  aiCreditLimitForPlan,
  aiCreditOverageAmountMinor,
  calculateAiCredits,
  conservativeTokenUpperBound,
  estimateAiCreditReservation,
  geminiBillableTokenUsage,
  geminiModelForPlan,
} from "../src/ai-credits.js";

const managedGeminiRate = {
  inputCreditsPerMillion: 4000,
  outputCreditsPerMillion: 32000,
  cachedInputCreditsPerMillion: 4000,
  reasoningCreditsPerMillion: 32000,
  fixedCredits: 0,
};

test("AI credits are deterministic and round each cost component up", () => {
  assert.deepEqual(
    calculateAiCredits(managedGeminiRate, {
      inputTokens: 1000,
      cachedInputTokens: 250,
      outputTokens: 100,
      reasoningTokens: 50,
    }),
    {
      quantity: 10,
      components: {
        input: "3",
        cachedInput: "1",
        output: "4",
        reasoning: "2",
        fixed: "0",
      },
    },
  );
});

test("credit reservations conservatively cover prompt bytes and maximum output", () => {
  const systemPrompt = "Translate carefully";
  const userPrompt = "Bonjour 👋";
  const expectedInput = Buffer.byteLength(systemPrompt + userPrompt, "utf8");
  assert.equal(
    conservativeTokenUpperBound(systemPrompt, userPrompt),
    expectedInput,
  );
  const reservation = estimateAiCreditReservation(managedGeminiRate, {
    systemPrompt,
    userPrompt,
    maxOutputTokens: 2048,
  });
  assert.ok(reservation.quantity >= 66);
});

test("Gemini billing includes prompt, output, cached, and reasoning tokens", () => {
  assert.deepEqual(
    geminiBillableTokenUsage({
      promptTokenCount: 40,
      candidatesTokenCount: 12,
      cachedContentTokenCount: 10,
      thoughtsTokenCount: 8,
    }),
    {
      inputTokens: 40,
      outputTokens: 12,
      cachedInputTokens: 10,
      reasoningTokens: 8,
    },
  );
});

test("Business hard cap combines included credits with the authorized spend cap", () => {
  const limits = {
    usage: {
      ai_credits: {
        included: 100000,
        warningPercent: 75,
        enforcement: "overage",
      },
    },
  };
  assert.deepEqual(aiCreditLimitForPlan(limits, 20000), {
    includedCredits: 100000,
    overageCapMinor: 20000,
    maximumCredits: 300000,
    warningPercent: 75,
    overageEnabled: true,
  });
  assert.equal(aiCreditOverageAmountMinor(100001, 100000), 1000);
  assert.equal(aiCreditOverageAmountMinor(120000, 100000), 2000);
});

test("AI credit plans preserve an explicit zero-percent warning threshold", () => {
  assert.equal(aiCreditLimitForPlan({
    usage: {
      ai_credits: {
        limit: 25_000,
        warningPercent: 0,
        enforcement: "block",
      },
    },
  }).warningPercent, 0);
});

test("efficient plans cannot inherit a configured frontier model", () => {
  const environment = {
    HEDGELING_EFFICIENT_GEMINI_MODEL: "models/gemini-efficient",
    HEDGELING_FRONTIER_GEMINI_MODEL: "models/gemini-frontier",
  };
  assert.equal(
    geminiModelForPlan({ modelTier: "efficient" }, environment),
    "gemini-efficient",
  );
  assert.equal(
    geminiModelForPlan({ modelTier: "frontier" }, environment),
    "gemini-frontier",
  );
});
