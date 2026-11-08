import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  botColor,
  type Bot,
  type ChatMessage,
  type Conversation,
  type CreateBotInput,
  type CreateConversationInput,
  type Integration,
  type User,
} from "@slopbot/contracts";
import { decryptSecret, encryptSecret } from "./crypto";
import { bots, conversations, desktopJobs, integrations, messages, oauthStates, pendingActions, toBot } from "./schema";
import type { AppStore, DesktopJob, NewDesktopJob, NewIntegration, NewMessage, NewPendingAction, OAuthState, PendingAction } from "./types";
import type { IntegrationSecret } from "../apps/web/lib/server/mcp";


const iso = (value: string) => new Date(value).toISOString();

export class PostgresStore implements AppStore {
  private readonly client: ReturnType<typeof postgres>;
  private readonly db: ReturnType<typeof drizzle>;

  constructor(url: string) {
    this.client = postgres(url, { max: 5, prepare: false });
    this.db = drizzle(this.client);
  }

  async getUser(userId: string): Promise<User> {
    return { id: userId, name: "Member", email: null, avatarUrl: null };
  }

  async listBots(userId: string): Promise<Bot[]> {
    const rows = await this.db.select().from(bots).where(eq(bots.userId, userId)).orderBy(bots.createdAt);
    return rows.map(toBot);
  }

  async getBot(userId: string, botId: string): Promise<Bot | null> {
    const [row] = await this.db.select().from(bots).where(and(eq(bots.userId, userId), eq(bots.id, botId))).limit(1);
    return row ? toBot(row) : null;
  }

  async createBot(userId: string, input: CreateBotInput): Promise<Bot> {
    const id = `bot_${crypto.randomUUID()}`;
    const [row] = await this.db.insert(bots).values({ ...input, id, userId, color: botColor(id) }).returning();
    if (!row) throw new Error("Could not create bot.");
    return toBot(row);
  }

  async deleteBot(userId: string, botId: string): Promise<void> {
    await this.db.delete(bots).where(and(eq(bots.userId, userId), eq(bots.id, botId)));
  }

  async listConversations(userId: string): Promise<Conversation[]> {
    const rows = await this.db.select().from(conversations).where(eq(conversations.userId, userId)).orderBy(desc(conversations.updatedAt));
    return rows.map(toConversation);
  }

  async getConversation(userId: string, conversationId: string): Promise<Conversation | null> {
    const [row] = await this.db.select().from(conversations).where(and(eq(conversations.userId, userId), eq(conversations.id, conversationId))).limit(1);
    return row ? toConversation(row) : null;
  }

  async createConversation(userId: string, input: CreateConversationInput): Promise<Conversation> {
    const [row] = await this.db.insert(conversations).values({ ...input, id: `conv_${crypto.randomUUID()}`, userId }).returning();
    if (!row) throw new Error("Could not create conversation.");
    return toConversation(row);
  }

  async setConversationRun(userId: string, conversationId: string, runId: string | null, status: Conversation["runStatus"]): Promise<void> {
    await this.db.update(conversations)
      .set({ activeRunId: runId, runStatus: status, updatedAt: new Date().toISOString() })
      .where(and(eq(conversations.userId, userId), eq(conversations.id, conversationId)));
  }

