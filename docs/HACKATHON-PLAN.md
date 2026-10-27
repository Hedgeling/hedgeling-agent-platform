# Meta hackathon delivery plan

Planning baseline: 2026-10-26. This is a public development workspace built on existing Hedgeling code, not a claim that the whole product was created during the event. See [the baseline boundary](REPOSITORY-BOUNDARY.md).

## Product goal

A user can describe a localization task, watch Agent Hedgeling navigate the console, review its proposed changes, and take over manually. Built-in chat and external agents use the same permission-checked API. Demonstrate organization → business unit → project → localization job, followed by cross-project reporting and management.

Existing baseline: console shell, chat modes and attention cues; human write confirmations; bounded job-start authorization; paginated reads/reporting; local named sessions; Gemini and deterministic fixture providers; organization billing/AI-key foundations. These are pre-existing features. The standalone public MCP/client packaging is preparation for independent development.

## New work, in delivery order

1. **Meta-powered agent.** Introduce a provider-neutral conversation/message and tool-result representation, then a Meta adapter for structured tools, streaming, usage, cancellation and errors. Existing persistence contains Gemini-specific shapes; normalize it explicitly and test compatibility. Configure model IDs from the event access actually available. Do not substitute a model name or URL and assume the protocols match.
2. **Provider profiles and organization controls.** Represent model vendor, access provider and workload separately. Select chat, context enrichment and translation models independently. Add server-side Meta key storage, masked status, validation, rotation and deletion to the existing organization key controls. Keep keys out of chat context, browser responses and audit payloads. Preserve Gemini as an alternative.
3. **Meta models through Bedrock.** Add a distinct AWS transport/profile with region, model or inference-profile ID and server-side identity. Prefer an IAM role with temporary credentials for the hosted service. Later support customer-owned AWS access through a narrowly scoped cross-account role, rather than collecting long-lived AWS keys. A Meta API key is not an AWS credential. See [AWS Bedrock identity documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/security-iam.html).
4. **Context enrichment and translation.** Operate on imported strings and metadata, with provider-neutral usage accounting, budgets, retries and cancellation. Preserve the separation from private application-source extraction. Confirm job scope and cost ceiling before generating drafts; keep review, publication, access and spending changes separately authorized. Never silently route a failed BYOK request to a paid managed provider.
5. **API/MCP and demo finish.** Expand shared typed actions only where the complete workflow needs them. Cover organization isolation, multi-page project/job queries, proposals/confirmation, manual takeover and provider failures with integration tests. Show a Meta-powered end-to-end run and an external MCP client against the same API using synthetic data.

The API remains the domain/authorization boundary. Chat and MCP are adapters; neither owns a separate write implementation. A GraphQL read layer can be considered when concrete reporting clients need it. Federation and separate reporting services are not prerequisites for this milestone.

## Acceptance checks

- Local public checkout installs and runs without any private package or extractor.
- Real Meta tool use completes the bounded workflow; invalid tool inputs never bypass validation.
- The agent cannot confirm its own proposals; each mutation uses the human's current permissions and explicit scope.
- Users can pause, resume and take over; current work is visible in the console.
- A >100-project organization can be queried with pagination and account-wide reporting without silently truncating results.
- BYOK configuration remains server-side, fails clearly when unavailable, and never incurs unexpected fallback charges.
- Included platform chat and translation billing stay separate; the 14-day chat trial policy remains intact.
- Provider and role matrices include missing credentials, unauthorized scopes, quota errors, cancellation, replay/idempotency and timeouts.
- Public documentation lists what is implemented, what is demonstrated with fixtures, and what remains planned.

## Event and submission record

The [official event overview](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) lists October 26–November 4, with submissions due November 4 at 9 PM ET. The participant [details/rules page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details) was not readable during baseline preparation, so pre-existing-code eligibility and any specific publication/license requirements are not represented here as verified. Reconcile the submission with the accepted participant rules. Preserve the baseline tag and explain the new work in the submission.

Status at baseline: Meta adapter, Meta BYOK and Bedrock were **planned**. No Meta inference is claimed by the initial repository.

## Implemented after the baseline

The Meta Responses adapter now supports server-managed chat with Muse Spark 1.3 (`muse-spark-1.3`), structured tool calls, encrypted reasoning replay, cancellation, usage accounting and explicit configuration failures. A live two-turn synthetic tool-call exchange passed on October 26; provider tests also cover legacy conversation conversion, incomplete responses, malformed calls, request cancellation and response-size bounds. Responses are currently buffered; token-by-token model streaming remains future work. The existing console still streams run/tool events.

The isolated AWS demo and manual GitHub deployment pipeline are defined in [the deployment guide](AWS-DEMO.md). Demo owner membership and access use the normal authorization and entitlement checks. There is no public signup or external billing in the demo seed. Organization Meta BYOK and context-aware translation are implemented separately from the managed chat adapter. Bedrock and a separate context-enrichment pass remain planned.

The event-only submission repository now provides a project-bound source extraction and catalog import workflow, vendored here with Apache license and commit/hash provenance. Chat, manual workspace controls and MCP share the same actions. Extraction and import have separate human approvals; import uses the existing transactional importer and usage limits, preserves translations, and does not prune sources or write to GitHub. Integration tests cover lost responses/retry, stale previews, project isolation, cap rollback and revoked connections. Browser tests cover chat/MCP plus manual controls using a synthetic HTTPS engine. The proprietary extraction implementation remains in its separately deployed service. The submission repository documents exact workflow limits and deployment evidence.

Organization owners/admins can now keep Gemini and Meta credentials side by side in **Admin → AI providers & keys**. Saving, replacing, deleting, or selecting a key uses the existing human confirmation boundary. Metadata-only connection tests perform no inference. Selected organization Meta keys power contextual translation revisions, with provider/model provenance and token usage recorded, no Hedgeling translation-credit charge, and no automatic fallback. Included chat continues to use the managed Meta account. These paths are covered by synthetic provider, database, authorization, and browser tests.

Chat now shares the sign-in palette through semantic design tokens in both brands. Opaque reading surfaces, stronger muted text and control borders, labeled 48px layout controls, and an almost full-screen layout improve readability. Assistant replies render a safe DOM-only Markdown subset (including bold, lists and code); model HTML remains inert. Clicking or tabbing into a paused conversation’s input resumes it without sending a message or confirming a pending change. Explicit takeover remains for a conversation controlled by another tab. Browser checks cover both themes, computed text contrast, mobile layout, retry/draft preservation, keyboard activation, approval boundaries and cross-tab ownership. The standalone Markdown renderer is event-authored; the earlier console and design system remain existing-product code.

Existing projects now expose Languages with current source/targets and an additive target-language preview, plus a shortcut from translation review. The same event-authored action and skill are available to chat and both MCP adapters. Human approval rechecks unscoped locale-management access, plan limits and exact state; existing languages, jobs and translations are preserved. A shared account lock serializes additions with catalog imports. This milestone supports adding/re-enabling targets; source-language changes and removals remain separate work. The event repository documents contracts, bounds and verification.

Automatic demo release: main pushes run the complete platform checks, then exercise agent approval and project-language persistence inside the final Linux container. CI retains that exact image for seven days. A successful main push triggers the demo-only deployment workflow; it downloads and verifies the tested image, publishes it to private ECR, and updates ECS by immutable digest. Superseded main builds are skipped. Manual rollback requires a successful main build with a retained image. Feature branches receive PR checks without duplicate push runs; no production resources or npm publication are involved.
