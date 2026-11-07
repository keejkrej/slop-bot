import { WorkflowAgent } from "@ai-sdk/workflow";
import { Effect } from "effect";
import { isStepCount, jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import type { Bot, ChatMessage } from "@slopbot/contracts";

import type { McpToolDefinition } from "../apps/web/lib/server/mcp";
import { executeDesktopTool } from "./desktop-tools";
import { nativeTools } from "./native-tools";
import { McpService, StoreService, fromPromise, runService, withStore } from "../apps/web/lib/server/effect";

export type GroupTurnInput = {
  userId: string;
  conversationId: string;
  botIds: string[];
  useGateway: boolean;
  resumeActionId?: string;
};

type BotContext = {
  bot: Bot;
  messages: ModelMessage[];
};

type LoadedTool = McpToolDefinition & {
  integrationId: string;
  kind: "mcp" | "github" | "composio" | "desktop";
  qualifiedName: string;
};

export async function runGroupTurn(input: GroupTurnInput): Promise<{ savedMessageIds: string[]; pendingActionId?: string }> {
  "use workflow";

  const savedMessageIds: string[] = [];
  try {
    for (const botId of input.botIds.slice(0, 4)) {
      const resumeAction = input.resumeActionId && botId === input.resumeActionId ? await loadResumeAction(input.userId, input.conversationId, botId) : null;
      if (input.resumeActionId && !resumeAction) continue;
      const context = resumeAction ?? await loadBotContext(input.userId, input.conversationId, botId);
      if (!context) continue;
      const tools = await loadBotTools(input.userId);
      let content: string;
      try {
        if (!input.useGateway) {
          content = await demoBotReply(context.bot, context.messages);
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
            stopWhen: isStepCount(6),
            maxOutputTokens: 1_200,
          });
          const pending = approvalRequestOf(result);
          if (pending) {
            const actionId = await createApproval(input.userId, input.conversationId, botId, result.responseMessages, pending.summary);
            await saveApprovalMessage(input.userId, input.conversationId, actionId);
            return { savedMessageIds, pendingActionId: actionId };
          }
          if (resumeAction) await setApprovalStatus(input.userId, input.resumeActionId!, "completed");
          content = result.text.trim() || "I don't have a useful response yet.";
        }
      } catch (error) {
        content = "I hit an error while responding. The group can continue, and you can try my turn again.";
        await saveBotMessage(input.userId, input.conversationId, botId, content, "failed", safeError(error));
        continue;
      }
      const saved = await saveBotMessage(input.userId, input.conversationId, botId, content, "complete", null);
      savedMessageIds.push(saved);
    }
    await finishGroupRun(input.userId, input.conversationId, "idle");
    return { savedMessageIds };
  } catch (error) {
    await recordGroupFailure(input.userId, input.conversationId, safeError(error));
    throw error;
  }
}

async function loadBotContext(userId: string, conversationId: string, botId: string): Promise<BotContext | null> {
  "use step";
  return runService(withStore(async (store) => {
    const [conversation, bot, history, allBots] = await Promise.all([
      store.getConversation(userId, conversationId),
      store.getBot(userId, botId),
      store.listMessages(userId, conversationId),
      store.listBots(userId),
    ]);
    if (!conversation || !bot || !conversation.botIds.includes(botId)) return null;
    return { bot, messages: toModelMessages(history, botId, allBots) };
  }));
}

async function loadResumeAction(userId: string, conversationId: string, actionId: string): Promise<BotContext | null> {
  "use step";
  return runService(withStore(async (store) => {
    const action = await store.getPendingAction(userId, actionId);
    if (!action || action.status !== "pending") return null;
    const bot = await store.getBot(userId, action.botId);
    if (!bot) return null;
    return {
      bot,
      messages: [
        ...(action.modelMessages as ModelMessage[]),
        { role: "tool", content: [{ type: "tool-approval-response", approvalId: action.id, approved: true }] },
      ],
    };
  }));
}

async function createApproval(userId: string, conversationId: string, botId: string, modelMessages: ModelMessage[], summary: string): Promise<string> {
  "use step";
  return runService(withStore(async (store) => {
    const action = await store.createPendingAction({ userId, conversationId, botId, kind: "tool_approval", summary, modelMessages });
    return action.id;
  }));
}