  async listMessages(userId: string, conversationId: string): Promise<ChatMessage[]> {
    const rows = await this.db.select().from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.conversationId, conversationId)))
      .orderBy(messages.createdAt);
    return rows.map(toMessage);
  }

  async addMessage(userId: string, input: NewMessage): Promise<ChatMessage> {
    return this.db.transaction(async (tx) => {
      const [conversation] = await tx.select({ id: conversations.id }).from(conversations)
        .where(and(eq(conversations.userId, userId), eq(conversations.id, input.conversationId))).limit(1);
      if (!conversation) throw new Error("Conversation not found.");
      const [row] = await tx.insert(messages).values({
        ...input,
        id: `msg_${crypto.randomUUID()}`,
        userId,
        status: input.status ?? "complete",
        error: input.error ?? null,
      }).returning();
      if (!row) throw new Error("Could not save message.");
      await tx.update(conversations).set({ updatedAt: new Date().toISOString() }).where(eq(conversations.id, input.conversationId));
      return toMessage(row);
    });
  }

  async listIntegrations(userId: string): Promise<Integration[]> {
    const rows = await this.db.select().from(integrations).where(eq(integrations.userId, userId)).orderBy(integrations.createdAt);
    return rows.map(toIntegration);
  }

  async getIntegration(userId: string, integrationId: string): Promise<Integration | null> {
    const [row] = await this.db.select().from(integrations).where(and(eq(integrations.userId, userId), eq(integrations.id, integrationId))).limit(1);
    return row ? toIntegration(row) : null;
  }

  async createIntegration(userId: string, input: NewIntegration): Promise<Integration> {
    const [row] = await this.db.insert(integrations).values({
      ...input,
      id: `mcp_${crypto.randomUUID()}`,
      userId,
      toolCount: input.toolCount ?? 0,
      lastError: input.lastError ?? null,
    }).returning();
    if (!row) throw new Error("Could not create connection.");
    return toIntegration(row);
  }

  async updateIntegration(userId: string, integrationId: string, patch: Partial<Pick<Integration, "status" | "toolCount" | "lastError">>): Promise<void> {
    await this.db.update(integrations).set(patch).where(and(eq(integrations.userId, userId), eq(integrations.id, integrationId)));
  }

  async deleteIntegration(userId: string, integrationId: string): Promise<void> {
    const affectedBots = await this.db.select().from(bots).where(eq(bots.userId, userId));
    for (const bot of affectedBots) {
      if (bot.integrationIds.includes(integrationId)) {
        await this.db.update(bots).set({ integrationIds: bot.integrationIds.filter((id) => id !== integrationId) }).where(eq(bots.id, bot.id));
      }
    }
    await this.db.delete(integrations).where(and(eq(integrations.userId, userId), eq(integrations.id, integrationId)));
  }

  async getSecret<T>(userId: string, integrationId: string): Promise<T | null> {
    const [row] = await this.db.select({ secret: integrations.secretCiphertext }).from(integrations)
      .where(and(eq(integrations.userId, userId), eq(integrations.id, integrationId))).limit(1);
    return row?.secret ? decryptSecret<T>(row.secret) : null;
  }

  async setSecret(userId: string, integrationId: string, value: unknown): Promise<void> {
    await this.db.update(integrations).set({ secretCiphertext: encryptSecret(value) })
      .where(and(eq(integrations.userId, userId), eq(integrations.id, integrationId)));
  }

  async putOAuthState(value: OAuthState): Promise<void> {
    await this.db.insert(oauthStates).values(value).onConflictDoUpdate({ target: oauthStates.state, set: value });
  }

  async getOAuthState(state: string): Promise<OAuthState | null> {
    const [row] = await this.db.select().from(oauthStates).where(eq(oauthStates.state, state)).limit(1);
    if (!row || Date.parse(row.expiresAt) <= Date.now()) return null;
    return { ...row, createdAt: iso(row.createdAt), expiresAt: iso(row.expiresAt) };
  }

  async deleteOAuthState(state: string): Promise<void> {
    await this.db.delete(oauthStates).where(eq(oauthStates.state, state));
  }

  async createDesktopJob(input: NewDesktopJob): Promise<DesktopJob> {
    const [row] = await this.db.insert(desktopJobs).values({ ...input, id: `desktop_job_${crypto.randomUUID()}` }).returning();
    if (!row) throw new Error("Could not create desktop tool job.");
    return toDesktopJob(row);
  }

  async getDesktopJob(userId: string, jobId: string): Promise<DesktopJob | null> {
    const [row] = await this.db.select().from(desktopJobs).where(and(eq(desktopJobs.userId, userId), eq(desktopJobs.id, jobId))).limit(1);
    return row ? toDesktopJob(row) : null;
  }

  async listPendingDesktopJobs(userId: string, deviceId: string): Promise<DesktopJob[]> {
    const rows = await this.db.select().from(desktopJobs).where(and(
      eq(desktopJobs.userId, userId),
      eq(desktopJobs.deviceId, deviceId),
      eq(desktopJobs.status, "pending"),
    )).orderBy(desktopJobs.createdAt).limit(20);
    return rows.map(toDesktopJob);
  }

  async completeDesktopJob(userId: string, jobId: string, result: { ok: boolean; output?: unknown; error?: string }): Promise<DesktopJob | null> {
    const [row] = await this.db.update(desktopJobs).set({
      status: result.ok ? "completed" : "failed",
      output: result.output ?? null,
      error: result.error ?? null,
    }).where(and(eq(desktopJobs.userId, userId), eq(desktopJobs.id, jobId), eq(desktopJobs.status, "pending"))).returning();
    return row ? toDesktopJob(row) : null;
  }

  async createPendingAction(input: NewPendingAction): Promise<PendingAction> {
    const [row] = await this.db.insert(pendingActions).values({ ...input, id: `approval_${crypto.randomUUID()}` }).returning();
    if (!row) throw new Error("Could not create approval.");
    return toPendingAction(row);
  }

  async getPendingAction(userId: string, actionId: string): Promise<PendingAction | null> {
    const [row] = await this.db.select().from(pendingActions).where(and(eq(pendingActions.userId, userId), eq(pendingActions.id, actionId))).limit(1);
    return row ? toPendingAction(row) : null;
  }

  async listPendingActions(userId: string, conversationId: string): Promise<PendingAction[]> {
    const rows = await this.db.select().from(pendingActions).where(and(
      eq(pendingActions.userId, userId),
      eq(pendingActions.conversationId, conversationId),
      eq(pendingActions.status, "pending"),
    )).orderBy(pendingActions.createdAt);
    return rows.map(toPendingAction);
  }

  async listPendingDesktopConnections(userId: string): Promise<Integration[]> {
    const rows = await this.db.select().from(integrations).where(and(
      eq(integrations.userId, userId),
      eq(integrations.kind, "desktop"),
      eq(integrations.status, "authorization_required"),
    ));
    const pending: Integration[] = [];
    for (const row of rows) {
      const secret = row.secretCiphertext ? decryptSecret<IntegrationSecret>(row.secretCiphertext) : null;
      if (secret?.pending) pending.push(toIntegration(row));
    }
    return pending;
  }

  async setPendingActionStatus(userId: string, actionId: string, status: PendingAction["status"]): Promise<void> {
    await this.db.update(pendingActions).set({ status }).where(and(eq(pendingActions.userId, userId), eq(pendingActions.id, actionId)));
  }
}

