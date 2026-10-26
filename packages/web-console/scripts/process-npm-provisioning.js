import {
  claimNpmProvisioningWork,
  completeNpmProvisioningWork,
  failNpmProvisioningWork,
} from "../src/npm-seats.js";
import {
  npmProvisioningConfiguration,
  provisionNpmSeat,
} from "../src/npm-provider.js";

const batchSize = Number(process.env.HEDGELING_NPM_PROVISIONING_BATCH_SIZE || 10);
const configuration = npmProvisioningConfiguration();
const claimed = await claimNpmProvisioningWork({ limit: batchSize });
let succeeded = 0;
let failed = 0;

for (const work of claimed.work) {
  const username = String(work.metadata?.npmUsername || "").trim();
  try {
    if (!username) throw new Error("Npm provisioning work is missing npmUsername");
    const providerState = await provisionNpmSeat(
      work.operation,
      username,
      configuration,
    );
    await completeNpmProvisioningWork(work.id, claimed.workerId, providerState);
    succeeded += 1;
  } catch (error) {
    await failNpmProvisioningWork(work.id, claimed.workerId, error);
    failed += 1;
    console.error(JSON.stringify({
      event: "npm_provisioning_failed",
      workId: work.id,
      operation: work.operation,
      username,
      error: String(error?.message || error),
    }));
  }
}

console.log(JSON.stringify({
  event: "npm_provisioning_batch_complete",
  claimed: claimed.work.length,
  succeeded,
  failed,
}));
if (failed) process.exitCode = 1;
