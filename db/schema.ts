import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, integer, primaryKey, uniqueIndex } from "drizzle-orm/pg-core";
import type {
  AutomationOccurrenceStatus,
  AutomationSchedule,
  AutomationStatus,
  Bot,
  Conversation,
  RunStatus,
  RunTrigger,
  ToolRisk,
} from "@slopbot/contracts";

export const bots = pgTable("bots", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  handle: text("handle").notNull(),
  persona: text("persona").notNull(),
  model: text("model").notNull(),
  color: text("color").notNull(),
  integrationIds: jsonb("integration_ids").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  botIds: jsonb("bot_ids").$type<string[]>().notNull(),
  activeRunId: text("active_run_id"),
  runStatus: text("run_status").$type<Conversation["runStatus"]>().notNull().default("idle"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  userId: text("user_id").notNull(),
  senderType: text("sender_type").notNull(),
  senderId: text("sender_id").notNull(),
  content: text("content").notNull(),
  status: text("status").notNull().default("complete"),
  error: text("error"),
  runId: text("run_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const conversationReads = pgTable(
  "conversation_reads",
  {
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true, mode: "string" }).notNull(),
    lastReadMessageId: text("last_read_message_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.conversationId] })],
);

export const integrations = pgTable("integrations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull(),
  toolCount: integer("tool_count").notNull().default(0),
  lastError: text("last_error"),
  secretCiphertext: text("secret_ciphertext"),
  allowedWriteTools: jsonb("allowed_write_tools").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const oauthStates = pgTable("oauth_states", {
  state: text("state").primaryKey(),
  integrationId: text("integration_id").notNull(),
  userId: text("user_id").notNull(),
  platform: text("platform").$type<"web" | "android">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
});

export const pendingActions = pgTable("pending_actions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  botId: text("bot_id").notNull(),
  kind: text("kind").notNull(),
  summary: text("summary").notNull(),
  modelMessages: jsonb("model_messages").notNull(),
  status: text("status").notNull().default("pending"),
  runId: text("run_id"),
  providerApprovalId: text("provider_approval_id"),
  toolName: text("tool_name"),
  toolArgsRedacted: jsonb("tool_args_redacted").$type<Record<string, unknown> | null>(),
  toolRisk: text("tool_risk").$type<ToolRisk>().notNull().default("read"),
  idempotencyKey: text("idempotency_key"),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
  integrationId: text("integration_id"),
  integrationName: text("integration_name"),
  argsDigest: text("args_digest"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  botId: text("bot_id").notNull().default(""),
  status: text("status").$type<RunStatus>().notNull().default("queued"),
  trigger: jsonb("trigger").$type<RunTrigger>().notNull(),
  attempt: integer("attempt").notNull().default(0),
  fence: integer("fence").notNull().default(0),
  idempotencyKey: text("idempotency_key"),
  messageId: text("message_id"),
  actionId: text("action_id"),
  workflowRunId: text("workflow_run_id"),
  outputMessageId: text("output_message_id"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "string" }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const runEvents = pgTable("run_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  data: jsonb("data"),
  dedupeKey: text("dedupe_key"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const runTimers = pgTable("run_timers", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  runId: text("run_id").notNull(),
  kind: text("kind").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true, mode: "string" }).notNull(),
  status: text("status").notNull().default("pending"),
  claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const runClaims = pgTable(
  "run_claims",
  {
    userId: text("user_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    runId: text("run_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.idempotencyKey] })],
);

export const automationTasks = pgTable("automation_tasks", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  botId: text("bot_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  title: text("title").notNull(),
  instructions: text("instructions").notNull(),
  schedule: jsonb("schedule").$type<AutomationSchedule>().notNull(),
  status: text("status").$type<AutomationStatus>().notNull().default("active"),
  nextDueAt: timestamp("next_due_at", { withTimezone: true, mode: "string" }),
  lastOccurredAt: timestamp("last_occurred_at", { withTimezone: true, mode: "string" }),
  lastError: text("last_error"),
  attempts: integer("attempts").notNull().default(0),
  claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "string" }),
  revision: integer("revision").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const automationOccurrences = pgTable("automation_occurrences", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  userId: text("user_id").notNull(),
  occurrenceAt: timestamp("occurrence_at", { withTimezone: true, mode: "string" }).notNull(),
  executionId: text("execution_id").notNull(),
  runId: text("run_id"),
  workflowRunId: text("workflow_run_id"),
  status: text("status").$type<AutomationOccurrenceStatus>().notNull().default("queued"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

/**
 * Durable file-backed memory. Global user instructions use empty
 * `conversation_id`/`bot_id`; conversation memory is bound to one bot in one
 * conversation. `version` is the compare-and-swap revision.
 */
export const memoryFiles = pgTable(
  "memory_files",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id").notNull().default(""),
    botId: text("bot_id").notNull().default(""),
    path: text("path").notNull(),
    content: text("content").notNull(),
    version: integer("version").notNull().default(1),
    source: text("source").notNull(),
    provenance: text("provenance").notNull(),
    sourceRunId: text("source_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("memory_files_scope_path_idx").on(
      table.userId,
      table.conversationId,
      table.botId,
      table.path,
    ),
  ],
);

export const desktopJobs = pgTable(
  "desktop_jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    deviceId: text("device_id").notNull(),
    integrationId: text("integration_id").notNull(),
    toolName: text("tool_name").notNull(),
    args: jsonb("args").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"),
    output: jsonb("output"),
    error: text("error"),
    runId: text("run_id"),
    stepKey: text("step_key"),
    attempt: integer("attempt"),
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "string" }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "string" }),
    deliveryStatus: text("delivery_status").notNull().default("pending"),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    deliveryError: text("delivery_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("desktop_jobs_run_step_idx")
      .on(table.runId, table.stepKey)
      .where(sql`${table.runId} is not null and ${table.stepKey} is not null`),
  ],
);

export type BotRow = typeof bots.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type IntegrationRow = typeof integrations.$inferSelect;

export function toBot(row: BotRow): Bot {
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    persona: row.persona,
    model: row.model,
    color: row.color,
    integrationIds: row.integrationIds,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
