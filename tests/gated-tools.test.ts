import { describe, expect, it } from "vitest";
import type { Bot, Integration } from "@slopbot/contracts";
import type { PendingAction } from "@db/types";
import {
  McpExecutionError,
  createInMemoryExecutionLedger,
  executeMcpTool,
  type McpExecutionDeps,
  type McpExecutionStore,
} from "../apps/web/lib/server/gated-tools";
import { buildCallToolParams, IDEMPOTENCY_META_KEY } from "../apps/web/lib/server/mcp";
import {
  buildToolApprovalMetadata,
  decideToolPolicy,
} from "../apps/web/lib/server/tool-permissions";
import { canonicalArgsDigest } from "../apps/web/lib/server/portable-hash";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = "2026-01-02T00:00:00.000Z";
const PAST = "2025-12-31T00:00:00.000Z";

function makeIntegration(overrides: Partial<Integration> = {}): Integration {
  return {
    id: "mcp_1",
    kind: "mcp",
    name: "GitHub",
    url: "https://example.com/mcp",
    description: "",
    status: "connected",
    toolCount: 2,
    lastError: null,
    allowedWriteTools: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot_1",
    name: "Nova",
    handle: "nova",
    persona: "Helpful",
    model: "test/model",
    color: "#000000",
    integrationIds: ["mcp_1"],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeAction(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    id: "approval_1",
    userId: "user_1",
    conversationId: "conv_1",
    botId: "bot_1",
    kind: "tool_approval",
    summary: "Create an issue",
    modelMessages: [],
    status: "pending",
    runId: "run_1",
    providerApprovalId: "appr_1",
    toolName: "GITHUB_CREATE_ISSUE",
    toolArgsRedacted: { title: "Bug" },
    toolRisk: "write",
    idempotencyKey: "idem-key-12345678",
    expiresAt: FUTURE,
    integrationId: "mcp_1",
    integrationName: "GitHub",
    argsDigest: canonicalArgsDigest({ title: "Bug" }),
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const readTool = {
  name: "GITHUB_GET_REPOSITORY",
  description: "Read a repo",
  inputSchema: {},
  readOnly: true,
  risk: "read" as const,
};

const writeTool = {
  name: "GITHUB_CREATE_ISSUE",
  description: "Create an issue",
  inputSchema: {},
  readOnly: false,
  risk: "write" as const,
};

function makeDeps(input: {
  integration?: Integration;
  bot?: Bot | null;
  action?: PendingAction | null;
  tools?: Array<typeof readTool | typeof writeTool>;
  result?: unknown;
  ledger?: ReturnType<typeof createInMemoryExecutionLedger>;
}) {
  const calls: Array<{ toolName: string; idempotencyKey: string | null }> = [];
  const store: McpExecutionStore = {
    getIntegration: async () => input.integration ?? makeIntegration(),
    getBot: async () => (input.bot === undefined ? makeBot() : input.bot),
    getPendingAction: async () => (input.action === undefined ? null : input.action),
  };
  const deps: McpExecutionDeps = {
    store,
    listTools: async () => input.tools ?? [readTool, writeTool],
    callTool: async (call) => {
      calls.push({ toolName: call.toolName, idempotencyKey: call.idempotencyKey });
      return input.result ?? { ok: true };
    },
    ledger: input.ledger ?? createInMemoryExecutionLedger(),
    now: () => NOW,
  };
  return { deps, calls };
}

const baseRequest = {
  userId: "user_1",
  integrationId: "mcp_1",
  toolName: "GITHUB_CREATE_ISSUE",
  args: { title: "Bug" },
  botId: "bot_1",
  conversationId: "conv_1",
  runId: "run_1",
};

describe("tool policy decision", () => {
  it("allows reads, gates granted writes, and denies unknown writes", () => {
    expect(decideToolPolicy({ toolName: "GITHUB_GET_REPOSITORY", risk: "read", allowedWriteTools: [] }))
      .toEqual({ kind: "allow", risk: "read" });
    expect(decideToolPolicy({ toolName: "GITHUB_CREATE_ISSUE", risk: "write", allowedWriteTools: ["GITHUB_CREATE_ISSUE"] }))
      .toEqual({ kind: "approval_required", risk: "write" });
    expect(decideToolPolicy({ toolName: "SOME_OPAQUE_OPERATION", risk: "write", allowedWriteTools: [] }))
      .toEqual({ kind: "deny", reason: "not_granted" });
  });

  it("never lets a Composio executor be granted by name", () => {
    expect(decideToolPolicy({
      toolName: "COMPOSIO_EXECUTE_TOOL",
      risk: "write",
      allowedWriteTools: ["COMPOSIO_EXECUTE_TOOL"],
    })).toEqual({ kind: "deny", reason: "nested_composio" });
  });
});

describe("gated MCP execution", () => {
  it("allows a read with no approval context", async () => {
    const { deps, calls } = makeDeps({});
    const result = await executeMcpTool(
      { ...baseRequest, toolName: "GITHUB_GET_REPOSITORY", args: {} },
      deps,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("denies a write with no approval before calling the provider", async () => {
    const { deps, calls } = makeDeps({
      integration: makeIntegration({ allowedWriteTools: ["GITHUB_CREATE_ISSUE"] }),
    });
    await expect(executeMcpTool(baseRequest, deps)).rejects.toMatchObject({
      code: "approval_missing",
    });
    expect(calls).toHaveLength(0);
  });

  it("executes a granted write exactly once with a matching action", async () => {
    const action = makeAction();
    const { deps, calls } = makeDeps({
      integration: makeIntegration({ allowedWriteTools: ["GITHUB_CREATE_ISSUE"] }),
      action,
    });
    const result = await executeMcpTool(
      { ...baseRequest, approval: { actionId: action.id, providerApprovalId: "appr_1" } },
      deps,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.idempotencyKey).toBe("idem-key-12345678");
  });

  it("does not execute when the approved arguments changed", async () => {
    const action = makeAction();
    const { deps, calls } = makeDeps({
      integration: makeIntegration({ allowedWriteTools: ["GITHUB_CREATE_ISSUE"] }),
      action,
    });
    await expect(executeMcpTool(
      {
        ...baseRequest,
        args: { title: "Different" },
        approval: { actionId: action.id, providerApprovalId: "appr_1" },
      },
      deps,
    )).rejects.toMatchObject({ code: "approval_mismatch" });
    expect(calls).toHaveLength(0);
  });

  it("accepts the same approved arguments in a different key order", async () => {
    const action = makeAction({
      argsDigest: canonicalArgsDigest({ title: "Bug", labels: ["a", "b"] }),
    });
    const { deps, calls } = makeDeps({
      integration: makeIntegration({ allowedWriteTools: ["GITHUB_CREATE_ISSUE"] }),
      action,
    });
    const result = await executeMcpTool(
      {
        ...baseRequest,
        args: { labels: ["a", "b"], title: "Bug" },
        approval: { actionId: action.id, providerApprovalId: "appr_1" },
      },
      deps,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("fails closed for a legacy action without an argument digest", async () => {
    const action = makeAction({ argsDigest: null });
    const { deps, calls } = makeDeps({
      integration: makeIntegration({ allowedWriteTools: ["GITHUB_CREATE_ISSUE"] }),
      action,
    });
    await expect(executeMcpTool(
      { ...baseRequest, approval: { actionId: action.id, providerApprovalId: "appr_1" } },
      deps,
    )).rejects.toMatchObject({ code: "approval_mismatch" });
    expect(calls).toHaveLength(0);
  });

  it("reconciles a duplicate action record without a second physical call", async () => {
    const ledger = createInMemoryExecutionLedger();
    const first = makeAction({ id: "approval_1" });
    const second = makeAction({ id: "approval_2" });
    const { deps, calls } = makeDeps({
      integration: makeIntegration({ allowedWriteTools: ["GITHUB_CREATE_ISSUE"] }),
      action: first,
      ledger,
    });
    await executeMcpTool(
      { ...baseRequest, approval: { actionId: first.id, providerApprovalId: "appr_1" } },
      deps,
    );
    const duplicateDeps: McpExecutionDeps = {
      ...deps,
      store: {
        ...deps.store,
        getPendingAction: async () => second,
      },
    };
    const result = await executeMcpTool(
      { ...baseRequest, approval: { actionId: second.id, providerApprovalId: "appr_1" } },
      duplicateDeps,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("fails closed when the grant was revoked after approval", async () => {
    const action = makeAction();
    const { deps, calls } = makeDeps({
      integration: makeIntegration({ allowedWriteTools: [] }),
      action,
    });
    await expect(executeMcpTool(
      { ...baseRequest, approval: { actionId: action.id, providerApprovalId: "appr_1" } },
      deps,
    )).rejects.toMatchObject({ code: "permission_revoked" });
    expect(calls).toHaveLength(0);
  });

  it("rejects an action for a different tool", async () => {
    const action = makeAction({ toolName: "GITHUB_DELETE_REPOSITORY" });
    const { deps, calls } = makeDeps({
      integration: makeIntegration({ allowedWriteTools: ["GITHUB_CREATE_ISSUE"] }),
      action,
    });
    await expect(executeMcpTool(
      { ...baseRequest, approval: { actionId: action.id, providerApprovalId: "appr_1" } },
      deps,
    )).rejects.toMatchObject({ code: "approval_mismatch" });
    expect(calls).toHaveLength(0);
  });

  it("rejects an action owned by another user or run", async () => {
    const action = makeAction({ runId: "run_other" });
    const { deps, calls } = makeDeps({
      integration: makeIntegration({ allowedWriteTools: ["GITHUB_CREATE_ISSUE"] }),
      action,
    });
    await expect(executeMcpTool(
      { ...baseRequest, approval: { actionId: action.id, providerApprovalId: "appr_1" } },
      deps,
    )).rejects.toMatchObject({ code: "approval_mismatch" });
    expect(calls).toHaveLength(0);
  });

  it("rejects an expired action", async () => {
    const action = makeAction({ expiresAt: PAST });
    const { deps, calls } = makeDeps({
      integration: makeIntegration({ allowedWriteTools: ["GITHUB_CREATE_ISSUE"] }),
      action,
    });
    await expect(executeMcpTool(
      { ...baseRequest, approval: { actionId: action.id, providerApprovalId: "appr_1" } },
      deps,
    )).rejects.toMatchObject({ code: "approval_expired" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a mismatched provider approval signature", async () => {
    const action = makeAction();
    const { deps, calls } = makeDeps({
      integration: makeIntegration({ allowedWriteTools: ["GITHUB_CREATE_ISSUE"] }),
      action,
    });
    await expect(executeMcpTool(
      { ...baseRequest, approval: { actionId: action.id, providerApprovalId: "appr_other" } },
      deps,
    )).rejects.toMatchObject({ code: "approval_mismatch" });
    expect(calls).toHaveLength(0);
  });

  it("denies unknown nested Composio execution before calling the provider", async () => {
    const composio = {
      name: "COMPOSIO_EXECUTE_TOOL",
      description: "Execute",
      inputSchema: {},
      readOnly: true,
      risk: "write" as const,
    };
    const { deps, calls } = makeDeps({ tools: [composio] });
    await expect(executeMcpTool(
      {
        ...baseRequest,
        toolName: "COMPOSIO_EXECUTE_TOOL",
        args: { tool_slug: "GITHUB_CREATE_ISSUE", arguments: {} },
      },
      deps,
    )).rejects.toMatchObject({ code: "permission_denied" });
    expect(calls).toHaveLength(0);
  });

  it("bounds and redacts provider output", async () => {
    const wide = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`field_${index}`, "x ".repeat(2_000)]),
    );
    const { deps } = makeDeps({
      result: { apiKey: "secret", ...wide },
    });
    const result = await executeMcpTool(
      { ...baseRequest, toolName: "GITHUB_GET_REPOSITORY", args: {} },
      deps,
    ) as Record<string, unknown>;
    expect(result.truncated).toBe(true);
    expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();
  });

  it("surfaces unexpected provider failures with a distinct code", async () => {
    const { deps } = makeDeps({});
    const failing: McpExecutionDeps = {
      ...deps,
      callTool: async () => {
        throw new Error("socket hang up");
      },
    };
    await expect(executeMcpTool(
      { ...baseRequest, toolName: "GITHUB_GET_REPOSITORY", args: {} },
      failing,
    )).rejects.toBeInstanceOf(McpExecutionError);
    await expect(executeMcpTool(
      { ...baseRequest, toolName: "GITHUB_GET_REPOSITORY", args: {} },
      failing,
    )).rejects.toMatchObject({ code: "unexpected" });
  });
});

describe("approval metadata and idempotency mapping", () => {
  it("builds a sanitized, bounded approval summary", () => {
    const metadata = buildToolApprovalMetadata({
      tool: { name: "GITHUB_CREATE_ISSUE", risk: "write" },
      integration: { id: "mcp_1", name: "GitHub" },
      args: { title: "Bug", token: "sk-abcdefghijklmnop", body: "x".repeat(2_000) },
      idempotencyKey: "idem-key-12345678",
      now: NOW,
    });
    expect(metadata.toolName).toBe("GITHUB_CREATE_ISSUE");
    expect(metadata.toolRisk).toBe("write");
    expect(metadata.integrationId).toBe("mcp_1");
    expect(metadata.toolArgsRedacted.token).toBe("[REDACTED]");
    expect(metadata.summary.length).toBeLessThanOrEqual(300);
    expect(metadata.expiresAt).toBe("2026-01-08T00:00:00.000Z");
    expect(metadata.argsDigest).toBe(canonicalArgsDigest({
      title: "Bug",
      token: "sk-abcdefghijklmnop",
      body: "x".repeat(2_000),
    }));
    expect("modelMessages" in metadata).toBe(false);
  });

  it("drops invalid idempotency keys instead of forwarding them", () => {
    const metadata = buildToolApprovalMetadata({
      tool: { name: "GITHUB_CREATE_ISSUE", risk: "write" },
      integration: { id: "mcp_1", name: "GitHub" },
      args: {},
      idempotencyKey: "bad key with spaces",
      now: NOW,
    });
    expect(metadata.idempotencyKey).toBeNull();
  });

  it("maps the persisted key to the inert _meta field only when valid", () => {
    expect(buildCallToolParams("GITHUB_CREATE_ISSUE", { title: "Bug" }, "idem-key-12345678"))
      .toEqual({
        name: "GITHUB_CREATE_ISSUE",
        arguments: { title: "Bug" },
        _meta: { [IDEMPOTENCY_META_KEY]: "idem-key-12345678" },
      });
    expect(buildCallToolParams("GITHUB_CREATE_ISSUE", { title: "Bug" }, null))
      .toEqual({ name: "GITHUB_CREATE_ISSUE", arguments: { title: "Bug" } });
  });
});
