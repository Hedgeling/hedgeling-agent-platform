# Self-service customer onboarding

Status: commercial foundation implemented; provider configuration and
production certification remain.

This contract covers customer account creation, the no-card trial, first
workspace provisioning, project credentials, and the transition to a paid SaaS
subscription. Agency organizations and individual vendors remain
invitation-only.

## Product decisions

- The trial lasts 14 days and does not collect a card.
- One verified user may claim one self-service trial workspace.
- A claim creates one customer organization, one `Main` business unit, and one
  first project.
- The customer chooses one source locale, up to three target locales, and one
  versioned workflow preset.
- Managed Gemini is the default trial AI provider. Trial and Starter use the
  efficient managed model tier; Business unlocks frontier-model routing.
  Organization-owned Gemini keys are available on all paid plans through the
  `ai_byok` entitlement. They replace managed translation-credit charges, not
  the platform subscription. Bedrock remains a future provider extension.
- Agent chat is included with the platform and the 14-day no-card trial.
  Chat never consumes translation credits or incurs per-message overages.
  Fair-use limits still apply. At trial expiry, chat becomes read-only with
  an upgrade prompt; existing history and permitted manual pages remain
  accessible. There is no permanent free platform tier in this release.
- Business is intended to be a fully self-service Stripe upgrade. Enterprise
  may use a sales-assisted path.
- Facilitated vendor payments are not enabled by a SaaS upgrade. An eligible
  Business or Enterprise customer must separately enter the facilitated-
  payment program and satisfy its operational approval gates.

The first release records the verified owner's non-public email domain for
future anti-abuse policy but enforces the hard, race-safe rule at the user
level: `self_service_trial_claims.owner_user_id` is unique. Domain-wide trial
history and public-email abuse controls require a reviewed policy before they
become blocking rules.

## Trial limits

| Resource or usage | Limit |
|---|---:|
| Business units | 1 |
| Projects | 1 |
| Target locales | 3 |
| Active source strings | 2,500 |
| AI credits | 25,000 |
| Internal users | 3 |
| Vendor relationships | 1 |
| Agency linguists | 5 |
| Active work orders | 3 |
| Glossary terms | 500 |
| Active workflows | 1 |
| Service accounts | 1 |
| Active credentials | 2 |
| Concurrent AI runs | 1 |

The AI-credit limit is a hard stop with no trial overage. The request reserves
a conservative maximum before the provider call and reconciles to the
successful final call. System prompts, input, output, cached input, and
reasoning tokens can each have an immutable rate. Failed provider requests and
internal validation retries remain observable as raw provider tokens and COGS,
but consume zero customer AI credits.

The launch managed-Gemini rate card calibrates the worst-case credit COGS at
approximately `$0.00008/credit`: the 25,000-credit trial therefore has a
roughly `$2` AI COGS ceiling, and Starter's 50,000 credits roughly `$4`. A rate
card is never edited after use; a provider price or model-policy change creates
a new effective version. PostgreSQL permits draft rate-card edits, but active
cards may only transition to retired; their rates cannot be inserted, updated,
or deleted after publication. Published Stripe price mappings likewise permit
only activation/deactivation and metadata changes, never economic-field edits.

The source-string and target-locale limits are rechecked under an
organization-scoped transaction lock during imports. The remaining resource
limits are part of the product contract and must be added to each corresponding
creation route before public launch.

## Paid commercial contract

| Plan | Base | Managed strings | Locales | Included AI credits | Private npm seats |
|---|---:|---:|---:|---:|---:|
| Starter | $49 monthly | 2,500 hard limit | 3 | 50,000 hard stop | 1 included; second $15/month; maximum 2 |
| Business | $3,588 paid annually | 15,000 included; $15 per started 1,000 above; hard maximum 50,000 | Unlimited | 100,000/month; $10 per started 10,000 above | 5 included; $15/month each above |
| Enterprise | Custom, starting at $1,500/month annual commit | Custom | Unlimited | Custom, starting at 500,000 | Contract |

Starter has no annual cadence and no micro-overages. Business's annual base is
non-refundable; AI, string, and seat overages settle monthly in arrears.
Credits reset on the monthly usage anniversary and never roll over. Business
customers choose a hard monthly AI-credit overage cap; a request whose
pre-reservation would exceed the remaining cap is rejected before provider
work.

