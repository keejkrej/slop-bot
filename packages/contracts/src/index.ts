import { z } from "zod";

export const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";
export const MAX_CHAT_BOTS = 1;

export const botSchema = z.object({
  id: z.string(),
  name: z.string(),
  handle: z.string(),
  persona: z.string(),
  model: z.string(),
  color: z.string(),
  integrationIds: z.array(z.string()),
  createdAt: z.string(),
});

export const createBotSchema = z.object({
  name: z.string().trim().min(2).max(40),
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]{1,23}$/, "Use 2–24 letters, numbers, or underscores; start with a letter."),
  persona: z.string().trim().min(10).max(4_000),
  model: z.string().trim().min(3).max(120).default(DEFAULT_MODEL),
  integrationIds: z.array(z.string()).max(20).default([]),
});

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

export const conversationRunStatusSchema = z.enum([
  "idle",
  "queued",
  "running",
  "awaiting_approval",
  "failed",
]);

export const pendingActionStatusSchema = z.enum([
  "pending",
  "resuming",
  "completed",
  "cancelled",
  "expired",
]);

export const runTriggerSchema = z
  .object({
    kind: z.enum(["message", "approval", "scheduled"]),
  })
  .catchall(z.unknown());

export const runSchema = z.object({
  id: z.string(),
  userId: z.string(),
  conversationId: z.string(),
  botId: z.string(),
  status: runStatusSchema,
  trigger: runTriggerSchema,
  attempt: z.number().int().nonnegative(),
  fence: z.number().int().nonnegative(),
  idempotencyKey: z.string().nullable(),
  messageId: z.string().nullable(),
  actionId: z.string().nullable(),
  workflowRunId: z.string().nullable(),
  outputMessageId: z.string().nullable(),
  leaseOwner: z.string().nullable(),
  leaseExpiresAt: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const runEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  seq: z.number().int().positive(),
  type: z.string(),
  data: z.unknown(),
  dedupeKey: z.string().nullable(),
  createdAt: z.string(),
});

export const runTimerStatusSchema = z.enum(["pending", "claimed", "fired", "cancelled"]);

export const runTimerSchema = z.object({
  id: z.string(),
  userId: z.string(),
  runId: z.string(),
  kind: z.string(),
  dueAt: z.string(),
  status: runTimerStatusSchema,
  claimedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const automationStatusSchema = z.enum(["active", "paused", "completed", "missed", "failed"]);

export const automationOccurrenceStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_approval",
  "succeeded",
  "failed",
  "missed",
]);

export const automationScheduleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("once"),
    localTime: z.string().trim().min(1),
    timezone: z.string().trim().min(1),
  }),
  z.object({
    kind: z.literal("cron"),
    expression: z.string().trim().min(1),
    timezone: z.string().trim().min(1),
  }),
]);

export const automationTaskSchema = z.object({
  id: z.string(),
  userId: z.string(),
  botId: z.string(),
  conversationId: z.string(),
  title: z.string(),
  instructions: z.string(),
  schedule: automationScheduleSchema,
  status: automationStatusSchema,
  nextDueAt: z.string().nullable(),
  lastOccurredAt: z.string().nullable(),
  lastError: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  claimedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const automationOccurrenceSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  userId: z.string(),
  occurrenceAt: z.string(),
  executionId: z.string(),
  runId: z.string().nullable(),
  workflowRunId: z.string().nullable(),
  status: automationOccurrenceStatusSchema,
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const createAutomationSchema = z.object({
  title: z.string().trim().min(1).max(120),
  botId: z.string().trim().min(1),
  instructions: z.string().trim().min(1).max(12_000),
  schedule: automationScheduleSchema,
});

export const updateAutomationSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    instructions: z.string().trim().min(1).max(12_000).optional(),
    schedule: automationScheduleSchema.optional(),
    status: z.enum(["active", "paused"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Provide at least one field to update." });

export const automationListSchema = z.object({
  automations: z.array(automationTaskSchema),
});

export const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  botIds: z.array(z.string()),
  activeRunId: z.string().nullable(),
  runStatus: conversationRunStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const createConversationSchema = z.object({
  title: z.string().trim().min(2).max(80),
  botIds: z.array(z.string()).length(MAX_CHAT_BOTS),
});

export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  senderType: z.enum(["user", "bot", "system"]),
  senderId: z.string(),
  content: z.string(),
  status: z.enum(["complete", "pending", "failed"]),
  error: z.string().nullable(),
  /** Set only for a bot output message owned by a durable run. */
  runId: z.string().nullable().default(null),
  createdAt: z.string(),
});

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(12_000),
});

