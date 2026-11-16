import type { Integration, ToolRisk } from "@slopbot/contracts";
import type { AppStore, PendingAction } from "@db/types";
import { getStore } from "@db/store";
import {
  assertMcpArgumentsSafe,
  boundMcpResult,
  invokeMcpTool,
  listMcpTools,
  type McpToolDefinition,
} from "./mcp";
import {
  buildToolApprovalMetadata,
  decideToolPolicy,
  isComposioNestedExecutor,
  isPendingActionExpired,
  normalizeIdempotencyKey,
  type ToolApprovalMetadata,
} from "./tool-permissions";
import { canonicalArgsDigest } from "./portable-hash";

/**
 * Approval context supplied by the workflow when resuming an approved tool
 * call. `providerApprovalId` is the provider's approval signature/operator id
 * and must match the persisted pending action.
 */
export type McpApprovalContext = {
  actionId: string;
  providerApprovalId: string;
};

export type McpExecutionRequest = {
  userId: string;
  integrationId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Required for write/destructive execution. */
  botId?: string;
  conversationId?: string;
  runId?: string;
  approval?: McpApprovalContext | null;
};

/** Small options object accepted by `mcp.call` so the workflow can pass context. */
export type McpCallOptions = {
  botId?: string;
  conversationId?: string;
  runId?: string;
  approval?: McpApprovalContext | null;
};

export type McpExecutionErrorCode =
  | "permission_denied"
  | "permission_revoked"
  | "approval_missing"
  | "approval_mismatch"
  | "approval_expired"
  | "connection_unavailable"
  | "unexpected";

export class McpExecutionError extends Error {
  readonly code: McpExecutionErrorCode;

  constructor(code: McpExecutionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "McpExecutionError";
    this.code = code;
  }
}

export type McpExecutionStore = Pick<
  AppStore,
  "getIntegration" | "getBot" | "getPendingAction"
>;

export type McpToolCaller = (input: {
  integration: Integration;
  userId: string;
  toolName: string;
  args: Record<string, unknown>;
  idempotencyKey: string | null;
}) => Promise<unknown>;

/**
 * Best-effort, process-local dedupe. This is deliberately not an exactly-once
 * guarantee: it only prevents a repeated physical call for the same persisted
 * action key while the process is alive.
 */
export type McpExecutionLedger = {
  get(key: string): Promise<unknown | undefined> | unknown | undefined;
  set(key: string, value: unknown): Promise<void> | void;
};

export type McpExecutionDeps = {
  store: McpExecutionStore;
  listTools: (userId: string, integrationId: string) => Promise<McpToolDefinition[]>;
  callTool: McpToolCaller;
  ledger?: McpExecutionLedger;
  now?: () => Date;
};

export function createInMemoryExecutionLedger(): McpExecutionLedger {
  const entries = new Map<string, unknown>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => {
      entries.set(key, value);
    },
  };
}

const defaultLedger = createInMemoryExecutionLedger();

function defaultDeps(): McpExecutionDeps {
  return {
    store: getStore(),
    listTools: listMcpTools,
    callTool: invokeMcpTool,
    ledger: defaultLedger,
  };
}

/**
 * Execute an MCP tool with a fresh policy check. Reads run without approval.
 * Writes and destructive operations require an explicit connector grant and a
 * matching, unexpired pending action owned by the same user, conversation, run,
 * bot, tool, and connection. Composio executors are never grantable; they may
 * only run when every nested operation is a read.
 */
export async function executeMcpTool(
  request: McpExecutionRequest,
  deps: McpExecutionDeps = defaultDeps(),
): Promise<unknown> {
  const now = deps.now?.() ?? new Date();
  const approval = request.approval ?? null;
  const hasApproval = Boolean(approval?.actionId);

  const integration = await deps.store.getIntegration(request.userId, request.integrationId);
  if (!integration) {
    throw new McpExecutionError("connection_unavailable", "MCP connection not found.");
  }
  if (integration.kind === "desktop") {
    throw new McpExecutionError("connection_unavailable", "Desktop tools use the desktop execution path.");
  }
  if (integration.status !== "connected") {
    throw hasApproval
      ? new McpExecutionError("permission_revoked", "The connection is no longer available.")
      : new McpExecutionError("connection_unavailable", "MCP connection is not connected.");
  }

  const tools = await deps.listTools(request.userId, request.integrationId);
  const tool = tools.find((item) => item.name === request.toolName);
  if (!tool) {
    throw hasApproval
      ? new McpExecutionError("permission_revoked", "The MCP tool no longer exists.")
      : new McpExecutionError("permission_denied", "The MCP tool no longer exists.");
  }

  // Composio executors are never grantable. They may only run when every
  // nested operation is a read; the recursive validator enforces that.
  if (isComposioNestedExecutor(tool.name)) {
    try {
      assertMcpArgumentsSafe(tool, request.args);
    } catch (error) {
      throw new McpExecutionError(
        "permission_denied",
        error instanceof Error ? error.message : "Composio execution is not allowed.",
      );
    }
    return runTool(request, integration, deps, null);
  }

  const decision = decideToolPolicy({
    toolName: tool.name,
    risk: tool.risk ?? "write",
    allowedWriteTools: integration.allowedWriteTools ?? [],
  });

  if (decision.kind === "allow") {
    return runTool(request, integration, deps, null);
  }

  if (decision.kind === "deny") {
    if (hasApproval && approval) {
      // Distinguish a revoked grant from a bogus approval reference.
      const action = await deps.store.getPendingAction(request.userId, approval.actionId);
      if (!action) {
        throw new McpExecutionError("approval_mismatch", "Approval not found.");
      }
      if (action.toolName === tool.name && action.integrationId === integration.id) {
        throw new McpExecutionError(
          "permission_revoked",
          "This tool is no longer permitted on the selected connection.",
        );
      }
      throw new McpExecutionError("approval_mismatch", "Approval does not match this tool.");
    }
    throw new McpExecutionError("permission_denied", "This tool is not permitted on the selected connection.");
  }

  // approval_required
  if (!approval?.actionId) {
    throw new McpExecutionError("approval_missing", "This tool requires approval before it can run.");
  }
  if (!request.botId || !request.conversationId || !request.runId) {
    throw new McpExecutionError("approval_mismatch", "Approval context is incomplete.");
  }
  if (!approval.providerApprovalId) {
    throw new McpExecutionError("approval_mismatch", "Approval signature is missing.");
  }

  const action = await deps.store.getPendingAction(request.userId, approval.actionId);
  if (!action) {
    throw new McpExecutionError("approval_mismatch", "Approval not found.");
  }
  assertActionMatches(action, request, approval, tool, integration, now);
  assertArgsMatch(action, request.args);

  // Re-check the bot's current connection selection at execution time.
  const bot = await deps.store.getBot(request.userId, request.botId);
  if (!bot || !bot.integrationIds.includes(request.integrationId)) {
    throw new McpExecutionError("permission_revoked", "This connection is no longer enabled for this bot.");
  }

  assertRiskCovered(action, tool.risk ?? "write");

  return runTool(request, integration, deps, action);
}

