# Hedgeling API and MCP design

Status: approved architecture direction, 2026-10-24. Companion to the
[agent console specification](AGENT-CONSOLE-SPEC.md). Existing behavior is
documented in [the foundation guide](AGENT-FOUNDATION.md) and the
[first implementation](AGENT-CONSOLE-IMPLEMENTATION.md).

## Recommendation

Keep the shared domain action API as the initial primary integration contract.
The built-in runtime and external agents use MCP adapters for those actions;
ordinary console screens call the API directly. Organize code by domains now.
Consider GraphQL later for composed reads if real screen/reporting requirements
justify it. Do not start with federated subgraphs solely to group agent tools.

GraphQL, MCP, and skills answer different questions: GraphQL describes and queries
a data graph; MCP exposes tools and context to agent clients; skills guide how
an agent uses those capabilities. None replaces domain validation, scoped
authorization, approval, or durable jobs.

## GraphQL decision

| Option | Advantages | Cost for Hedgeling now | Recommendation |
|---|---|---|---|
| Existing HTTP routes plus typed domain actions | Reuses the foundation and current services; explicit commands fit confirmations and audit | Composed screens may need purpose-built reads | Start here |
| One modular GraphQL schema | Flexible related-data reads and typed schema; domains can live in separate code modules | Resolver/schema work, query-cost controls, pagination, field-level access and cache design | Revisit when representative screens demonstrate a benefit |
| Federated GraphQL subgraphs | Independently owned/deployed services can compose a shared graph | Router, composition/versioning, distributed query planning and operational ownership | Defer until independent services/teams need these properties |

