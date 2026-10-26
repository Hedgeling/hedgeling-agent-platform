import {
  claimSubscriptionProvisioning,
  failSubscriptionProvisioning,
  provisionMixedIntervalSubscription,
} from "../src/subscription-provisioning.js";

const batchSize = Number(
  process.env.HEDGELING_SUBSCRIPTION_PROVISIONING_BATCH_SIZE || 10,
);
const claimed = await claimSubscriptionProvisioning({ limit: batchSize });
let succeeded = 0;
let requiresAction = 0;
let failed = 0;

for (const work of claimed.work) {
  try {
    const result = await provisionMixedIntervalSubscription(
      work.id,
      claimed.workerId,
    );
    if (result.status === "requires_action") requiresAction += 1;
    else succeeded += 1;
  } catch (error) {
    await failSubscriptionProvisioning(work.id, claimed.workerId, error);
    failed += 1;
    console.error(JSON.stringify({
      event: "subscription_provisioning_failed",
      workId: work.id,
      error: String(error?.message || error),
      code: error?.code || null,
      providerSubscriptionId: error?.providerSubscriptionId || null,
    }));
  }
}

console.log(JSON.stringify({
  event: "subscription_provisioning_batch_complete",
  claimed: claimed.work.length,
  succeeded,
  requiresAction,
  failed,
}));
if (failed) process.exitCode = 1;