function assertActionMatches(
  action: PendingAction,
  request: McpExecutionRequest,
  approval: McpApprovalContext,
  tool: McpToolDefinition,
  integration: Integration,
  now: Date,
): void {
  if (action.userId !== request.userId) {
    throw new McpExecutionError("approval_mismatch", "Approval belongs to a different user.");
  }
  if (action.conversationId !== request.conversationId) {
    throw new McpExecutionError("approval_mismatch", "Approval belongs to a different conversation.");
  }
  if (action.runId !== request.runId) {
    throw new McpExecutionError("approval_mismatch", "Approval belongs to a different run.");
  }
  if (action.botId !== request.botId) {
    throw new McpExecutionError("approval_mismatch", "Approval belongs to a different bot.");
  }
  if (action.toolName !== tool.name) {
    throw new McpExecutionError("approval_mismatch", "Approval is for a different tool.");
  }
  if (action.integrationId !== integration.id) {
    throw new McpExecutionError("approval_mismatch", "Approval is for a different connection.");
  }
  if (action.providerApprovalId !== approval.providerApprovalId) {
    throw new McpExecutionError("approval_mismatch", "Approval signature does not match.");
  }
  if (action.status !== "pending" && action.status !== "resuming") {
    throw new McpExecutionError("approval_mismatch", "Approval is no longer pending.");
  }
  if (isPendingActionExpired(action, now)) {
    throw new McpExecutionError("approval_expired", "Approval has expired.");
  }
}

/**
 * Bind execution to the exact arguments the user approved. The digest is
 * canonical, so JSON key order does not matter, but any value change does.
 * Legacy actions without a digest fail closed for gated writes.
 */
function assertArgsMatch(action: PendingAction, args: Record<string, unknown>): void {
  if (!action.argsDigest) {
    throw new McpExecutionError(
      "approval_mismatch",
      "Approval is missing an argument digest and cannot authorize this write.",
    );
  }
  let digest: string;
  try {
    digest = canonicalArgsDigest(args);
  } catch {
    throw new McpExecutionError("approval_mismatch", "Approval arguments are not valid JSON.");
  }
  if (digest !== action.argsDigest) {
    throw new McpExecutionError("approval_mismatch", "Approval arguments do not match this request.");
  }
}

/**
 * Fail closed when the operation's current risk is wider than what the user
 * approved. A legacy `read` approval never covers a write.
 */
function assertRiskCovered(action: PendingAction, currentRisk: ToolRisk): void {
  if (currentRisk === "read") return;
  if (action.toolRisk === "read") {
    throw new McpExecutionError("permission_revoked", "The approval does not cover a write operation.");
  }
  if (currentRisk === "destructive" && action.toolRisk !== "destructive") {
    throw new McpExecutionError("permission_revoked", "The tool risk changed after approval.");
  }
}

async function runTool(
  request: McpExecutionRequest,
  integration: Integration,
  deps: McpExecutionDeps,
  action: PendingAction | null,
): Promise<unknown> {
  const idempotencyKey = action ? normalizeIdempotencyKey(action.idempotencyKey) : null;
  const ledgerKey = action ? (idempotencyKey ?? action.id) : null;

  if (ledgerKey && deps.ledger) {
    const cached = await deps.ledger.get(ledgerKey);
    if (cached !== undefined) return cached;
  }

  let raw: unknown;
  try {
    raw = await deps.callTool({
      integration,
      userId: request.userId,
      toolName: request.toolName,
      args: request.args,
      idempotencyKey,
    });
  } catch (error) {
    if (error instanceof McpExecutionError) throw error;
    throw new McpExecutionError("unexpected", "The MCP tool call failed.", { cause: error });
  }

  const bounded = boundMcpResult(raw);
  if (ledgerKey && deps.ledger) {
    await deps.ledger.set(ledgerKey, bounded);
  }
  return bounded;
}

export type { ToolApprovalMetadata };
export { buildToolApprovalMetadata };
