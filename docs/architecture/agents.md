# Agent architecture

## Model

Each bot has four distinct resources:

```text
Identity + instructions (Neon)
Computer (just-in-time Vercel Sandbox)
Memory (durable file tree in the store)
Capabilities (bot-selected connections + native tools)
```

Bots do not get long-running VMs. A sandbox is created only when a computer tool is invoked, used for a bounded turn, and stopped in `finally`.

Compute is ephemeral; durable state is not. `AppStore.runs` (`RunStore`) is the core record for a unit of work, and the workflow process is replaceable around it. See [always-on.md](./always-on.md) for the proactive model.

## Compute lifecycle and cost controls

- Use `Sandbox.getOrCreate` only when compute is needed; no sandbox at bot creation.
- Default to `persistent: false` and a short timeout. Do not expose ports or interactive sessions.
- Stop the sandbox after the current bot turn, including failures.
- Use `networkPolicy: "deny-all"` unless a tool explicitly requires an allowlisted network operation.
- Bound command duration, output size, model steps, tool count, and optional daily compute minutes.
- Prefer a Drive for persistent files instead of snapshotting VMs. Drives persist files independently of compute and are created only for file-oriented work.
- Keep no background jobs, daemons, or `openInteractive` sessions.

Sources: [Persistent sandboxes](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes), [Drives](https://vercel.com/docs/sandbox/concepts/drives), [Sandbox SDK](https://vercel.com/docs/sandbox/sdk-reference).

## Memory is not the system of record

- **Neon:** bots, conversations, messages, connections, run state (`AppStore.runs`, the core record), approvals, and the durable memory file tree.
- **Drive:** files produced by a bot, only when persistence is required.

Memory is a small, validated markdown tree stored in the same database as the rest of the app. `instructions.md` is global to the user and read-only to the model; `index.md`, `reported.md`, `notes/*.md`, and `progress/*.md` are conversation-scoped. Only the always-on core is loaded at run start; notes and progress are browsed on demand. There is no semantic vector store, remote memory service, or background consolidation. See [memory.md](./memory.md).

## Capabilities are selected per bot

Each bot has an explicit `integrationIds` allowlist. Only those connections are listed to the model and only those connections can execute tools for that bot; an empty list means no MCP tools at all. Native tools are unaffected. The store still verifies that every connection belongs to the same user, and the 10-connection / 64-tool bounds apply after selection.

A global policy layer, not the allowlist alone, decides what can execute. Read-only MCP operations are allowed. Writes and destructive operations are denied unless the connection grants that exact tool in a finite `allowedWriteTools` list, and a granted write still pauses for a signed, expiring approval. There is no blanket write toggle. Composio executors are evaluated recursively: every nested `tool_slug` must be a read operation, and nested `COMPOSIO_EXECUTE_*`, `COMPOSIO_MULTI_EXECUTE_TOOL`, or `COMPOSIO_MANAGE_CONNECTIONS` calls are rejected. A read verb in a tool name or a `readOnlyHint` annotation is a hint, not a security boundary. See [tool-permissions.md](./tool-permissions.md).

Native tools:

- `web_search`: Parallel Search.
- `memory_view`, `memory_create`, `memory_str_replace`, `memory_insert`, `memory_rename`: durable file memory scoped to the calling bot's conversation.
- `memory_delete`: durable file memory deletion, requiring explicit user approval.
- `computer_*`: bounded just-in-time sandbox operations.
- Custom/cloud/desktop MCP tools, with read/execute policy checks.

Sources: [Parallel Search quickstart](https://docs.parallel.ai/search/search-quickstart), [Composio multi execute](https://docs.composio.dev/toolkits/meta-tools/multi_execute_tool).

## Desktop local MCP

The desktop renders the same web app. A private endpoint such as `http://127.0.0.1:<port>/mcp` becomes a desktop-pending connection. Electrobun discovers and claims it through the authenticated outbound bridge. Hosted agents receive schemas and invoke tools through Workflow hooks; the hosted API never connects inbound to the laptop's port.

Desktop tools are read-only. The bridge claims a job with a short lease before executing it, and the server records execution and hook delivery separately. A completed job can be re-posted to retry delivery, and an already-delivered result is acknowledged without resuming the hook again. Results are bounded and redacted on the desktop before they leave the machine and again on the server before persistence or delivery.

## Proactive work

Scheduled and unattended work reuses the same run and turn path as interactive chat. A bot has one conversation; automations resolve it rather than creating new ones. Durable tasks and occurrences live in the store, and a single protected tick admits due occurrences. Proactive results are quiet by default and surface in the in-app activity view, with no external delivery channel.

See [always-on.md](./always-on.md) for the design and boundaries, and [scheduling.md](./scheduling.md) for the time policy.

## Safety and durability

- Model and tool work runs in `WorkflowAgent` with explicit step limits.
- Runs are fenced and exclusive per conversation; a stale writer cannot overwrite newer state.
- Run timers and `recoverRuns` are a durable recovery layer for approval timeouts, lease expiry, and start handoff. Admission writes the timers and the scheduler tick runs recovery by default.
- `RunStore.completeWithMessage` writes the bot outbox message and the terminal run state atomically.
- Consequential writes, such as deleting a memory file, pause for signed user approval and resume durably.
- MCP execution is guarded by operation, including every nested `tool_slug` in Composio execute and multi-execute; nested executors and connection mutations are rejected.
- A write approval is rechecked at execution time against the current connection, bot selection, tool risk, and expiry. A revoked grant or a widened risk fails closed.
- MCP results are treated as untrusted: sensitive keys are redacted, depth and collection sizes are capped, and oversized results become a structured envelope rather than invalid JSON.
- Sandbox handles and live MCP clients never cross durable-step serialization boundaries.
- Compute and memory retrieval happen only on demand to control both latency and spend.
