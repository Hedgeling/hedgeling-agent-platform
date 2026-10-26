# Reporting and pagination

Reporting is a read-only module of the shared Hedgeling API. The console,
built-in assistant, and external MCP clients use the same typed queries and
authorization rules. Each report returns a versioned data package with metrics,
filters, scope, coverage, freshness, and definitions. Account-wide means one
explicitly selected organization, including its permitted business units and
projects; it does not combine unrelated organizations.

## API structure

Keep reporting in the existing service for this milestone. Separate its query
handlers from creation/confirmation logic in `src/reporting.js`; expose each
report through the shared action catalog. A separate deployment, GraphQL
subgraph, or second authentication system is not required for adding reports.
The module can move to a read service later without changing tool semantics.

| Action | MCP tool | Data package |
|---|---|---|
| `reports.workspace.summary` | `console_report_workspace` | Permitted project and active business-unit counts, job totals, projects with jobs, job source-string counts, and jobs by status |
| `reports.jobs.summary` | `console_report_jobs` | Complete matching job totals and a page of groups by status, project, business unit, or target locale |
| `localization_jobs.list` | `console_list_localization_jobs` | A page of job metadata in a project or organization, for drilling into a report |

Calls use `POST /api/actions/:name`; `GET /api/actions` and MCP tool discovery
provide the schemas. These operations are read-only and require no write
confirmation. Existing human-confirmation rules still govern creation.

Every new report should declare its own strict input schema and tool description,
required scope/permissions, allowed filters and dimensions, metric definitions,
result version, cost controls, and permission/accuracy tests. Prefer a small
catalog of useful report packages over an arbitrary SQL or free-form query tool.
Keep input schemas beside other actions in `packages/api-contract`, and register
the handler in `reporting.js`. Add an activity label and agent skill guidance when
introducing a tool. This gives future quality, usage, cost, or throughput reports
room to grow without one enormous response schema.

For example, the job report accepts:

```json
{
  "organizationId": "11111111-1111-4111-8111-111111111111",
  "groupBy": "project",
  "targetLocale": "fr",
  "createdFrom": "2026-01-01T00:00:00Z",
  "createdBefore": "2026-02-01T00:00:00Z",
  "limit": 50
}
```

Optional filters are project slug, business-unit ID, literal job-name search,
job status, target locale, and creation timestamps. Date ranges include
`createdFrom` and exclude `createdBefore`; timestamps must be valid UTC values.
Filters narrow the full permitted dataset before counts, groups, or pagination.
The job-list action also accepts `jobId` for an authorized lookup, including
keeping an older edited job in view after the workspace refreshes.

## Meaning and completeness

The report envelope includes `report.id`, `report.version`, `startedAt`,
`generatedAt`, `freshness: live`, `consistency: read_committed`, organization
scope, applied filters, coverage, and definitions. Job reports also return
`totals`, `groupBy`, `groups`, and `page`.

- Totals include **all authorized matching jobs**, even when only one page of
  groups is returned. `coverage.complete` refers to that authorized query scope.
- `coverage.groupsComplete` says whether this single response contains every
  group. Follow the group cursor to inspect the remainder; do not add the
  repeated whole-query totals from different pages.
- Workspace project counts require `strings.view`. Business-unit counts include
  permitted active units. Job counts independently require `jobs.view` on the
  project and every target locale in each job. A multi-locale job is omitted
  entirely when any target locale is unauthorized.
- Hidden resources do not contribute to totals or pagination metadata. Reports
  never reveal how many inaccessible projects or jobs exist.
- A job targeting French and German appears in both locale groups. Group counts
  overlap; the report total counts that job once. A target-locale filter selects
  jobs containing that locale; grouping still describes all targets of those
  selected jobs.
- Source-string metrics sum stored snapshot lengths, so content reused in two
  jobs counts twice. They are not unique strings, translated strings, approved
  strings, or billable usage.
- The current job model supports **drafts only**. Reports do not claim completed
  translations, live workflow progress, quality scores, deadlines, or spending.
  Add those metrics only alongside their actual execution/domain data.

Reads are live, not a frozen export. Totals and groups for one job query come
from the same SQL statement; permissions and workspace inventories can be read
at different points during the report. Changes between calls can change counts
and membership. `generatedAt` is completion time, not an immutable dataset
snapshot. A future reproducible export needs an explicit snapshot contract.

## Pagination contract

`projects.list`, `organizations.list`, `localization_jobs.list`, and job-report
groups accept `limit` and `cursor`. Each response retains its named collection
and adds:

```json
{
  "page": {
    "limit": 50,
    "returned": 50,
    "total": 137,
    "hasMore": true,
    "nextCursor": "opaque-server-issued-continuation"
  }
}
```

The default page size is 50 and the maximum is 100. A page size is not a total
resource cap. Keep all filters and the page size unchanged and send `nextCursor`
as `cursor` until `hasMore` is false. `total` counts only currently authorized
matching rows. Zero results produce a zero total and null cursor.

`workspace.get` has two independently paged collections. Use
`pages.projects.nextCursor` as `projectCursor`, and
`pages.businessUnits.nextCursor` as `businessUnitCursor`; `limit` applies to both.
Consumers must finish both collections when they need the whole workspace.
The console loads all inventory pages for its workspace selectors. It fetches
only the newest 100 visible organization jobs initially; each project's
**Browse jobs / Load more jobs** control retrieves additional pages with visible
counts, rather than silently treating those initial jobs as complete.
The console configuration's organization picker is an internal unpaged read;
it no longer has the old 100-organization cutoff and is not sent to the model.

