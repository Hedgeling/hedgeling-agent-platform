// Reuse the existing local-only database, named user and short-lived session.
// Deterministic demonstration calls the real API; it never needs a model key.
process.env.HEDGELING_AGENT_ENABLED = "true";
process.env.HEDGELING_AGENT_ORG_CREATION_ENABLED = "true";
process.env.HEDGELING_AGENT_PROVIDER ||= "fixture";
await import("./dev-local.js");
