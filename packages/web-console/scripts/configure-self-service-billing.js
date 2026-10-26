import {
  configureSelfServiceStripeBilling,
} from "../src/self-service-billing-configuration.js";
import { pool } from "../src/db.js";

try {
  const configured = await configureSelfServiceStripeBilling();
  console.log(JSON.stringify({
    event: "self_service_stripe_billing_configured",
    configured,
  }));
} finally {
  await pool.end();
}
