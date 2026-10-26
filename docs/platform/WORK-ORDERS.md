# Agency work orders and assigned content access

Status: Phases 5B and 5C implemented. Work orders convert an approved relationship
rate into an immutable commercial commitment, authorize named agency linguists
to see only attached strings, and produce an append-only payable work ledger
after customer quality approval.

## Boundary and authority

A work order belongs to one `vendor_relationship` and one project owned by the
relationship customer. The customer creates and offers it. The agency accepts
it. Assignment, delivery, and approval never turn the linguist into a customer
organization member or expose the rest of the project.

The administrative API verifies that the organization in the URL is a party to
the relationship. Agency actions require organization-scoped agency
permissions. Customer work-order viewing, management, and quality decisions
accept the corresponding permission at organization, inherited BU, or project
scope and filter work-order discovery to that scope. Payable, dispute, and
payment actions remain organization-scoped. The personal work API is different:
it starts from the authenticated user's assignment ID and does not require
`organization.view` or general project permission.

Customer-content access requires the complete chain at request time:

```text
active user
+ active, unexpired agency membership
+ agency linguist role and matching role conditions
+ active relationship inside its effective dates
+ matching project/BU and locale/service/content relationship scopes
+ current nomination and customer approval when required
+ matching linguist conditions
+ active assignment (completed is read-only)
+ source string explicitly attached to the assigned work order
+ readable/editable work-order state
```

Every input is resolved server-side. A successful Phase 4 eligibility check or
approved-linguist row is never sufficient by itself. Stable denial codes explain
which link failed. Relationship suspension, approval revocation, membership
suspension, or scope changes take effect on the next request.

## Lifecycle

```text
draft --customer offers--> offered --agency accepts--> accepted
accepted --linguist starts--> in_progress
accepted|in_progress --linguist submits--> submitted
submitted --customer requests changes--> in_progress
submitted --customer approves quality--> quality_approved
quality_approved --customer approves payable--> payable_approved
payable_approved --statement finalized--> included_in_statement
included_in_statement --confirmed payment completes statement--> paid
included_in_statement --statement voided--> payable_approved
```

The customer may cancel `draft`, `offered`, `accepted`, or `in_progress` work.
The agency may cancel `offered` or `accepted` work. Cancellation requires a
reason and revokes active assignments. `canceled` and `paid` are terminal.
Canceled work has no in-platform compensation path in Phase 5: adjustments and
statements require quality-approved work. Parties must settle partial canceled
work outside Hedgeling and retain the cancellation reason until a dedicated
cancellation-settlement workflow is designed.

Quality approval (`quality.approve`) and payable approval
(`payables.approve`) are deliberately separate. A quality rejection records the
decision on that submission and returns the order to `in_progress`; a new
idempotent submission is then required. Quality approval completes active
assignments but keeps their attached content readable as history while the
relationship and identity chain remain valid.

## Rate selection and snapshot

Offering requires one current approved rate-card line whose service and unit
match exactly. Optional selectors are conjunctive. The most specific applicable
line wins in this order:

1. project;
2. business unit;
3. target locale;
4. source locale;
5. content type;
6. match band;
7. stable line ID as the final deterministic ordering.

The order snapshots the card and line IDs, currency, currency exponent, unit
rate, minimum units, minimum charge, and payment terms. PostgreSQL verifies that
the snapshot equals the selected immutable card/line facts. Later rate-card or
relationship-default changes do not alter accepted work.

Draft commercial fields and attached strings are editable. Offering freezes
both. Each attached source string must belong to the order project. Project
moves and tenant-crossing membership changes that would invalidate historical
work are blocked below the API.

## Assignments and personal work API

An assignment references an active membership in the relationship agency.
Customer-managed assignment is the default. The agency may assign only when the
customer enabled `agency_may_assign_linguists`. In either case the shared
eligibility evaluator must pass at assignment time and again whenever the
linguist reads or writes content.

Personal routes:

| Route | Behavior |
|---|---|
| `GET /api/work/assignments` | Lists the caller's active and completed assignments without exposing unrelated relationships or projects |
| `GET /api/work/assignments/:assignmentId/content` | Returns only source strings attached to that order |
| `PUT /api/work/assignments/:assignmentId/content/:sourceStringId/translations/:locale` | Saves a human translation only for the order target locale and an attached string |
| `POST /api/work/assignments/:assignmentId/start` | Moves accepted work to `in_progress` |
| `POST /api/work/assignments/:assignmentId/submit` | Creates an idempotent delivery fact and moves the order to `submitted` |

Translation edits use the existing translation/revision model and remain
pending until the work-order quality decision. Authorization is re-evaluated
inside the write transaction after locking the relationship, order, assignment,
organizations, identity, membership, team/role grants, and approval facts used
by the decision. The corresponding access-management updates therefore cannot
race a personal translation or submission commit.

