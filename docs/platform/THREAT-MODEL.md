# Platform threat model

Status: PR6 review baseline. This document describes the implemented controls
and the target-environment evidence still required before a pilot. It does not
declare production approval.

## Security objectives

Hedgeling must:

- keep organization, business-unit, project, locale, vendor-relationship, and
  work-order data inside the caller's authorized scope;
- keep human, service-account, SCIM, support, and provider identities distinct
  in authorization and audit lineage;
- prevent a browser, customer, agency, or machine identity from initiating a
  platform money decision that requires a named platform human;
- preserve provider events and financial facts so retries converge without
  duplicate movement;
- keep credentials, refresh tokens, signing secrets, provider payloads, and
  customer content out of logs and public errors; and
- remain fail-closed when Cognito, Stripe, PostgreSQL, reconciliation, or
  entitlement state is unavailable or ambiguous.

## Protected assets

The highest-impact assets are:

1. source strings, translations, glossaries, personas, prompts, and exports;
2. user identity, enterprise-provider bindings, memberships, assignments, and
   recovery grants;
3. agency rates, work orders, payable statements, payment records, disputes,
   provider events, and normalized money facts;
4. Cognito, SCIM, service-account, session-signing, database, Gemini, and Stripe
   credentials;
5. audit events, access reviews, certification evidence, reconciliation
   checkpoints, and usage ledgers; and
6. release images, database migrations, infrastructure configuration, alarms,
   and launch approvals.

## Trust boundaries

| Boundary | Untrusted input | Authoritative control |
|---|---|---|
| Public browser | login fields, cookies, Origin, request IDs | Cognito verification, secure cookies, same-origin mutation gate, CSP, rate limits |
| Enterprise SSO | discovery email, Hosted UI callback, claims | PKCE, state, nonce, issuer/audience/signature, subject and provider binding, local identity policy |
| SCIM | bearer token and provisioning body | hashed organization-bound token, SCIM schema validation, tenant-scoped links and transactions |
| Service account / AI agent | bearer token, scope, batch payload | hashed credential, active principal, scoped role assignments, entitlement and budget checks |
| Customer organization | users, BUs, projects, roles, vendor relationships | active membership plus permission, scope ownership, conditions, feature and entitlement gates |
| Agency organization | agency users, rates, nominations, work | relationship membership, approved eligibility, explicit assignment, party-restricted transitions |
| Support | temporary cross-tenant access | named platform user, expiring grant, denied permission set, ticket/incident reference, audit |
| Stripe Billing | raw webhook bytes | dedicated secret, signature, event ledger, state timestamp, local entitlement projection |
| Stripe Connect | raw webhook bytes and connected-account context | separate secret/client, mode isolation, signature, account/metadata binding, idempotent facts |
| PostgreSQL | application queries and migrations | foreign keys, checks, partial unique indexes, tenant validation, transactions, advisory locks |
| AWS control plane | deploy and operator actions | OIDC/role boundaries, private RDS, SG source relationships, Secrets Manager, CloudTrail evidence |

## Principal-specific abuse cases

### Anonymous and password-login attacker

Threats include credential stuffing, account enumeration, reset abuse, cookie
theft, CSRF, clickjacking, and reflected internal errors.

Controls include failure-only credential rate limits plus volume limits,
generic reset and login responses, Cognito token validation, `HttpOnly`,
`SameSite=Lax`, production `Secure` cookies, no browser token storage, CSP
`frame-ancestors 'none'`, `X-Frame-Options: DENY`, no referrer, a cross-origin
mutation gate, no Express disclosure header, and generic unhandled `500`
responses. Logout revokes refresh but not already-issued access tokens; the
one-hour Cognito access-token lifetime is the accepted offboarding window.

Residual risk: the in-memory rate limiter is task-local and is not a
distributed bot-management control. Pilot monitoring must alarm on
authentication-denial volume; higher-volume launch requires an ALB/WAF or
shared limiter decision.

### Enterprise identity and SCIM administrator

Threats include provider confusion, callback replay, domain takeover, shared
user mutation, provisioning races, group escalation, and an IdP believing a
write succeeded when Hedgeling ignored it.

Controls include verified organization-domain ownership, safe provider names,
case-insensitive provider-prefix matching, ID/access-token subject equality,
signed subject-bound connection cookies, fail-closed `sso_required`, SCIM
organization binding, uniqueness conflicts as `409`, deterministic lock order,
and auditable membership/team projections. A shared cross-organization user
cannot be silently renamed by one organization's IdP.

### Organization, BU, project, and content users

Threats include trusting a role name without an active membership, using a
parent grant outside inheritance rules, bypassing locale conditions, editing
another tenant's scope ID, exporting unapproved content, and treating
commercial access as RBAC.

Authorization evaluates principal, active membership, scoped role assignment,
inheritance, conditions, resource ancestry, and permission. Entitlement and
feature gates are separate, producing `402` and `403` semantics. Database and
route validation reject cross-tenant scope ownership. Empty-locale exports fail
closed for locale-conditioned users.

### Freelancer, agency, and agency linguist

Threats include a customer-controlled fake agency, approval without content
assignment, rate manipulation after work begins, overlapping work overwrites,
unapproved quality transitions, self-reported payable inflation, and one party
seeing another relationship.

