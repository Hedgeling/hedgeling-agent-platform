# Public baseline verification

Verified locally on 2026-10-26 using Node 22.18.0 and disposable loopback PostgreSQL schemas.

| Check | Result |
|---|---|
| Independent `npm ci` | Passed; only public npm resolutions and five public workspaces |
| Build and lint | Passed for all workspaces |
| Platform client tests | 2 passed |
| Platform MCP tests | 3 passed, including real SDK stdio discovery and authenticated HTTP dispatch |
| Design-system test | Passed, including swappable brand output |
| Console unit tests | 157 passed; 8 database-dependent cases skipped in this invocation and run separately below |
| Agent/API integration | 8 passed, including authorization, proposals, reporting, management and organization keys |
| Local-session checks | Passed startup, login/logout, bearer access, host restrictions, isolation and revocation |
| Authorization matrix | Passed |
| Navigation browser suite | Passed desktop/mobile navigation, themes, agent coexistence and role visibility |
| Agent browser suite | Passed approvals, edits, highlights, manual takeover, accessibility/focus, second brand and pagination beyond 100 |
| Commercial browser suite | Passed billing, spending confirmation, key changes, removal without fallback, trial upgrade and mobile |
| Synthetic catalog | Prepared three source strings offline without extraction or provider credentials |
| Public-boundary scan | Passed; no detected credential signatures, excluded workspace dependencies or deployment endpoints |
| Commercial LICENSE | Byte-for-byte match to the source baseline |

One inherited authorization assertion relied on `pgcrypto.digest` being visible in its temporary schema. The assertion now calculates the expected SHA-256 digest in Node, so it remains independent of extensions created in other test schemas. Runtime behavior is unchanged by that test fix.

Chrome was used for local browser verification. CI installs Playwright Chromium and repeats the suites. Docker was not running locally, so the container build is included as a CI check rather than represented as locally verified. No live model inference, payment-provider call, production deployment or private extractor was needed for these checks. Passing fixture tests does not establish Meta/Bedrock support; those adapters are still planned.
