import { z } from "zod";

export const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";
export const MAX_GROUP_BOTS = 4;

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

export const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  botIds: z.array(z.string()),
  activeRunId: z.string().nullable(),
  runStatus: z.enum(["idle", "running", "failed"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const createConversationSchema = z.object({
  title: z.string().trim().min(2).max(80),
  botIds: z.array(z.string()).min(1).max(MAX_GROUP_BOTS),
});

export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  senderType: z.enum(["user", "bot", "system"]),
  senderId: z.string(),
  content: z.string(),
  status: z.enum(["complete", "pending", "failed"]),
  error: z.string().nullable(),
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

export const bootstrapSchema = z.object({
  user: userSchema,
  bots: z.array(botSchema),
  conversations: z.array(conversationSchema),
  integrations: z.array(integrationSchema),
  agentMode: z.enum(["gateway", "demo"]),
});

export const conversationDetailSchema = z.object({
  conversation: conversationSchema,
  messages: z.array(messageSchema),
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
export type Conversation = z.infer<typeof conversationSchema>;
export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type ChatMessage = z.infer<typeof messageSchema>;
export type Integration = z.infer<typeof integrationSchema>;
export type CreateIntegrationInput = z.infer<typeof createIntegrationSchema>;
export type User = z.infer<typeof userSchema>;
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
