import { WorkflowAgent } from "@ai-sdk/workflow";
import { Effect } from "effect";
import { isStepCount, jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import { getWorkflowMetadata } from "workflow";
import type {
  Bot,
  ChatMessage,
  PendingActionStatus,
  Run,
  RunStatus,
} from "@slopbot/contracts";
import type { PendingAction } from "@db/types";

import type { McpToolDefinition } from "../apps/web/lib/server/mcp";
import { executeDesktopTool } from "./desktop-tools";
import { nativeTools } from "./native-tools";
import { McpService, StoreService, fromPromise, runService, withStore } from "../apps/web/lib/server/effect";
import {
  cancelAllTimers,
  cancelTimers,
  LEASE_MS,
  scheduleApprovalTimeout,
  scheduleLeaseRecovery,
} from "../apps/web/lib/server/run-timers";

const MAX_STEPS = 6;
const MAX_OUTPUT_TOKENS = 1_200;
const MAX_TOOLS = 64;
const MAX_INTEGRATIONS = 10;
const MAX_HISTORY = 40;

export type ScheduledTrigger = {
  automationId: string;
  occurrenceAt: string;
  prompt: string;
};

export type GroupTurnInput = {
  userId: string;
  conversationId: string;
  runId: string;
  /** Durable attempt number; approval resumes increment it. */
  attempt: number;
  /** Stable per-attempt start token, carried by value so retries reuse it. */
  startToken: string;
  useGateway: boolean;
  resumeActionId?: string;
  scheduled?: ScheduledTrigger;
};

export type GroupTurnResult =
  | { outcome: "completed"; messageId: string }
  | { outcome: "completed_silent" }
  | { outcome: "awaiting_approval"; actionId: string }
  | { outcome: "skipped" }
  | { outcome: "failed"; error: string };

type BotContext = {
  bot: Bot;
  messages: ModelMessage[];
  resumeAction: PendingAction | null;
};

type LoadedTool = McpToolDefinition & {
  integrationId: string;
  kind: "mcp" | "github" | "composio" | "desktop";
  qualifiedName: string;
};

type TransitionPatch = {
  error?: string | null;
  botId?: string;
  workflowRunId?: string | null;
  outputMessageId?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  action?: { id: string; status: PendingActionStatus };
  event?: { type: string; data?: unknown; dedupeKey?: string };
};

export async function runGroupTurn(input: GroupTurnInput): Promise<GroupTurnResult> {
  "use workflow";

  const workflowRunId = getWorkflowMetadata().workflowRunId;
  const begin = await beginRunStep(input.userId, input.runId, workflowRunId);
  if (!begin.run) return { outcome: "skipped" };
  if (!begin.proceed) {
    if (input.resumeActionId && isTerminalRunStatus(begin.run.status)) {
      await setActionStatusStep(
        input.userId,
        input.resumeActionId,
        begin.run.status === "succeeded" ? "completed" : "cancelled",
      );
    }
    return { outcome: "skipped" };
  }

  const run = begin.run;
  const scheduled = scheduledTriggerOf(run, input);
  const resumeActionId = input.resumeActionId;

  try {
    const context = await loadTurnContextStep({
      userId: input.userId,
      conversationId: input.conversationId,
      runId: input.runId,
      resumeActionId,
      scheduled,
    });
    if (!context) {
      await transitionRunStep({
        userId: input.userId,
        runId: input.runId,
        from: "running",
        to: "failed",
        patch: {
          error: "Could not load the conversation context.",
          leaseOwner: null,
          leaseExpiresAt: null,
          action: resumeActionId ? { id: resumeActionId, status: "cancelled" } : undefined,
          event: { type: "failed", data: { error: "context_unavailable" }, dedupeKey: `failed:${input.runId}` },
        },
      });
      return { outcome: "failed", error: "Could not load the conversation context." };
    }

    const tools = await loadBotTools(input.userId);
    let text: string;

    if (!input.useGateway) {
      text = await demoBotReply(context.bot, context.messages);
    } else {
      const agent = new WorkflowAgent({
        id: context.bot.id,
        model: context.bot.model,
        instructions: instructionsFor(context.bot),
        tools: { ...makeTools(tools, input.userId), ...nativeTools(context.bot.id, input.conversationId) },
        experimental_toolApprovalSecret: { environmentVariable: "TOOL_APPROVAL_SECRET" },
        toolCallConcurrency: 1,
      });
      const result = await agent.generate({
        messages: context.messages,
        stopWhen: isStepCount(MAX_STEPS),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });

      const pending = approvalRequestOf(result);
      if (pending) {
        const action = await createApprovalStep({
          userId: input.userId,
          conversationId: input.conversationId,
          runId: input.runId,
          botId: context.bot.id,
          summary: pending.summary,
          providerApprovalId: pending.approvalId,
          modelMessages: [...context.messages, ...(result.responseMessages as ModelMessage[])],
        });
        const waiting = await transitionRunStep({
          userId: input.userId,
          runId: input.runId,
          from: "running",
          to: "awaiting_approval",
          patch: {
            leaseOwner: null,
            leaseExpiresAt: null,
            action: resumeActionId ? { id: resumeActionId, status: "completed" } : undefined,
            event: {
              type: "awaiting_approval",
              data: { actionId: action.actionId },
              dedupeKey: `awaiting:${action.actionId}`,
            },
          },
        });
        if (waiting.outcome !== "applied") {
          await setActionStatusStep(input.userId, action.actionId, "cancelled");
          return { outcome: "skipped" };
        }
        return { outcome: "awaiting_approval", actionId: action.actionId };
      }

      text = result.text.trim();
    }

    if (scheduled && isNoReply(text)) {
      const done = await transitionRunStep({
        userId: input.userId,
        runId: input.runId,
        from: "running",
        to: "succeeded",
        patch: {
          leaseOwner: null,
          leaseExpiresAt: null,
          action: resumeActionId ? { id: resumeActionId, status: "completed" } : undefined,
          event: { type: "succeeded", data: { silent: true }, dedupeKey: `succeeded:${input.runId}` },
        },
      });
      return done.outcome === "applied" ? { outcome: "completed_silent" } : { outcome: "skipped" };
    }

    const content = text || "I don't have a useful response yet.";
    const saved = await completeWithMessageStep({
      userId: input.userId,
      runId: input.runId,
      content,
      actionId: resumeActionId,
    });
    if (saved.outcome === "stale") return { outcome: "skipped" };
    return { outcome: "completed", messageId: saved.messageId };
  } catch (error) {
    const message = safeError(error);
    await failRunStep({
      userId: input.userId,
      runId: input.runId,
      error: message,
      resumeActionId,
    });
    return { outcome: "failed", error: message };
  }
}

async function beginRunStep(
  userId: string,
  runId: string,
  workflowRunId: string,
): Promise<{ proceed: boolean; run: Run | null }> {
  "use step";
  return runService(withStore(async (store) => {
    const run = await store.runs.getRun(userId, runId);
    if (!run) return { proceed: false, run: null };
    if (run.status === "running") {
      return { proceed: run.workflowRunId === workflowRunId, run };
    }
    if (run.status !== "queued") return { proceed: false, run };

    const leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
    await scheduleLeaseRecovery(store, run, leaseExpiresAt);
    const result = await store.runs.transitionRun({
      userId,
      runId,
      expectedStatus: "queued",
      expectedFence: run.fence,
      status: "running",
      workflowRunId,
      leaseOwner: workflowRunId,
      leaseExpiresAt,
      botId: run.botId,
      timers: cancelTimers("start_handoff"),
    });
    if (result.outcome === "applied") return { proceed: true, run: result.run };

    const current = await store.runs.getRun(userId, runId);
    return {
      proceed: current?.status === "running" && current.workflowRunId === workflowRunId,
      run: current,
    };
  }));
}

async function transitionRunStep(input: {
  userId: string;
  runId: string;
  from: RunStatus;
  to: RunStatus;
  patch?: TransitionPatch;
}): Promise<{ outcome: "applied"; run: Run } | { outcome: "stale" }> {
  "use step";
  return runService(withStore(async (store) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const run = await store.runs.getRun(input.userId, input.runId);
      if (!run || run.status !== input.from) return { outcome: "stale" as const };
      if (input.to === "awaiting_approval") {
        await scheduleApprovalTimeout(store, run, new Date());
      }
      const timers =
        input.to === "awaiting_approval"
          ? cancelTimers("lease_recovery", "start_handoff")
          : isTerminalRunStatus(input.to)
            ? cancelAllTimers()
            : undefined;
      const result = await store.runs.transitionRun({
        userId: input.userId,
        runId: input.runId,
        expectedStatus: input.from,
        expectedFence: run.fence,
        status: input.to,
        ...input.patch,
        ...(timers ? { timers } : {}),
      });
      if (result.outcome === "applied") return { outcome: "applied" as const, run: result.run };
    }
    return { outcome: "stale" as const };
  }));
}