function toConversation(row: typeof conversations.$inferSelect): Conversation {
  return {
    id: row.id,
    title: row.title,
    botIds: row.botIds,
    activeRunId: row.activeRunId,
    runStatus: row.runStatus,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toMessage(row: typeof messages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderType: row.senderType as ChatMessage["senderType"],
    senderId: row.senderId,
    content: row.content,
    status: row.status as ChatMessage["status"],
    error: row.error,
    createdAt: iso(row.createdAt),
  };
}

function toPendingAction(row: typeof pendingActions.$inferSelect): PendingAction {
  return {
    id: row.id,
    userId: row.userId,
    conversationId: row.conversationId,
    botId: row.botId,
    kind: row.kind as PendingAction["kind"],
    summary: row.summary,
    modelMessages: row.modelMessages,
    status: row.status as PendingAction["status"],
    createdAt: iso(row.createdAt),
  };
}

function toDesktopJob(row: typeof desktopJobs.$inferSelect): DesktopJob {
  return {
    id: row.id,
    userId: row.userId,
    deviceId: row.deviceId,
    integrationId: row.integrationId,
    toolName: row.toolName,
    args: row.args,
    status: row.status as DesktopJob["status"],
    output: row.output,
    error: row.error,
    createdAt: iso(row.createdAt),
  };
}
function toIntegration(row: typeof integrations.$inferSelect): Integration {
  return {
    id: row.id,
    kind: row.kind as Integration["kind"],
    name: row.name,
    url: row.url,
    description: row.description,
    status: row.status as Integration["status"],
    toolCount: row.toolCount,
    lastError: row.lastError,
    createdAt: iso(row.createdAt),
  };
}