Managed strings and npm seats use an organization-wide monthly high-water mark.
Deleting a string or revoking a seat does not lower the current month's bill.
Pending npm invitations count immediately. A failed provider operation also
continues to reserve its seat because Hedgeling cannot safely assume that npm
did not create access; an operator must retry, reconcile, or explicitly revoke
the assignment before the seat becomes available again. Repositories and
workflow instances are unlimited on paid plans; Hedgeling measures value
through strings and consumption rather than repository count.

## Fixed, versioned workflows

“Fixed” means onboarding chooses a supported template instead of assembling an
arbitrary state graph. “Versioned” means an existing project stays on the exact
template behavior it selected even after Hedgeling publishes a new revision.

Version 1 includes:

1. AI → Publish
2. AI → Human review → Publish
3. AI → Translator edit → Lead approval → Publish
4. Human translation → Reviewer approval → Publish

`workflow_presets` stores immutable template versions.
`project_workflows` records the active project selection. Changing a template
later must supersede the old project row; it must not rewrite history.

## Account and workspace flow

```text
GET  /signup
POST /api/auth/signup
POST /api/auth/signup/confirm
POST /api/auth/login
GET  /onboarding
POST /api/onboarding/workspace
GET  /api/billing/plans
POST /api/access/organizations/:organizationId/billing/checkout
```

1. Cognito creates an email-address account and sends a confirmation code.
2. The verified first sign-in creates or links the local Hedgeling user.
3. Workspace provisioning validates current legal document versions.
4. One PostgreSQL transaction creates the organization, BU, project, locales,
   owner membership/grant, identity policy, billing account, local trial
   subscription, workflow selection, trial claim, legal evidence, audit fact,
   and first service account/credential.
5. The plaintext service credential is returned once. Only its SHA-256 digest
   is stored.
6. A retried provisioning request returns the existing workspace and never
   creates a second trial or credential. If the one-time plaintext response was
   lost, onboarding uses the normal rotation API to revoke it and show one
   replacement.

The initial credential expires after 180 days. The existing credential
rotation APIs remain the authority for overlapping replacement and revocation.

The package uses that credential to request a signed Ed25519 entitlement lease.
The lease is project-bound, lasts at most 24 hours, and is cached locally. A
valid lease controls local extraction, diagnostics, hosted AI, and BYOK
capabilities independently. When billing becomes non-current, the next lease
keeps catalog reads and production fallback but disables new extraction,
diagnostics, and translation work. If the console is temporarily unavailable,
an unexpired prior lease remains usable. Production CI must pin
`HEDGELING_LEASE_PUBLIC_KEY`; accepting the key returned by the console is a
development convenience, not a production trust policy.

Bundler integrations fail open for the application build but closed for new
Hedgeling value: an expired or restricted lease skips new auto-wrap transforms,
warns once, preserves the last generated catalog/runtime bundle, and returns
success so a billing incident cannot take down production CI. A plugin instance
caches the verified decision for at most 30 seconds so a build does not perform
filesystem reads and Ed25519 verification for every module. The explicit
`hedgeling check` release gate instead exits `2` when diagnostics are paused;
it cannot report a vacuous green check.

The lease is commercial enforcement for ordinary customer operation, not DRM
against a developer who controls the package process and source. A user who
removes both the integration configuration and local enrollment cache—or
patches the installed package—can bypass local-only checks. Hedgeling therefore
keeps hosted AI, imports, project APIs, package distribution, and other costly
value behind server-side authorization. Product and customer documentation
must not claim that possession of package bytes is cryptographically prevented
from bypassing local extraction.

Trial and Starter AI revisions always use the configured efficient Gemini
model. Business and Enterprise may use a separately configured frontier Gemini
model only after an immutable active rate exists for that exact provider,
model, and operation. The provider/model cache is isolated by model name so a
frontier response can never be reused for an efficient-tier request. Other
frontier provider adapters remain a later extension behind the same plan and
rate-card boundary.