/**
 * The statuses from which an unexpected turn error may safely fail the run.
 * Terminal runs are never resurrected, and a run that is still queued is left
 * to admission/recovery rather than being failed by a stale workflow attempt.
 */
export function failureTransitionFrom(status: RunStatus): "running" | "awaiting_approval" | null {
  if (status === "running" || status === "awaiting_approval") return status;
  return null;
}

async function failRunStep(input: {
  userId: string;
  runId: string;
  error: string;
  resumeActionId?: string;
}): Promise<void> {
  "use step";
  await runService(withStore(async (store) => {
    const run = await store.runs.getRun(input.userId, input.runId);
    if (!run) return;
    const from = failureTransitionFrom(run.status);
    if (!from) return;

    // Cancel the approval that belongs to this run, if any. A fresh action is
    // only cancelled when the run itself is being failed, never merely because
    // a transition report failed.
    const pending = await store.listPendingActions(input.userId, run.conversationId);
    const action = pending.find(
      (item) =>
        item.runId === run.id && (item.status === "pending" || item.status === "resuming"),
    );
    let actionId = action?.id;
    if (!actionId && input.resumeActionId) {
      const resume = await store.getPendingAction(input.userId, input.resumeActionId);
      if (resume && (resume.status === "pending" || resume.status === "resuming")) {
        actionId = resume.id;
      }
    }

    await store.runs.transitionRun({
      userId: input.userId,
      runId: input.runId,
      expectedStatus: from,
      expectedFence: run.fence,
      status: "failed",
      error: input.error,
      leaseOwner: null,
      leaseExpiresAt: null,
      action: actionId ? { id: actionId, status: "cancelled" } : undefined,
      event: { type: "failed", data: { error: input.error }, dedupeKey: `failed:${input.runId}` },
      timers: cancelAllTimers(),
    });
  }));
}

