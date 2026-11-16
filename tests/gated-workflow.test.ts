import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { Integration } from "@slopbot/contracts";
import type { PendingAction } from "@db/types";
import { FileStore } from "../db/file-store";
import {
  McpExecutionError,
  executeMcpTool,
  type McpExecutionDeps,
} from "../apps/web/lib/server/gated-tools";
import { classifyTraceError } from "../apps/web/lib/server/run-telemetry";
import type { McpToolDefinition } from "../apps/web/lib/server/mcp";
import {
  applyMemoryOperationForUser,
  readMemoryForUser,
} from "../apps/web/lib/server/memory";
import {
  approvalIdempotencyKey,
  approvalRequestOf,
  approvalToolIdentity,
  buildApprovalMetadataForTool,
  checkResumeAuthorization,
  decideTurnOutcome,
  mcpApprovalContext,
  selectAgentTools,
  type LoadedTool,
} from "../workflows/group-chat";
import { assertMemoryDeleteApproved, nativeTools } from "../workflows/native-tools";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = "2026-01-02T00:00:00.000Z";
const PAST = "2025-12-31T00:00:00.000Z";
const USER = "demo-user";

let directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

async function makeStore() {
  const directory = await mkdtemp(join(tmpdir(), "slop-gated-workflow-"));
  directories.push(directory);
  return new FileStore(join(directory, "store.json"));
}

const readTool: McpToolDefinition = {
  name: "GITHUB_GET_REPOSITORY",
  description: "Read a repo",
  inputSchema: {},
  readOnly: true,
  risk: "read",
};

const writeTool: McpToolDefinition = {
  name: "GITHUB_CREATE_ISSUE",
  description: "Create an issue",
  inputSchema: {},
  readOnly: false,
  risk: "write",
};

const composioTool: McpToolDefinition = {
  name: "COMPOSIO_EXECUTE_TOOL",
  description: "Execute",
  inputSchema: {},
  readOnly: true,
  risk: "write",
};

