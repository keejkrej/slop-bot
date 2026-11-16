# Release runbook

This runbook covers a production release of the web app. It is written for the
current repository state: a single Vercel project whose root directory is
`apps/web`, deployed from the CLI. The project's Git integration is disabled, so
pushing a branch does not deploy. Do not assume a Git push will produce a
deployment.

## Preconditions

Do not invoke production until every code check has passed.

1. **Code checks.** Run the repository checks and confirm they pass:

   ```bash
   pnpm typecheck
   pnpm test
   pnpm build
   ```

2. **Postgres integration tests.** Run the full suite serially against a
   disposable local test database:

   ```bash
   pnpm exec dotenv -e .env.test.local -- pnpm exec vitest run
   ```

   The integration suites skip when `TEST_DATABASE_URL` is unset. Use a
   disposable database, never production. No Neon branch was provisioned for
   this release: creating one needs control-plane credentials, and testing
   against production is not acceptable. The local test database is the
   supported path.

3. **Backup or snapshot.** Take a safe backup or provider snapshot of the
   production database before applying migrations. Keep the backup outside the
   repository and do not print its contents.

4. **Migrations are additive.** `db/schema.sql` only adds tables, columns, and
   indexes. `db/schema-init.ts` applies the whole script inside one transaction
   that first takes a fixed transaction-scoped advisory lock, so concurrent
   initializers serialize instead of racing on `create ... if not exists`
   (notably unique indexes). Do not rewrite or drop existing tables as part of a
   normal release.

## Environment and secrets

- **Auth project root.** The Vercel project root directory is `apps/web`.
- **`CRON_SECRET`.** Required in Production only; the tick route fails closed
  when it is unset. Generate it and pipe it directly into the environment
  without printing it or committing it. Rotating it requires a redeploy so the
  new value reaches the deployment.
- **AI Gateway.** Vercel OIDC is the expected production path. A fallback
  `AI_GATEWAY_API_KEY` may already be present in the parent environment. Never
  print a key, and never download a secret into a tracked file.
- **Other required production variables.** `DATABASE_URL`,
  `TOKEN_ENCRYPTION_KEY`, `VERCEL_APP_CLIENT_ID`, `VERCEL_APP_CLIENT_SECRET`,
  `BETTER_AUTH_SECRET`, `ALLOWED_USER_ID`, and `APP_URL`. Optional:
  `DESKTOP_PAIRING_TOKEN` and `DESKTOP_USER_ID`.

## Release steps

1. **Confirm the revision.** Check the current `origin/HEAD` revision and the
   commit you intend to release. Do not rely on stale CLI metadata or an old
   local branch name.

   ```bash
   git fetch origin
   git rev-parse origin/HEAD
   git rev-parse HEAD
   ```

2. **Apply migrations.** Run the migration against production after the backup
   exists:

   ```bash
   pnpm db:migrate
   ```

   The migration is additive and serialized by the advisory lock. If it fails,
   stop and restore from the backup rather than editing the schema by hand.

3. **Deploy explicitly to production.** Run from the repository root. The root
   `.vercel/project.json` is linked to the project whose Root Directory is
   `apps/web`, so the CLI resolves the correct project and build root from the
   repository root. Do not `cd apps/web` first: that bypasses the linked
   repository location and makes the target ambiguous.

   ```bash
   vercel deploy --prod --project slop-bot --scope keejkrej-teams
   ```

   An `apps/web`-specific link is only necessary if you deliberately maintain a
   separate `.vercel` link inside `apps/web` (for example, a standalone checkout
   of that directory). In this repository the root link is authoritative.

4. **Verify the schedule registration.** The static schedule in
   `apps/web/vercel.json` uses the current `schedules` object: the entry
   `proactive-tick` POSTs `/api/cron/tick` every 15 minutes. Confirm it is
   registered from the repository root:

   ```bash
   vercel schedules list --project slop-bot --scope keejkrej-teams
   ```

   The repository test `tests/vercel-schedules.test.ts` only checks the
   configuration shape and the route's exported method. It does not prove host
   registration or invocation; those are verified here, after deploy, from the
   CLI and the schedule's execution history. Do not assume the legacy `crons`
   array, a GET request, or a different path.

5. **Smoke check.** Confirm the deployment is healthy and that a manual tick
   succeeds with the configured secret. Do not run a production invocation
   before the code checks above have passed.

## Rollback

- **New version only.** Roll back to a previously deployed version only when
  the schema changes in this release are additive. The current tables are
  compatible with the old app for additive changes.
- **Old app compatibility is not guaranteed** if a release manually removes
  tools, users, or other schema. Do not drop columns or tables to roll back.
- **Migrations remain in place.** Rolling back the application does not roll
  back the database. Leave the additive migrations applied; the previous app
  version ignores the new columns and tables.

## Boundary warnings

- **Optional OTel.** The installed `WorkflowAgent` telemetry is enabled only
  when `OTEL_EXPORTER_OTLP_ENDPOINT` is explicitly configured. Input and output
  recording stay off (`recordInputs: false`, `recordOutputs: false`). The
  default path stores backend usage and tool events only.
- **MCP idempotency is inert.** The `_meta` idempotency key is a best-effort
  hint. Provider support is unknown, and there is no exactly-once guarantee.
- **Tool output is bounded.** MCP and desktop results are redacted and capped
  before persistence or delivery. Oversized results become a structured
  envelope, not invalid JSON.
- **Secrets stay out of logs and snippets.** Global secrets are not written to
  logs, trace events, approval summaries, or user-facing snippets.
- **Preserve the current behavior.** This release removes the Mem0 and AgentMail
  integrations and keeps the existing bot-level `integrationIds` selection
  behavior. Do not reintroduce those services or change the connection-selection
  semantics as part of a release.
