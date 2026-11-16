import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileStore } from "../db/file-store";
import type { PendingActionStatus } from "@slopbot/contracts";
import {
  executeAgentTurn,
  type AgentFactory,
  type AgentTurnResult,
} from "../apps/web/lib/server/agent-turn";
import {
  appendTraceEvent,
  listTraceEvents,
  traceApprovalEnd,
  traceApprovalStart,
  traceModelEnd,
  traceRunEnd,
  traceRunStart,
  traceToolEnd,
  traceToolStart,
  usageFromResult,
  type TraceEventRecord,
} from "../apps/web/lib/server/run-telemetry";
import {
  assertIntegrationSelected,
  decideTurnOutcome,
  type TurnDecision,
} from "../workflows/group-chat";
import { formatReportedContent } from "../apps/web/lib/server/memory-files";

type ReplayToolCall = {
  toolCallId: string;
  toolName: string;
  integrationId?: string;
  error?: string;
};

type ReplayFixture = {
  name: string;
  trigger: "message" | "scheduled" | "approval";
  model: string;
  prompt?: string;
  reportedText?: string;
  resume?: boolean;
  selectedIntegrationIds?: string[];
  toolCalls?: ReplayToolCall[];
  result: AgentTurnResult;
  expected: {
    decision: TurnDecision["kind"];
    runStatus: string;
    messageCount: number;
    messageContent?: string;
    actionStatus?: PendingActionStatus;
    traceTypes: string[];
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
    toolEndStatus?: string;
    toolErrorKind?: string;
    redacted?: boolean;
  };
};

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/replay/", import.meta.url));

let directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

async function makeStore() {
  const directory = await mkdtemp(join(tmpdir(), "slop-replay-"));
  directories.push(directory);
  return new FileStore(join(directory, "store.json"));
}

async function loadFixtures(): Promise<ReplayFixture[]> {
  const names = (await readdir(FIXTURE_DIR)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(FIXTURE_DIR, name), "utf8")) as ReplayFixture),
  );
}

async function transitionToRunning(store: FileStore, runId: string, fence: number) {
  const result = await store.runs.transitionRun({
    userId: "demo-user",
    runId,
    expectedStatus: "queued",
    expectedFence: fence,
    status: "running",
    workflowRunId: "wf_replay",
    leaseOwner: "wf_replay",
    leaseExpiresAt: "2026-01-01T00:05:00.000Z",
  });
  if (result.outcome !== "applied") throw new Error("Could not start replay run");
}

async function applyDecision(
  store: FileStore,
  input: {
    userId: string;
    runId: string;
    conversationId: string;
    botId: string;
    decision: TurnDecision;
    resumeActionId?: string;
  },
): Promise<{ actionId?: string; messageId?: string }> {
  const run = await store.runs.getRun(input.userId, input.runId);
  if (!run) throw new Error("Replay run is missing");

  if (input.decision.kind === "approval") {
    const action = await store.createPendingAction({
      userId: input.userId,
      conversationId: input.conversationId,
      botId: input.botId,
      kind: "tool_approval",
      summary: input.decision.summary,
      modelMessages: [{ role: "user", content: "Delete it" }],
      runId: input.runId,
      providerApprovalId: input.decision.approvalId,
    });
    await store.runs.transitionRun({
      userId: input.userId,
      runId: input.runId,
      expectedStatus: "running",
      expectedFence: run.fence,
      status: "awaiting_approval",
      leaseOwner: null,
      leaseExpiresAt: null,
      action: input.resumeActionId
        ? { id: input.resumeActionId, status: "completed" }
        : undefined,
      event: {
        type: "awaiting_approval",
        data: { actionId: action.id },
        dedupeKey: `awaiting:${action.id}`,
      },
    });
    return { actionId: action.id };
  }

  if (input.decision.kind === "silent") {
    await store.runs.transitionRun({
      userId: input.userId,
      runId: input.runId,
      expectedStatus: "running",
      expectedFence: run.fence,
      status: "succeeded",
      leaseOwner: null,
      leaseExpiresAt: null,
      action: input.resumeActionId
        ? { id: input.resumeActionId, status: "completed" }
        : undefined,
      event: { type: "succeeded", data: { silent: true }, dedupeKey: `succeeded:${input.runId}` },
    });
    return {};
  }

  if (input.decision.kind === "suppress") {
    await store.runs.transitionRun({
      userId: input.userId,
      runId: input.runId,
      expectedStatus: "running",
      expectedFence: run.fence,
      status: "succeeded",
      leaseOwner: null,
      leaseExpiresAt: null,
      action: input.resumeActionId
        ? { id: input.resumeActionId, status: "completed" }
        : undefined,
      event: {
        type: "report_suppressed",
        data: { hash: input.decision.hash },
        dedupeKey: `report_suppressed:${input.runId}`,
      },
    });
    return {};
  }

  const result = await store.runs.completeWithMessage({
    userId: input.userId,
    runId: input.runId,
    expectedStatus: "running",
    expectedFence: run.fence,
    content: input.decision.text,
    action: input.resumeActionId
      ? { id: input.resumeActionId, status: "completed" }
      : undefined,
    event: { type: "succeeded", dedupeKey: `succeeded:${input.runId}` },
  });
  return { messageId: result.outcome === "applied" ? result.message.id : undefined };
}

