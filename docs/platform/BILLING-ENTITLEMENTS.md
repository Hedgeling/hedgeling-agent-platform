# SaaS billing, entitlements, and feature access

Status: Phases 3A–3D are implemented for the initial product surface. Monetary budgets and external alert delivery remain future extensions.

## Purpose and boundaries

SaaS billing answers whether a customer organization may use a commercial platform capability. It does not grant a user permission. A request must pass authentication, tenant membership, RBAC, feature rollout, and commercial access independently.

The local database is authoritative during a request. Hedgeling never calls a payment provider synchronously to authorize an operation. A later provider adapter will update local subscription state from idempotent webhooks.

Vendor rates, agency payables, and payouts are a separate commercial domain and are not represented by these tables.

## Phase 3 delivery slices

1. **3A — commercial access foundation:** billing accounts, versioned plans, entitlements, subscription state, organization overrides, feature flags, route gates, and a read API.
2. **3B — provider integration:** **implemented with Stripe** — provider customer/subscription mapping, checkout and portal sessions, signed idempotent webhooks, and local reconciliation.
3. **3C — usage ledger and limits:** **implemented** — append-only usage events, exact request and string measurements, idempotency, aggregation, atomic reservations, plan-limit enforcement, and usage views.
4. **3D — budgets:** **implemented for metered quantities** — organization/BU/project budgets, warning and blocking policies, in-console alerts, acknowledgement, audit history, and administrative UI.

Stripe is the Phase 3B SaaS provider. Provider-specific identifiers and payloads stay outside authorization logic, so a future provider can synchronize the same local model.

## Data model

- `billing_accounts`: one SaaS billing boundary per organization.
- `product_plans`: immutable/versioned commercial plan definitions. Material changes create a new plan version.
- `entitlement_definitions`: stable capability keys and their subscription access class.
- `plan_entitlements`: the capabilities and future limit values included in a plan version.
- `subscriptions`: locally synchronized subscription lifecycle and billing period data.
- `organization_entitlement_overrides`: explicit, expiring contractual or operational grants/denials.
- `feature_flags`: platform rollout defaults independent from payment.
- `organization_feature_flag_overrides`: explicit, expiring per-organization rollout decisions.
- `billing_prices`: server-owned mappings from stable Hedgeling price keys to Stripe Price IDs and plan versions.
- `billing_provider_events`: signed provider events, processing state, attempts, and replay-safe provider IDs.
- `usage_metric_definitions`: stable word, character, and token metric keys.
- `usage_events`: immutable tenant-, operation-, actor-, and provider-attributed usage facts.
- `usage_event_measurements`: normalized request-level quantities used for aggregation and future limits.
- `usage_event_items`: per-string source/output measurements and links to source strings and AI translation revisions.
- `usage_event_billing_periods`: immutable-at-application subscription-period
  identity used to keep historical projections deterministic after a provider
  advances its current subscription period.
- `usage_period_rollups`: exact metric/counting-version projections by
  organization/BU/project and subscription/calendar period. Quantities are
  signed so compensating adjustment events can reverse prior usage without
  mutating the original fact.
- `usage_rollup_applied_events`: one marker per immutable event included in the
  rollup projection.
- `usage_reservations` and `usage_reservation_measurements`: short-lived atomic holds used before paid work starts.
- `usage_budgets`: append-oriented organization, BU, and project policies for a metric and period.
- `usage_budget_alerts`: deduplicated warning, exceeded, and blocked threshold facts with acknowledgement state.

Overrides are append-oriented. A replacement marks the previous record `superseded_at` rather than rewriting its commercial history.

Phase 3A entitlement keys are:

| Key | Access class | Initial route |
|---|---|---|
| `verified_exports` | `export` | `GET /api/export-verified` |
| `state_imports` | `paid_write` | `POST /api/import-state` |
| `ai_revision` | `paid_write` | `POST /api/translations/:sourceId/:locale/revise` |

## Effective access

The effective decision combines:

```text
RBAC permission
+ enabled feature flag
+ plan entitlement or active organization override
+ subscription-state policy
```

The RBAC middleware runs before the entitlement middleware so an unauthorized user cannot use billing responses to discover tenant resources.

Subscription behavior is:

| State | Export entitlement | Paid-write entitlement |
|---|---:|---:|
| `trialing`, `active` | allowed | allowed |
| `past_due` | allowed | allowed only before `grace_ends_at` |
| `paused` | allowed | denied |
| `unpaid`, `canceled`, missing | denied | denied |