async function loadTurnContextStep(input: {
  userId: string;
  conversationId: string;
  runId: string;
  resumeActionId?: string;
  scheduled: ScheduledTrigger | null;
}): Promise<BotContext | null> {
  "use step";
  return runService(withStore(async (store) => {
    const run = await store.runs.getRun(input.userId, input.runId);
    if (!run) return null;
    const bot = await store.getBot(input.userId, run.botId);
    if (!bot) return null;

    if (input.resumeActionId) {
      const action = await store.getPendingAction(input.userId, input.resumeActionId);
      if (!action || action.runId !== run.id) return null;
      if (action.status !== "resuming" && action.status !== "pending") return null;
      if (!action.providerApprovalId) return null;
      return {
        bot,
        resumeAction: action,
        messages: buildResumeMessages(action),
      };
    }

    const [history, allBots] = await Promise.all([
      store.listMessages(input.userId, input.conversationId),
      store.listBots(input.userId),
    ]);
    const messages = toModelMessages(history, run.botId, allBots, input.scheduled ? "scheduled" : "message");
    if (input.scheduled) messages.push({ role: "user", content: input.scheduled.prompt });
    return { bot, messages, resumeAction: null };
  }));
}

async function createApprovalStep(input: {
  userId: string;
  conversationId: string;
  runId: string;
  botId: string;
  summary: string;
  providerApprovalId: string;
  modelMessages: ModelMessage[];
}): Promise<{ actionId: string }> {
  "use step";
  return runService(withStore(async (store) => {
    const action = await store.createPendingAction({
      userId: input.userId,
      conversationId: input.conversationId,
      botId: input.botId,
      kind: "tool_approval",
      summary: input.summary,
      modelMessages: input.modelMessages,
      runId: input.runId,
      providerApprovalId: input.providerApprovalId,
    });
    return { actionId: action.id };
  }));
}

async function setActionStatusStep(
  userId: string,
  actionId: string,
  status: PendingActionStatus,
): Promise<void> {
  "use step";
  await runService(withStore(async (store) => {
    const action = await store.getPendingAction(userId, actionId);
    if (!action) return;
    if (action.status === "completed" || action.status === "cancelled" || action.status === "expired") return;
    await store.setPendingActionStatus(userId, actionId, status);
  }));
}