Private npm membership is handled through a leased transactional outbox, never
inside a Stripe webhook. The worker adds the npm developer membership and then
the dedicated customer-reader team; configuration explicitly rejects the
default `developers` team as the customer package-access team. The npm
organization must be hardened separately so `developers` has no write access
to `@hedgeling/i18n` and the customer-reader team has package-level read-only
access. A terminal Stripe subscription cancellation queues all current
customer npm seats for asynchronous revocation in the same local transaction.
Past-due payment events do not revoke registry membership—the signed lease
freezes new commercial work while preserving clean production installs—but
they do prevent new npm seats.

Public signup endpoints apply both a coarse per-IP request ceiling and a
normalized-email dimension. These in-process controls are defense in depth;
the production edge must also enforce a fleet-wide AWS WAF (or equivalent)
rate rule so requests distributed across tasks cannot evade the ceiling.

Trial distribution does not create npm organization membership. An active
trial owner may request an audited presigned GET for one immutable `.tgz`
artifact in a private S3 bucket. The link lasts at most ten minutes, never
outlives the trial, is rate-limited to ten issuances per owner per hour, and
returns the artifact's pinned SHA-256 digest. Storage coordinates are not part
of the public configuration. Every authorization is recorded in
`trial_package_download_issuances`; successful issuance also writes the normal
organization audit fact.

Artifact keys are versioned and uploaded with `If-None-Match: *`, so a release
cannot silently replace bytes under an existing key. The console task role
needs `s3:GetObject` only for the configured object prefix; the release role
needs `s3:PutObject`. The bucket remains private and blocks public access.
Publish a reviewed `npm pack` artifact with:

```sh
HEDGELING_TRIAL_PACKAGE_BUCKET=hedgeling-private-artifacts \
HEDGELING_TRIAL_PACKAGE_KEY=trial-packages/i18n/0.1.0/hedgeling-i18n-0.1.0.tgz \
AWS_REGION=us-east-1 \
npm -w @hedgeling/web-console run trial-package:publish -- \
  --file ./hedgeling-i18n-0.1.0.tgz \
  --version 0.1.0
```

The command prints the immutable digest and exact runtime environment values.
Production self-service startup fails closed unless trial package distribution
is enabled and fully pinned. The installed archive participates in the signed
lease flow, while server-side APIs remain the authoritative commercial
boundary; local lease checks have the honor-system limitation described above.
Private npm membership begins on Starter; Trial therefore retains zero npm
seats and avoids the approximately `$7` acquisition cost.

## Trial expiration and upgrade

The local trial is a provider-neutral subscription whose
`current_period_end = current_period_start + 14 days`. Paid writes fail closed
after the period end even if no background job has rewritten the subscription
state. Retention remains available, and verified export remains available
through the explicit 30-day `grace_ends_at`.

The public plan catalog exposes only active plans with
`product_plans.metadata.public = true`. It never exposes Stripe provider price
IDs. Checkout accepts the stable local `billing_prices.key`.

When Stripe confirms the paid subscription, webhook reconciliation cancels the
local trial subscription before inserting/updating the Stripe subscription.
The existing one-current-subscription index remains the database backstop.

Public presentation is stored on versioned plan metadata. Stripe Price and
Meter IDs remain provider configuration and are never returned publicly;
Checkout accepts only the stable local `billing_prices.key`.

The reviewed provider objects are activated with:

```sh
npm -w @hedgeling/web-console run billing:configure-self-service
```

The command retrieves all six configured Stripe Prices first and verifies USD
amount, monthly/annual cadence, active state, and licensed-vs-metered behavior.
Only then does one database transaction activate the versioned local mappings.
An existing local key can never be repointed to a different provider Price.
Changing a Stripe price requires a new versioned key and a reviewed migration.

Starter Checkout creates one flexible monthly subscription containing the base
and configured monthly meter items. Checkout cannot create a mixed-interval
Business subscription. Business therefore uses this durable sequence:

1. Checkout runs in Setup mode and authenticates a reusable off-session payment
   method.
2. The signed `checkout.session.completed` webhook links the customer and
   inserts one idempotent subscription-provisioning job.
3. A leased worker creates the flexible Stripe subscription with the annual
   base plus every monthly meter item.