An active organization entitlement override can grant or deny a capability independently of the plan and subscription state. This supports contracted or complimentary access without fabricating payment state. A feature flag can still disable the feature.

Platform administrators bypass plan entitlement checks for support and recovery, but do not bypass a disabled feature flag. Retention/read routes remain governed by RBAC and are not commercially gated in Phase 3A.

Commercial denial returns `402` with `code: "entitlement_required"`. A rollout denial returns `403` with `code: "feature_disabled"`.

## API

`GET /api/access/organizations/:organizationId/billing-access`

- Requires `billing.view`.
- Returns the local billing account/current subscription summary.
- Returns each effective entitlement, source, feature state, plan, limits, and denial reason.
- Does not expose provider secrets or raw webhook payloads.

`POST /api/access/organizations/:organizationId/billing/checkout`

- Requires `billing.manage`.
- Accepts a server-owned `priceKey`, never an arbitrary Stripe Price ID.
- Creates or reuses the organization Stripe Customer using an idempotency key.
- Returns a short-lived hosted Checkout URL.
- Reuses the organization’s still-open Checkout Session so concurrent clicks cannot create duplicate subscriptions.
- Rejects creation when a non-canceled Stripe subscription already exists.

`POST /api/access/organizations/:organizationId/billing/portal`

- Requires `billing.manage`.
- Creates a short-lived Stripe customer-portal URL using the configured server-side return URL.

`POST /api/billing/stripe/webhook`

- Public by network location but authenticated by Stripe signature.
- Receives the untouched raw request body before JSON parsing.
- Reconciles Checkout customer links and subscription lifecycle events.
- Returns success for duplicate and intentionally ignored events.
- Returns an error for unmapped customers/prices so Stripe retries after operations correct the mapping.

Plan, price, entitlement, and feature-override mutation APIs remain deferred to platform-finance workflows. Direct database changes are not a supported customer workflow.

### Usage API

`GET /api/access/organizations/:organizationId/usage`

- Requires `usage.view`.
- Defaults to the current subscription-period start (or the UTC calendar month when unavailable) and accepts ISO `from`/`to` timestamps for windows up to 366 days.
- Accepts optional organization-owned `businessUnitId` and `projectId` filters.
- Returns exact metric totals, operation counts, daily measurements, BU/project breakdowns, and the 50 most recent usage events.
- Returns `bigint` quantities as decimal strings so JavaScript clients cannot silently lose precision.

## Usage measurements

The first metered operations are state imports and one-string AI translation revisions. Metrics are:

| Metric | Scope | Definition |
|---|---|---|
| `source_words_processed` | request and string | Locale-aware `Intl.Segmenter` word-like segments |
| `source_characters_processed` | request and string | Unicode code points including whitespace |
| `ai_output_words` | request | Locale-aware words across every AI attempt |
| `ai_output_characters` | request | Unicode code points across every AI attempt |
| `llm_input_tokens` | request | Provider-reported prompt/input tokens |
| `llm_output_tokens` | request | Provider-reported candidate/output tokens |
| `llm_cached_input_tokens` | request | Provider-reported cached input tokens |
| `llm_reasoning_tokens` | request | Provider-reported thought/reasoning tokens |
| `llm_total_tokens` | request | Provider-reported total tokens |

Text measurements use a counting version such as
`intl-word-unicode-codepoint-v1-node22-icu77.1`, stored on both the event and
each item. The Node major and ICU version are part of the identifier because
`Intl.Segmenter` behavior can change with runtime data. Historical quantities
are facts and are not recalculated; a Node/ICU upgrade naturally creates a new
counting-version cohort.

State imports count source words and characters only for source-string rows that
are inserted or whose source text, shape, purpose, visual context, or character
limit changes. An unchanged re-import still creates an idempotent operation
record but adds no source measurement or item. The response exposes
`meteredSourceStrings` separately from the number of source entries visited.

Gemini revision retries belong to the same user operation. Token and generated-output totals include every provider attempt because every attempt consumes capacity, including output rejected by validation. Attempt-level provider usage metadata, response IDs, model, API version, and finish reasons are retained in event metadata. The item row retains the final candidate’s output counts for revision/HTER attribution; the request measurement remains the commercial total across all attempts.

The current revision endpoint sends one string per LLM request, so its request token totals are exactly attributable to that string through `usage_event_items`. Future batches must retain exact token usage at request scope. Per-string token allocation may be added only as an explicitly `estimated` measurement unless a provider supplies item-level usage.

