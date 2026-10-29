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

The launcher ignores hosted database, Cognito, Stripe and engine settings. It uses only its dedicated loopback database and an allowlist of model/vault settings. Restart after changing local configuration. The local workspace gets synthetic Business access, English as the sample project's source language, and target locales `fr-CA`, `ru-RU`, and `de`; confirm additions or edits through normal UI/agent flows. Organization translation keys are stored in this local database's encrypted vault and are independent of hosted settings. Add/select a translation provider in **Admin → AI providers & keys**. An explicit `fixture` chat provider offers deterministic demos without model calls; it is not a general-purpose assistant.

Document uploads, Library, project/locale management, jobs, review, file delivery and reporting run locally. GitHub source extraction/tuning still requires a separately configured private engine and local-tenant connection; the launcher does not silently connect to a live service. Do not assume a hosted project's connection exists in this fresh local database.

## Validate and release a batch

Test locally through the UI and agent, run the relevant suites plus build/lint/public-boundary checks, and keep new work off `main` until ready. Then open one reviewed batch PR, update the event provenance/integration inventory, and let the existing CI/container/deployment pipeline validate and publish the batch. There is no need to run the cloud deployment for each visual change.
