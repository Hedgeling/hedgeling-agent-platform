import { pool } from "../src/db.js";
import { compareUsageRollups } from "../src/usage.js";

const limit = Number(process.env.HEDGELING_USAGE_ROLLUP_MONITOR_LIMIT || 1000);

try {
  const result = await compareUsageRollups({ limit });
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "Hedgeling/Usage",
        Dimensions: [[]],
        Metrics: [
          { Name: "MismatchCount", Unit: "Count" },
          { Name: "UnappliedEvents", Unit: "Count" },
          { Name: "AppliedEventsWithoutPeriod", Unit: "Count" },
        ],
      }],
    },
    MismatchCount: result.mismatchCount,
    UnappliedEvents: result.unappliedEvents,
    AppliedEventsWithoutPeriod: result.appliedEventsWithoutPeriod,
    exact: result.exact,
    truncated: result.truncated,
    ledgerEvents: result.ledgerEvents,
  }));
  if (!result.exact) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({
    metric: "HedgelingUsageRollupMonitor",
    outcome: "failed",
    error: String(error?.message || error).slice(0, 500),
  }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