Each item links the source string and successful AI `translation_revisions` row. A subsequent human revision already stores the AI text as `previous_text` and the final edit as `next_text`; this preserves the inputs required to compute Levenshtein distance and HTER asynchronously without rewriting the usage ledger.

If operational retention or import pruning deletes a linked source string/revision, the item link becomes null while its immutable counts remain. Usage history therefore never blocks source pruning.

Callers may send `Idempotency-Key`; otherwise the server namespaces
`X-Request-Id` or a generated UUID by operation. Reusing a key and request
fingerprint after success returns the stored status and JSON body with
`Idempotency-Replayed: true`; the operation and metering are not repeated. A
concurrent retry while the first attempt is still held returns `409
idempotency_in_progress` with the reservation and attempt number. Reusing the
key for different content returns `409`.

Failed and partial provider attempts remain immutable usage facts because they
consume capacity, but they do not permanently claim the logical request. The
same key and fingerprint can create a later numbered reservation and event
attempt. At most one attempt for a logical request may have outcome
`succeeded`, and that successful event stores the replay response. Successful
events created before response storage return `409 idempotency_replayed` with
their event ID rather than an inaccurate “accepted” message.

## Atomic limits and reservations

State imports and AI revisions reserve known usage before work starts. Reservation creation takes an organization-scoped PostgreSQL advisory transaction lock and evaluates recorded usage plus every unexpired held reservation. Concurrent requests therefore cannot independently spend the same remaining allowance.

Reservations expire after 15 minutes, are released when work fails before a
usage fact is recorded, and are consumed by the matching numbered usage
attempt. The reservation ID, organization, idempotency key, request fingerprint,
and attempt number must all match.

Known source words and characters are reserved exactly. Provider output and token counts are unknown before an LLM response, so an applicable limit or budget holds a minimum of one unit for concurrency control and reconciles to the provider-reported total when the event is recorded. This prevents new work after a limit is exhausted, but a single in-flight LLM operation can exceed the remaining output/token allowance. A future provider-specific estimator can reserve a larger conservative quantity without changing the ledger model.

Plan limits live in the effective entitlement `limits` document:

```json
{
  "usage": {
    "source_words_processed": {
      "limit": 1000000,
      "warningPercent": 80,
      "enforcement": "block"
    },
    "llm_total_tokens": 5000000
  }
}
```

A positive integer is shorthand for a blocking limit with an 80% warning threshold. Explicit enforcement is `observe`, `warn`, or `block`. Invalid policy values fail closed to the safe defaults in the evaluator but should be rejected by the future plan-management API.

Allowed import and AI-revision responses include `usageWarnings` when projected usage has reached a plan or budget warning threshold. Persistent custom-budget alerts are also created after the usage event is recorded.

An operation that would exceed a blocking plan limit or custom budget returns:

```json
{
  "error": "The requested operation exceeds a usage limit or budget",
  "code": "usage_limit_exceeded",
  "details": {
    "type": "plan_limit",
    "metricKey": "source_words_processed",
    "projectedQuantity": "1000001",
    "limitQuantity": "1000000",
    "enforcement": "block"
  }
}
```

The HTTP status is `402`, preserving the existing distinction between commercial denial (`402`) and permission/tenant denial (`403`).

## Budgets and alerts

Budgets are independent guardrails layered on top of plan limits. Each current budget selects one metered metric, an organization/BU/project scope, a subscription or calendar-month period, a positive integer limit, a warning percentage, and `observe`, `warn`, or `block` enforcement.

- Organization budgets include all child usage. BU and project budgets include only directly attributed usage in that scope.
- A newly created budget applies to the current selected period and includes usage already recorded in that period.
- All applicable hierarchy levels are evaluated; any applicable blocking policy can deny the operation.
- `observe` and `warn` policies never deny. `block` permits an operation that reaches the limit exactly and denies one projected above it.
- Status includes both recorded and held quantities. It is `within`, `warning`, or `exceeded`.
- Warning, exceeded, and blocked alerts are unique per budget, threshold, and period. Acknowledgement does not delete the alert.
- Replacing or removing a budget sets `superseded_at`; historical policies, alerts, and audit events remain queryable.
- Reservation checks query only budgets for the request's relevant metrics and
  organization/BU/project hierarchy. Post-event alert checks reevaluate only
  budgets touched by the event's recorded metrics.
