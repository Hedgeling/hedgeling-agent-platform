import {
  claimBillingMeterEvents,
  deliverBillingMeterEvent,
  failBillingMeterEvent,
} from "../src/billing-meters.js";

const batchSize = Number(process.env.HEDGELING_BILLING_METER_BATCH_SIZE || 100);
const claimed = await claimBillingMeterEvents({ limit: batchSize });
let delivered = 0;
let failed = 0;

for (const work of claimed.work) {
  try {
    await deliverBillingMeterEvent(work, claimed.workerId);
    delivered += 1;
  } catch (error) {
    await failBillingMeterEvent(work.id, claimed.workerId, error);
    failed += 1;
    console.error(JSON.stringify({
      event: "billing_meter_delivery_failed",
      workId: work.id,
      code: error?.code || null,
      error: String(error?.message || error),
    }));
  }
}

console.log(JSON.stringify({
  event: "billing_meter_batch_complete",
  claimed: claimed.work.length,
  delivered,
  failed,
}));
if (failed) process.exitCode = 1;
