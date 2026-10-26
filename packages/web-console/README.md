# Hedgeling web console

See the [public repository quickstart](../../README.md) for installation, local sessions, MCP and tests.

- [Agent implementation and configuration](../../docs/platform/AGENT-CONSOLE-IMPLEMENTATION.md)
- [API and MCP architecture](../../docs/platform/API-AND-MCP-DESIGN.md)
- [Authorization](../../docs/platform/AUTHORIZATION.md)
- [Billing and organization keys](../../docs/platform/BILLING-ENTITLEMENTS.md)
- [Hackathon provider roadmap](../../docs/HACKATHON-PLAN.md)

This package serves both the console and the platform API. Its catalog importer accepts already prepared source content; it contains no source extraction engine. Hosted identity, billing and optional private package distribution require explicit server configuration. They are not needed for the local fixture demo.