async function completeWithMessageStep(input: {
  userId: string;
  runId: string;
  content: string;
  actionId?: string;
}): Promise<{ outcome: "applied" | "idempotent" | "stale"; messageId: string }> {
  "use step";
  return runService(withStore(async (store) => {
    const run = await store.runs.getRun(input.userId, input.runId);
    if (!run) return { outcome: "stale" as const, messageId: "" };
    if (run.status === "succeeded" && run.outputMessageId) {
      return { outcome: "idempotent" as const, messageId: run.outputMessageId };
    }
    if (run.status !== "running") return { outcome: "stale" as const, messageId: "" };

    const result = await store.runs.completeWithMessage({
      userId: input.userId,
      runId: input.runId,
      expectedStatus: "running",
      expectedFence: run.fence,
      content: input.content,
      action: input.actionId ? { id: input.actionId, status: "completed" } : undefined,
      event: { type: "succeeded", dedupeKey: `succeeded:${input.runId}` },
      timers: cancelAllTimers(),
    });
    if (result.outcome === "applied") {
      return { outcome: "applied" as const, messageId: result.message.id };
    }
    if (result.outcome === "idempotent") {
      return { outcome: "idempotent" as const, messageId: result.message.id };
    }
    return { outcome: "stale" as const, messageId: "" };
  }));
}

async function loadBotTools(userId: string): Promise<LoadedTool[]> {
  "use step";
  return runService(Effect.gen(function* () {
    const mcp = yield* McpService;
    const store = yield* StoreService;
    const connections = yield* fromPromise(() => store.listIntegrations(userId));
    const integrationIds = connections.map((connection) => connection.id);
    const groups = yield* fromPromise(() => Promise.all(
      integrationIds.slice(0, MAX_INTEGRATIONS).map(async (integrationId) => {
        try {
          const tools = await mcp.list(userId, integrationId);
          const integration = await store.getIntegration(userId, integrationId);
          if (!integration) return [];
          return tools.filter((tool) => tool.readOnly).map((tool) => ({
            ...tool,
            integrationId,
            kind: integration.kind,
            qualifiedName: safeToolName(integrationId, tool.name),
          }));
        } catch (error) {
          console.error(`Could not load MCP tools for ${integrationId}`, safeError(error));
          return [];
        }
      }),
    ));
    return groups.flat().slice(0, MAX_TOOLS) as LoadedTool[];
  }));
}

async function executeMcpToolStep(input: {
  userId: string;
  integrationId: string;
  toolName: string;
  args: Record<string, unknown>;
}): Promise<unknown> {
  "use step";
  return runService(Effect.gen(function* () {
    const mcp = yield* McpService;
    return yield* fromPromise(() => mcp.call(input.userId, input.integrationId, input.toolName, input.args));
  }));
}

async function demoBotReply(bot: Bot, messages: ModelMessage[]): Promise<string> {
  "use step";
  return runService(Effect.sync(() => {
    const latest = [...messages].reverse().find((message) => message.role === "user");
    const text = latest ? modelMessageText(latest) : "Introduce yourself and invite the user to share what they are working on.";
    const cleaned = text.replace(/^\[.+?\]:\s*/s, "").slice(0, 240);
    if (bot.handle === "nova") return `I like the direction. My read: “${cleaned}” is worth turning into one small experiment. Let's define the user outcome first, then ship the thinnest version that proves it.`;
    if (bot.handle === "patch") return `Building on that: I'd timebox the experiment, add one failure path, and measure whether the outcome actually changed. For “${cleaned}”, the next concrete step is a runnable happy path before expanding scope.`;
    return `${bot.name} here. On “${cleaned}”: I'd clarify the desired outcome, choose the smallest next action, and report back with something concrete.`;
  }));
}

function makeTools(definitions: LoadedTool[], userId: string): ToolSet {
  return Object.fromEntries(
    definitions.map((definition) => [
      definition.qualifiedName,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.inputSchema),
        execute: async (args) =>
          definition.kind === "desktop"
            ? executeDesktopTool({
                userId,
                integrationId: definition.integrationId,
                toolName: definition.name,
                args: args as Record<string, unknown>,
              })
            : executeMcpToolStep({
                userId,
                integrationId: definition.integrationId,
                toolName: definition.name,
                args: args as Record<string, unknown>,
              }),
      }),
    ]),
  );
}

