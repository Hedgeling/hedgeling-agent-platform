# Demo hosting and Meta chat

The demo is isolated from the production application's database, identity pool, secrets, container repository and IAM roles. It shares an existing VPC, ECS cluster and HTTPS load balancer, supplied through private CloudFormation parameters. The host rule adds the demo hostname without changing the default listener route. No customer data is copied.

## Local Meta chat

Put these settings in an ignored, private `.env.local` file. Use a model that your Meta account can access; this adapter has been tested with `muse-spark-1.3`.

```dotenv
HEDGELING_AGENT_PROVIDER=meta
HEDGELING_META_API_KEY=<server-side-key>
HEDGELING_AGENT_META_MODEL=muse-spark-1.3
```

With the disposable local database configured, run:

```sh
DATABASE_URL=postgresql://platform:local-demo-only@127.0.0.1:55477/platform node --env-file=.env.local packages/web-console/scripts/dev-agent.js
```

The adapter uses Meta's [Responses protocol](https://dev.meta.ai/docs/protocols/responses) with `store: false` and replays encrypted reasoning server-side. It preserves function call IDs across turns and keeps the same shared tools, permission checks, confirmation boundary and included-chat quotas. Model output is buffered; console activity events still update while tools run. Errors do not expose credentials or silently switch providers. Organization Meta keys and contextual translation have a separate adapter described below. Bedrock remains planned.

## Infrastructure bootstrap

Use `infra/aws/demo-stack.json`. Read `sub_claim_prefix` from `GET /repos/{owner}/{repo}/actions/oidc/customization/sub` and supply it as `GitHubOidcSubjectPrefix`; newer repositories can include immutable owner/repository IDs, so do not guess the subject from the repository name. See the [GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc). Supply the existing network, ALB/listener, hosted-zone and GitHub OIDC identifiers in a private parameter file. Never commit actual resource IDs, hostnames, passwords, owner emails or stack outputs. The initial foundation can use `ServiceEnabled=false` and an unset image; do not launch that task until an image is published.

1. Create the stack with `CAPABILITY_IAM`, keeping `ServiceEnabled=false`. It provisions private encrypted PostgreSQL, backups, a Cognito pool with admin-created users only, ECR, logs, an ACM certificate and scoped roles.
2. Preserve the generated `sessionSigningSecret` in the runtime secret. Add `metaApiKey` and `aiKeyring`; the latter is a JSON string mapping `demo-v1` to a base64-encoded random 32-byte key. DB credentials are generated and managed separately by RDS. Never put secret values in task overrides, workflow inputs or logs.
3. Prepare the invited Cognito users with email verified, `MessageAction=SUPPRESS` and unique temporary passwords. Store these in a private password manager or ignored local file. Users set a new password at first login. This step does not email invitations.
4. Create the GitHub `demo` environment, permit only `main`, and configure `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY`, `ECS_CLUSTER`, `ECS_SERVICE`, `ECS_TASK_FAMILY` and `DEMO_PUBLIC_ORIGIN` as environment variables. No static AWS credential is required; the role trusts this repository's `demo` environment through OIDC.
5. Run **Deploy demo** with `image_only=true` after CI passes. Set the stack's `ImageUri` to the resulting immutable digest, still with `ServiceEnabled=false`. This registers the runnable task definition.
6. Run a one-off task with that definition, the demo task security group and private subnets. Override its command to `node packages/web-console/scripts/seed-demo.js` and supply `HEDGELING_DEMO_SEED_ENABLED=true` plus `HEDGELING_DEMO_OWNER_EMAILS` as a JSON array. The seed refuses any database name other than `hedgeling_demo`. It initializes the fresh migration baseline, adds named owners and a synthetic workspace with local Business access. It creates no Stripe customer, card, charge or external subscription. Re-running does not duplicate membership or subscriptions.
7. Enable the service in CloudFormation. This adds the DNS alias and host route, starts a private Fargate task and enables deployment rollback. Verify HTTPS health, anonymous API rejection, owner login and a real agent tool call.