Continuation cursors are HMAC-signed, expire after one hour, and bind the action,
authenticated principal, identity connection, filters, and sort position. They
are opaque to clients, not authorization grants or encrypted secrets. Every
continuation rechecks current permissions. Changed queries, tampering, expiry,
or a different principal return `400 invalid_cursor`. Restart from page one.

Configure `HEDGELING_CURSOR_SECRET` as a shared server-side secret with at least
32 bytes for multiple instances; never expose it through frontend configuration.
Without it, a random process-local key is used, and a restart invalidates existing
cursors. Rotation likewise invalidates old continuations. No key is committed.

Inventory pages sort by immutable unique ID (projects.list uses unique slug).
Jobs use descending `(created_at, id)`, preserving timestamp precision across
ties; report groups use a stable group key. Deleting an anchor does not break
continuation. Pagination is over live data: it does not guarantee inclusion of
concurrent inserts or a historical view of edited records. This follows the
need for a unique ordering described in
[PostgreSQL pagination guidance](https://www.postgresql.org/docs/current/queries-limit.html).
MCP tool discovery pagination is distinct from these domain cursors; the tool
input/result schemas explicitly carry our continuation fields. See
[MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

## Caps and budgets

These are current implementation defaults, not MCP protocol restrictions or a
new commercial pricing policy. Existing contract version 1 keeps the same named
collection fields and adds pagination inputs/metadata; clients must now follow
cursors instead of assuming the first response is exhaustive. Rebuild the MCP
adapter with the shared contract when updating a client.

| Boundary | Current cap or behavior | Applies to |
|---|---|---|
| List / group page | Default 50, maximum 100; additional pages supported | API, built-in agent, external MCP |
| Organization discovery and workspace inventory | No total read cutoff; old organization/BU list caps removed | Shared reads; scope checks never depend on list position |
| Cursor lifetime | One hour; same principal/query; restart invalidation without a configured shared secret | Paged reads |
| Non-trial creation | 100 active BUs, 250 unpurged projects per organization; 30 requested target locales | Shared creation/confirmation API |
| Trial creation | One BU, one project, three target locales | Shared creation/confirmation API |
| Job draft | 10,000 source strings, 30 target locales, up to four distinct workflow steps | Shared job-draft creation |
| Preview / organization creation | 200 previews and five organization creations per user in a rolling day | Shared creation API |
| Proposal validity | 15 minutes; permissions and resource versions rechecked at confirmation | Human approval |
| New conversations | 100 per user in a rolling day | Built-in agent |
| Model loop | Eight steps, at most eight tool calls per step; tools execute serially | Built-in agent; external hosts set their own loop budgets |
| Conversation length | New messages blocked once model history reaches 100 entries; one message at most 6,000 characters | Built-in agent |
| Model request guard | Serialized request bytes plus 2,048 must not exceed 100,000 (roughly 98 KB of JSON); this is a conservative application estimate, not the model's native token window | Gemini adapter |
| Output / transport | 2,048 requested output tokens, 45-second provider timeout, 512 KiB response body | Gemini adapter |
| User allowance | 500,000 actual or conservatively reserved tokens per database calendar day | Built-in Gemini adapter |
| Organization chat allowance | 2,000,000 `agent_chat_tokens` through usage-period/budget accounting; separate from translation credits | Built-in Gemini adapter |
| Controller lease | 30 seconds, renewed every eight seconds; pause/takeover remain effective | Built-in agent |
| Event reads | Replay endpoint returns 1,000 events; SSE continues after the cursor in batches of 100 | Conversation replay; not a project/job count cap |

The agent's pagination skill prefers reports for complete counts and filtered
pages for inspection. If a step or context budget prevents finishing traversal,
it must state partial coverage. Raising model budgets is not a substitute for
backend filtering and aggregation. Reports should never enumerate every project
through separate model calls merely to count jobs.

## Growth path and verification

The current implementation bounds response size, calculates job aggregates in
SQL, and keeps project/locale permission checks in the existing authorization
layer. Some inventory and authorization work still scales with project and
locale count on the server. This milestone validates hundreds of resources; it
is not a benchmark or promise of warehouse-scale performance.

As reporting grows, add permission-aware rollups and indexes for measured hot
queries, cache only with appropriate principal/scope/access-version keys, and
move slow reports into asynchronous jobs with progress and cancellation. Keep
freshness and coverage in every package. Introduce a separate read service only
when query workloads, deployment needs, or data ownership justify it; keep its
API facade and metric definitions stable.

`npm -w @hedgeling/web-console run test:agent -- <local-db-url>` includes fixtures
with 126 projects, 126 business units, 106 accessible organizations, and 262 jobs,
including same-timestamp paging, complete totals, overlapping locale groups,
filters, revoked grants, and restricted human/service-account access. Unit tests
cover cursor tampering, expiry, principal/query binding, and strict schemas. MCP
adapter tests verify that filters and cursors reach the shared API unchanged.

The local demo recognizes requests containing “overview,” “summary,” “report,”
or “how many” in an organization-scoped conversation and invokes these real
report tools. Its narration is deterministic; arbitrary natural-language query
planning still requires configuring Gemini.
