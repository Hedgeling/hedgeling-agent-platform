import { query } from "./db.js";

const CREDITS_PER_OVERAGE_MINOR = 10n;

function normalizedModel(value) {
  return String(value || "").trim().replace(/^models\//, "");
}

export function geminiModelForPlan(planLimits, environment = process.env) {
  const efficient = normalizedModel(
    environment.HEDGELING_EFFICIENT_GEMINI_MODEL
    || environment.HEDGELING_GEMINI_MODEL
    || "gemini-3.5-flash-lite",
  );
  if (String(planLimits?.modelTier || "efficient") === "efficient") {
    return efficient;
  }
  return normalizedModel(environment.HEDGELING_FRONTIER_GEMINI_MODEL) || efficient;
}

function nonNegativeBigInt(value, field) {
  const normalized = typeof value === "bigint" ? value : BigInt(value ?? 0);
  if (normalized < 0n) throw new Error(`${field} cannot be negative`);
  return normalized;
}

function safeNumber(value, field) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${field} exceeds the supported safe-integer range`);
  }
  return Number(value);
}

function ceilDiv(numerator, denominator) {
  if (numerator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

function rateValue(rate, key) {
  return nonNegativeBigInt(rate?.[key], key);
}

export function calculateAiCredits(rate, tokenUsage = {}) {
  const cachedInputTokens = nonNegativeBigInt(
    tokenUsage.cachedInputTokens,
    "cachedInputTokens",
  );
  const reportedInputTokens = nonNegativeBigInt(
    tokenUsage.inputTokens,
    "inputTokens",
  );
  const uncachedInputTokens = reportedInputTokens > cachedInputTokens
    ? reportedInputTokens - cachedInputTokens
    : 0n;
  const outputTokens = nonNegativeBigInt(tokenUsage.outputTokens, "outputTokens");
  const reasoningTokens = nonNegativeBigInt(
    tokenUsage.reasoningTokens,
    "reasoningTokens",
  );
  const perMillion = 1_000_000n;
  const components = {
    input: ceilDiv(
      uncachedInputTokens * rateValue(rate, "inputCreditsPerMillion"),
      perMillion,
    ),
    cachedInput: ceilDiv(
      cachedInputTokens * rateValue(rate, "cachedInputCreditsPerMillion"),
      perMillion,
    ),
    output: ceilDiv(
      outputTokens * rateValue(rate, "outputCreditsPerMillion"),
      perMillion,
    ),
    reasoning: ceilDiv(
      reasoningTokens * rateValue(rate, "reasoningCreditsPerMillion"),
      perMillion,
    ),
    fixed: rateValue(rate, "fixedCredits"),
  };
  const total = Object.values(components).reduce((sum, value) => sum + value, 0n);
  return {
    quantity: safeNumber(total, "AI credit quantity"),
    components: Object.fromEntries(
      Object.entries(components).map(([key, value]) => [key, value.toString()]),
    ),
  };
}

export function conservativeTokenUpperBound(...parts) {
  return parts.reduce(
    (total, part) => total + Buffer.byteLength(String(part ?? ""), "utf8"),
    0,
  );
}

export function estimateAiCreditReservation(rate, {
  systemPrompt,
  userPrompt,
  maxOutputTokens,
} = {}) {
  const inputTokens = conservativeTokenUpperBound(systemPrompt, userPrompt);
  return calculateAiCredits(rate, {
    inputTokens,
    outputTokens: nonNegativeBigInt(maxOutputTokens, "maxOutputTokens"),
  });
}

export function geminiBillableTokenUsage(usageMetadata = {}) {
  return {
    inputTokens: Number(
      usageMetadata.promptTokenCount
      ?? usageMetadata.inputTokenCount
      ?? 0,
    ),
    outputTokens: Number(
      usageMetadata.candidatesTokenCount
      ?? usageMetadata.outputTokenCount
      ?? 0,
    ),
    cachedInputTokens: Number(
      usageMetadata.cachedContentTokenCount
      ?? usageMetadata.cachedInputTokenCount
      ?? 0,
    ),
    reasoningTokens: Number(
      usageMetadata.thoughtsTokenCount
      ?? usageMetadata.reasoningTokenCount
      ?? 0,
    ),
  };
}

export async function loadActiveAiCreditRate({
  provider,
  model,
  operation = "translation",
  at = new Date(),
  database = { query },
}) {
  const result = await database.query(
    `select
       rate.id,
       card.key as "rateCardKey",
       card.version as "rateCardVersion",
       card.currency,
       card.credits_per_billing_block as "creditsPerBillingBlock",
       card.billing_block_amount_minor as "billingBlockAmountMinor",
       rate.provider,
       rate.model,
       rate.operation,
       rate.input_credits_per_million as "inputCreditsPerMillion",
       rate.output_credits_per_million as "outputCreditsPerMillion",
       rate.cached_input_credits_per_million as "cachedInputCreditsPerMillion",
       rate.reasoning_credits_per_million as "reasoningCreditsPerMillion",
       rate.fixed_credits as "fixedCredits"
     from ai_credit_rates rate
     join ai_credit_rate_cards card on card.id = rate.rate_card_id
     where card.status = 'active'
       and card.effective_at <= $4
       and (card.retired_at is null or card.retired_at > $4)
       and rate.provider = $1
       and rate.model = $2
       and rate.operation = $3
     order by card.effective_at desc, card.version desc
     limit 1`,
    [provider, model, operation, at.toISOString()],
  );
  if (!result.rows[0]) {
    const error = new Error(
      `No active AI credit rate is configured for ${provider}/${model}/${operation}`,
    );
    error.status = 503;
    error.code = "ai_credit_rate_missing";
    throw error;
  }
  return result.rows[0];
}

export function aiCreditLimitForPlan(planLimits, overageCapMinor = 0) {
  const policy = planLimits?.usage?.ai_credits;
  if (!policy || typeof policy !== "object") return null;
  const configuredWarningPercent = Number(policy.warningPercent ?? 75);
  const warningPercent = Number.isInteger(configuredWarningPercent)
    && configuredWarningPercent >= 0
    && configuredWarningPercent <= 100
    ? configuredWarningPercent
    : 75;
  const directLimit = Number(policy.limit);
  if (Number.isSafeInteger(directLimit) && directLimit > 0) {
    return {
      includedCredits: directLimit,
      overageCapMinor: 0,
      maximumCredits: directLimit,
      warningPercent,
      overageEnabled: false,
    };
  }
  const includedCredits = Number(policy.included);
  if (!Number.isSafeInteger(includedCredits) || includedCredits <= 0) return null;
  const cap = nonNegativeBigInt(overageCapMinor, "overageCapMinor");
  const maximum = BigInt(includedCredits) + cap * CREDITS_PER_OVERAGE_MINOR;
  return {
    includedCredits,
    overageCapMinor: safeNumber(cap, "overageCapMinor"),
    maximumCredits: safeNumber(maximum, "maximumCredits"),
    warningPercent,
    overageEnabled: policy.enforcement === "overage",
  };
}

export async function effectiveAiCreditPlanLimits(
  organizationId,
  planLimits,
  database = { query },
) {
  const policy = planLimits?.usage?.ai_credits;
  if (!policy || typeof policy !== "object") {
    return { planLimits, creditPolicy: null };
  }
  let overageCapMinor = 0;
  if (policy.enforcement === "overage") {
    const result = await database.query(
      `select ai_credit_overage_cap_minor as "aiCreditOverageCapMinor"
       from organization_spend_controls
       where organization_id = $1`,
      [organizationId],
    );
    overageCapMinor = Number(result.rows[0]?.aiCreditOverageCapMinor || 0);
  }
  const creditPolicy = aiCreditLimitForPlan(planLimits, overageCapMinor);
  if (!creditPolicy) return { planLimits, creditPolicy: null };
  return {
    creditPolicy,
    planLimits: {
      ...planLimits,
      usage: {
        ...(planLimits.usage || {}),
        ai_credits: {
          limit: creditPolicy.maximumCredits,
          warningPercent: creditPolicy.warningPercent,
          enforcement: "block",
        },
      },
    },
  };
}

export function aiCreditOverageAmountMinor(usedCredits, includedCredits) {
  const used = nonNegativeBigInt(usedCredits, "usedCredits");
  const included = nonNegativeBigInt(includedCredits, "includedCredits");
  if (used <= included) return 0;
  const overage = used - included;
  const blocks = ceilDiv(overage, 10_000n);
  return safeNumber(blocks * 1_000n, "AI credit overage amount");
}