async function saveApprovalMessage(userId: string, conversationId: string, actionId: string): Promise<void> {
  "use step";
  await runService(withStore((store) => store.addMessage(userId, {
    conversationId,
    senderType: "system",
    senderId: actionId,
    content: "Approval required for send_email. Review the request and approve it in this chat.",
  })));
}

async function setApprovalStatus(userId: string, actionId: string, status: "completed" | "cancelled"): Promise<void> {
  "use step";
  await runService(withStore((store) => store.setPendingActionStatus(userId, actionId, status)));
}

function approvalRequestOf(result: { content: Array<{ type: string; approvalId?: string; input?: unknown }> }): { approvalId: string; summary: string } | null {
  const request = result.content.find((part) => part.type === "tool-approval-request" && part.approvalId);
  if (!request?.approvalId) return null;
  const input = request.input as { to?: unknown; subject?: unknown; text?: unknown } | undefined;
  const summary = input
    ? `send_email to ${String(input.to ?? "recipient")}\nSubject: ${String(input.subject ?? "(no subject)")}\n\n${String(input.text ?? "")}`
    : "send_email";
  return { approvalId: request.approvalId, summary };
}

async function loadBotTools(userId: string): Promise<LoadedTool[]> {
  "use step";
  return runService(Effect.gen(function* () {
    const mcp = yield* McpService;
    const store = yield* StoreService;
    const connections = yield* fromPromise(() => store.listIntegrations(userId));
    const integrationIds = connections.map((connection) => connection.id);
    const groups = yield* fromPromise(() => Promise.all(
      integrationIds.slice(0, 10).map(async (integrationId) => {
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
    return groups.flat().slice(0, 64) as LoadedTool[];
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
    const text = latest ? modelMessageText(latest) : "Introduce yourselves and decide what this group should explore.";
    const cleaned = text.replace(/^\[.+?\]:\s*/s, "").slice(0, 240);
    if (bot.handle === "nova") return `I like the direction. My read: “${cleaned}” is worth turning into one small experiment. Let's define the user outcome first, then ship the thinnest version that proves it.`;
    if (bot.handle === "patch") return `Building on that: I'd timebox the experiment, add one failure path, and measure whether the outcome actually changed. For “${cleaned}”, the next concrete step is a runnable happy path before expanding scope.`;
    return `${bot.name} here. On “${cleaned}”: I'd clarify the desired outcome, choose the smallest next action, and report back with something concrete.`;
  }));
}

async function saveBotMessage(
  userId: string,
  conversationId: string,
  botId: string,
  content: string,
  status: "complete" | "failed",
  error: string | null,
): Promise<string> {
  "use step";
  return runService(withStore(async (store) => {
    const message = await store.addMessage(userId, {
      conversationId,
      senderType: "bot",
      senderId: botId,
      content,
      status,
      error,
    });
    return message.id;
  }));
}

async function finishGroupRun(userId: string, conversationId: string, status: "idle" | "failed"): Promise<void> {
  "use step";
  return runService(withStore((store) => store.setConversationRun(userId, conversationId, null, status)));
}

async function recordGroupFailure(userId: string, conversationId: string, error: string): Promise<void> {
  "use step";
  return runService(withStore(async (store) => {
    await store.addMessage(userId, {
      conversationId,
      senderType: "system",
      senderId: "system",
      content: "The group run stopped unexpectedly. You can retry without losing earlier messages.",
      status: "failed",
      error,
    });
    await store.setConversationRun(userId, conversationId, null, "failed");
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
    `You are ${bot.name} (@${bot.handle}), one user-created bot in a group chat.`,
    bot.persona,
    "Other speakers are identified as [Name (@handle)]. Read their messages and respond to the group, not just the latest user.",
    "Build on or constructively challenge another bot when useful. Never imitate another bot or write messages on its behalf.",
    "Return exactly one concise message for yourself. Do not ask the group to enter an open-ended discussion loop.",
    "Only read-only MCP tools are available. Never claim a write or external side effect happened unless a tool result proves it.",
  ].join("\n\n");
}

function toModelMessages(history: ChatMessage[], currentBotId: string, bots: Bot[]): ModelMessage[] {
  const relevant = history.filter((message) => message.status === "complete").slice(-40);
  if (relevant.length === 0) {
    return [{ role: "user", content: "The human opened this group. Introduce yourself briefly and suggest one useful topic for the group." }];
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
