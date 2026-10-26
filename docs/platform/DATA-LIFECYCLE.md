# Customer data lifecycle

Status: implemented application contract; production schedule remains disabled
until an operator runs the launch verification.

## Policy decision

Hedgeling gives a customer **30 calendar days** to export translation catalogs
after the customer confirms deletion of a project or termination of an
organization. At the deadline, console and package access lock immediately.
The scheduled worker then purges customer translation content and records an
auditable tombstone.

A temporary billing state such as `past_due`, `paused`, or the associated
degraded read-only mode does **not** start the deletion clock. A subscription
cancellation also does not silently delete data. The clock starts only from an
explicit, authenticated deletion request whose operator types the current
project or organization name. This separates payment recovery from an
irreversible customer-content decision.

The default is controlled by `HEDGELING_DATA_EXPORT_GRACE_DAYS=30`; the service
accepts only 1–90 days. Changing this setting is a legal/product policy change,
not an ordinary runtime tuning decision.

## Lifecycle

```text
active
  -> scheduled / export-only
  -> locked at export_available_until
  -> processing
  -> purged

scheduled or failed -> canceled (before export deadline)
scheduled or failed -> legal hold -> released
processing -> failed -> leased retry
```

The customer may cancel an unheld pending request before the export deadline.
Once the deadline passes, cancellation is not available. A platform
super-admin may apply a legal hold to a scheduled or failed request. A legal
hold pauses the purge worker, prevents customer cancellation, and does not
extend or restore customer access.

Only one nonterminal organization request and one nonterminal request per
project can exist. Organization deletion cannot be scheduled while project
deletion requests remain pending. Project deletion cannot be scheduled while
organization deletion is pending.

## Export-only behavior

During the export window, project permissions are reduced to:

- strings and translations read;
- locales, prompts, personas, and glossary read;
- verified catalog export.

Imports, edits, approvals, AI generation/revision, extraction, diagnostics,
new credentials/package downloads, member changes, and workflow changes are
denied. A canceled
subscription cannot defeat the promised export window: the export-class
entitlement receives a lifecycle-only exception even when the plan did not
include export. An organization-specific feature override also cannot withdraw
this portability right. The platform feature default remains an emergency
global security kill switch and must alert operations if it interrupts an
active export window. Vendor/work-assignment access is denied as soon as
deletion is scheduled; the export window belongs to the customer, not its
external agency.

New signed package leases disable extraction, diagnostics, hosted/BYOK AI, and
all mutations as soon as deletion is scheduled. Catalog read remains available
only through the deadline. Lease expiration is clamped to that deadline, so a
new lease cannot extend customer access beyond it; once the deadline has
passed, the lease endpoint returns `403` rather than signing a dead lease. An offline lease issued
before the request may remain usable for its existing maximum 24-hour TTL;
shortening that TTL is an incident-response option.

During the export window, organization permissions are reduced to lifecycle
status/cancellation, billing and usage read, and audit read/export. At the
export deadline, audit read/export is also removed so an embedded historical
snapshot cannot become a content side door while purge is pending or held. At
purge completion, ordinary organization and project access is empty, including
for platform super-admins; the separately authenticated platform lifecycle
routes remain available for legal holds and recovery.

The human requester retains narrowly scoped access to their completed purge
receipt through the tenant lifecycle `GET`. This receipt-only path returns only
that requester's purged requests and does not restore organization membership
or access to ordinary tenant APIs. Other operators use the platform lifecycle
route.

## Preconditions

Organization deletion requires a provider-backed subscription to be `canceled`
or `unpaid`. The worker repeats this provider-subscription check while holding
the organization purge lock so a subscription reactivated during the export
window cannot be orphaned by local account closure. Project and organization
deletion fail closed while they have:

- nonterminal work orders;
- unsettled payable statements;
- active payment attempts, refunds, or reversals;
- active provider disputes;
- open facilitated-payment exceptions or recovery cases.

The worker rechecks these conditions immediately before purge. An obligation
created after scheduling therefore fails the request instead of deleting data
under an active commercial process.

## Purged data

For each project, the worker deletes or redacts:

