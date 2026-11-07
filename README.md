# Slop Bot

A single-tenant personal bot club for Android, web, and desktop. Create custom bots, place up to four in a room, and run bounded group turns where each bot can read and respond to earlier speakers.

## What works

- **Web:** Next.js 16, React, shadcn/ui `base-lyra`, Base UI, Tailwind.
- **Android:** Expo SDK 57, Expo Router, React Native Reusables, NativeWind.
- **Shared design:** `@slopbot/design-tokens` supplies Lyra's neutral palette, monospace type, square geometry, spacing, and semantic tokens to every client.
- **Agents:** AI SDK 7 `WorkflowAgent` (the durable `ToolLoopAgent` counterpart), Vercel AI Gateway with `anthropic/claude-sonnet-5.5` as the default model, and Vercel Workflows.
- **Persistence:** Drizzle + Postgres in production; an atomic file store for zero-setup local development.
- **Connections:** custom Streamable HTTP MCP, OAuth discovery + dynamic client registration + PKCE, and optional encrypted API-key headers for providers such as Composio.
- **Native capabilities:** Parallel Search, per-bot Mem0 memory, just-in-time Vercel Sandbox computers, and AgentMail sends with durable signed approval/resume.
- **Desktop:** Electrobun with the native system webview (WKWebView, WebView2, or WebKitGTK). Its outbound bridge reaches MCP servers on your computer without opening an inbound cloud-accessible port.
- **Application layer:** Effect 4 services, Layers, typed errors, and dependency injection for storage, authentication, and MCP.

## Run locally

Requirements: Node 24, pnpm 10, and—only for desktop builds—Bun/Hutch. The Electrobun initializer installs its matching Hutch release.

```bash
cp .env.example .env
pnpm install
pnpm dev
```

Open **http://localhost:3000**. Local mode uses `demo-user`, `apps/web/.data/store.json`, and a deterministic demo responder when no gateway credentials are present. If `AI_GATEWAY_API_KEY` is set, bots use the configured Vercel AI Gateway model instead.

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

## Deploy to Vercel

Use `apps/web` as the Vercel project's root directory. Install workspace dependencies and run `pnpm build` for the web project. The Next.js configuration in `apps/web/next.config.ts` enables `withWorkflow` and generates the workflow routes.

Required production environment:

- `DATABASE_URL`
- `TOKEN_ENCRYPTION_KEY`
- `VERCEL_APP_CLIENT_ID`
- `VERCEL_APP_CLIENT_SECRET`
- `BETTER_AUTH_SECRET`
- `ALLOWED_USER_ID`
- `APP_URL`
- AI Gateway OIDC access or `AI_GATEWAY_API_KEY`

Optional: `DESKTOP_PAIRING_TOKEN` and `DESKTOP_USER_ID`.

## Verification

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm build:desktop
pnpm --filter @slopbot/mobile export:android
```

The repository includes unit tests for shared contracts, persistence/secret isolation, desktop-job idempotency, and Effect service injection. The local fixture at `tests/fixtures/local-mcp-server.mjs` provides a loopback-only read-only MCP tool for bridge testing.

## Intentional MVP boundaries

- Group turns are sequential and bounded: at most four bots and six model steps per bot.
- Clients poll persisted messages; resumable token-by-token streaming is not yet exposed.
- MCP tools are exposed only when explicitly marked read-only. Writes remain blocked until durable per-call approval UI is implemented.
- Bots do not autonomously create endless conversations or recurse into uncontrolled bot-to-bot loops.
- This is a personal single-tenant product, not a multi-organization permissions system.