- Full-period totals use exact period rollups. During legacy backfill, status
  adds immutable events without an applied marker; budgets beginning partway
  through a period use the raw ledger for that exact partial window. The
  ledger remains authoritative and comparison detects projection drift.
- Unknown provider output/token quantities use the documented one-unit hold.
  Therefore one in-flight operation can cross a blocking threshold; the actual
  provider usage is always recorded afterward and subsequent work is blocked.

The management API is:

- `GET /api/access/organizations/:organizationId/budgets` — `usage.view`; returns current statuses, metric definitions, and recent alerts.
- `POST /api/access/organizations/:organizationId/budgets` — `budgets.manage`; creates or atomically replaces the matching current policy.
- `DELETE /api/access/organizations/:organizationId/budgets/:budgetId` — `budgets.manage`; supersedes a current policy.
- `POST /api/access/organizations/:organizationId/budget-alerts/:alertId/acknowledge` — `budgets.manage`.

The Access view exposes current-period usage, active budgets, held quantities, alerts, acknowledgement, and budget creation/removal. Every budget mutation and alert acknowledgement writes an organization audit event.

## Stripe configuration

Stripe is disabled unless `HEDGELING_STRIPE_ENABLED=true`. When enabled, startup requires:

```text
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_CHECKOUT_SUCCESS_URL
STRIPE_CHECKOUT_CANCEL_URL
STRIPE_PORTAL_RETURN_URL
```

Production callback URLs must use HTTPS. Optional controls are:

```text
HEDGELING_STRIPE_AUTOMATIC_TAX=false
HEDGELING_STRIPE_ALLOW_PROMOTION_CODES=false
HEDGELING_STRIPE_PAST_DUE_GRACE_DAYS=7
```

Before exposing Checkout, create a Stripe recurring Price and map it to an immutable Hedgeling plan version:

```sql
insert into billing_prices(
  key, plan_id, provider, provider_price_id, currency, billing_interval
)
select
  'starter-monthly',
  id,
  'stripe',
  'price_REPLACE_WITH_STRIPE_PRICE_ID',
  'USD',
  'month'
from product_plans
where key = 'starter-v1';
```

Configure the Stripe webhook endpoint as:

```text
https://YOUR_CONSOLE_HOST/api/billing/stripe/webhook
```

Subscribe it to:

- `checkout.session.completed`
- `checkout.session.expired`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.paused`
- `customer.subscription.resumed`

Other signed events are retained as `ignored`. Stripe subscription statuses `incomplete` and `incomplete_expired` map fail-closed to local `unpaid` and `canceled`.

## Migration behavior

The one-time `2026-07-legacy-billing-backfill` migration gives existing customer and internal-platform organizations a local `legacy-v1` plan and active migration subscription so enabling Phase 3A does not unexpectedly disable existing environments. A `schema_migrations` marker and transaction-scoped advisory lock prevent the backfill from granting access again on later application starts. Upgrades recognize prior migration subscriptions before claiming the marker.

Upgrade recognition depends on at least one existing subscription retaining `metadata.migrationSubscription = true` until the marker has been created. Operators must not manually delete all migration-tagged subscriptions before applying this upgrade; doing so would make the installation appear un-migrated and allow the legacy backfill to run again.

Organizations created after this migration do not receive legacy access. The eventual organization-creation service must create the organization, `billing_accounts` row, and intended trial/subscription in the same application transaction; tests must treat that provisioning as part of the organization-creation contract.

The legacy plan is a compatibility plan, not the future public pricing model.

## Security and operations

- Payment state never changes user roles.
- Stripe webhook signatures are verified against the unmodified request bytes before parsing.
- Provider event IDs are unique and processing is transactionally idempotent. Failed events retain a bounded error for operational retry.
- Failed Stripe events can be replayed after correcting their cause with `npm -w @hedgeling/web-console run billing:replay-stripe -- evt_...`. Only events currently marked `failed` are eligible.
- Subscription events use their provider timestamp so an older delivery cannot overwrite newer state.
- Past-due grace periods start at the provider event timestamp, not local processing time.
- Stripe subscriptions must contain exactly one line item. Multi-item subscriptions fail reconciliation rather than silently selecting one price.
- Checkout and Customer creation use Stripe idempotency keys.
- An open Checkout Session is reused only for the same price. Selecting another price expires the prior provider and local sessions before creating the replacement. If local persistence of a newly created session fails, the provider session is expired on a best-effort basis.
- Checkout currently calls Stripe while holding an organization advisory lock and database connection. This deliberately favors strict serialization at low volume; higher checkout volume should move provider calls outside the transaction and use create-then-record reconciliation.
- Billing and feature overrides require future platform-finance/super-admin mutation APIs with reasons and expiry.
- Raw payment credentials, card data, and provider secrets must never be stored in these tables.
- Full signed Stripe event payloads may contain customer PII. Retain full payloads for 90 days by default, then redact `payload` while retaining provider event ID, type, timestamps, status, attempt count, and bounded error metadata. A scheduled pruning/redaction job is required before production billing launch; the retention window should remain configurable for contractual requirements.
- Entitlement failure is fail-closed when the subscription, plan, entitlement, or feature definition is missing.

## Verification

Database integration tests cover:

- active, grace-period, paused, unpaid, and missing subscription behavior;
- export versus paid-write access classes;
- complimentary entitlement overrides;
- organization feature disablement;
- separation between `organization_admin` and `billing_admin`;
- migration idempotency and existing export authorization.
- Checkout and portal authorization, fixed metadata, and customer reuse;
- webhook deduplication, ignored events, and failed-event recording;
- stale subscription-event suppression and stable past-due grace periods;
- provider-timestamp grace anchoring and multi-item subscription rejection;
- explicit replay of failed provider events after their cause is corrected;
- one-time legacy migration behavior for organizations created after the marker;
- same-price checkout reuse and different-price session replacement;
- atomic replacement of the migration subscription with a Stripe subscription.
- usage-event idempotency and conflicting-fingerprint rejection;
- successful response replay, in-progress rejection, and failed-attempt retry
  under one logical idempotency key;
- organization, BU, project, daily, and operation usage aggregation;
- `usage.view` authorization and tenant-scoped usage reporting;
- locale-aware word/Unicode character counting and provider token normalization.
- atomic reservation consumption/release, held-quantity plan enforcement, and structured `402` denial;
- current-period organization budget creation/replacement and warning/exceeded/blocked alerts;
- budget-alert acknowledgement and audit history.
- touched-metric alert filtering and unchanged-import zero metering.

## Known limitations

- No platform UI/API for plan, entitlement, or feature mutation yet.
- Admin → Billing & usage renders plan, credit and capacity summaries, a
  reviewed translation-overage cap, hosted Checkout and customer-portal links.
  Switching existing complex subscriptions is still subject to portal support;
  unsupported plan changes require billing support.
- Invoice summaries are available in Stripe’s portal but are not synchronized into Hedgeling.
- There is no scheduled reconciliation job yet; webhooks are the synchronization path.
- There is no scheduled event-payload redaction job yet; production launch requires the 90-day retention policy above to be automated.
- Successful responses created before response replay was introduced cannot be
  reconstructed; those legacy events return `409` with their event ID.
- LLM output/token limits use a one-unit minimum reservation because exact provider usage is known only after completion. One in-flight request can overshoot the remaining allowance.
- Budget alerts are visible in the console but are not yet sent by email, Slack, or webhook.
- Budgets currently govern metered quantities. Monetary budgets require the later provider-cost and work-cost ledgers.
- Human translation/configuration writes are not yet subscription-state gated; Phase 3A gates the initial paid processing and export surfaces only.
- The in-process evaluator reads PostgreSQL per check. Caching should be added only with explicit invalidation after provider and override updates.

## Included chat and organization AI keys

The October 2026 console foundation separates platform access, included chat,
and translation consumption:

| Capability | Commercial rule |
|---|---|
| Console chat | `agent_chat` on a current plan/trial; no translation credits or per-message charge |
| Managed AI translations | Existing versioned AI-credit rates, included allowance, and authorized overage cap |
| Organization Gemini key | `ai_byok` on Starter, Business, Enterprise; platform fees still apply, provider bills inference directly |
| Trial expiry | Stop new chat turns and agent confirmations; keep history, cancellation and permitted manual access |

The server checks chat access at run creation, message submission, resume,
continuation, each tool/model step, and confirmation. Trial timestamps are
checked directly even if a provider webhook has not arrived. Selecting no
organization does not grant production chat. The explicit local fixture may
demonstrate organization creation without a subscription, but does not bypass
the expiry of an actual trial record. Agent-created organizations still have
no subscription; outside the fixture they need commercial provisioning before
their chat becomes available. This does not create another self-service trial.

Chat records provider tokens and `agent_chat_tokens` for fair-use accounting;
it never records `ai_credits`. Default limits are 500,000 tokens per user per
database calendar day and 2,000,000 chat tokens per organization usage period.
These are safety limits, not billable overages. Organization/provider token
totals remain observable separately from customer translation charges.

`GET /api/access/organizations/:organizationId/billing-summary` requires
`billing.view`. It returns the local plan state, effective entitlements,
managed-string count and high-water mark, translation-credit use and estimated
AI-credit overage, included chat status, and safe Stripe configuration flags.
The AI estimate excludes base fees, string/seat overages and taxes. It is not
an invoice. Payment methods and invoices remain in the Stripe customer portal.
Checkout and spending changes require a human `billing.manage` principal.
Local troubleshooting refuses live Stripe keys.

Admin → AI providers & keys uses these endpoints:

| Method/path after `/api/access/organizations/:organizationId/ai-providers` | Behavior |
|---|---|
| `GET /` | Masked key metadata and provider selection; requires `ai_providers.view` |
| `POST /test` | Metadata-only Gemini model access check; no generated content |
| `POST /preview` | Prepare connect, replace, remove, or translation-mode change |
| `POST /proposals/:id/confirm` | Apply the exact pending change after fresh permission, plan and revision checks |
| `POST /proposals/:id/reject` | Discard a preview and scrub its secret payload |

All mutations require `ai_providers.manage` and a human console session. Owner
and organization-admin roles get management; billing admins get metadata read.
Service accounts and MCP do not receive key-management tools. Connection
previews reveal only the last four characters. Previews expire in 15 minutes;
stale revisions require another preview. Confirmations are idempotent. Audit
events contain masked before/after values, never plaintext or ciphertext.
Removal is allowed after a subscription expires. Removing a selected BYOK key
leaves BYOK selected and blocks new inference; no managed billing fallback is
permitted. Work already dispatched may finish using its selected credential.

Secrets use AES-256-GCM with a random nonce and tenant/provider-bound additional
authenticated data. Active and pending secrets are encrypted in PostgreSQL.
The deployment must inject `HEDGELING_AI_KEYRING` (JSON mapping version IDs to
base64-encoded 32-byte wrapping keys) and `HEDGELING_AI_KEY_ID` (active version)
from its server-side secret store. No key or endpoint belongs in frontend
configuration. Missing/invalid wrapping configuration disables key connection
and fails closed for BYOK inference. Preserve old wrapping-key versions while
saved credentials still use them; new saves use the active version. Key
replacement/removal does not revoke the corresponding key at Google.

Plaintext is accepted only by the dedicated HTTPS settings endpoint and is
never returned. Key material is sent to Google in a header, never a URL. Provider
errors are sanitized. Expired preview payloads are scrubbed on startup, every
minute while the server runs, and on preview/confirmation requests. Organization
purging deletes credentials, pending proposals and routing settings. Database
backup retention and deployment secret-store access remain operator concerns.

The existing single-string revision endpoint now resolves organization routing
server-side. BYOK revisions record provider usage but zero managed credits,
including on replay. Job execution must call the same resolver when implemented.
The managed chat provider is independent of translation routing.

Provider references: [Stripe-hosted Checkout](https://docs.stripe.com/payments/checkout),
[Stripe test environments](https://docs.stripe.com/testing),
[Gemini key handling](https://ai.google.dev/gemini-api/docs/api-key),
[Gemini model metadata](https://ai.google.dev/api/models).

## Usage-rollup operations

New usage events snapshot their billing period and update the immutable ledger,
application marker, applicable period rollups, reservation state, and
touched-metric alerts in one transaction. Legacy events use the best retained
subscription period or a calendar fallback once, then keep that snapshot
stable. They can be projected with:

```bash
npm -w @hedgeling/web-console run usage:rollups:backfill -- \
  --batch-size 500 --max-batches 100
npm -w @hedgeling/web-console run usage:rollups:compare
```

Comparison exits non-zero for unapplied events or any quantity, event-count,
scope, period, or counting-version mismatch. After investigating the cause, an
operator may rebuild one organization's projection from its immutable ledger:

```bash
npm -w @hedgeling/web-console run usage:rollups:repair -- \
  --organization-id 00000000-0000-0000-0000-000000000000
```

Deployment, contention, rollback, and evidence requirements are documented in
CAPACITY-BASELINE.md (private product document; not included in this export).