- translations and translation revision text;
- source text, source hashes, and source context (source rows referenced by
  historical work orders become non-content tombstones rather than being
  deleted through a restricted foreign key);
- context variants and AI analysis payloads;
- prompts, personas, glossary terms, locales, and workflow configuration;
- Gemini call payloads and pipeline-run records;
- usage-event response bodies, locale/content item metadata, and direct
  content pointers;
- customer-content snapshots embedded in matching audit records;
- onboarding locale/service-credential projections, vendor project scopes,
  and active project grants. The onboarding row itself remains as a stable
  organization bootstrap link so live self-service reads do not lose their
  relational anchor when the first project becomes a tombstone.

Project and business-unit identifiers remain as pseudonymized tombstones so
immutable usage, payable, and audit relationships continue to reconcile.

Organization termination additionally:

- revokes service credentials, SCIM tokens, recovery/support access, roles,
  and memberships;
- removes invitations, teams, SCIM links, verified domains, and enterprise
  identity connections;
- pseudonymizes customer-defined role labels while retaining referenced
  authorization history;
- stages idempotent private-npm membership revocation through the existing
  provisioning outbox;
- terminates vendor relationships and archives business units;
- closes and removes contact data from the local billing account;
- replaces the organization name and slug with a non-content tombstone.

## Retained records

Hedgeling retains the minimum facts needed for accounting, security evidence,
legal claims, and provider reconciliation:

- billing, invoice, tax, payment, refund, dispute, transfer, and recovery facts;
- work-order/payable quantities and amounts, with source content tombstoned;
- aggregate and append-only usage measurements, with response content removed;
- legal acceptance evidence;
- the one-trial-per-owner claim, with its copied owner email/domain removed;
- audit action, actor, resource, time, and lifecycle evidence, with customer
  content/profile snapshots removed where identified.

Retention periods for those categories require final legal approval and are
tracked in launch certification. This account-termination flow is not a
substitute for an individual data-subject deletion workflow for a user who may
belong to multiple organizations.

## Backup boundary

The purge applies to the live database. Current infrastructure provisions
seven-day RDS automated-backup retention, so deleted content may remain in an
encrypted, access-controlled recovery copy until that backup expires. Manual
snapshots must not be retained outside the approved retention schedule.
Any restore procedure must re-run the lifecycle worker before reopening
customer traffic and reconcile the restored state against deletion evidence.
Legal must approve the final backup and financial-record retention schedule
before the public policy promises a precise backup-erasure deadline.

## API and worker

Tenant endpoints (human; mutations require `organization.delete`, while the
post-purge `GET` has the requester-only receipt exception described above):

- `GET /api/access/organizations/:organizationId/data-lifecycle`
- `POST /api/access/organizations/:organizationId/data-lifecycle`
- `POST /api/access/organizations/:organizationId/data-lifecycle/:requestId/cancel`

Platform super-admin endpoints:

- `GET /api/platform/data-lifecycle`
- `POST /api/platform/data-lifecycle/:requestId/hold`
- `POST /api/platform/data-lifecycle/:requestId/release-hold`
- `POST /api/platform/data-lifecycle/:requestId/retry`

The scheduled worker runs:

```sh
npm -w @hedgeling/web-console run data-lifecycle:process
```

Claims use `FOR UPDATE SKIP LOCKED`, a UUID lease, a 15-minute lease timeout,
and a 64-bit organization advisory lock. Failed requests retry after one hour
for at most `HEDGELING_DATA_LIFECYCLE_MAX_ATTEMPTS` attempts (default `24`).
At the circuit-breaker limit, `retry_at` remains null and only the audited
platform retry endpoint can authorize another attempt. Failures emit a nonzero
worker exit for alarming. Purge operations are idempotent at the project
tombstone boundary.

## Operations checklist

Before enabling the production schedule:

1. migrate the production schema;
2. run the worker once with the schedule disabled and verify its EMF output;
3. verify tenant cancellation and platform hold/release against a disposable
   customer organization;
4. verify npm revocation outbox processing;
5. verify failed-request and scheduler-delivery alarms;
6. perform a restore drill and confirm due deletion requests are reprocessed;
7. obtain legal approval for retained-record and backup schedules.