export const integrationSchema = z.object({
  id: z.string(),
  kind: z.enum(["mcp", "github", "composio", "desktop"]),
  name: z.string(),
  url: z.string(),
  description: z.string(),
  status: z.enum(["connected", "authorization_required", "error"]),
  toolCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
});

export const createIntegrationSchema = z.object({
  kind: z.literal("mcp"),
  name: z.string().trim().min(2).max(60).optional(),
  url: z.string().trim().max(2_048).optional(),
  description: z.string().trim().max(500).default(""),
  toolkits: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
  platform: z.enum(["web", "android"]).default("web"),
  headerName: z.string().trim().regex(/^[A-Za-z0-9-]+$/).max(60).optional(),
  headerValue: z.string().max(4_096).optional(),
});

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});

export const botPreviewSchema = z.object({
  botId: z.string(),
  content: z.string(),
  createdAt: z.string(),
});

/** Per-user, per-conversation read bookmark. Only ids/timestamps, never content. */
export const conversationReadStateSchema = z.object({
  conversationId: z.string(),
  lastReadAt: z.string(),
  lastReadMessageId: z.string().nullable(),
});

export const markReadSchema = z.object({
  messageId: z.string().trim().min(1).nullable().optional(),
});

/** Conversation id -> nonnegative unread bot-message count. */
export const unreadCountsSchema = z.record(z.string(), z.number().int().nonnegative());

export const bootstrapSchema = z.object({
  user: userSchema,
  bots: z.array(botSchema),
  conversations: z.array(conversationSchema),
  integrations: z.array(integrationSchema),
  botPreviews: z.array(botPreviewSchema).default([]),
  unreadCounts: unreadCountsSchema.default({}),
  agentMode: z.enum(["gateway", "demo"]),
});

export const conversationDetailSchema = z.object({
  conversation: conversationSchema,
  messages: z.array(messageSchema),
  pendingActions: z.array(z.object({
    id: z.string(),
    botId: z.string(),
    kind: z.literal("tool_approval"),
    summary: z.string(),
    status: pendingActionStatusSchema,
    runId: z.string().nullable().default(null),
    providerApprovalId: z.string().nullable().default(null),
    createdAt: z.string(),
  })).default([]),
});

export const connectResponseSchema = z.object({
  integration: integrationSchema,
  authorizationUrl: z.string().nullable(),
});

export const runAcceptedSchema = z.object({
  runId: z.string(),
  status: z.literal("running"),
});

export type Bot = z.infer<typeof botSchema>;
export type CreateBotInput = z.infer<typeof createBotSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type ConversationRunStatus = z.infer<typeof conversationRunStatusSchema>;
export type PendingActionStatus = z.infer<typeof pendingActionStatusSchema>;
export type RunTrigger = z.infer<typeof runTriggerSchema>;
export type Run = z.infer<typeof runSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunTimerStatus = z.infer<typeof runTimerStatusSchema>;
export type RunTimer = z.infer<typeof runTimerSchema>;
export type AutomationStatus = z.infer<typeof automationStatusSchema>;
export type AutomationOccurrenceStatus = z.infer<typeof automationOccurrenceStatusSchema>;
export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;
export type AutomationTask = z.infer<typeof automationTaskSchema>;
export type AutomationOccurrence = z.infer<typeof automationOccurrenceSchema>;
export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;
export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type ChatMessage = z.infer<typeof messageSchema>;
export type Integration = z.infer<typeof integrationSchema>;
export type CreateIntegrationInput = z.infer<typeof createIntegrationSchema>;
export type User = z.infer<typeof userSchema>;
export type BotPreview = z.infer<typeof botPreviewSchema>;
export type ConversationReadState = z.infer<typeof conversationReadStateSchema>;
export type MarkReadInput = z.infer<typeof markReadSchema>;
export type UnreadCounts = z.infer<typeof unreadCountsSchema>;
export type Bootstrap = z.infer<typeof bootstrapSchema>;
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;
export type ConnectResponse = z.infer<typeof connectResponseSchema>;
export type RunAccepted = z.infer<typeof runAcceptedSchema>;

export function botColor(id: string): string {
  const colors = ["#ff6b35", "#6c5ce7", "#0984e3", "#00a884", "#d63076", "#b7791f"];
  const score = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return colors[score % colors.length] ?? "#ff6b35";
}

export function displayError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