function integration(overrides: Partial<Integration> = {}): Integration {
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

const QUALIFIED_WRITE = "mcp_00000001_GITHUB_CREATE_ISSUE";

async function seed(store: FileStore, allowedWriteTools: string[] = []) {
  const created = await store.createIntegration(USER, {
    kind: "mcp",
    name: "GitHub",
    url: "https://example.com/mcp",
    description: "",
    status: "connected",
    allowedWriteTools,
  });
  const bot = await store.createBot(USER, {
    name: "Nova",
    handle: `nova_${Math.random().toString(36).slice(2, 8)}`,
    persona: "Helpful",
    model: "test/model",
    integrationIds: [created.id],
  });
  const conversation = await store.createConversation(USER, {
    title: "Gated",
    botIds: [bot.id],
  });
  return { bot, conversation, integration: created };
}

function loadedWriteTool(integrationId: string): LoadedTool {
  return {
    ...writeTool,
    integrationId,
    integrationName: "GitHub",
    kind: "mcp",
    qualifiedName: QUALIFIED_WRITE,
    risk: "write",
    needsApproval: true,
  };
}

async function createWriteAction(
  store: FileStore,
  input: {
    userId?: string;
    conversationId: string;
    botId: string;
    runId?: string;
    /** The real connection the approval was created for. */
    integrationId: string;
    /** Override the persisted connection to simulate a mismatched action. */
    actionIntegrationId?: string;
    expiresAt?: string;
    toolName?: string;
    args?: Record<string, unknown>;
  },
): Promise<PendingAction> {
  const identity = approvalToolIdentity(QUALIFIED_WRITE, [
    loadedWriteTool(input.integrationId),
  ]);
  const metadata = buildApprovalMetadataForTool({
    identity,
    args: input.args ?? { title: "Bug" },
    runId: input.runId ?? "run_1",
    toolCallId: "call_1",
    providerApprovalId: "appr_1",
    now: NOW,
  });
  return store.createPendingAction({
    userId: input.userId ?? USER,
    conversationId: input.conversationId,
    botId: input.botId,
    kind: "tool_approval",
    summary: metadata.summary,
    modelMessages: [{ role: "user", content: "Create the issue" }],
    runId: input.runId ?? "run_1",
    providerApprovalId: "appr_1",
    toolName: input.toolName ?? metadata.toolName,
    toolArgsRedacted: metadata.toolArgsRedacted,
    toolRisk: metadata.toolRisk,
    idempotencyKey: metadata.idempotencyKey,
    expiresAt: input.expiresAt ?? metadata.expiresAt,
    integrationId: input.actionIntegrationId ?? metadata.integrationId,
    integrationName: metadata.integrationName,
    argsDigest: metadata.argsDigest,
  });
}

function mcpDeps(
  store: FileStore,
  input: { tools?: McpToolDefinition[]; result?: unknown } = {},
): { deps: McpExecutionDeps; calls: Array<{ toolName: string; idempotencyKey: string | null }> } {
  const calls: Array<{ toolName: string; idempotencyKey: string | null }> = [];
  return {
    calls,
    deps: {
      store,
      listTools: async () => input.tools ?? [readTool, writeTool],
      callTool: async (call) => {
        calls.push({ toolName: call.toolName, idempotencyKey: call.idempotencyKey });
        return input.result ?? { ok: true };
      },
      now: () => NOW,
    },
  };
}

describe("agent tool exposure", () => {
  it("exposes trusted reads and only explicitly granted writes", () => {
    const selected = selectAgentTools([readTool, writeTool, composioTool], integration());
    expect(selected.map((tool) => tool.name)).toEqual(["GITHUB_GET_REPOSITORY"]);
    expect(selected[0]?.needsApproval).toBe(false);

    const granted = selectAgentTools(
      [readTool, writeTool, composioTool],
      integration({ allowedWriteTools: ["GITHUB_CREATE_ISSUE", "COMPOSIO_EXECUTE_TOOL"] }),
    );
    expect(granted.map((tool) => tool.name)).toEqual([
      "GITHUB_GET_REPOSITORY",
      "GITHUB_CREATE_ISSUE",
    ]);
    expect(granted.find((tool) => tool.name === "GITHUB_CREATE_ISSUE")?.needsApproval).toBe(true);
  });

  it("requires approval for a granted destructive tool", () => {
    const destructive: McpToolDefinition = {
      ...writeTool,
      name: "GITHUB_DELETE_REPOSITORY",
      risk: "destructive",
    };
    const selected = selectAgentTools(
      [destructive],
      integration({ allowedWriteTools: ["GITHUB_DELETE_REPOSITORY"] }),
    );
    expect(selected[0]?.risk).toBe("destructive");
    expect(selected[0]?.needsApproval).toBe(true);
  });

  it("keeps distinct model-facing names for tools that share a truncated prefix", () => {
    const prefix = "GITHUB_GET_REPOSITORY_CONTENT_WITH_EXTRA_";
    const alpha: McpToolDefinition = { ...readTool, name: `${prefix}ALPHA` };
    const beta: McpToolDefinition = { ...readTool, name: `${prefix}BETA` };
    const selected = selectAgentTools([alpha, beta], integration());
    expect(selected).toHaveLength(2);
    const names = selected.map((tool) => tool.qualifiedName);
    expect(new Set(names).size).toBe(2);
    // Each model-facing name stays bound to its exact provider definition.
    expect(selected.find((tool) => tool.qualifiedName === names[0])?.name).toBe(alpha.name);
    expect(selected.find((tool) => tool.qualifiedName === names[1])?.name).toBe(beta.name);
  });

  it("never exposes an unrecognized write or a nested Composio executor", () => {
    const unknown: McpToolDefinition = {
      name: "SOME_OPAQUE_OPERATION",
      description: "Unknown",
      inputSchema: {},
      readOnly: false,
      risk: "write",
    };
    expect(selectAgentTools([unknown], integration())).toEqual([]);
    expect(selectAgentTools([composioTool], integration({ allowedWriteTools: ["COMPOSIO_EXECUTE_TOOL"] })))
      .toEqual([]);
  });
});

describe("structured approval creation", () => {
  it("redacts arguments but keeps the qualified tool and risk identity", () => {
    const identity = approvalToolIdentity(QUALIFIED_WRITE, [loadedWriteTool("mcp_1")]);
    const metadata = buildApprovalMetadataForTool({
      identity,
      args: { title: "Bug", token: "sk-abcdefghijklmnop", body: "x".repeat(2_000) },
      runId: "run_1",
      toolCallId: "call_1",
      providerApprovalId: "appr_1",
      now: NOW,
    });

    expect(metadata.toolName).toBe("GITHUB_CREATE_ISSUE");
    expect(metadata.toolRisk).toBe("write");
    expect(metadata.toolArgsRedacted.token).toBe("[REDACTED]");
    expect(metadata.summary).toContain("mcp_00000001_GITHUB_CREATE_ISSUE");
    expect(metadata.summary).toContain("write");
    expect(metadata.summary).not.toContain("sk-abcdefghijklmnop");
    expect(metadata.summary.length).toBeLessThanOrEqual(300);
    expect(metadata.expiresAt).toBe("2026-01-08T00:00:00.000Z");
    expect(metadata.idempotencyKey).toBe(approvalIdempotencyKey("run_1", "call_1", "appr_1"));
    expect(metadata.integrationId).toBe("mcp_1");
    expect(metadata.integrationName).toBe("GitHub");
  });

  it("derives a stable key from the durable run and tool call, not raw args", () => {
    const first = approvalIdempotencyKey("run_1", "call_1", "appr_1");
    const second = approvalIdempotencyKey("run_1", "call_1", "appr_1");
    const other = approvalIdempotencyKey("run_1", "call_2", "appr_1");
    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^approval:[a-f0-9]{32}$/);
  });

  it("does not resolve an abbreviated tool name to a real connection", () => {
    const identity = approvalToolIdentity("GITHUB_CREATE_ISSUE", [loadedWriteTool("mcp_1")]);
    expect(identity.integrationId).toBeNull();
    expect(identity.risk).toBe("write");
  });

  it("binds an approval only to the exact tool and connection", () => {
    const definition = loadedWriteTool("mcp_1");
    const action = {
      id: "approval_1",
      toolName: "GITHUB_CREATE_ISSUE",
      integrationId: "mcp_1",
      providerApprovalId: "appr_1",
    } as PendingAction;
    expect(mcpApprovalContext(definition, action)).toEqual({
      actionId: "approval_1",
      providerApprovalId: "appr_1",
    });
    expect(mcpApprovalContext(definition, { ...action, toolName: "OTHER_TOOL" })).toBeNull();
    expect(mcpApprovalContext(definition, { ...action, integrationId: "mcp_2" })).toBeNull();
    expect(mcpApprovalContext(definition, null)).toBeNull();
  });

  it("carries the tool call identity from the provider approval request", () => {
    const result = {
      text: "",
      content: [
        {
          type: "tool-approval-request",
          approvalId: "appr_1",
          toolCall: {
            toolName: "mcp_00000001_GITHUB_CREATE_ISSUE",
            toolCallId: "call_1",
            input: { title: "Bug" },
          },
        },
      ],
    };
    const request = approvalRequestOf(result);
    expect(request).toMatchObject({
      approvalId: "appr_1",
      toolName: "mcp_00000001_GITHUB_CREATE_ISSUE",
      toolCallId: "call_1",
      input: { title: "Bug" },
    });
    expect(decideTurnOutcome(result, { scheduled: false, reportedContent: null })).toMatchObject({
      kind: "approval",
      approvalId: "appr_1",
      toolCallId: "call_1",
      input: { title: "Bug" },
    });
  });
});

