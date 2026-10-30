# Local console development

Use a development branch for local feature batches. The hosted demo updates when reviewed changes reach `main`; starting localhost does not deploy anything. The console runs from this repository. For event-owned API/UI modules, edit `hedgeling-meta-hackathon` first and vendor the clean committed revision with its existing script before releasing a batch. Do not edit only a vendored copy and lose the event source/provenance record.

## Start, sign in and stop

```sh
npm run local:start
npm run local:open
npm run local:status
npm run local:stop
```

`local:start` initializes or resumes a dedicated PostgreSQL cluster and named local owner, applies migrations, and starts the console in the background. Local sessions expire after four hours. Stop/start to renew one; existing projects, uploads, translations and chat remain. `local:open` opens the sign-in page and, on macOS, copies the private local token to the clipboard for pasting. The token is required; local auth is restricted to direct loopback connections. Server edits restart the server automatically; refresh the browser for UI edits. A server restart can interrupt an in-flight chat or job, so finish or stop active tasks before editing execution code.

The ignored `.hedgeling/local/` directory contains the database, private logs and session file. The ignored `.env.development.local` stores local configuration and encryption keys. Keep both private. Stopping preserves data; do not delete either directory or the encryption key unless deliberately discarding local test data. Nothing is copied from the hosted database. Local test plan access does not create external subscriptions or charges; real model requests still consume provider credits.

## Private configuration

Install Node 22.13+, project dependencies and native PostgreSQL. Create `.env.development.local` with mode `600`:

```dotenv
LOCAL_PORT=8088
LOCAL_DATABASE_PORT=55479
LOCAL_PG_BIN=/absolute/path/to/postgresql/bin
LOCAL_DATABASE_PASSWORD=replace-with-a-generated-local-password
HEDGELING_AGENT_PROVIDER=meta
HEDGELING_META_API_KEY=replace-with-your-server-side-key
HEDGELING_AGENT_META_MODEL=your-accessible-model
HEDGELING_META_RESPONSES_URL=https://provider.example/v1/responses
HEDGELING_META_TRANSLATION_MODEL=your-accessible-model
HEDGELING_AI_KEY_ID=local
HEDGELING_AI_KEYRING='{"local":"replace-with-32-random-bytes-in-base64"}'
```

The launcher ignores hosted database, Cognito and Stripe settings. It uses its dedicated loopback database and an explicit allowlist of model/vault, GitHub OAuth and engine settings from this local file. It never inherits a live service endpoint from the shell. Restart after changing local configuration. The local workspace gets synthetic Business access, English as the sample project's source language, and target locales `fr-CA`, `ru-RU`, and `de`; confirm additions or edits through normal UI/agent flows. Organization translation keys are stored in this local database's encrypted vault and are independent of hosted settings. Add/select a translation provider in **Admin → AI providers & keys**. An explicit `fixture` chat provider offers deterministic demos without model calls; it is not a general-purpose assistant.

Document uploads, Library, project/locale management, jobs, review, file delivery and reporting run locally. GitHub source extraction/tuning still requires a separately configured private engine and local-tenant connection; the launcher does not silently connect to a live service. Do not assume a hosted project's connection exists in this fresh local database.

## GitHub repositories and local extraction

In **Projects → Source extraction → Connect or change a repository**, enter an HTTPS GitHub repository URL. Explore the default branch, list other branches, select literal paths, and review the connection. Ask Hedgeling to inspect the repository and suggest relevant paths when the feature scope is unclear. Suggestions based on filenames need review, especially for shared files. File lists paginate at 100; branches at 50. Extraction has its own confirmation, pins a commit, and accepts up to 100 files, 1 MiB each and 5 MiB total. Importing extracted strings is a separate confirmation.

Public repositories work without login. For private repositories, add the following server-only values to the ignored local file:

```dotenv
HEDGELING_GITHUB_CLIENT_ID=your-github-app-client-id
HEDGELING_GITHUB_CLIENT_SECRET=your-github-app-client-secret
LOCAL_ENGINE_ROOT=/absolute/path/to/separate-private-engine-checkout
LOCAL_ENGINE_PORT=4319
```

Install/build the private checkout's dependencies first. The launcher starts its existing engine API separately on loopback, with a separate `hedgeling_engine_local` database and generated local service credentials under `.hedgeling/local/engine/`. The console repository does not contain that engine. Stop/start restarts both processes and preserves data. Restart the local site after changing private engine code. Alternatively, configure `HEDGELING_ENGINE_URL` and `HEDGELING_ENGINE_TOKEN` explicitly for an authorized HTTPS service. Loopback HTTP is allowed only in local development with `HEDGELING_ENGINE_ALLOW_LOOPBACK_HTTP=true`; never use a production service as a fallback.

Register `http://127.0.0.1:8088/api/github/callback` in the GitHub App (adjust the port if needed). The local launcher supplies that callback value automatically. Wildcards, authorization during installation, and Device Flow are unnecessary for this browser flow. Click **Connect GitHub** while signed into the console. Private access requires both the user's own access and the App's read-only Contents access to that repository. Being logged into github.com alone does not authorize the console. User credentials stay encrypted in the backend; they never reach the agent or engine. Reconnect after the current eight-hour connection expires. Disconnect removes local credentials; revoking the GitHub authorization itself is done on GitHub.

After extraction confirmation, the console backend downloads the selected source at its pinned commit and sends that bounded snapshot to the separate engine. This is a hosted-processing workflow, not a promise that code stays on the user's device. Source snapshots are removed after processing/cancellation; catalogs and reports follow the existing seven-day retention. Private repository access is rechecked before reading results. No source is pushed back to GitHub.

Context enrichment is available in **Projects → Context · descriptions and length suggestions** and through the assistant. The synthetic **Context workshop (sample)** project was imported locally to verify nearby-code descriptions; it does not represent a GitHub connection. Generate suggestions, review them, then accept selected context separately before starting a translation job. Advisory length suggestions never change enforced limits. The engine's source-excerpt adapter still needs deployment before hosted re-extractions can include those excerpts.

## Validate and release a batch

Test locally through the UI and agent, run the relevant suites plus build/lint/public-boundary checks, and keep new work off `main` until ready. Then open one reviewed batch PR, update the event provenance/integration inventory, and let the existing CI/container/deployment pipeline validate and publish the batch. There is no need to run the cloud deployment for each visual change.
