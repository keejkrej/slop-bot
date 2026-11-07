# Slop Bot

A single-tenant personal bot club for Android, web, and desktop. Create custom bots, place up to four in a room, and run bounded group turns where each bot can read and respond to earlier speakers.

## What works

- **Web:** Next.js 16, React, shadcn/ui `base-lyra`, Base UI, Tailwind.
- **Android:** Expo SDK 57, Expo Router, React Native Reusables, NativeWind.
- **Shared design:** `@slopbot/design-tokens` supplies Lyra's neutral palette, monospace type, square geometry, spacing, and semantic tokens to every client.
- **Agents:** AI SDK 7 `WorkflowAgent` (the durable `ToolLoopAgent` counterpart), Vercel AI Gateway, and Vercel Workflows.
- **Persistence:** Drizzle + Postgres in production; an atomic file store for zero-setup local development.
- **Connections:** custom Streamable HTTP MCP, OAuth discovery + dynamic client registration + PKCE, GitHub remote MCP, and Composio user-scoped hosted MCP sessions.
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

Create a Postgres database (Supabase works well), then set:

```dotenv
DATABASE_URL=postgresql://...
TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32>
```

Run:

```bash
pnpm db:migrate
```

Do not deploy with the file store; Vercel's filesystem is not durable application storage.

### 2. Single-tenant Google login

Create a Supabase project and enable **Google** under Auth → Providers. Configure Google OAuth with the Supabase callback URL shown in the dashboard. Set:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
EXPO_PUBLIC_SUPABASE_URL=<same-project-url>
EXPO_PUBLIC_SUPABASE_ANON_KEY=<same-anon-key>
ALLOWED_EMAIL=you@example.com
```

Only `ALLOWED_EMAIL` can use the production API. Local development bypasses login only when Supabase variables are absent. Email magic links are also available. GitHub sign-in is not needed for app authentication; GitHub remains available as an MCP tool connection.

### 3. Agents

On Vercel, Eve is not required and no separate agent service is needed. Next.js hosts the workflows, and Vercel Workflows provides managed durability. AI Gateway can authenticate through the project's OIDC identity. For local inference, set:

```dotenv
AI_GATEWAY_API_KEY=<gateway-key>
```

Each bot can override the model ID in its creation form.

### 4. MCP OAuth and Composio

Set the public canonical URL:

```dotenv
APP_URL=https://your-app.vercel.app
```

The OAuth callback is:

```text
https://your-app.vercel.app/api/oauth/mcp/callback
```

Compliant MCP OAuth servers can use discovery and dynamic client registration; no provider token is shipped to clients. Locally, OAuth providers generally require a public HTTPS tunnel instead of a LAN URL.

For Composio:

```dotenv
COMPOSIO_API_KEY=<project-api-key>
```

Composio sessions are created with the signed-in user's ID. Session headers are encrypted before storage.

### 5. Desktop pairing

Set a high-entropy pairing token and your Supabase Auth user UUID:

```dotenv
DESKTOP_PAIRING_TOKEN=<openssl rand -hex 32>
DESKTOP_USER_ID=<supabase-auth-user-uuid>
```

In the signed-in web app, open **Connections → Desktop setup** to copy the token. Paste it into the desktop app's Pairing panel and use your deployed `APP_URL`. The desktop then:

1. Connects directly to local MCP endpoints.
2. Registers tool schemas over authenticated outbound HTTPS.
3. Polls for jobs addressed to its device ID.
4. Executes only tools whose MCP annotations declare `readOnlyHint: true`.
5. Resumes the waiting Vercel Workflow hook with the result.

No local MCP URL or listening port is made available to the cloud. Tool arguments and results do cross the bridge when you ask a cloud-hosted bot to use a local tool.

## Deploy to Vercel

Use `apps/web` as the Vercel project's root directory. Install workspace dependencies and run `pnpm build` for the web project. The Next.js configuration in `apps/web/next.config.ts` enables `withWorkflow` and generates the workflow routes.

Required production environment:

- `DATABASE_URL`
- `TOKEN_ENCRYPTION_KEY`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `ALLOWED_EMAIL`
- `APP_URL`
- AI Gateway OIDC access or `AI_GATEWAY_API_KEY`

Optional: `COMPOSIO_API_KEY`, `DESKTOP_PAIRING_TOKEN`, and `DESKTOP_USER_ID`.

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
