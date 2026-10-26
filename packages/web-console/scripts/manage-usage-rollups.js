import {
  backfillUsageRollups,
  compareUsageRollups,
  repairUsageRollups,
} from "../src/usage.js";
import { pool } from "../src/db.js";

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

const command = process.argv[2];
if (!["backfill", "compare", "repair"].includes(command)) {
  throw new Error(
    "Usage: manage-usage-rollups.js backfill|compare|repair "
    + "[--organization-id UUID] [--batch-size N] [--max-batches N] [--limit N]",
  );
}

try {
  let result;
  if (command === "backfill") {
    result = await backfillUsageRollups({
      batchSize: option("batch-size", 500),
      maxBatches: option("max-batches", 100),
    });
  } else if (command === "compare") {
    result = await compareUsageRollups({
      organizationId: option("organization-id"),
      limit: option("limit", 1000),
    });
    if (!result.exact) process.exitCode = 2;
  } else {
    result = await repairUsageRollups({
      organizationId: option("organization-id"),
    });
    const comparison = await compareUsageRollups({
      organizationId: result.organizationId,
      limit: option("limit", 1000),
    });
    result = { repair: result, comparison };
    if (!comparison.exact) process.exitCode = 2;
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
