# Slop Bot

A single-tenant personal bot club for Android, web, and desktop. Create custom bots and keep a focused one-to-one chat with each of them.

## What works

- **Web:** Next.js 16, React, shadcn/ui `base-lyra`, Base UI, Tailwind.
- **Android:** Expo SDK 57, Expo Router, React Native Reusables, NativeWind.
- **Shared design:** `@slopbot/design-tokens` supplies Lyra's neutral palette, monospace type, square geometry, spacing, and semantic tokens to every client.
- **Agents:** AI SDK 7 `WorkflowAgent` (the durable `ToolLoopAgent` counterpart), Vercel AI Gateway with `anthropic/claude-sonnet-5.5` as the default model, and Vercel Workflows.
- **Persistence:** Drizzle + Postgres in production; an atomic, single-process file store for zero-setup local development.
- **Proactive automations:** user-managed one-time or five-field cron schedules in an IANA timezone, bound to a bot's existing conversation, with durable runs, busy queuing, catch-up coalescing, and an in-app Activity view on web and desktop.
- **Durable runs:** fenced per-conversation runs with idempotent message, approval, and scheduled starts; approval decisions resume through a public persistent seam.
- **Connections:** custom Streamable HTTP MCP, OAuth discovery + dynamic client registration + PKCE, and optional encrypted API-key headers for providers such as Composio.
- **Native capabilities:** Parallel Search, durable file-backed memory with user-confirmed instructions and approval-gated deletion, and just-in-time Vercel Sandbox computers.
- **Desktop:** Electrobun with the native system webview (WKWebView, WebView2, or WebKitGTK). Its outbound bridge reaches MCP servers on your computer without opening an inbound cloud-accessible port.
- **Application layer:** Effect 4 services, Layers, typed errors, and dependency injection for storage, authentication, and MCP.

## Proactive automations

Automations are user-managed schedules bound to a bot's existing conversation. A schedule is either a one-time local timestamp or a standard five-field cron expression, each with an IANA timezone. Due work is admitted as a durable run; if the conversation is busy, the occurrence stays queued and a later tick retries it. Recurring catch-up coalesces missed occurrences into the latest one, and a one-time task expires after 24 hours late. Results and run history appear in the in-app Activity view on web and desktop; unread bot-message badges appear on web and mobile, backed by a per-conversation read bookmark. There is no Android Activity surface yet. `GET /api/activity` returns read-only run summaries for the signed-in user.

Runs are the durable record for regular messages, approvals, and scheduled work. Message, approval, and scheduled starts share one claim-and-admit path with idempotency keys, and approval decisions resume through a public persistent seam. A run's terminal completion writes the bot message and the succeeded status atomically, and start tokens are scoped per attempt so an approval resume gets a fresh owner. Idempotency reduces duplicate work but does not make external side effects exactly-once.

`FileStore` is single-process and intended for local development; production requires Postgres.

See [always-on.md](docs/architecture/always-on.md), [scheduling.md](docs/architecture/scheduling.md), and [run-recovery.md](docs/architecture/run-recovery.md).

## Memory and tool permissions

Memory is a small, validated markdown tree stored in the same database as the rest of the app. `instructions.md` is global to the user and read-only to the model; `index.md`, `reported.md`, `notes/*.md`, and `progress/*.md` are conversation-scoped. Only the always-on core loads at run start; notes and progress are browsed on demand. The Memory settings tab supports editing instructions, browsing files, exporting a snapshot, and explicit path-scoped forget. See [memory.md](docs/architecture/memory.md).

MCP tools are read-only by default. Each connection can grant a finite, explicit list of write tools; there is no blanket write toggle. A granted write still pauses for a signed, expiring approval and is rechecked at execution time against the current connection, bot selection, and risk. Composio executors are evaluated recursively and are never grantable. See [tool-permissions.md](docs/architecture/tool-permissions.md).

## Run locally

Requirements: Node 24, pnpm 10, and—only for desktop builds—Bun/Hutch. The Electrobun initializer installs its matching Hutch release.

```bash
cp .env.example .env
pnpm install
pnpm dev
```

