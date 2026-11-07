# Slop Bot Desktop

Electrobun + Bun desktop client using the operating system's native webview.

## Run

From the repository root:

```bash
pnpm dev:desktop
```

Build the current platform:

```bash
pnpm build:desktop
```

The root scripts locate Hutch in its standard user-level installation directories and run it in this package.

## Structure

- `src/bun/index.ts` — native windows and typed RPC handlers.
- `src/bun/mcp.ts` — direct local Streamable HTTP MCP discovery and invocation.
- `src/bun/bridge.ts` — authenticated outbound registration, job polling, and result delivery.
- `src/bun/store.ts` — atomic settings persistence under Electrobun's app-scoped `Utils.paths.userData`.
- `src/shared/rpc.ts` — type-only main/webview RPC contract.
- `src/mainview/` — Lyra-themed local connection manager.

**Open web app** creates a separate sandboxed native webview with no privileged RPC. The local-tools window retains the privileged RPC bridge.

Local MCP servers never need to listen beyond the user's machine. Cloud agent workflows receive tool schemas and send jobs through the authenticated API; only explicitly read-only MCP tools can execute.
