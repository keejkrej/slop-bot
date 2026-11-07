# Agent architecture

## Model

Each bot has four distinct resources:

```text
Identity + instructions (Neon)
Computer (just-in-time Vercel Sandbox)
Memory (bot-scoped Mem0)
Capabilities (global connections + native tools)
```

Bots do not get long-running VMs. A sandbox is created only when a computer tool is invoked, used for a bounded turn, and stopped in `finally`.

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

- **Neon:** bots, conversations, messages, connections, run state, and approvals.
- **Mem0:** preferences and learned context, scoped by `agent_id` to one bot and `app_id` to Slop Bot. `run_id` identifies a group turn when useful.
- **Drive:** files produced by a bot, only when persistence is required.

Mem0 writes should use `infer: false` for explicitly attributed facts or role-tagged conversation messages for automatic extraction. Do not query with `AND(user_id, agent_id)` for extraction-produced memories; the default extraction path attributes facts to one speaker, not both.

Sources: [Mem0 entity-scoped memory](https://docs.mem0.ai/platform/features/entity-scoped-memory), [Mem0 quickstart](https://docs.mem0.ai/platform/quickstart).

## Capabilities are global, not assigned per bot

Every bot sees the same configured connections and native tools. A global policy layer, not a per-bot allowlist, decides what can execute.

Native tools:

- `web_search`: Parallel Search.
- `memory_search` / `memory_save`: Mem0, scoped to the calling bot.
- `send_email`: AgentMail, requiring explicit approval.
- `computer_*`: bounded just-in-time sandbox operations.
- Custom/cloud/desktop MCP tools, with read/execute policy checks.

Sources: [Parallel Search quickstart](https://docs.parallel.ai/search/search-quickstart), [AgentMail send message](https://docs.agentmail.to/api-reference/inboxes/messages/send), [Composio multi execute](https://docs.composio.dev/toolkits/meta-tools/multi_execute_tool).

## Desktop local MCP

The desktop renders the same web app. A private endpoint such as `http://127.0.0.1:<port>/mcp` becomes a desktop-pending connection. Electrobun discovers and claims it through the authenticated outbound bridge. Hosted agents receive schemas and invoke tools through Workflow hooks; the hosted API never connects inbound to the laptop's port.

## Safety and durability

- Model and tool work runs in `WorkflowAgent` with explicit step limits.
- Email and other consequential writes pause for signed user approval and resume durably.
- MCP execution is guarded by operation, including every nested `tool_slug` in Composio multi-execute.
- Sandbox handles and live MCP clients never cross durable-step serialization boundaries.
- Compute and memory retrieval happen only on demand to control both latency and spend.
