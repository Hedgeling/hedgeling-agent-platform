import { pool } from "../src/db.js";
import { processDueDataLifecycleRequests } from "../src/data-lifecycle.js";

const limit = Number(process.env.HEDGELING_DATA_LIFECYCLE_BATCH_SIZE || 10);

try {
  const result = await processDueDataLifecycleRequests({ limit });
  const failed = result.outcomes.filter((outcome) => outcome.status === "failed");
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "Hedgeling/DataLifecycle",
        Dimensions: [["PolicyVersion"]],
        Metrics: [
          { Name: "ClaimedRequests", Unit: "Count" },
          { Name: "PurgedRequests", Unit: "Count" },
          { Name: "FailedRequests", Unit: "Count" },
        ],
      }],
    },
    PolicyVersion: "customer-content-v1",
    ClaimedRequests: result.claimed,
    PurgedRequests: result.outcomes.length - failed.length,
    FailedRequests: failed.length,
    outcome: failed.length ? "failed" : "succeeded",
    workerId: result.workerId,
  }));
  if (failed.length) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    metric: "HedgelingDataLifecycle",
    outcome: "failed",
    error: String(error?.message || error).slice(0, 500),
  }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