Open **http://localhost:3000**. Local mode uses `demo-user`, `apps/web/.data/store.json`, and a deterministic demo responder when no gateway credentials are present. If `AI_GATEWAY_API_KEY` is set, bots use the configured Vercel AI Gateway model instead.

### Scheduler tick

`next dev` does not run a continuous background timer. Trigger a tick manually:

```bash
pnpm tick
```

`pnpm tick` runs the scheduled-task pass and durable run recovery in one pass.

### Android phone

Keep `pnpm dev` running, then in another terminal:

```bash
pnpm dev:mobile
```

1. Install the current **Expo Go** app (this project intentionally uses SDK 57 for Expo Go compatibility).
2. Connect the phone and computer to the same network.
3. Scan the QR code with Expo Go.
4. Leave `EXPO_PUBLIC_API_URL` blank: the app derives the API host from Expo's Metro host. For an Android emulator, set it to `http://10.0.2.2:3000`.

Verify the Android bundle without a device:

```bash
pnpm --filter @slopbot/mobile export:android
pnpm --filter @slopbot/mobile typecheck
```

### Desktop

Hutch is already initialized for this project. If you install it separately, follow Electrobun's current quick-start and ensure `hutch` is on your PATH. Do not re-run the initializer over the existing app.

```bash
source ~/.bashrc # if Hutch was just added to PATH
pnpm dev:desktop
```

Build without launching the watcher:

```bash
pnpm build:desktop
```

The desktop window manages local MCP servers. **Open web app** opens the shared product UI in a separate sandboxed native webview with no privileged RPC attached.

## Production setup

### 1. Database

Create a Neon Postgres database (any compatible Postgres provider also works), then set:

```dotenv
DATABASE_URL=postgresql://...
TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32>
```

Run:

```bash
pnpm db:migrate
```

Do not deploy with the file store; Vercel's filesystem is not durable application storage.

### 2. Single-tenant Vercel login

Create a Vercel App under **Team Settings → Apps**. Enable `openid`, `email`, `profile`, and `offline_access`, restrict Sign-In Access to your team, and register both callbacks:

```text
http://localhost:3000/api/auth/callback/vercel
https://your-app.vercel.app/api/auth/callback/vercel
```

Set the app's credentials and the Vercel user ID allowed to use this deployment. `BETTER_AUTH_SECRET` signs the app's own web/mobile sessions; generate it with `openssl rand -base64 32` if it wasn't provisioned by the Vercel app setup.

```dotenv
VERCEL_APP_CLIENT_ID=<vercel-app-client-id>
VERCEL_APP_CLIENT_SECRET=<vercel-app-client-secret>
BETTER_AUTH_SECRET=<random-32-byte-secret>
ALLOWED_USER_ID=<your-vercel-user-id>
```

You can find the user ID with `vercel api /v2/user`. Web uses an HTTP-only signed cookie; Android stores its signed session in Expo SecureStore. The OAuth flow uses PKCE, state, and nonce validation. Local development bypasses login without weakening production checks.

### 3. Agents

On Vercel, Eve is not required and no separate agent service is needed. Next.js hosts the workflows, and Vercel Workflows provides managed durability. AI Gateway can authenticate through the project's OIDC identity. For local inference, set:

```dotenv
AI_GATEWAY_API_KEY=<gateway-key>
```

Each bot can override the model ID in its creation form.

### 4. Custom MCP

Add any Streamable HTTP MCP URL from **Connections → Add connection**. OAuth-capable servers use discovery, dynamic client registration, and PKCE. For API-key providers such as Composio, enter an optional header name/value pair (for example, `x-api-key`); the value is encrypted before storage and never returned to clients. GitHub's remote MCP endpoint is `https://api.githubcopilot.com/mcp/`.

Set the public canonical URL:

```dotenv
APP_URL=https://your-app.vercel.app
```

The OAuth callback is:

```text
https://your-app.vercel.app/api/oauth/mcp/callback
```

Compliant MCP OAuth servers can use discovery and dynamic client registration; no provider token is shipped to clients. Locally, OAuth providers generally require a public HTTPS tunnel instead of a LAN URL.