function instructionsFor(bot: Bot): string {
  return [
    `You are ${bot.name} (@${bot.handle}), a user-created bot in a one-to-one chat.`,
    bot.persona,
    "Respond directly to the user in your own voice.",
    "Build on or constructively challenge another bot when useful. Never imitate another bot or write messages on its behalf.",
    "Return exactly one concise message. Do not invite an open-ended bot-to-bot discussion.",
    "Only read-only MCP tools are available. Never claim a write or external side effect happened unless a tool result proves it.",
  ].join("\n\n");
}

function toModelMessages(
  history: ChatMessage[],
  currentBotId: string,
  bots: Bot[],
  mode: "message" | "scheduled" = "message",
): ModelMessage[] {
  const relevant = history.filter((message) => message.status === "complete").slice(-MAX_HISTORY);
  if (relevant.length === 0) {
    return mode === "scheduled"
      ? []
      : [{ role: "user", content: "The human opened this chat. Introduce yourself briefly and invite them to share what they need help with." }];
  }
  return relevant.map((message) => {
    if (message.senderType === "bot" && message.senderId === currentBotId) {
      return { role: "assistant", content: message.content };
    }
    const speaker = message.senderType === "bot" ? bots.find((bot) => bot.id === message.senderId) : undefined;
    const prefix = speaker ? `[${speaker.name} (@${speaker.handle})]: ` : message.senderType === "system" ? "[System]: " : "[Human]: ";
    return { role: "user", content: `${prefix}${message.content}` };
  });
}

function modelMessageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
}

function safeToolName(integrationId: string, name: string): string {
  const suffix = integrationId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
  const bare = name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
  return `mcp_${suffix}_${bare}`;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Agent turn failed.").slice(0, 500);
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "expired";
}

function scheduledTriggerOf(run: Run, input: GroupTurnInput): ScheduledTrigger | null {
  if (input.scheduled) return input.scheduled;
  if (run.trigger.kind !== "scheduled") return null;
  const prompt = typeof run.trigger.prompt === "string" ? run.trigger.prompt : "";
  if (!prompt) return null;
  return {
    automationId: typeof run.trigger.automationId === "string" ? run.trigger.automationId : "",
    occurrenceAt: typeof run.trigger.occurrenceAt === "string" ? run.trigger.occurrenceAt : "",
    prompt,
  };
}

type ApprovalContentPart = {
  type: string;
  approvalId?: string;
  isAutomatic?: boolean;
  toolCall?: { input?: unknown };
};

/**
 * Reads a manual tool-approval request from a generation result. Automatic
 * approvals are ignored because they do not need a human decision.
 */
export function approvalRequestOf(
  result: { content: ReadonlyArray<ApprovalContentPart> },
): { approvalId: string; summary: string } | null {
  const request = result.content.find(
    (part) =>
      part.type === "tool-approval-request" &&
      !part.isAutomatic &&
      typeof part.approvalId === "string" &&
      part.approvalId.length > 0,
  );
  if (!request?.approvalId) return null;
  const input = request.toolCall?.input as { to?: unknown; subject?: unknown; text?: unknown } | undefined;
  const summary = input
    ? `send_email to ${String(input.to ?? "recipient")}\nSubject: ${String(input.subject ?? "(no subject)")}\n\n${String(input.text ?? "")}`
    : "send_email";
  return { approvalId: request.approvalId, summary };
}

/**
 * Rebuilds the model context for an approved tool call. The stored history
 * already contains the original conversation plus the generated tool call and
 * approval request, so only the provider approval response is appended.
 */
export function buildResumeMessages(
  action: Pick<PendingAction, "modelMessages" | "providerApprovalId">,
): ModelMessage[] {
  const history = Array.isArray(action.modelMessages) ? (action.modelMessages as ModelMessage[]) : [];
  if (!action.providerApprovalId) return history;
  return [
    ...history,
    {
      role: "tool",
      content: [{ type: "tool-approval-response", approvalId: action.providerApprovalId, approved: true }],
    },
  ];
}

/** Scheduled turns may opt out of a visible reply with an exact NO_REPLY. */
export function isNoReply(text: string): boolean {
  return text.trim() === "NO_REPLY";
}
