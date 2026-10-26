# Hedgeling Agent Platform

Public development workspace for Hedgeling's platform API, MCP tools, and conversational localization console during the Meta Global AI Developer Hackathon.

**This repository contains pre-existing Hedgeling code.** The initial `hackathon-start` tag records the sanitized baseline; subsequent commits record hackathon work. See [provenance and separation](docs/REPOSITORY-BOUNDARY.md) and [the hackathon plan](docs/HACKATHON-PLAN.md).

The existing [commercial license](LICENSE) is preserved. Public visibility does not grant an open-source license. Third-party assets retain their accompanying licenses.

## Included

| Package | Responsibility |
|---|---|
| `web-console` | Platform API, database, authorization, chat, approvals, localization jobs, reporting and billing foundations |
| `api-contract` | Shared action names, input schemas and validation |
| `platform-client` | Bearer-authenticated HTTP transport with explicit origin configuration |
| `platform-mcp` | Standalone stdio adapter exposing only platform actions |
| `design-system` | Swappable brands, tokens, fonts and console assets |

The private source extractor, framework adapters, generated runtime, extraction MCP tools, editor extension and benchmarks are excluded. No private checkout or private npm package is needed to install and run this repo.

## Local console

Use Node 22+ and a disposable loopback PostgreSQL database. For example, with Docker:

```sh
docker run --name hedgeling-platform-db -e POSTGRES_USER=platform -e POSTGRES_PASSWORD=local-demo-only -e POSTGRES_DB=platform -p 127.0.0.1:55477:5432 -d postgres:16
npm ci --registry=https://registry.npmjs.org/
npm run build
DATABASE_URL=postgresql://platform:local-demo-only@127.0.0.1:55477/platform npm run dev:agent
```

Open the printed localhost login URL and paste the expiring token printed in your terminal. Keep that token private. The command migrates the local database and creates a named organization owner and a synthetic project. Stop with Ctrl+C; restart to issue a new session. Set `PORT` if port 8080 is occupied.

The default agent uses a deterministic fixture and the real platform API. **No AWS account, model key, production login, or paid inference is required.** This is a scripted demonstration, not a general language model. Select **Set up demo workspace** or type that phrase, then inspect and confirm each proposal. Existing integration/browser tests exercise the rest of the workflow with synthetic data.

For real model chat, the baseline currently supports server-side Gemini configuration; see [agent implementation](docs/platform/AGENT-CONSOLE-IMPLEMENTATION.md). **Meta chat, Meta BYOK and Bedrock are planned, not implemented in this baseline.** Keep keys on the server and configure an accessible model explicitly. The example environment file documents available settings; the local launcher expects exported environment variables and does not load `.env`.

## MCP

After building, configure your MCP client to run `node` with the absolute path to `packages/platform-mcp/dist/index.js`. Supply `HEDGELING_CONSOLE_URL` and `HEDGELING_CONSOLE_TOKEN` through the client's private environment configuration. Use an authorized scoped service-account credential for hosted automation; the local session token works with the local console.

The server offers the actions in [the shared contract](packages/api-contract/index.js), including paginated reads, reports and write proposals. It cannot confirm its own proposals, elevate permissions, extract source code, or read local project files. Tool discovery works without credentials; execution reports missing configuration explicitly. Hosted MCP routes also remain in the console; see [API/MCP design](docs/platform/API-AND-MCP-DESIGN.md).

## Source content without the private extractor

Import an existing catalog through the authenticated `/api/import-state` boundary. A synthetic [source catalog](examples/source-catalog.json) and [locale config](examples/locales.json) are included. To prepare an offline state file from the repository root:

```sh
HEDGELING_SOURCE_JSON=examples/source-catalog.json HEDGELING_CONFIG_PATH=examples/locales.json HEDGELING_PROJECT_SLUG=hedgeling-local HEDGELING_STATE_OUTPUT=/tmp/hedgeling-demo-state.json node packages/web-console/scripts/import-source-catalog.js
```

To import, omit `HEDGELING_STATE_OUTPUT` and supply the configured console origin and private bearer token. Provision the project first; authorization and organization entitlements still apply. Imports preserve human translations and do not prune missing content unless explicitly requested. The importer never scans application source files.

## Verification

```sh
npm run check:public
npm run build
npm run lint
npm test
export TEST_DATABASE_URL=postgresql://platform:local-demo-only@127.0.0.1:55477/platform
npm run test:agent
npm run test:local
npm run test:authorization
npx playwright install chromium
npm run test:navigation:browser
npm run test:agent:browser
npm run test:commercial:browser
```

Integration tests use isolated schemas in the disposable database. See [baseline verification](docs/BASELINE-VERIFICATION.md) for recorded results and limitations. CI runs these checks without cloud/model secrets and has no production deployment workflow. Container build: `docker build -f packages/web-console/Dockerfile .`; running a production container requires explicit database, identity and public-origin configuration.

## Design and behavior

- [Product specification](docs/platform/AGENT-CONSOLE-SPEC.md)
- [Agent and console implementation](docs/platform/AGENT-CONSOLE-IMPLEMENTATION.md)
- [Authentication and local troubleshooting](docs/platform/AGENT-FOUNDATION.md)
- [Reporting, pagination and caps](docs/platform/REPORTING-AND-PAGINATION.md)
- [Billing and entitlements](docs/platform/BILLING-ENTITLEMENTS.md)

Inherited design documents describe both implemented behavior and future plans. The hackathon plan records the new provider direction and takes precedence where older documents specify Gemini as the sole provider.