Federation combines constituent APIs behind a router; the benefit is independent
service ownership and composition. That is a different boundary from a tool
category such as “Creation.” This recommendation is an engineering judgment
based on the current shared console backend, not a limitation of GraphQL.
[Apollo federation overview](https://www.apollographql.com/docs/graphos/schema-design/federated-schemas/federation).

If GraphQL is introduced, start with a modular schema over the same domain
services. Queries can aggregate reporting and job/project detail; mutations
must use the same proposal, confirmation, permission, and idempotency logic as
HTTP actions. Keep authorization in the business layer, including the fields
and resources each resolver returns.
[GraphQL authorization guidance](https://www.graphql.org/learn/authorization/).

Prefer domain boundaries such as Workspace, Localization, Language assets,
Identity, and Usage/reporting. Creation belongs to each owning domain instead
of a cross-domain Creation service. A future subgraph should own cohesive data
and workflows, not mirror a menu section or one MCP tool.

## Proposed operation groups

The first implementation adds organization discovery, `workspace.get`, four
creation proposals and localization-job listing to the two original reads.
Other names below remain proposals; existing HTTP features do not automatically
become available to agents. `workspace.get` includes permitted business units.

| Domain | Example actions | Delivery |
|---|---|---|
| Project discovery | `projects.list`, `project.sync.status` | Already implemented |
| Workspace | `organizations.list`, `organization.create`, `business_units.list`, `business_unit.create`, `project.create` | First creation workflow; bootstrap organization ownership requires a human control |
| Localization | `localization_jobs.list`, `localization_job.create`, `localization_job.get`, `localization_job.start`, `localization_job.cancel` | Draft first; start/cancel later with explicit previews |
| Content/review | `strings.search`, `translation.get`, `translation.propose_edit` | Read scope and versioned write previews; human approval remains distinct |
| Language assets | `glossary.search`, `prompt.get`, `prompt.propose_change`, `persona.get` | Scoped, versioned changes and human decision paths |
| Reporting | `job.progress`, `project.coverage`, `usage.summary` | Bounded reads with pagination, consistent metric definitions and permitted fields |
| Integrations | `project.sync.preview`, `project.sync.run`, `source.import.preview` | Explicit external effects, credential ownership, and cost/content scope |

Expose useful, bounded tools rather than all database CRUD or a universal
GraphQL/HTTP executor. Select a relevant tool subset for the current task. A
model's requested tool and arguments never constitute authorization.

## Extend the action contract

Keep protocol-neutral definitions in `packages/api-contract`. Add complete
input/output schemas and a real schema validator as types become richer; the
implementation uses Ajv for strict input validation. Output schemas and the
full effect metadata below remain to be completed before broad client release.

Each action needs a stable name/version, domain, input/output schema, scope
resolution, required capabilities, effect classification, human-only decision
marker, proposal/confirmation rules, idempotency behavior, resource-version
preconditions, cancellation behavior, timeout and cost metadata, pagination,
and structured errors. Catalog metadata describes capabilities; server services
enforce them on every invocation.

Derive MCP definitions, model function declarations, documentation, and client
types from that contract where practical. Keep output resource references and
safe UI targets stable so manual screens and agent progress show the same
entities. Do not embed CSS selectors or presentation instructions in domain
business logic; the shell maps safe targets to components.

## Write proposal lifecycle

1. An authorized agent requests a proposal with canonical inputs and expected
   versions. The API validates scope and builds a truthful preview without
   making the proposed business change.
2. The human views that exact proposal through an authenticated console UI.
   One explicit confirmation authorizes one logical write with disclosed side
   effects. Expired, rejected, changed, or stale proposals cannot execute.
3. Ordinary agent writes commit through a narrowly scoped grant bound to that
   proposal. Human-only decisions execute in a separate trusted human path.
   Both paths revalidate permissions, versions, entitlements, and limits.
4. The transaction records the effect, audit identity, result, and durable
   event. An idempotency record reconciles retries and uncertain responses.
5. The runtime receives evidence of success/failure and advances or pauses. A
   browser animation or model statement cannot advance the business state.

The first creation workflow commits directly in the authenticated human
confirmation transaction; there is no reusable execution grant exposed to the
model. For the next job-execution milestone, a separately confirmed job start
may issue a bounded worker authorization covering generated draft writes for
the exact source snapshot, locales, steps and cost ceiling. It must not confer
review approval, publishing, access administration or unbounded spending.

Proposal/confirmation persistence is internal orchestration, not a business
write that recursively requires another confirmation. Batch edits must show
their complete bounded scope; bulk behavior needs explicit product review
before it can satisfy the per-write confirmation requirement. New domain
actions must not hide unrelated writes under one convenient tool.

## MCP transport and identity

Retain stdio for repo-local tooling and CLI use. Add a hosted MCP endpoint for
external agents when delegated authentication is ready. Streamable HTTP is the
proposed hosted transport; preserve client compatibility by pinning and testing
a supported protocol version.
[MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

Remote MCP needs authorization discovery, narrowly scoped credentials, audience
validation, revocation and expiry. The MCP credential and downstream API
credential must be issued for their respective audiences; do not pass through
an arbitrary upstream bearer token. Stdio credentials stay in private local
configuration. Existing service accounts remain useful for approved machine
reads, while delegated human context is a separate capability to build.
[MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

MCP tools carry schemas, structured results and effect annotations; annotations
help clients explain behavior and do not enforce access. Resource and prompt
capabilities can expose scoped context and workflow guidance, but clients may
use them differently. Enforce per-write confirmations at the API so both a
built-in assistant and an external client obey the same rule.
[MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

External write attempts return a pending proposal and console review link. The
external client may query its status but cannot approve it as the human. The
authenticated console resolves human-only decisions and ordinary confirmations
through their appropriate paths. Browsing that link alone never commits a write.

## Delivery boundaries

Implement domain services and action contracts before exposing new MCP tools.
Refactor existing route logic incrementally so API and UI do not maintain
different versions of business rules. Keep one deployable backend initially;
extract services only for measured scaling or ownership needs.

The chat activity stream is a UI/runtime concern. Long-lived localization jobs
are domain objects. MCP progress messages and transport sessions are neither a
durable job database nor a replacement for resumable run events.

Verify manual/API/MCP parity using the same actors, scopes, inputs and expected
results. Include confirmation bypass, stale grants, tenant isolation, locale
restrictions, retry/idempotency, and cancellation at real transaction boundaries.
This work does not require a new API technology to begin.
