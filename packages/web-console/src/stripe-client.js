import Stripe from "stripe";

// Provider and SDK versions are part of the certified money-movement
// contract. Change these only with the recertification described in
// docs/platform/PRODUCTION-READINESS.md.
export const stripeApiVersion = "2026-06-24.dahlia";
export const stripeNodeSdkVersion = "22.3.2";

export function createPinnedStripeClient(secretKey) {
  return new Stripe(secretKey, { apiVersion: stripeApiVersion });
}