PostgreSQL TLS verifies the AWS RDS trust chain using [AWS's public certificate bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html). The task has no general AWS API permissions. The execution role can read only the demo image, logs and two demo secrets. Self-service signup, Stripe checkout and facilitated payments are disabled. Translation requires its own explicitly configured provider; the Meta chat key does not enable paid translation automatically.

## Releases and rollback

Run **Deploy demo** on `main`, with `ref=main` or a full commit SHA on main. The workflow requires a successful `ci.yml` push run for that exact SHA, builds or reuses an immutable image tag, then deploys by digest. Its AWS role can update only the demo service and pass only the demo task roles. Updates preserve the task's secret references and configuration. The workflow verifies service stability, health and HTTP 401 for anonymous agent access. Secret values are never passed to the workflow; operational endpoints are configured through environment variables rather than committed source.

To roll back, dispatch the workflow with an earlier tested SHA on main. ECS also uses automatic rollback for failed deployments. Application rollback does not reverse database migrations; review migration compatibility before release. Deployment is manual to avoid an unreviewed push immediately changing the demo. The CI workflow remains automatic on pushes and pull requests.

CloudFormation owns infrastructure and the initial task definition; subsequent release revisions are registered by the deployment workflow. Before updating infrastructure, set the private `ImageUri` parameter to the service's current image digest so an infrastructure change does not restore an older image. Keep changes to the shared listener limited to this stack's certificate and host rule.

## Operations

Use `/api/health`, ECS service events and the demo CloudWatch log group for troubleshooting. Runtime logs expire after 14 days; database automated backups retain three days. RDS deletion protection and snapshot retention are enabled. Deleting the stack alone does not stop all retained-resource costs: explicitly review retained database snapshots, ECR images and shared infrastructure afterward. No notification destination is configured by default.

Rotate a model key in the demo runtime secret, then force a new demo service deployment; ECS injects secret values at task startup. Keep AI keyring entries needed to decrypt previously saved credentials when rotating the active key. Restarting tasks interrupts active agent runs, so deploy between demo sessions. The current single-task service is a staging configuration, not a high-availability claim.

Additional judges require individual Cognito logins and explicit workspace membership. Never enable public signup merely to grant a judge access. The seeded organization provides the initial chat context; newly created organizations still need their own entitlement setup. Product onboarding and Meta BYOK are not replaced by this operator-only bootstrap.

## Synthetic extraction project

The source workflow needs the separate private engine connection configured on the demo server. Vendor the event-only modules from a clean reviewed commit in the submission repository; retain their license and hash manifest. Server startup applies the additive extraction connection/request migration. The old engine is never included in this console image.

After deployment, run the explicit one-off command `node packages/web-console/scripts/seed-extraction-demo.js` using the demo task's existing network, roles and secret references. Set `HEDGELING_DEMO_SEED_ENABLED=true` and `HEDGELING_DEMO_SOURCE` to a JSON object containing `connectionId`, `repositoryId`, `owner`, and `repository` from the verified synthetic GitHub installation. It only accepts `hackathon-source` for `Hedgeling/hedgeling-meta-hackathon` and refuses other database/workspace identities or conflicting records. The numeric repository ID must come from the verified installation, not a guessed value.

This creates **Source demo → Source extraction demo** (`extraction-demo`) within the existing synthetic workspace, with English source and access limited to `examples/source`. Existing workspace owners inherit their normal project permissions. It creates no new memberships, billing, extraction jobs or imports. Repeating the same seed is safe; changed bindings require explicit review.

Try chat: “Extract source strings for project extraction-demo from its connected repository, using main and examples/source.” Confirm the extraction, wait for the progress card, then select **Review import** and confirm separately. Manual access is in the workspace project's **Source extraction** panel. The preview discloses hosted source processing and the pinned commit. No translation or repository write starts in this flow. Label any operator smoke run separately from live Meta chat verification.

## Organization Meta keys

Configure `MetaResponsesUrl` and `MetaTranslationModel` in the private CloudFormation parameters to populate server-only `HEDGELING_META_RESPONSES_URL` and `HEDGELING_META_TRANSLATION_MODEL`. Obtain the HTTPS Responses endpoint from the provider documentation; there is no fallback URL. Local development uses the same environment variables. Missing configuration leaves the Meta card visible with an administrator-setup notice and disables connection/selection. Existing Gemini settings remain usable.

A paid organization owner/admin can open **Admin → AI providers & keys**, enter a Meta key, review and confirm saving, test model access, then separately review and confirm **My organization’s Meta key** as the translation provider. Testing retrieves model metadata and generates no content. Keys remain encrypted and provider/organization-bound; they are never sent to chat or returned by the settings API. Replacement and removal affect only the named provider. Removing the selected key pauses AI translation without switching billing accounts.

The additive migration changes credentials to a composite organization/provider primary key and defaults existing translation routing to Gemini. Existing encrypted Gemini values and pending confirmations remain readable. The legacy `credential` response remains Gemini-only for compatibility; `credentials` contains masked entries by provider and `translationProvider` identifies the selected organization provider. Preview/test requests accept `provider: "meta"` or `"gemini"`; omitted provider retains Gemini behavior. Agent chat continues to use its managed key and separate included-chat limits. The existing translation prompt includes source context, glossary and project instructions; the private extraction service does not receive these keys or gain a context-enrichment pass.