An approved linguist is not sufficient for content access: an active
relationship, scope, eligibility, and work assignment are all required. Rate
and commercial terms are snapshotted. Verified translations require explicit
replacement confirmation. Customer quality approval controls payable
generation and surfaces source-unit variance. Every relationship and work
transition is party scoped and audited.

### Service account and AI agent

Threats include credential disclosure, platform-role escalation, human-review
bypass, unlimited processing, and money movement.

Only credential digests are stored. Machine principals need active,
non-expired, scoped assignments and pass the same resource/condition checks as
users. Usage reservations and entitlements apply. Human-only approval and
every facilitated-money mutation reject service accounts and system agents,
even if an assignment was mistakenly granted.

### Platform operations, super admin, and support

Threats include broad standing privilege, accidental movement from a read
role, replay abuse, support impersonation, and unaudited recovery.

Payment operations has separate view and manage Cognito groups. Provider-event
replay and reconciliation require manage, explicit confirmation/reason, lease,
correlation, and audit. Refund, transfer, reversal, program, certification, and
recovery decisions re-elevate to a named super-admin human. Support uses
expiring grants; normal support cannot receive access-management, billing, or
money permissions. Break-glass requires an incident reference and never
creates a role by itself.

## Provider and money-movement threats

Both Stripe webhooks are mounted with bounded raw-body parsing before the
global JSON parser. Each uses its own client and signing secret. Provider mode,
livemode, connected-account context, local resource IDs, currency, amounts,
metadata, and event timestamps are validated. Durable provider-event ledgers,
row/advisory locks, conditional finalization, replay leases, provider
idempotency keys, and append-only compensating facts provide convergence.

Known provider-specific hazards have explicit policy:

- ACH success is not release eligibility; returns create compensating facts
  and transfer release waits for the configured settlement hold;
- late success for an ineligible statement is recorded, quarantined, and never
  silently applied;
- a failed/ambiguous transfer older than Stripe's idempotency window is not
  automatically retried;
- dispute, refund, reversal, return, and payout failure never erase the
  original fact; and
- live movement requires global, per-operation, program, organization,
  certification, cap, and named-human gates.

## HTTP, logging, and data disclosure

The console emits a restrictive same-origin CSP, HSTS with subdomain coverage
in production, cross-origin isolation headers, no-sniff, no-referrer, no
framing, and `Cache-Control: no-store` for API and sensitive UI responses.
Production refuses startup without an exact external HTTPS
`HEDGELING_PUBLIC_ORIGIN`, so TLS termination cannot make same-origin browser
mutations appear cross-origin.

Unsafe cross-origin browser requests receive `403` before
authentication/provider work. Requests with neither `Origin` nor
`Sec-Fetch-Site` remain allowed because Stripe, SCIM, service accounts, and
other server-to-server clients do not reliably send browser metadata. This
gate is defense in depth: browser session cookies are `HttpOnly`,
`SameSite=Lax`, and production-secure; bearer credentials are not stored in
browser JavaScript; and every mutation still requires its normal
authentication, tenant authorization, entitlement, and operation gates.
Correlation IDs accept only a bounded safe character set.

Only security-relevant outcome metadata is logged for `401`, `403`, and `5xx`
responses; paths, query strings, bodies, cookies, Authorization headers, and
principal emails are excluded. Unknown internal errors are logged as bounded
fields and returned as `Internal error`. Provider payload access is restricted
to normalized/redacted operator views.

## Infrastructure threats

The target contract requires private encrypted RDS with deletion protection
and PITR, ECS tasks without public IPs, ALB-only task ingress, task-only
database ingress, HTTPS redirect, database-aware readiness, bounded log
retention, ECR scanning and immutable release tags, Secrets Manager injection,
least-privilege execution/task/scheduler roles, and GitHub OIDC deployment.

`infra/aws/verify-production-readiness.sh` is read-only and emits no secret
values. Any failed infrastructure check blocks launch. An existing unencrypted
RDS instance cannot be repaired in place; it requires encrypted snapshot copy,
restore, validation, endpoint cutover, and rollback evidence.

## Verification and accepted findings

Required evidence is:

- unit and PostgreSQL integration tests, including principal and tenant
  boundaries;
- Playwright persona and operator journeys;
- repository secret/control scan and production dependency audit;
- protected-environment dynamic HTTP security smoke;
- read-only AWS identity and production-readiness reports;
- authenticated application scan and manual authorization matrix;
- restore, migration, deployment rollback, provider outage, and incident
  drills; and
- explicit security review of every unresolved finding.

Accepted findings live in `security-exceptions.json`. Every entry needs a
unique ID, severity, owner, rationale, approver, durable HTTPS evidence, and a
future expiry. Expired or malformed entries fail CI. No critical or high
finding is accepted by silence.

## Residual launch decisions

The pilot cannot be approved until named reviewers decide and record:

- WAF/shared rate-limiter timing;
- raw provider payload, audit, identity, financial, and log retention;
- credential and signing-secret rotation intervals;
- RDS encryption/cutover if the current instance is unencrypted;
- alert destinations and primary/secondary on-call owners; and
- pilot organizations, transaction caps, and observation window.
