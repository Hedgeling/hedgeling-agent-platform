import { pool } from "../src/db.js";
import { replayFailedStripeEvent } from "../src/stripe-billing.js";

const eventId = String(process.argv[2] || "").trim();
try {
  if (!eventId) {
    throw new Error("Usage: npm -w @hedgeling/web-console run billing:replay-stripe -- evt_...");
  }
  const replayed = await replayFailedStripeEvent(eventId);
  console.log(JSON.stringify({ eventId, ...replayed }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
