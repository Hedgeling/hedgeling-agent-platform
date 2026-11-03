# Hedgeling web console

See the [public repository quickstart](../../README.md) for installation, local sessions, MCP and tests.

- [Agent implementation and configuration](../../docs/platform/AGENT-CONSOLE-IMPLEMENTATION.md)
- [API and MCP architecture](../../docs/platform/API-AND-MCP-DESIGN.md)
- [Authorization](../../docs/platform/AUTHORIZATION.md)
- [Billing and organization keys](../../docs/platform/BILLING-ENTITLEMENTS.md)
- [Hackathon provider roadmap](../../docs/HACKATHON-PLAN.md)

This package serves both the console and the platform API. Its catalog importer accepts already prepared source content; it contains no source extraction engine. Hosted identity, billing and optional private package distribution require explicit server configuration. They are not needed for the local fixture demo.

## Repository delivery onboarding

Before proposing paid enrichment or translation for repository work, Agent Hedgeling checks `repositories.delivery_readiness` (`console_check_repository_delivery` in MCP). It needs a project and repository URL, with an optional named `baseBranch`; no translation job is required. Project import/source access and conversation scope are enforced before contacting GitHub, using only the current user's connection.

The read-only result contains the checked commit, branch status, current account push access, counts and bounded paths for existing `hedgeling-bundle.json` and `hedgeling-source-key-map.json` files, plus setup instructions for chat. It does not download source or translation contents, make model calls, or write to GitHub. A truncated or inaccessible repository is an error, not evidence of missing files. File presence, JSON compatibility, App write permissions, and an app actually loading translations are separate facts; the last three are explicitly unchecked. A successful metadata check reports `checks_remaining`, never a guarantee that delivery or deployment will work.

The agent explains missing setup before users spend on translation and offers delivery setup first or translation-only work. Missing integration does not block extraction or translation. Document-only work skips this check. Existing PR delivery still requires compatible runtime files, matching extraction provenance, complete translation coverage, the chosen review workflow, and human confirmation. It updates the files; it cannot install a runtime or rewrite app code. The developer handoff covers runtime integration, bundle/map files, language selection, a translated-UI check, and re-extraction after setup changes reach the base branch.

Operators can set the optional server environment variable `HEDGELING_GITHUB_APP_SLUG` to their GitHub App's public slug. GitHub connection status and readiness then provide its installation link. There is no guessed or deployment-specific default. Without this setting, the agent asks the operator for the installation link; GitHub's installed-app settings page only manages existing installations. Users authorize their own account, select their repository in the App installation, and need repository Write access plus App Contents and Pull requests read/write. They should never paste tokens into chat or edit callback configuration themselves.