describe("gated MCP execution at the store seam", () => {
  it("pauses a granted write and executes it once with the exact matching action", async () => {
    const store = await makeStore();
    const { bot, conversation, integration: created } = await seed(store, ["GITHUB_CREATE_ISSUE"]);
    const action = await createWriteAction(store, {
      conversationId: conversation.id,
      botId: bot.id,
      integrationId: created.id,
    });
    const { deps, calls } = mcpDeps(store);

    const result = await executeMcpTool(
      {
        userId: USER,
        integrationId: created.id,
        toolName: "GITHUB_CREATE_ISSUE",
        args: { title: "Bug" },
        botId: bot.id,
        conversationId: conversation.id,
        runId: "run_1",
        approval: { actionId: action.id, providerApprovalId: "appr_1" },
      },
      deps,
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.idempotencyKey).toBe(action.idempotencyKey);
  });

  it("does not execute when the grant was revoked after approval", async () => {
    const store = await makeStore();
    const { bot, conversation, integration: created } = await seed(store, ["GITHUB_CREATE_ISSUE"]);
    const action = await createWriteAction(store, {
      conversationId: conversation.id,
      botId: bot.id,
      integrationId: created.id,
    });
    await store.updateIntegration(USER, created.id, { allowedWriteTools: [] });
    const { deps, calls } = mcpDeps(store);

    await expect(
      executeMcpTool(
        {
          userId: USER,
          integrationId: created.id,
          toolName: "GITHUB_CREATE_ISSUE",
          args: { title: "Bug" },
          botId: bot.id,
          conversationId: conversation.id,
          runId: "run_1",
          approval: { actionId: action.id, providerApprovalId: "appr_1" },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "permission_revoked" });
    expect(calls).toHaveLength(0);
  });

  it("does not execute an expired action", async () => {
    const store = await makeStore();
    const { bot, conversation, integration: created } = await seed(store, ["GITHUB_CREATE_ISSUE"]);
    const action = await createWriteAction(store, {
      conversationId: conversation.id,
      botId: bot.id,
      integrationId: created.id,
      expiresAt: PAST,
    });
    const { deps, calls } = mcpDeps(store);

    await expect(
      executeMcpTool(
        {
          userId: USER,
          integrationId: created.id,
          toolName: "GITHUB_CREATE_ISSUE",
          args: { title: "Bug" },
          botId: bot.id,
          conversationId: conversation.id,
          runId: "run_1",
          approval: { actionId: action.id, providerApprovalId: "appr_1" },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "approval_expired" });
    expect(calls).toHaveLength(0);
  });

  it("does not execute an action for another run, user, or connection", async () => {
    const store = await makeStore();
    const { bot, conversation, integration: created } = await seed(store, ["GITHUB_CREATE_ISSUE"]);

    const wrongRun = await createWriteAction(store, {
      conversationId: conversation.id,
      botId: bot.id,
      integrationId: created.id,
      runId: "run_other",
    });
    const wrongUser = await createWriteAction(store, {
      userId: "other-user",
      conversationId: conversation.id,
      botId: bot.id,
      integrationId: created.id,
    });
    const wrongIntegration = await createWriteAction(store, {
      conversationId: conversation.id,
      botId: bot.id,
      integrationId: created.id,
      actionIntegrationId: "mcp_other",
    });

    for (const action of [wrongRun, wrongUser, wrongIntegration]) {
      const { deps, calls } = mcpDeps(store);
      await expect(
        executeMcpTool(
          {
            userId: USER,
            integrationId: created.id,
            toolName: "GITHUB_CREATE_ISSUE",
            args: { title: "Bug" },
            botId: bot.id,
            conversationId: conversation.id,
            runId: "run_1",
            approval: { actionId: action.id, providerApprovalId: "appr_1" },
          },
          deps,
        ),
      ).rejects.toMatchObject({ code: "approval_mismatch" });
      expect(calls).toHaveLength(0);
    }
  });

  it("does not execute a write without an approval context", async () => {
    const store = await makeStore();
    const { bot, conversation, integration: created } = await seed(store, ["GITHUB_CREATE_ISSUE"]);
    const { deps, calls } = mcpDeps(store);

    await expect(
      executeMcpTool(
        {
          userId: USER,
          integrationId: created.id,
          toolName: "GITHUB_CREATE_ISSUE",
          args: { title: "Bug" },
          botId: bot.id,
          conversationId: conversation.id,
          runId: "run_1",
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "approval_missing" });
    expect(calls).toHaveLength(0);
  });
});

describe("trace taxonomy for gate denials", () => {
  it("classifies gated execution errors as permission denials without arguments", () => {
    for (const code of [
      "permission_denied",
      "permission_revoked",
      "approval_missing",
      "approval_mismatch",
      "approval_expired",
    ] as const) {
      const error = new McpExecutionError(code, "This tool is no longer permitted.");
      const classified = classifyTraceError(error);
      expect(classified.kind).toBe("permission_denied");
      expect(classified.message).not.toContain("sk-");
    }
  });
});

describe("resume authorization after approval", () => {
  const writeAction = {
    toolName: "GITHUB_CREATE_ISSUE",
    integrationId: "mcp_1",
    toolRisk: "write" as const,
  };
  const grantedTool = {
    name: "GITHUB_CREATE_ISSUE",
    integrationId: "mcp_1",
    risk: "write" as const,
  };

  it("fails closed when the grant or tool was removed after approval", () => {
    expect(checkResumeAuthorization(writeAction, [])).toMatchObject({ ok: false });
    expect(checkResumeAuthorization(writeAction, [
      { name: "GITHUB_GET_REPOSITORY", integrationId: "mcp_1", risk: "read" },
    ])).toMatchObject({ ok: false });
    // A tool on a different connection does not satisfy the approval.
    expect(checkResumeAuthorization(writeAction, [
      { name: "GITHUB_CREATE_ISSUE", integrationId: "mcp_2", risk: "write" },
    ])).toMatchObject({ ok: false });
    // A renamed connection also fails closed.
    expect(checkResumeAuthorization(
      { ...writeAction, integrationName: "GitHub" },
      [{ ...grantedTool, integrationName: "GitHub Renamed" }],
    )).toMatchObject({ ok: false });
  });

  it("allows a still-granted write and leaves reads/native approvals alone", () => {
    expect(checkResumeAuthorization(writeAction, [grantedTool])).toEqual({ ok: true });
    expect(checkResumeAuthorization(
      { toolName: "GITHUB_GET_REPOSITORY", integrationId: "mcp_1", toolRisk: "read" },
      [],
    )).toEqual({ ok: true });
    expect(checkResumeAuthorization(
      { toolName: "memory_delete", integrationId: null, toolRisk: "destructive" },
      [],
    )).toEqual({ ok: true });
  });

  it("fails closed on a risk downgrade or escalation", () => {
    expect(checkResumeAuthorization(writeAction, [
      { name: "GITHUB_CREATE_ISSUE", integrationId: "mcp_1", risk: "read" },
    ])).toMatchObject({ ok: false });
    expect(checkResumeAuthorization(
      { toolName: "GITHUB_CREATE_ISSUE", integrationId: "mcp_1", toolRisk: "destructive" },
      [grantedTool],
    )).toMatchObject({ ok: false });
    expect(checkResumeAuthorization(writeAction, [
      { name: "GITHUB_CREATE_ISSUE", integrationId: "mcp_1", risk: "destructive" },
    ])).toMatchObject({ ok: false });
  });

  it("classifies the revoked resume error as a permission denial", () => {
    const error = new Error("permission_revoked: The approved tool is no longer available on this connection.");
    const classified = classifyTraceError(error);
    expect(classified.kind).toBe("permission_denied");
    expect(classified.message).toContain("permission_revoked");
  });
});

describe("native memory_delete approval", () => {
  it("requires approval and reports destructive risk", () => {
    const tools = nativeTools({
      userId: USER,
      botId: "bot_1",
      conversationId: "conv_1",
      runId: "run_1",
    });
    expect(tools.memory_delete?.needsApproval).toBe(true);
  });

  it("persists complete metadata and keeps the original history", async () => {
    const store = await makeStore();
    const { bot, conversation } = await seed(store);
    const identity = approvalToolIdentity("memory_delete", []);
    const metadata = buildApprovalMetadataForTool({
      identity,
      args: { path: "notes/example.md" },
      runId: "run_1",
      toolCallId: "call_delete",
      providerApprovalId: "appr_delete",
      now: NOW,
    });
    const history = [
      { role: "user" as const, content: "Delete notes/example.md" },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call_delete",
            toolName: "memory_delete",
            input: { path: "notes/example.md" },
          },
        ],
      },
    ];
    const action = await store.createPendingAction({
      userId: USER,
      conversationId: conversation.id,
      botId: bot.id,
      kind: "tool_approval",
      summary: metadata.summary,
      modelMessages: history,
      runId: "run_1",
      providerApprovalId: "appr_delete",
      toolName: metadata.toolName,
      toolArgsRedacted: metadata.toolArgsRedacted,
      toolRisk: metadata.toolRisk,
      idempotencyKey: metadata.idempotencyKey,
      expiresAt: metadata.expiresAt,
      integrationId: metadata.integrationId,
      integrationName: metadata.integrationName,
    });

    expect(action.toolName).toBe("memory_delete");
    expect(action.toolRisk).toBe("destructive");
    expect(action.toolArgsRedacted).toEqual({ path: "notes/example.md" });
    expect(action.expiresAt).toBe("2026-01-08T00:00:00.000Z");
    expect(action.idempotencyKey).toMatch(/^approval:[a-f0-9]{32}$/);
    expect(action.integrationId).toBeNull();
    expect(action.integrationName).toBeNull();
    expect(action.summary).toContain("notes/example.md");
    expect(action.summary).toContain("destructive");

    const loaded = await store.getPendingAction(USER, action.id);
    expect(loaded?.modelMessages).toEqual(history);
  });

  it("only applies the delete for the exact approved file and live action", async () => {
    const store = await makeStore();
    const { bot, conversation } = await seed(store);
    await applyMemoryOperationForUser(
      store,
      USER,
      conversation.id,
      bot.id,
      { op: "create", path: "notes/example.md", content: "remember this" },
      { actor: "model", source: "assistant", provenance: "test" },
    );
    const action = await store.createPendingAction({
      userId: USER,
      conversationId: conversation.id,
      botId: bot.id,
      kind: "tool_approval",
      summary: "Delete memory file notes/example.md [destructive]",
      modelMessages: [],
      runId: "run_1",
      providerApprovalId: "appr_delete",
      toolName: "memory_delete",
      toolArgsRedacted: { path: "notes/example.md" },
      toolRisk: "destructive",
      idempotencyKey: "approval:0123456789abcdef0123456789abcdef",
      expiresAt: FUTURE,
      integrationId: null,
      integrationName: null,
    });
    const context = {
      runId: "run_1",
      conversationId: conversation.id,
      botId: bot.id,
      approval: action,
    };

    expect(() => assertMemoryDeleteApproved(context, "notes/example.md", NOW)).not.toThrow();
    expect(() => assertMemoryDeleteApproved(context, "notes/other.md", NOW)).toThrow(
      /different memory file/,
    );
    expect(() =>
      assertMemoryDeleteApproved({ ...context, approval: null }, "notes/example.md", NOW),
    ).toThrow(/requires approval/);
    expect(() =>
      assertMemoryDeleteApproved(
        { ...context, approval: { ...action, expiresAt: PAST } },
        "notes/example.md",
        NOW,
      ),
    ).toThrow(/expired/);
    expect(() =>
      assertMemoryDeleteApproved(
        { ...context, approval: { ...action, runId: "run_other" } },
        "notes/example.md",
        NOW,
      ),
    ).toThrow(/different run/);
    expect(() =>
      assertMemoryDeleteApproved(
        { ...context, approval: { ...action, toolRisk: "read" } },
        "notes/example.md",
        NOW,
      ),
    ).toThrow(/does not cover/);

    // The approved delete itself is still scoped to the user's conversation.
    await applyMemoryOperationForUser(
      store,
      USER,
      conversation.id,
      bot.id,
      { op: "delete", path: "notes/example.md" },
      { actor: "model", source: "assistant", provenance: "memory tool", sourceRunId: "run_1" },
    );
    expect(
      await readMemoryForUser(store, USER, conversation.id, bot.id, "notes/example.md"),
    ).toBeNull();
  });
});
