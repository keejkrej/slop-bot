# Tool permissions

Tool policy is enforced in code at the tool boundary, not only in the prompt.
The pure policy lives in `apps/web/lib/server/tool-permissions.ts`; the gated
execution path lives in `apps/web/lib/server/gated-tools.ts`. Both are covered
by `tests/tool-permissions.test.ts` and `tests/gated-tools.test.ts`.

## Risk classification

`classifyToolRisk` reads annotations first, then the tool name:

1. Composio executors and connection management are always `write`.
2. An explicit `destructiveHint: true` is `destructive`.
3. An explicit `readOnlyHint: true` (or the legacy normalized `readOnly` flag)
   is `read`.
4. Destructive verbs in the name are `destructive`.
5. Read verbs in the name are `read`.
6. Write verbs in the name are `write`.
7. Everything else defaults to `write`.

A read verb in a tool name or a `readOnlyHint` annotation is a hint, not a
security boundary. Unknown tools stay denied until an explicit grant exists.

## Per-connection write allowlist

Each connection stores a finite `allowedWriteTools` list. It is:

- Explicit plain tool names only. Wildcards, blanket selectors, and free-form
  names are rejected.
- Bounded to `MAX_ALLOWED_WRITE_TOOLS` (20) and `MAX_TOOL_NAME_LENGTH` (128).
- Never able to include a Composio executor or connection-management tool.
- Validated against the provider's live tool listing before it is saved. Only
  known, write-class, non-Composio tools can be granted.

`PATCH /api/integrations/[id]/policy` reads the live listing, validates the
requested grants, and persists the normalized list. `GET` on the same route
returns sanitized tool summaries (`name`, bounded `description`, `risk`,
`allowed`) and a `listingAvailable` flag. When the provider listing cannot be
read, nothing is marked permitted. The Connections UI exposes this as
**Permissions**; there is no blanket write toggle.

## Bot selection

A bot has an explicit `integrationIds` allowlist (`bot.selectedConnections`).
Only those connections are listed to the model and only those connections can
execute tools for that bot. An empty list means no MCP tools at all; native
tools are unaffected. The store still verifies that every connection belongs to
the same user, and the 10-connection / 64-tool bounds apply after selection.

## Decision

`decideToolPolicy` returns one of:

- `allow` for a read.
- `approval_required` for a write or destructive tool that appears in the
  connection's `allowedWriteTools`.
- `deny` for an invalid name, a Composio nested executor, or a write that is not
  granted.

Reads run without approval. Writes and destructive operations require both an
explicit grant and a matching, unexpired pending action.

The workflow applies the same decision when it builds the model's tool set.
`selectAgentTools` exposes reads and granted writes, drops denied tools, and
marks each write or destructive tool with `needsApproval`. The agent therefore
sees only tools the policy would allow, and a write pauses before execution.

## Approval metadata

A tool approval stores only sanitized, bounded metadata:

- `toolName`, `toolRisk`, `integrationId`, `integrationName`.
- `toolArgsRedacted`: key- and value-aware redaction with depth, collection, and
  string caps. Raw arguments are never persisted.
- `summary`: a short preview, never the raw payload.
- `idempotencyKey`: an opaque, bounded server-generated key, or `null`.
- `expiresAt`: a deadline. New actions always receive one (7 days by default);
  legacy rows may have `null` and are treated as not expired.

The workflow builds this metadata with `buildApprovalMetadataForTool` and a
stable, server-generated `approvalIdempotencyKey` derived from the run and tool
call. Raw arguments never enter the key. The public approval DTO
(`toPublicPendingAction`) omits model messages, tool-call signatures, and
unsanitized arguments. The chat approval card shows the tool, connection, risk,
redacted argument preview, and expiry, and disables the decision buttons once
the action is no longer pending or has expired.

## Execution recheck

`executeMcpTool` re-evaluates policy at execution time. It does not trust the
approval alone. The workflow passes the bot, conversation, run, and a bound
`McpApprovalContext` through `mcp.call`; `mcpApprovalContext` returns `null`
when the persisted action does not match the tool and connection, so a
mismatched action is denied rather than executed.

1. The connection must exist, be connected, and not be a desktop connection.
2. The tool must still exist in the live listing.
3. Composio executors are never grantable. They may run only when every nested
   operation is a read; the recursive validator enforces that.
4. A read runs immediately.
5. A write or destructive tool must be granted on the connection.
6. The pending action must match the same user, conversation, run, bot, tool,
   connection, and provider approval id, and must still be `pending` or
   `resuming`.
7. The action must not be expired.
8. The bot's current `integrationIds` must still include the connection.
9. The current risk must be covered by the approved risk. A legacy `read`
   approval never covers a write, and a risk that widened to `destructive`
   after approval is rejected.

Failures use distinct codes: `permission_denied`, `permission_revoked`,
`approval_missing`, `approval_mismatch`, `approval_expired`,
`connection_unavailable`, and `unexpected`.

## Composio nested restrictions

Composio executors (`COMPOSIO_EXECUTE_TOOL`, `COMPOSIO_MULTI_EXECUTE_TOOL`) and
`COMPOSIO_MANAGE_CONNECTIONS` are never treated as plain reads and are never
grantable through a connection allowlist. Arguments are walked recursively:

- Every nested `tool_slug` / `toolSlug` / `tool_name` / `toolName` must be a
  read operation.
- Nested executors and connection management are rejected.
- Recursion depth is bounded.
- Connection management may only add or list connections.

## Result handling

MCP results are untrusted. `boundMcpResult` redacts sensitive keys, caps depth,
collection sizes, key counts, and string lengths, and turns an oversized result
into a structured envelope rather than sliced invalid JSON. Desktop results are
bounded and redacted on the desktop before they leave the machine and again on
the server before persistence or hook delivery.

## Idempotency

The persisted action key is attached to `tools/call` as an opaque `_meta` hint
(`slopbot/idempotencyKey`). Provider support is unknown, so this is inert unless
a provider chooses to honor it. A process-local ledger prevents a repeated
physical call for the same persisted action while the process is alive. Neither
mechanism makes external side effects exactly-once.

## Desktop local tools

Desktop tools are read-only. The desktop claims a job with a short lease before
executing it, and the server records execution and hook delivery separately.
A completed job can be re-posted to retry delivery, and a job whose result was
already delivered is acknowledged without resuming the hook again. Delivery is
at-least-once; the stored delivery status is the evidence.

## Workflow integration

The workflow uses the same policy end to end. `loadBotTools` selects only the
bot's connections, and `selectAgentTools` exposes reads plus granted writes,
dropping denied tools and marking writes with `needsApproval`. When a write
pauses, `createApprovalStep` persists the sanitized metadata and the run moves
to `awaiting_approval`. On resume, `makeTools` passes the bound
`McpApprovalContext` into `executeMcpToolStep`, which forwards the bot,
conversation, run, and approval to `mcp.call` and therefore to
`executeMcpTool`. A mismatched or revoked action is denied at that boundary.
