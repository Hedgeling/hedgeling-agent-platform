# Authorization test matrix

Status: PR6 launch-test contract. Automated coverage is necessary but the
manual target-environment pass below is also required for the frozen release.

Authorization is not a single role field. Effective access combines principal
type, principal state, organization membership, role assignment, scope
ancestry, inheritance, conditions, resource ownership, feature state,
commercial entitlement, and—in the agency domain—relationship, nomination,
eligibility, and explicit work assignment.

## Principal matrix

| Principal | Expected access | Must remain denied |
|---|---|---|
| Anonymous | health, readiness, auth config, login/SSO discovery/callback, signed webhooks, organization-bound SCIM endpoint | console data, operator UI, organization discovery, provider payloads |
| Platform super admin | platform configuration, governance, certification, recovery, named-human money actions | disabled global features; machine-only credentials; anonymous SSO bypass |
| Payment operations view | normalized payment queues, events, exceptions, reconciliation state | replay, reconcile, resolve, certification, refund, transfer, reversal |
| Payment operations manage | view plus replay, reconciliation, exception resolution | money movement and program/certification decisions without super-admin |
| Temporary support user | only granted organization permissions until expiry | billing, access management, money, impersonation, other organizations |
| Break-glass user | incident-scoped granted permissions until one-hour expiry | permissions not granted, suspended principals, unaudited recovery |
| Organization admin | organization settings, membership, approved delegated access | platform settings, unrelated organizations, super-admin-only movement |
| BU/project admin | inherited or direct resources under that scope | sibling BUs/projects and non-inherited parent resources |
| Internal org/BU user | assigned content/actions under membership and conditions | unassigned scopes/locales and inactive memberships |
| External freelancer | explicit assigned work and allowed content | organization-wide access from membership alone |
| Agency owner/operations | own agency, active customer relationships, rates/work/payables permitted by role | customer content without relationship scope and assignment |
| Agency lead/linguist | eligible and assigned work at allowed locales | approval or assignment as a substitute for permission |
| Translator/editor/lead | assigned content; lead approval only with approval permission | disallowed locales, prompts/personas/glossaries without permission |
| Service account / AI agent | scoped batch import/export/revision and workflow initiation | human approval, platform administration, facilitated-money mutations |
| System agent | explicit background-job scope and audit attribution | user-session routes, platform or money decisions |
| SCIM client | users/groups for the token's exact organization | cross-organization provisioning, role grants, payment/content access |
| Suspended/expired/revoked principal | none beyond intentionally public endpoints | cached membership, expired assignment, revoked credential/session refresh |

## Automated evidence

| Boundary | Evidence |
|---|---|
| Cognito, Basic retirement, groups, cookies, rate limiting | `test/auth.test.js`, `test/phase6.test.js` |
| Tenant ancestry, roles, scopes, inheritance, conditions | `test/authorization.integration.mjs` |
| SCIM, SSO, JIT, recovery, support, access reviews | `test/authorization.integration.mjs`, `test/phase6.test.js` |
| Service-account scopes and machine denial | `test/authorization.integration.mjs`, `test/phase6.test.js` |
| Vendor relationship, agency eligibility, work assignment | `test/vendor-eligibility.test.js`, `test/authorization.integration.mjs` |
| Payment operations view/manage/super-admin elevation | `test/auth.test.js`, `test/authorization.integration.mjs` |
| Human-only collection/refund/transfer/reversal | `test/authorization.integration.mjs`, `test/facilitated-money.test.js` |
| Entitlement/feature/budget separation | `test/stripe-billing.test.js`, `test/usage.test.js`, PostgreSQL integration |
| HTTP origin, headers, correlation, error disclosure | `test/http-security.test.js`, protected dynamic smoke |
| Operator browser UI | `e2e/operator-payments.spec.js` |
| Hosted UI/PKCE boundary | `e2e/pkce-smoke.spec.js` and credentialed provider checklist |

CI must fail if the PostgreSQL suite is skipped. Query-count assertions are
part of the authorization evidence because eliminating N+1 queries must not
broaden a tenant result set.

## Manual frozen-release matrix

Use non-production content and one user per row. Do not reuse super-admin
credentials to simulate a narrower role.

| Case | Action | Expected | Evidence |
|---|---|---|---|
| Anonymous | request `/api/me` and `/operations` | `401` without tenant hints | link |
| Org boundary | org-A user requests org-B resource by UUID | `403` or non-disclosing `404` | link |
| BU boundary | BU-A admin requests sibling BU-B | denied | link |
| Locale condition | `fr` translator requests `de` content/export | denied | link |
| External user | active membership without assignment opens content | denied | link |
| Agency relationship | approved agency linguist without work assignment | denied | link |
| Agency assignment | eligible assigned linguist opens exact work item | allowed, no sibling items | link |
| Verified edit | linguist replaces verified translation without confirmation | conflict | link |
| Operations view | view operator loads queue and attempts replay | view succeeds, replay denied | link |
| Operations manage | manage operator replays confirmed event | succeeds and audits; movement denied | link |
| Super admin human | certified test-mode money action | exact approved action only | link |
| Service account | attempts approval/refund/transfer/reversal | denied despite any assignment | link |
| SCIM cross-tenant | org-A token uses org-B path | denied | link |
| Support expiry | support user retries after expiry | denied and audit remains | link |
| SSO required | password-bound session enters SSO-required org | denied until correct provider login | link |
| Suspension | active token after user/membership suspension | denied by local state | link |
| Cross-origin browser | hostile Origin posts login/mutation | `403 cross_origin_mutation_denied` | link |

For every case, retain the frozen commit, environment, actor ID, request
correlation ID, expected/actual status, relevant audit-event ID, reviewer, and
UTC timestamp. Redact cookies, bearer tokens, provider payloads, and content.

## Approval rule

Any unexpected allow is a launch blocker. An unexpected deny may be accepted
only as a documented product limitation if it does not create an unsafe
operator workaround. No manual database role grant is an acceptable test fix.