async function runFixture(fixture: ReplayFixture) {
  const store = await makeStore();
  const bot = await store.createBot("demo-user", {
    name: "Replay Bot",
    handle: `replay_${Math.random().toString(36).slice(2, 8)}`,
    persona: "A bot used to replay recorded agent output.",
    model: fixture.model,
    integrationIds: fixture.selectedIntegrationIds ?? [],
  });
  const conversation = await store.createConversation("demo-user", {
    title: "Replay",
    botIds: [bot.id],
  });

  let runId: string;
  let resumeActionId: string | undefined;
  let reportedContent: string | null = null;

  if (fixture.trigger === "approval") {
    const initial = await store.runs.claimRun({
      kind: "message",
      userId: "demo-user",
      conversationId: conversation.id,
      message: { senderType: "user", senderId: "demo-user", content: "Delete the memory file" },
    });
    if (initial.outcome !== "claimed") throw new Error("Could not claim initial run");
    await transitionToRunning(store, initial.run.id, initial.run.fence);
    const running = await store.runs.getRun("demo-user", initial.run.id);
    if (!running) throw new Error("Initial run is missing");
    const action = await store.createPendingAction({
      userId: "demo-user",
      conversationId: conversation.id,
      botId: bot.id,
      kind: "tool_approval",
      summary: "Delete memory file notes/example.md",
      modelMessages: [{ role: "user", content: "Delete the memory file" }],
      runId: initial.run.id,
      providerApprovalId: "approval-1",
    });
    await store.runs.transitionRun({
      userId: "demo-user",
      runId: initial.run.id,
      expectedStatus: "running",
      expectedFence: running.fence,
      status: "awaiting_approval",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const approval = await store.runs.claimRun({
      kind: "approval",
      userId: "demo-user",
      conversationId: conversation.id,
      actionId: action.id,
      decision: "approve",
    });
    if (approval.outcome !== "claimed") throw new Error("Could not claim approval run");
    runId = approval.run.id;
    resumeActionId = action.id;
    await transitionToRunning(store, runId, approval.run.fence);
  } else if (fixture.trigger === "scheduled") {
    const claim = await store.runs.claimRun({
      kind: "scheduled",
      userId: "demo-user",
      conversationId: conversation.id,
      trigger: {
        automationId: "auto-1",
        occurrenceAt: "2026-01-01T00:00:00.000Z",
        prompt: fixture.prompt ?? "Report status",
      },
    });
    if (claim.outcome !== "claimed") throw new Error("Could not claim scheduled run");
    runId = claim.run.id;
    await transitionToRunning(store, runId, claim.run.fence);
    if (fixture.reportedText) {
      reportedContent = formatReportedContent(fixture.reportedText, {
        runId: "run_prev",
        at: "2026-01-01T00:00:00.000Z",
      });
    }
  } else {
    const claim = await store.runs.claimRun({
      kind: "message",
      userId: "demo-user",
      conversationId: conversation.id,
      message: { senderType: "user", senderId: "demo-user", content: "Hello" },
    });
    if (claim.outcome !== "claimed") throw new Error("Could not claim message run");
    runId = claim.run.id;
    await transitionToRunning(store, runId, claim.run.fence);
  }

  await appendTraceEvent(store, {
    userId: "demo-user",
    runId,
    event: traceRunStart({ model: fixture.model, attempt: 0 }),
  });
  if (resumeActionId) {
    await appendTraceEvent(store, {
      userId: "demo-user",
      runId,
      event: traceApprovalEnd({ approvalId: resumeActionId, status: "ok" }),
    });
  }

  const factory: AgentFactory = async (request) => {
    for (const toolCall of fixture.toolCalls ?? []) {
      const event = {
        toolCall: {
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: {},
        },
        stepNumber: 0,
        messages: [],
        toolContext: undefined,
      };
      await request.onToolExecutionStart?.(event);
      if (toolCall.error) {
        await request.onToolExecutionEnd?.({
          ...event,
          durationMs: 5,
          success: false,
          error: new Error(toolCall.error),
        });
      } else {
        await request.onToolExecutionEnd?.({
          ...event,
          durationMs: 5,
          success: true,
          output: { ok: true },
        });
      }
    }
    return fixture.result;
  };

  const result = await executeAgentTurn(
    {
      id: bot.id,
      model: fixture.model,
      instructions: "Replay instructions.",
      tools: {},
      messages: [{ role: "user", content: "Hello" }],
      maxSteps: 6,
      maxOutputTokens: 1_200,
      onToolExecutionStart: async (event) => {
        await appendTraceEvent(store, {
          userId: "demo-user",
          runId,
          event: traceToolStart({
            toolName: event.toolCall.toolName,
            toolCallId: event.toolCall.toolCallId,
            integrationId: fixture.toolCalls?.find(
              (tool) => tool.toolCallId === event.toolCall.toolCallId,
            )?.integrationId,
            stepNumber: event.stepNumber,
          }),
        });
      },
      onToolExecutionEnd: async (event) => {
        await appendTraceEvent(store, {
          userId: "demo-user",
          runId,
          event: traceToolEnd({
            toolName: event.toolCall.toolName,
            toolCallId: event.toolCall.toolCallId,
            integrationId: fixture.toolCalls?.find(
              (tool) => tool.toolCallId === event.toolCall.toolCallId,
            )?.integrationId,
            stepNumber: event.stepNumber,
            durationMs: event.durationMs,
            success: event.success,
            error: event.success ? undefined : event.error,
          }),
        });
      },
    },
    factory,
  );

  await appendTraceEvent(store, {
    userId: "demo-user",
    runId,
    event: traceModelEnd({
      model: fixture.model,
      durationMs: 10,
      usage: usageFromResult(result),
      status: "ok",
    }),
  });

  const decision = decideTurnOutcome(result, {
    scheduled: fixture.trigger === "scheduled",
    reportedContent,
  });

  if (decision.kind === "approval") {
    await appendTraceEvent(store, {
      userId: "demo-user",
      runId,
      event: traceApprovalStart({
        approvalId: decision.approvalId,
        toolName: decision.toolName,
      }),
    });
  }

  const applied = await applyDecision(store, {
    userId: "demo-user",
    runId,
    conversationId: conversation.id,
    botId: bot.id,
    decision,
    resumeActionId,
  });

  if (decision.kind !== "approval") {
    await appendTraceEvent(store, {
      userId: "demo-user",
      runId,
      event: traceRunEnd({
        status: "ok",
        outcome:
          decision.kind === "silent"
            ? "silent"
            : decision.kind === "suppress"
              ? "suppressed"
              : "reply",
        attempt: 0,
      }),
    });
  }

  const run = await store.runs.getRun("demo-user", runId);
  const messages = await store.listMessages("demo-user", conversation.id);
  const traces: TraceEventRecord[] = await listTraceEvents(store, "demo-user", runId);

  return { store, bot, conversation, runId, decision, applied, run, messages, traces };
}

describe("recorded agent replay", () => {
  it("covers the recorded scheduled, approval, policy, and error patterns", async () => {
    const fixtures = await loadFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(6);

    for (const fixture of fixtures) {
      const { store, decision, run, messages, traces, applied } = await runFixture(fixture);

      expect(decision.kind, fixture.name).toBe(fixture.expected.decision);
      expect(run?.status, fixture.name).toBe(fixture.expected.runStatus);
      const botMessages = messages.filter((message) => message.senderType === "bot");
      expect(botMessages.length, fixture.name).toBe(fixture.expected.messageCount);
      if (fixture.expected.messageContent) {
        expect(botMessages.at(-1)?.content, fixture.name).toBe(fixture.expected.messageContent);
      }
      expect(traces.map((trace) => trace.type), fixture.name).toEqual(fixture.expected.traceTypes);

      const modelTrace = traces.find((trace) => trace.type === "trace.model.end");
      if (fixture.expected.usage === null) {
        expect(modelTrace?.usage, fixture.name).toBeUndefined();
      } else if (fixture.expected.usage) {
        expect(modelTrace?.usage, fixture.name).toEqual(fixture.expected.usage);
      }

      if (fixture.expected.toolEndStatus) {
        const toolEnd = traces.find((trace) => trace.type === "trace.tool.end");
        expect(toolEnd?.status, fixture.name).toBe(fixture.expected.toolEndStatus);
        expect(toolEnd?.error?.kind, fixture.name).toBe(fixture.expected.toolErrorKind);
        if (fixture.expected.redacted) {
          expect(toolEnd?.error?.message, fixture.name).not.toContain("sk-live");
          expect(toolEnd?.error?.message, fixture.name).not.toContain("Bearer");
        }
      }

      if (fixture.expected.actionStatus && applied.actionId) {
        const action = await store.getPendingAction("demo-user", applied.actionId);
        expect(action?.status, fixture.name).toBe(fixture.expected.actionStatus);
      }
    }
  });

  it("blocks an unselected integration before the tool step", () => {
    expect(() => assertIntegrationSelected(new Set(["int_selected"]), "int_other")).toThrow(
      /not enabled/,
    );
    expect(() => assertIntegrationSelected(new Set(["int_selected"]), "int_selected")).not.toThrow();
  });

  it("does not call live services or leak production config", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const fixtures = await loadFixtures();
    const fixture = fixtures.find((item) => item.name.includes("duplicate"));
    if (!fixture) throw new Error("Missing duplicate fixture");
    await runFixture(fixture);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    for (const path of [
      "../workflows/group-chat.ts",
      "../apps/web/lib/server/agent-turn.ts",
      "../apps/web/lib/server/run-telemetry.ts",
    ]) {
      const source = await readFile(new URL(path, import.meta.url), "utf8");
      expect(source.toLowerCase()).not.toContain("mem0");
      expect(source.toLowerCase()).not.toContain("agentmail");
    }
  });
});