### 5. Desktop pairing

Set a high-entropy pairing token and your Vercel user ID:

```dotenv
DESKTOP_PAIRING_TOKEN=<openssl rand -hex 32>
DESKTOP_USER_ID=<vercel-user-id>
```

In the signed-in web app, open **Connections → Desktop setup** to copy the token. Paste it into the desktop app's Pairing panel and use your deployed `APP_URL`. The desktop then:

1. Connects directly to local MCP endpoints.
2. Registers tool schemas over authenticated outbound HTTPS.
3. Polls for jobs addressed to its device ID.
4. Executes only tools approved by the read-only tool policy.
5. Resumes the waiting Vercel Workflow hook with the result.

No local MCP URL or listening port is made available to the cloud. Tool arguments and results do cross the bridge when you ask a cloud-hosted bot to use a local tool.

### 6. Scheduler tick

Production uses a static Vercel Schedule in `apps/web/vercel.json`: the `schedules` entry `proactive-tick` POSTs `/api/cron/tick` every 15 minutes. Set a secret:

```dotenv
CRON_SECRET=<openssl rand -hex 32>
```

`CRON_SECRET` is required in production (the route fails closed when unset) and optional locally. Rotating it requires redeploying so the new value reaches the deployment environment. Scheduling does not use `@vercel/schedules` or a queue product.

## Deploy to Vercel

Use `apps/web` as the Vercel project's root directory. Install workspace dependencies and run `pnpm build` for the web project. The Next.js configuration in `apps/web/next.config.ts` enables `withWorkflow` and generates the workflow routes.

Deployment is CLI-only: the project's Git integration is disabled, so a push does not deploy. Follow [release-runbook.md](docs/operations/release-runbook.md) for the preconditions, migration order, explicit production deploy, schedule verification, and rollback rules.

Required production environment:

- `DATABASE_URL`
- `TOKEN_ENCRYPTION_KEY`
- `VERCEL_APP_CLIENT_ID`
- `VERCEL_APP_CLIENT_SECRET`
- `BETTER_AUTH_SECRET`
- `ALLOWED_USER_ID`
- `APP_URL`
- `CRON_SECRET`
- AI Gateway OIDC access or `AI_GATEWAY_API_KEY`

Optional: `DESKTOP_PAIRING_TOKEN` and `DESKTOP_USER_ID`.

## Verification

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm tick
pnpm build:desktop
pnpm --filter @slopbot/mobile export:android
```

The repository includes unit tests for shared contracts, persistence/secret isolation, desktop-job idempotency and claim/delivery, Effect service injection, schedule-time calculation, automation storage, cron auth, run recovery, tool risk and write grants, gated MCP execution, file memory, sanitized run telemetry, and replay evals. The local fixture at `tests/fixtures/local-mcp-server.mjs` provides a loopback-only read-only MCP tool for bridge testing.

The Postgres integration suites skip when `TEST_DATABASE_URL` is unset. Point it at a disposable database and run the full suite serially:

```bash
pnpm exec dotenv -e .env.test.local -- pnpm exec vitest run
```

The schema is applied with a transaction-scoped advisory lock, and the suites clean up their own rows.

## Intentional MVP boundaries

- A chat has exactly one bot. Replies are bounded to six model steps.
- Clients poll persisted messages; resumable token-by-token streaming is not yet exposed.
- MCP tools are read-only by default. A connection can grant a finite list of write tools, but each granted write still requires a signed, expiring approval; there is no blanket write toggle.
- Memory is local and file-backed. There is no Mem0, AgentMail, or other external memory/email service, and no background memory dreaming or heartbeat loop.
- Proactive results stay in the in-app Activity view. There is no Slack, Telegram, inbound email, or push delivery channel.
- Idempotency keys reduce duplicate work but do not guarantee exactly-once external side effects. The MCP `_meta` idempotency hint is inert unless a provider chooses to honor it.
- Bots do not autonomously create endless conversations or recurse into uncontrolled bot-to-bot loops.
- This is a personal single-tenant product, not a multi-organization permissions system.
