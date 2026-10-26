import { pool } from "../src/db.js";
import {
  reconcilePayoutAccounts,
  validateFacilitatedMoneyConfiguration,
} from "../src/facilitated-money.js";

const limit = Number(process.env.HEDGELING_PAYOUT_RECONCILIATION_ACCOUNT_LIMIT || 25);

try {
  validateFacilitatedMoneyConfiguration();
  const result = await reconcilePayoutAccounts({ limit });
  const failed = result.outcomes.filter((outcome) => outcome.status === "failed");
  const partialCount = result.outcomes.filter((outcome) => outcome.status === "partial").length;
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "Hedgeling/Payments",
        Dimensions: [["ProviderMode"]],
        Metrics: [
          { Name: "FailedAccounts", Unit: "Count" },
          { Name: "PartialAccounts", Unit: "Count" },
          { Name: "StaleAccounts", Unit: "Count" },
        ],
      }],
    },
    ProviderMode: result.providerMode,
    FailedAccounts: failed.length,
    PartialAccounts: partialCount,
    StaleAccounts: result.staleAccountCount,
    outcome: failed.length ? "failed" : "succeeded",
    accountCount: result.outcomes.length,
    maximumLagMinutes: result.maximumLagMinutes,
  }));
  if (failed.length) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    metric: "HedgelingPayoutReconciliation",
    outcome: "failed",
    error: String(error?.message || error).slice(0, 500),
  }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
