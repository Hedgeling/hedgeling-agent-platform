# Platform state machines

## Membership

`invited -> active -> suspended -> removed`

Invitations expire. Removed memberships are retained for audit history and cannot authorize access.

## Vendor relationship

`invited -> onboarding -> active -> suspended -> terminated`

Only an active relationship can authorize new or continuing customer assignments. Suspension immediately blocks access while preserving work and financial history.

The agency moves `invited -> onboarding`; the customer moves `onboarding -> active`,
`active -> suspended`, and `suspended -> active`. Either party may terminate a
non-terminated relationship. Activation requires an active agency member and at
least one explicit customer business-unit or project scope.

## Rate card

`draft -> submitted -> approved -> superseded`

`submitted -> rejected` is also valid. The agency creates, edits, and submits;
the customer approves or rejects. There is one open proposal and one current
approved version per relationship. Approval atomically supersedes the previous
approved version. Submitted and historical commercial terms and lines are
immutable; changes create a new version. Phase 5A does not schedule
future-effective approvals.

The executable contract is documented in RATE-CARDS.md (private product document; not included in this export).

## Work order

```text
draft -> offered -> accepted -> in_progress -> submitted
accepted ------------------------------------> submitted
submitted --changes requested---------------> in_progress
submitted --quality approval----------------> quality_approved
quality_approved --payable approval---------> payable_approved
payable_approved --statement finalization---> included_in_statement
included_in_statement --statement void------> payable_approved
included_in_statement --statement paid------> paid
```

Customer or agency cancellation is state- and party-limited and requires a
reason. Quality and payable approval use separate permissions. Submission,
quality decision, rate snapshot, and work-ledger facts are immutable; correction
uses a new submission, adjustment, dispute, or future reversal. Canceled work is
terminal and cannot enter the Phase 5 payable ledger; partial-work compensation
is explicitly off-platform until a cancellation-settlement state is introduced.

## Work assignment

`active -> completed|revoked`

Quality approval completes active assignments. Cancellation or an explicit
administrative action revokes them with a reason. Completed assignments retain
read-only access to attached work while the full vendor authorization chain
remains valid.

## Work dispute

`open -> resolved|rejected`

One dispute may be open per work order. Open disputes block payable approval,
statement finalization, and payment recording. Opening requires
`disputes.open`; payables visibility alone cannot cause this state transition.

## Payable statement

`draft -> finalized -> paid`

`draft|finalized -> void`

Finalization includes payable-approved work. Void returns finalized work to
`payable_approved` and is unavailable after any payment record exists. Exact
confirmed payment totals atomically mark the statement and its work orders paid.

## External payment record

`reported -> confirmed|rejected`

Agency records require a customer decision. Customer-created records begin
confirmed. Records are retained as externally supplied settlement evidence and
do not move funds.

## Facilitated payment

Phase 7 keeps customer funding, agency transfer, and bank payout as separate
state machines:

Connected-account readiness is independently projected from signed Stripe
events or explicit reconciliation:

```text
account: not_started -> pending|ready|restricted|disabled
         pending -> ready|restricted|disabled
         ready -> restricted|disabled
         restricted -> ready|disabled
         disabled -> no automatic transition
```

`restricted` can recover only when the provider projection is fully `ready`;
it never falls back to `pending`. `disabled` is sticky so deauthorization or
deletion cannot be undone by a later routine account update. Phase 7B does not
yet expose connected-account supersession or self-service re-enable.

```text
payment: created -> requires_action -> processing -> succeeded
         created|requires_action|processing -> failed|canceled

funding: unfunded -> funded
         funded -> partially_refunded|funding_reversed|returned|disputed
         partially_refunded -> funding_reversed|returned|disputed
         disputed -> funded|partially_refunded|funding_reversed|returned

transfer: held -> submitting -> transferred
          held|submitting -> failed
          transferred -> partially_reversed|reversed
          partially_reversed -> partially_reversed|reversed
          failed -> held

payout: pending -> in_transit -> paid
        pending|in_transit|paid -> failed
        pending|in_transit -> canceled
```