4. Subscription webhooks project the base period, monthly usage period, and
   every provider subscription item locally.
5. On a monthly item-period transition, Hedgeling freezes one local period
   summary from AI-credit rollups and string/npm high-water facts.
6. A second outbox sends one Stripe meter event per non-zero summary. Retries
   stop before Stripe's provider-identifier safety window expires and require
   manual reconciliation rather than risking duplicate billing.

If late rollups raise a previously staged closed-period total, restaging locks
the summary and appends a separate adjustment fact/outbox item for only the
positive delta. It never mutates or re-sends the already delivered provider
fact. Replaying the same target is idempotent. A lower recomputed total is not
silently netted against Stripe; it fails with a manual-reconciliation outcome
so an operator can choose the provider-appropriate credit path.

The annual base period never becomes the AI-credit period. All reservation,
budget, usage-summary, and meter calculations prefer
`subscriptions.usage_period_*`, which is projected from the monthly Stripe
items.

For self-service plans, `paymentFailureGraceDays = 0`. A past-due payment keeps
existing verified translations, exports, retention, and production fallback
available, while new extraction, diagnostics, imports, hosted AI, revisions,
and npm-seat additions stop immediately.

## Cognito and deployment gates

Self-service is fail-closed unless:

- `HEDGELING_SELF_SERVICE_SIGNUP_ENABLED=true`;
- the auth mode is `cognito`;
- the dedicated Cognito pool permits public user signup;
- the public app client supports password authentication without a client
  secret;
- verified-email delivery is operational;
- current legal versions and HTTPS document URLs are configured; and
- the ordered database migration has completed.

The AWS configuration and drift-verification scripts derive
`AdminCreateUserConfig.AllowAdminCreateUserOnly` from the signup flag. Keeping
the flag false preserves invitation-only Cognito behavior.

## Configuration

```text
HEDGELING_SELF_SERVICE_SIGNUP_ENABLED=true
HEDGELING_SELF_SERVICE_TRIAL_DAYS=14
HEDGELING_TERMS_VERSION=...
HEDGELING_PRIVACY_VERSION=...
HEDGELING_TERMS_URL=https://...
HEDGELING_PRIVACY_URL=https://...
HEDGELING_LEASE_SIGNING_PRIVATE_KEY=...
HEDGELING_LEASE_SIGNING_KEY_ID=...
HEDGELING_LEASE_TTL_HOURS=24
# Required in package production CI; publish it with the package setup docs.
HEDGELING_LEASE_PUBLIC_KEY=...
HEDGELING_EFFICIENT_GEMINI_MODEL=gemini-3.5-flash-lite
HEDGELING_FRONTIER_GEMINI_MODEL=...
HEDGELING_NPM_ORGANIZATION=hedgeling
HEDGELING_NPM_CUSTOMER_TEAM=hedgeling:customer-readers
HEDGELING_NPM_PACKAGE=@hedgeling/i18n
HEDGELING_NPM_TOKEN=...
```

Production startup requires the two legal URLs to be absolute HTTPS URLs.

## Remaining launch work

- create the private trial-artifact bucket, least-privilege release/runtime IAM
  policies, publish the first immutable package, and configure its pinned
  version/key/digest;
- create and map the reviewed Stripe base Prices, usage Prices, Meters, event
  names, included quantities, and block sizes;
- schedule and alarm the subscription-provisioning, meter-delivery, and npm
  provisioning workers;
- add a fleet-wide signup/confirmation/resend rate rule at the production edge;
- add hosted batch translation to the package; the current local `translate`
  command is BYOK and therefore requires the paid-plan `ai_byok` entitlement;
- enforce seat, vendor, linguist, work-order, glossary, credential, and
  concurrency resource caps at their mutation boundaries;
- add email/domain anti-abuse policy and operational override tooling;
- add signup/onboarding Playwright coverage against a disposable Cognito
  environment;
- implement trial-expiry and approaching-limit notifications;
- implement the 30/14/7/1-day credential-expiry warning schedule; and
- certify signup → private-package access → lease → import → AI revision →
  export → Starter Checkout and Business mixed-interval upgrade in a
  production-like environment.
