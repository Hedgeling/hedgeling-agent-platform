# Authorization specification

## Scope hierarchy

`platform > organization > business_unit > project > vendor_relationship > work_order > job`

Locale and content classification are assignment conditions. A grant at a parent scope applies to descendants only when the role assignment's `inherit_to_children` flag is true.

## Principal types

- `user`: interactive human identity.
- `team`: group whose permissions are inherited by its active members.
- `service_account`: customer or agency automation using scoped credentials.
- `system_agent`: Hedgeling-managed worker; not an organization member.

## Default role templates

| Role | Scope | Purpose |
|---|---|---|
| `platform_super_admin` | Platform | Break-glass platform control |
| `platform_support` | Platform | Time-limited customer support |
| `platform_operations` | Platform | Jobs, usage, and feature operations |
| `platform_finance` | Platform | SaaS billing operations |
| `organization_owner` | Organization | Ownership and destructive governance |
| `organization_admin` | Organization | Members, BUs, projects, and settings |
| `billing_admin` | Organization | Subscription, usage, budgets, and vendor payables without string content |
| `security_admin` | Organization | Identity and security policy |
| `vendor_manager` | Organization | Agency relationships and assignments |
| `organization_viewer` | Organization | Read-only organization access |
| `business_unit_admin` | Business unit | BU membership, projects, and configuration |
| `project_admin` | Project | Project membership and configuration |
| `localization_manager` | BU or project | Jobs, assignments, and delivery |
| `developer` | Project | Integrations, imports, builds, and API keys |
| `translator` | Project/job | Assigned translation work |
| `lead_translator` | Project/job | Translation oversight and approval |
| `reviewer` | Project/job | Assigned editing and review |
| `lead_reviewer` | Project/job | Final linguistic approval |
| `language_owner` | BU or project | Locale rules, terminology, and persona approval |
| `terminologist` | BU or project | Glossary proposal and management |
| `requester` | BU or project | Submit jobs and inspect own requests |
| `viewer` | BU or project | Read-only content access |
| `agency_owner` | Agency organization | Agency ownership and payout governance |
| `agency_admin` | Agency organization | Agency users and customer relationships |
| `agency_operations` | Agency organization | Staffing, assignment, and delivery |
| `agency_finance` | Agency organization | Rates, statements, disputes, and payment records |
| `agency_lead_linguist` | Agency organization | Linguist oversight |
| `agency_linguist` | Agency organization | Identity eligible for customer assignments |

## Permission catalog

Permission keys are stable API contracts. Roles may evolve without changing route checks.

### Organization and access

`organization.view`, `organization.update`, `organization.delete`, `organization.transfer_ownership`, `members.view`, `members.invite`, `members.manage`, `teams.manage`, `business_units.create`, `business_units.manage`, `projects.create`, `projects.manage`, `roles.assign`, `audit.view`, `audit.export`, `security.manage`, `identity.manage`, `provisioning.manage`, `access_requests.approve`, `access_reviews.manage`, `support_access.manage`

### Translation configuration

`locales.view`, `locales.manage`, `prompts.view`, `prompts.propose`, `prompts.approve`, `prompts.manage`, `personas.view`, `personas.propose`, `personas.approve`, `personas.manage`, `glossary.view`, `glossary.propose`, `glossary.approve`, `glossary.manage`

### Workflow

`strings.view`, `translations.view`, `translations.edit`, `translations.submit`, `translations.approve`, `translations.publish`, `jobs.view`, `jobs.create`, `jobs.assign`, `jobs.cancel`, `work_orders.view`, `work_orders.manage`, `quality.approve`

### Integration and billing

`imports.run`, `exports.run`, `api_credentials.manage`, `webhooks.manage`, `usage.view`, `budgets.manage`, `billing.view`, `billing.manage`

### Vendors

`vendors.view`, `vendors.invite`, `vendors.manage`, `vendor_linguists.approve`, `rate_cards.view`, `rate_cards.propose`, `rate_cards.approve`, `payables.view`, `payables.approve`, `disputes.open`, `payment_records.manage`

Phase 7 seeds `payout_accounts.view` and `payout_accounts.manage` for the
agency roles described in
FACILITATED-PAYMENTS.md (private product document; not included in this export). The management route also
requires an active human agency membership; service accounts and platform-only
identities cannot use it. Active money-state permissions are
`facilitated_payments.view`, `facilitated_payments.initiate`,
`facilitated_payments.refund`, and the platform-only
`facilitated_transfers.release`. Their party, human-only, and rollout rules are defined in
FACILITATED-PAYMENTS.md (private product document; not included in this export).

## Mandatory separation of duties

- Persona, glossary, and prompt editing does not imply approval.
- Translation approval does not imply publication.
- Linguistic quality approval does not imply payable approval.
- Payables visibility does not imply authority to open a dispute and block the
  payable pipeline.
- Billing administration does not imply access to translation content.
- SaaS billing or external payment-record administration does not imply
  facilitated payment, refund, payout-account, or transfer authority.
- Agency administration does not grant access to customer content.
- Agency rate-card proposal does not imply customer approval; the proposing
  agency and approving customer are enforced as separate parties.
- Platform support access does not imply billing mutation or secret access.
- Directory group membership does not imply a role; SCIM groups become teams
  whose role assignments remain explicit.
- Access-request approval cannot be performed by the requester.
- Service accounts cannot perform human governance decisions even when a role
  is accidentally granted the corresponding permission.

## Conditions

Role assignments may carry structured conditions for locale, content classification, service type, internal/external relationship, assignment ID, and expiry. Conditions must be evaluated server-side and represented in audit events. Arbitrary executable policy expressions are deliberately excluded.

Locale conditions are implemented and fail closed: a locale-conditioned grant cannot authorize a locale-sensitive operation without a known locale. Operations affecting multiple locales must authorize every locale before reading or mutating data. The other condition types remain reserved for later workflows and must not be accepted by an API until their evaluation rules exist.

The vendor eligibility evaluator separately enforces locale, service
type, and content classification restrictions stored on vendor relationships and
linguist approvals. These are commercial/assignment prerequisites, not general
role-assignment conditions. Personal agency access additionally requires a
concrete active assignment, an attached source string, and a compatible
work-order state. Completed assignments are read-only. Rate-card selectors
constrain pricing only; they never grant content access.

Role assignments are unique only when the principal, role, scope, inheritance behavior, and canonical conditions are all equal. This preserves separate grants such as `fr` and `de` assignments for the same translator and scope. Locale arrays are order-independent for duplicate detection. Startup migration revokes only exact legacy duplicates and records each revocation in the audit log.

## Route policy rule

Every non-public API route declares one permission and resolves a server-owned resource scope. UI visibility uses the same effective-permissions response, but UI hiding is never an authorization control.

Organizations that require SSO add an identity-policy check before membership
and role evaluation. A password-authenticated user fails closed unless a named,
unexpired recovery grant exists. Anonymous discovery does not reveal grant
existence. An SSO session proof is bound to the selected connection, Cognito
subject, and issuance time, and the callback verifies the token's federated
provider before issuing it. Service accounts and explicit platform support
grants have separate credential/lifetime checks and never masquerade as tenant
members. See
ENTERPRISE-IDENTITY-GOVERNANCE.md (private product document; not included in this export).