An agency edit cannot overwrite or downgrade a customer-verified translation.
The write returns `409 verified_translation_protected` with the prior status;
the customer must explicitly reopen the translation before agency work can
continue. Successful writes return `previousHumanStatus` alongside the saved
translation so callers can surface the state transition. Source-row locking
serializes edits to the same attached string across overlapping work orders,
while revision history remains the durable text-change record.

## Administrative API

All routes below are under
`/api/access/organizations/:organizationId/vendor-relationships/:relationshipId`.

| Route | Permission | Party |
|---|---|---|
| `GET /work-orders` | `work_orders.view`, project-filtered for scoped customer grants | Either |
| `POST /work-orders` | `work_orders.manage`, organization/BU/project | Customer |
| `PUT /work-orders/:workOrderId` | `work_orders.manage`, organization/BU/project | Customer, draft only |
| `POST /work-orders/:workOrderId/transitions` | Action-specific at the order scope; payable approval stays organization-scoped | Customer or agency |
| `POST /work-orders/:workOrderId/assignments` | `work_orders.manage`, organization/BU/project for customer | Policy-dependent |
| `PATCH /work-orders/:workOrderId/assignments/:assignmentId` | `work_orders.manage`, organization/BU/project for customer | Either authorized operations party |
| `POST /work-orders/:workOrderId/adjustments` | `payables.approve` | Customer |
| `POST /work-orders/:workOrderId/disputes` | `disputes.open` | Either |
| `PATCH /work-orders/:workOrderId/disputes/:disputeId` | `payables.approve` | Customer |

Transition requests use `action` values `offer`, `accept`, `quality_approve`,
`quality_reject`, `payable_approve`, or `cancel`. Rejection and cancellation
require a reason.

The list returns at most 250 visible orders plus `page.hasMore`. Continue with
`beforeWorkOrderNumber=<page.nextBeforeWorkOrderNumber>`. Organization-wide
viewers are bounded before detail loading; project/BU-scoped viewers resolve
visibility set-wise before the response cap so unrelated newer orders cannot
hide an authorized older order.

## Delivery and work ledger

Each delivery is immutable except for one customer quality decision. The
idempotency key is unique within the work order. An exact retry replays the
stored submission; reusing the key with different assignment, quantity, or
notes returns `409`.

Quality approval appends one `approved_delivery` ledger entry. Amounts use
integer currency minor units:

```text
billable quantity = max(delivered units, snapshotted minimum units or 0)
calculated amount = round(billable quantity × unit rate × 10^currency exponent)
base payable = max(calculated amount, snapshotted minimum charge or 0)
```

Work-order responses include a `deliveryReview` with the locale-aware computed
source-word total, counting version, latest self-reported delivered units, and
the order estimate. Before quality approval, the console warns on any mismatch
between source-word units and the computed total, or between other delivered
units and the work-order estimate. The warning does not change the amount:
customer quality approval remains the control that accepts the submitted units
and creates the payable ledger entry.

The ledger is append-only. Customer adjustments are separate signed entries
with a required reason and idempotency key. Work in a current statement cannot
be adjusted. Reversal rows are modeled and database-validated for future
correction workflows; there is no reversal API yet.

## Database integrity, audit, and console

PostgreSQL enforces customer/agency ownership, work and assignment lifecycles,
rate-snapshot fidelity, source-string project ownership, unique active
assignments, one quality decision per submission, and the append-only ledger.
Commercial history cannot be deleted through normal cascades.

Work-order, assignment, delivery decision, adjustment, and dispute actions write
audit events to both relationship organizations. The Access view provides
commercial administration. “My work” is a separate project-independent view so
an agency linguist with no customer membership can work only on assigned
content. Administrative responses exclude source text, hide rate snapshots
without `rate_cards.view`, and hide ledger totals and disputes without
`payables.view`. Free-text order descriptions and delivery/quality notes are
visible only to work managers and quality approvers. UI visibility is not an
authorization control.

## Verification and deferred work

Unit tests cover the final assignment-content evaluator, including completed
read-only access and explicit item membership. PostgreSQL integration follows
create → offer → accept → assign → edit → submit → reject → resubmit → quality
approve → adjust → dispute → payable approval and verifies idempotent replay,
tenant guards, verified-translation protection, quantity variance disclosure,
dispute-open permission separation, immutable ledgers, and dual-party audit.

Deferred behavior includes batch assignment, per-item assignees, simultaneous
translator/reviewer stages, deadlines and reminders, richer work-order search,
translation-memory match calculation, cancellation compensation, and a ledger
reversal endpoint. Work-order details now load in six fixed set-based queries,
and personal assignment eligibility is one set-based tenant/relationship query;
PostgreSQL integration tests pin those query counts as result volume grows.
The initial Access console is the organization-level commercial administration
surface; project/BU-scoped customer reviewers are fully supported by the API,
while a dedicated scoped review queue remains a UI follow-up.
