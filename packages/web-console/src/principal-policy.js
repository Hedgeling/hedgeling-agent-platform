// Enforced at operation time, including for pre-existing or accidentally
// overprivileged service-account grants. Never infer a human from a role.
export const HUMAN_DECISION_PERMISSIONS = new Set([
  "translations.approve", "quality.approve", "payables.approve",
  "prompts.approve", "personas.approve", "glossary.approve",
  "rate_cards.approve", "vendor_linguists.approve",
  "access_requests.approve", "access_reviews.manage",
  "organization.delete", "organization.transfer_ownership",
  "roles.assign", "security.manage", "identity.manage",
  "provisioning.manage", "support_access.manage",
  "ai_providers.manage", "billing.manage",
]);

export function isHumanDecisionActor(auth) {
  return auth?.principalType === "user" && Boolean(auth.user?.id)
    && auth.executionType !== "agent";
}

export function humanDecisionDenied(auth, permission) {
  return HUMAN_DECISION_PERMISSIONS.has(permission) && !isHumanDecisionActor(auth);
}
