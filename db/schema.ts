import { jsonb, pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import type { Bot, Conversation } from "@slopbot/contracts";

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
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

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
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const desktopJobs = pgTable("desktop_jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  deviceId: text("device_id").notNull(),
  integrationId: text("integration_id").notNull(),
  toolName: text("tool_name").notNull(),
  args: jsonb("args").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("pending"),
  output: jsonb("output"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

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