A failed or canceled attempt is retained but does not permanently reserve its
statement. External settlement or statement voiding is permitted only when no
active/uncertain attempt and no facilitated payment fact exists. A
`submitting` transfer is an already-approved claim: retry/reconciliation may
resume its stable provider request and then transition it to `transferred` or
`failed`; it never returns directly to `held`.

Checkout status is independent of attempt state. A later signed or reconciled
session expiry changes `creating|open -> expired` even when its PaymentIntent
already made the attempt terminal; it does not rewrite that terminal attempt
state or completion time. A Stripe idempotency-key-in-use response leaves a
transfer, refund, or reversal `submitting` for exact retry/reconciliation.

A provider-confirmed full statement payment creates a facilitated
`payment_records` fact and moves the payable statement to `paid`; that statement
state is historical. The derived funding state records whether the customer
obligation remains economically funded after refunds, ACH returns, or disputes.
A full refund therefore produces `paid / funding_reversed`, and an ACH return
produces `paid / returned`; either blocks transfer release. A transfer means
funds reached the agency's connected-account balance. `payout.paid` means Stripe
reported a bank payout as paid, but it is not terminal because a bank return can
later produce `payout.failed`. Refunds, returns, reversals, disputes, and late
payout failures are append-only compensating facts and never rewrite linguistic
approval or the work ledger.

The Phase 7 contract is documented in
FACILITATED-PAYMENTS.md (private product document; not included in this export).

## SaaS subscription access

| State | Product behavior |
|---|---|
| `trialing`, `active` | Entitled access |
| `past_due` | Grace period, warnings, then expensive writes disabled |
| `paused` | Read/export access; paid processing disabled |
| `unpaid`, `canceled` | Read-only retention access unless contract says otherwise |

Payment status changes entitlements, not user roles. Webhooks update local billing state idempotently; request authorization does not call the payment provider synchronously.

The executable Phase 3 access policy and delivery slices are documented in [BILLING-ENTITLEMENTS.md](./BILLING-ENTITLEMENTS.md).

## Customer data lifecycle

```text
scheduled -> processing -> purged
scheduled -> canceled
scheduled -> failed -> processing
```

`scheduled`, `processing`, and `failed` are export-only until
`export_available_until`, then deny customer-content access. A legal hold
pauses worker claims without changing the customer access deadline. `canceled`
restores ordinary authorization; `purged` is terminal. Billing delinquency and
subscription cancellation do not themselves enter this state machine. A
provider subscription is rechecked before organization purge, and automatic
`failed -> processing` retries stop at the configured circuit breaker until a
platform operator explicitly retries. See
[DATA-LIFECYCLE.md](./DATA-LIFECYCLE.md).

## Work and usage ledgers

Usage events, work events, payable adjustments, webhook events, and audit events are append-only. Corrections use compensating events. Every externally supplied event has an idempotency key or provider event identifier.

Implemented usage facts separate request-level measurements from per-string attribution. Provider tokens remain exact at request scope; word and Unicode-code-point counts are exact per string. Successful AI usage items link to the generated translation revision so later human edits can produce derived HTER and Levenshtein metrics without altering commercial history.

Usage reservations transition `held -> consumed`, `held -> released`, or `held -> expired`. A consumed reservation points to exactly one matching immutable usage event. Organization-scoped advisory locks serialize allowance checks, and both held reservations and recorded events count toward projected use.

Usage budgets are append-oriented policies, not mutable counters. Replacement/removal sets `superseded_at`; status is derived from immutable usage plus live reservations. Threshold alerts are immutable per budget/threshold/period, while acknowledgement adds actor and timestamp state without deleting the alert.

Usage rollups are repairable projections rather than commercial facts. A usage
event moves from `unapplied -> applied` exactly once through its projection
marker in the same transaction that creates a live event and snapshots its
subscription-period identity. Legacy backfill is resumable; drift repair
deletes and rebuilds one organization's projection under the same organization
lock. Neither operation mutates or removes the ledger event or its period
snapshot.
