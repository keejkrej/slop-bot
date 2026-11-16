import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PgTransaction } from "drizzle-orm/pg-core";
import postgres from "postgres";
import {
  botColor,
  type Bot,
  type BotPreview,
  type ChatMessage,
  type Conversation,
  type ConversationReadState,
  type CreateBotInput,
  type CreateConversationInput,
  type Integration,
  type Run,
  type RunEvent,
  type RunStatus,
  type RunTimer,
  type RunTrigger,
  type User,
} from "@slopbot/contracts";
import { decryptSecret, encryptSecret } from "./crypto";
import {
  automationOccurrences,
  automationTasks,
  bots,
  conversationReads,
  conversations,
  desktopJobs,
  integrations,
  messages,
  oauthStates,
  pendingActions,
  runClaims,
  runEvents,
  runs,
  runTimers,
  toBot,
} from "./schema";
import {
  ACTIVE_RUN_STATUSES,
  conversationProjectionFor,
  isActiveRunStatus,
  START_HANDOFF_MS,
  type AdmitAutomationOccurrenceInput,
  type AppStore,
  type AutomationOccurrence,
  type AutomationOccurrencePatch,
  type AutomationStore,
  type AutomationTask,
  type AutomationTaskPatch,
  type ClaimApprovalRunInput,
  type ClaimDueAutomationTasksInput,
  type ClaimMessageRunInput,
  type ClaimRunInput,
  type ClaimRunResult,
  type ClaimScheduledRunInput,
  type CompleteAutomationOccurrenceInput,
  type CompleteRunWithMessageInput,
  type CompleteRunWithMessageResult,
  type DesktopJob,
  type ListRunsInput,
  type NewAutomationTask,
  type NewDesktopJob,
  type NewIntegration,
  type NewMessage,
  type NewPendingAction,
  type OAuthState,
  type PendingAction,
  type ListRecoverableRunsInput,
  type ReadStateStore,
  type ReleaseRunTimerInput,
  type RunStore,
  type TransitionRunInput,
  type TransitionRunResult,
  StoreDomainError,
} from "./types";
import type { IntegrationSecret } from "../apps/web/lib/server/mcp";


const iso = (value: string) => new Date(value).toISOString();

/** A tick lease older than this may be reclaimed after a crashed tick. */
const AUTOMATION_CLAIM_LEASE_MS = 5 * 60 * 1000;

type Tx = PgTransaction<any, any, any>;

export class PostgresStore implements AppStore {
  private readonly client: ReturnType<typeof postgres>;
  private readonly db: ReturnType<typeof drizzle>;

  readonly runs: RunStore = {
    claimRun: (input) => this.claimRun(input),
    getRun: (userId, runId) => this.getRun(userId, runId),
    listRuns: (input) => this.listRuns(input),
    transitionRun: (input) => this.transitionRun(input),
    completeWithMessage: (input) => this.completeWithMessage(input),
    appendEvent: (input) => this.appendEvent(input),
    listEvents: (userId, runId) => this.listEvents(userId, runId),
    upsertTimer: (input) => this.upsertTimer(input),
    claimDueTimers: (input) => this.claimDueTimers(input),
    releaseRunTimer: (input) => this.releaseRunTimer(input),
    listRecoverableRuns: (input) => this.listRecoverableRuns(input),
  };

  readonly automations: AutomationStore = {
    createTask: (input) => this.createAutomationTask(input),
    listTasks: (userId) => this.listAutomationTasks(userId),
    getTask: (userId, taskId) => this.getAutomationTask(userId, taskId),
    updateTask: (userId, taskId, patch, expectedRevision) =>
      this.updateAutomationTask(userId, taskId, patch, expectedRevision),
    deleteTask: (userId, taskId) => this.deleteAutomationTask(userId, taskId),
    claimDueTasks: (input) => this.claimDueAutomationTasks(input),
    admitOccurrence: (input) => this.admitAutomationOccurrence(input),
    completeOccurrence: (input) => this.completeAutomationOccurrence(input),
    updateOccurrence: (userId, occurrenceId, patch) =>
      this.updateAutomationOccurrence(userId, occurrenceId, patch),
    listOccurrences: (userId, taskId) => this.listAutomationOccurrences(userId, taskId),
    listOpenOccurrences: (limit) => this.listOpenAutomationOccurrences(limit),
    listPendingOccurrences: (limit) => this.listPendingAutomationOccurrences(limit),
    listOpenOccurrencesForTask: (userId, taskId) =>
      this.listOpenAutomationOccurrencesForTask(userId, taskId),
  };

  readonly readState: ReadStateStore = {
    markRead: (userId, conversationId, messageId) => this.markRead(userId, conversationId, messageId),
    getUnreadCounts: (userId) => this.getUnreadCounts(userId),
  };

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

  async listBotPreviews(userId: string): Promise<BotPreview[]> {
    const rows = await this.db
      .selectDistinctOn([messages.senderId], {
        botId: messages.senderId,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.senderType, "bot")))
      .orderBy(messages.senderId, desc(messages.createdAt));
    return rows.map((row) => ({ botId: row.botId, content: row.content, createdAt: iso(row.createdAt) }));
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

  async markRead(
    userId: string,
    conversationId: string,
    messageId?: string | null,
  ): Promise<ConversationReadState | null> {
    return this.db.transaction(async (tx) => {
      const [conversation] = await tx.select({ id: conversations.id }).from(conversations)
        .where(and(eq(conversations.userId, userId), eq(conversations.id, conversationId))).limit(1);
      if (!conversation) return null;

      let targetAt: string;
      let targetId: string | null;
      if (messageId) {
        const [message] = await tx.select({ id: messages.id, createdAt: messages.createdAt }).from(messages)
          .where(and(
            eq(messages.userId, userId),
            eq(messages.conversationId, conversationId),
            eq(messages.id, messageId),
          )).limit(1);
        if (!message) throw new Error("Message not found.");
        targetAt = iso(message.createdAt);
        targetId = message.id;
      } else {
        const [newest] = await tx.select({ id: messages.id, createdAt: messages.createdAt }).from(messages)
          .where(and(eq(messages.userId, userId), eq(messages.conversationId, conversationId)))
          .orderBy(desc(messages.createdAt), desc(messages.id)).limit(1);
        targetAt = newest ? iso(newest.createdAt) : new Date().toISOString();
        targetId = newest?.id ?? null;
      }

      const [existing] = await tx.select().from(conversationReads)
        .where(and(
          eq(conversationReads.userId, userId),
          eq(conversationReads.conversationId, conversationId),
        )).limit(1);
      if (existing) {
        const existingAt = iso(existing.lastReadAt);
        // Forward-only in the same (createdAt, id) order used for unread counts.
        const forward =
          compareReadPosition(targetAt, targetId, existingAt, existing.lastReadMessageId) > 0;
        if (!forward) {
          return {
            conversationId,
            lastReadAt: existingAt,
            lastReadMessageId: existing.lastReadMessageId,
          };
        }
      }

      const updatedAt = new Date().toISOString();
      await tx.insert(conversationReads).values({
        userId,
        conversationId,
        lastReadAt: targetAt,
        lastReadMessageId: targetId,
        updatedAt,
      }).onConflictDoUpdate({
        target: [conversationReads.userId, conversationReads.conversationId],
        set: { lastReadAt: targetAt, lastReadMessageId: targetId, updatedAt },
        // Forward-only even under concurrent writers, using the same total order.
        setWhere: sql`(${conversationReads.lastReadAt}, coalesce(${conversationReads.lastReadMessageId}, '')) < (${targetAt}::timestamptz, ${targetId ?? ""}::text)`,
      });

      const [saved] = await tx.select().from(conversationReads)
        .where(and(
          eq(conversationReads.userId, userId),
          eq(conversationReads.conversationId, conversationId),
        )).limit(1);
      return saved
        ? { conversationId, lastReadAt: iso(saved.lastReadAt), lastReadMessageId: saved.lastReadMessageId }
        : { conversationId, lastReadAt: targetAt, lastReadMessageId: targetId };
    });
  }

  async getUnreadCounts(userId: string): Promise<Record<string, number>> {
    const rows = await this.db
      .select({
        conversationId: messages.conversationId,
        count: sql<number>`count(*)::int`,
      })
      .from(messages)
      .innerJoin(
        conversations,
        and(eq(conversations.id, messages.conversationId), eq(conversations.userId, messages.userId)),
      )
      .leftJoin(
        conversationReads,
        and(
          eq(conversationReads.userId, messages.userId),
          eq(conversationReads.conversationId, messages.conversationId),
        ),
      )
      .where(and(
        eq(messages.userId, userId),
        eq(messages.senderType, "bot"),
        or(
          isNull(conversationReads.lastReadAt),
          sql`(${messages.createdAt}, ${messages.id}) > (${conversationReads.lastReadAt}, coalesce(${conversationReads.lastReadMessageId}, ''))`,
        ),
      ))
      .groupBy(messages.conversationId);

    const counts: Record<string, number> = {};
    for (const row of rows) {
      const count = Number(row.count);
      if (count > 0) counts[row.conversationId] = count;
    }
    return counts;
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
    const [row] = await this.db.insert(pendingActions).values({
      ...input,
      id: `approval_${crypto.randomUUID()}`,
      runId: input.runId ?? null,
      providerApprovalId: input.providerApprovalId ?? null,
    }).returning();
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

  private async createAutomationTask(input: NewAutomationTask): Promise<AutomationTask> {
    const [row] = await this.db.insert(automationTasks).values({
      ...input,
      id: `auto_${crypto.randomUUID()}`,
      status: input.status ?? "active",
      lastOccurredAt: null,
      lastError: null,
      attempts: 0,
      claimedAt: null,
    }).returning();
    if (!row) throw new Error("Could not create automation.");
    return toAutomationTask(row);
  }

  private async listAutomationTasks(userId: string): Promise<AutomationTask[]> {
    const rows = await this.db.select().from(automationTasks)
      .where(eq(automationTasks.userId, userId))
      .orderBy(desc(automationTasks.createdAt));
    return rows.map(toAutomationTask);
  }

  private async getAutomationTask(userId: string, taskId: string): Promise<AutomationTask | null> {
    const [row] = await this.db.select().from(automationTasks)
      .where(and(eq(automationTasks.userId, userId), eq(automationTasks.id, taskId)))
      .limit(1);
    return row ? toAutomationTask(row) : null;
  }

  private async updateAutomationTask(
    userId: string,
    taskId: string,
    patch: AutomationTaskPatch,
    expectedRevision?: number,
  ): Promise<AutomationTask | null> {
    const conditions = [eq(automationTasks.userId, userId), eq(automationTasks.id, taskId)];
    if (expectedRevision !== undefined) {
      conditions.push(eq(automationTasks.revision, expectedRevision));
    }
    const [row] = await this.db.update(automationTasks)
      .set({
        ...patch,
        revision: sql`${automationTasks.revision} + 1`,
        updatedAt: new Date().toISOString(),
      })
      .where(and(...conditions))
      .returning();
    return row ? toAutomationTask(row) : null;
  }

  private async deleteAutomationTask(userId: string, taskId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(automationOccurrences)
        .where(and(eq(automationOccurrences.userId, userId), eq(automationOccurrences.taskId, taskId)));
      await tx.delete(automationTasks)
        .where(and(eq(automationTasks.userId, userId), eq(automationTasks.id, taskId)));
    });
  }

  private async claimDueAutomationTasks(
    input: ClaimDueAutomationTasksInput,
  ): Promise<AutomationTask[]> {
    const at = input.now;
    const limit = input.limit ?? 25;
    const leaseCutoff = new Date(Date.parse(at) - AUTOMATION_CLAIM_LEASE_MS).toISOString();
    return this.db.transaction<AutomationTask[]>(async (tx) => {
      const rows = await tx.select().from(automationTasks)
        .where(and(
          eq(automationTasks.status, "active"),
          lte(automationTasks.nextDueAt, at),
          or(isNull(automationTasks.claimedAt), lt(automationTasks.claimedAt, leaseCutoff)),
        ))
        .orderBy(automationTasks.nextDueAt)
        .limit(limit)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.id);
      await tx.update(automationTasks)
        .set({
          claimedAt: at,
          revision: sql`${automationTasks.revision} + 1`,
          updatedAt: at,
        })
        .where(inArray(automationTasks.id, ids));
      return rows.map((row) =>
        toAutomationTask({ ...row, claimedAt: at, revision: row.revision + 1, updatedAt: at }),
      );
    });
  }

  private async admitAutomationOccurrence(
    input: AdmitAutomationOccurrenceInput,
  ): Promise<{ occurrence: AutomationOccurrence; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const [inserted] = await tx.insert(automationOccurrences).values({
        id: `occ_${crypto.randomUUID()}`,
        taskId: input.taskId,
        userId: input.userId,
        occurrenceAt: input.occurrenceAt,
        executionId: input.executionId,
        runId: null,
        workflowRunId: null,
        status: "queued",
        error: null,
        createdAt: input.now,
        updatedAt: input.now,
      }).onConflictDoNothing().returning();
      if (inserted) return { occurrence: toAutomationOccurrence(inserted), created: true };

      const [existing] = await tx.select().from(automationOccurrences)
        .where(eq(automationOccurrences.executionId, input.executionId))
        .limit(1);
      if (!existing) throw new Error("Could not admit automation occurrence.");
      return { occurrence: toAutomationOccurrence(existing), created: false };
    });
  }

  private async completeAutomationOccurrence(
    input: CompleteAutomationOccurrenceInput,
  ): Promise<AutomationOccurrence | null> {
    return this.db.transaction(async (tx) => {
      const [occurrence] = await tx.update(automationOccurrences)
        .set({
          status: input.occurrenceStatus,
          ...(input.runId !== undefined ? { runId: input.runId } : {}),
          ...(input.workflowRunId !== undefined ? { workflowRunId: input.workflowRunId } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
          updatedAt: input.now,
        })
        .where(and(
          eq(automationOccurrences.userId, input.userId),
          eq(automationOccurrences.id, input.occurrenceId),
        ))
        .returning();
      if (!occurrence) return null;

      const taskConditions = [
        eq(automationTasks.userId, input.userId),
        eq(automationTasks.id, input.taskId),
      ];
      if (input.expectedRevision !== undefined) {
        taskConditions.push(eq(automationTasks.revision, input.expectedRevision));
      }
      await tx.update(automationTasks)
        .set({
          ...(input.taskStatus !== undefined ? { status: input.taskStatus } : {}),
          ...(input.nextDueAt !== undefined ? { nextDueAt: input.nextDueAt } : {}),
          ...(input.lastOccurredAt !== undefined ? { lastOccurredAt: input.lastOccurredAt } : {}),
          ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
          ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
          claimedAt: null,
          revision: sql`${automationTasks.revision} + 1`,
          updatedAt: input.now,
        })
        .where(and(...taskConditions));
      return toAutomationOccurrence(occurrence);
    });
  }

  private async updateAutomationOccurrence(
    userId: string,
    occurrenceId: string,
    patch: AutomationOccurrencePatch,
  ): Promise<AutomationOccurrence | null> {
    const [row] = await this.db.update(automationOccurrences)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(and(
        eq(automationOccurrences.userId, userId),
        eq(automationOccurrences.id, occurrenceId),
      ))
      .returning();
    return row ? toAutomationOccurrence(row) : null;
  }

  private async listAutomationOccurrences(
    userId: string,
    taskId: string,
  ): Promise<AutomationOccurrence[]> {
    const rows = await this.db.select().from(automationOccurrences)
      .where(and(
        eq(automationOccurrences.userId, userId),
        eq(automationOccurrences.taskId, taskId),
      ))
      .orderBy(desc(automationOccurrences.occurrenceAt));
    return rows.map(toAutomationOccurrence);
  }

  private async listOpenAutomationOccurrences(limit = 50): Promise<AutomationOccurrence[]> {
    const rows = await this.db.select().from(automationOccurrences)
      .where(and(
        isNotNull(automationOccurrences.runId),
        inArray(automationOccurrences.status, ["queued", "running", "awaiting_approval"]),
      ))
      .orderBy(automationOccurrences.updatedAt)
      .limit(limit);
    return rows.map(toAutomationOccurrence);
  }

  private async listPendingAutomationOccurrences(limit = 50): Promise<AutomationOccurrence[]> {
    const rows = await this.db.select().from(automationOccurrences)
      .where(and(
        isNull(automationOccurrences.runId),
        eq(automationOccurrences.status, "queued"),
      ))
      .orderBy(automationOccurrences.occurrenceAt)
      .limit(limit);
    return rows.map(toAutomationOccurrence);
  }

  private async listOpenAutomationOccurrencesForTask(
    userId: string,
    taskId: string,
  ): Promise<AutomationOccurrence[]> {
    const rows = await this.db.select().from(automationOccurrences)
      .where(and(
        eq(automationOccurrences.userId, userId),
        eq(automationOccurrences.taskId, taskId),
        inArray(automationOccurrences.status, ["queued", "running", "awaiting_approval"]),
      ))
      .orderBy(automationOccurrences.occurrenceAt);
    return rows.map(toAutomationOccurrence);
  }

  private async claimRun(input: ClaimRunInput): Promise<ClaimRunResult> {
    if (input.kind === "message") return this.claimMessageRun(input);
    if (input.kind === "approval") return this.claimApprovalRun(input);
    return this.claimScheduledRun(input);
  }

  private async claimMessageRun(input: ClaimMessageRunInput): Promise<ClaimRunResult> {
    return this.db.transaction<ClaimRunResult>(async (tx) => {
      const [conversation] = await tx.select().from(conversations)
        .where(and(eq(conversations.userId, input.userId), eq(conversations.id, input.conversationId)))
        .for("update").limit(1);
      if (!conversation) throw new StoreDomainError("not_found", "Conversation not found.");

      if (input.idempotencyKey) {
        const [claim] = await tx.select().from(runClaims)
          .where(and(eq(runClaims.userId, input.userId), eq(runClaims.idempotencyKey, input.idempotencyKey)))
          .limit(1);
        const [run] = claim
          ? await tx.select().from(runs).where(eq(runs.id, claim.runId)).limit(1)
          : await tx.select().from(runs)
              .where(and(eq(runs.userId, input.userId), eq(runs.idempotencyKey, input.idempotencyKey)))
              .limit(1);
        if (run) {
          assertIdempotentRunMatches(toRun(run), input);
          const message = run.messageId
            ? (await tx.select().from(messages).where(eq(messages.id, run.messageId)).limit(1))[0]
            : undefined;
          return { outcome: "claimed", run: toRun(run), message: message ? toMessage(message) : null, action: null };
        }
      }

      const [active] = await tx.select().from(runs)
        .where(and(eq(runs.conversationId, input.conversationId), inArray(runs.status, ACTIVE_RUN_STATUSES)))
        .limit(1);
      if (active) return { outcome: "busy", run: toRun(active) };

      const botId = conversation.botIds[0];
      if (!botId) throw new StoreDomainError("not_found", "Conversation has no bot.");

      const timestamp = input.now ?? new Date().toISOString();
      const messageId = `msg_${crypto.randomUUID()}`;
      const [messageRow] = await tx.insert(messages).values({
        id: messageId,
        conversationId: input.conversationId,
        userId: input.userId,
        senderType: input.message.senderType,
        senderId: input.message.senderId,
        content: input.message.content,
        status: input.message.status ?? "complete",
        error: input.message.error ?? null,
      }).returning();
      if (!messageRow) throw new Error("Could not save message.");

      const runId = `run_${crypto.randomUUID()}`;
      const [runRow] = await tx.insert(runs).values({
        id: runId,
        userId: input.userId,
        conversationId: input.conversationId,
        botId,
        status: "queued",
        trigger: { kind: "message", ...(input.trigger ?? {}) } as RunTrigger,
        attempt: 0,
        fence: 0,
        idempotencyKey: input.idempotencyKey ?? null,
        messageId,
        actionId: null,
        workflowRunId: null,
        outputMessageId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        error: null,
      }).returning();
      if (!runRow) throw new Error("Could not create run.");

      await upsertStartHandoffTimer(tx, {
        userId: input.userId,
        runId,
        timestamp,
      });

      await tx.update(conversations)
        .set({ activeRunId: runId, runStatus: "queued", updatedAt: timestamp })
        .where(eq(conversations.id, input.conversationId));

      if (input.idempotencyKey) {
        await tx.insert(runClaims).values({ userId: input.userId, idempotencyKey: input.idempotencyKey, runId });
      }

      return { outcome: "claimed", run: toRun(runRow), message: toMessage(messageRow), action: null };
    });
  }

  private async claimApprovalRun(input: ClaimApprovalRunInput): Promise<ClaimRunResult> {
    return this.db.transaction<ClaimRunResult>(async (tx) => {
      const [conversation] = await tx.select().from(conversations)
        .where(and(eq(conversations.userId, input.userId), eq(conversations.id, input.conversationId)))
        .for("update").limit(1);
      if (!conversation) throw new StoreDomainError("not_found", "Conversation not found.");

      if (input.idempotencyKey) {
        const [claim] = await tx.select().from(runClaims)
          .where(and(eq(runClaims.userId, input.userId), eq(runClaims.idempotencyKey, input.idempotencyKey)))
          .limit(1);
        if (claim) {
          const [run] = await tx.select().from(runs).where(eq(runs.id, claim.runId)).limit(1);
          if (run) {
            assertIdempotentRunMatches(toRun(run), input);
            const action = run.actionId
              ? (await tx.select().from(pendingActions).where(eq(pendingActions.id, run.actionId)).limit(1))[0]
              : undefined;
            return { outcome: "claimed", run: toRun(run), message: null, action: action ? toPendingAction(action) : null };
          }
        }
      }

      const [actionRow] = await tx.select().from(pendingActions)
        .where(and(
          eq(pendingActions.userId, input.userId),
          eq(pendingActions.conversationId, input.conversationId),
          eq(pendingActions.id, input.actionId),
        ))
        .for("update").limit(1);
      if (!actionRow || actionRow.status !== "pending") return { outcome: "approval_missing" };

      const [runRow] = actionRow.runId
        ? await tx.select().from(runs).where(eq(runs.id, actionRow.runId)).for("update").limit(1)
        : [];
      if (!runRow) return { outcome: "approval_missing" };

      if (runRow.status !== "awaiting_approval") {
        return isActiveRunStatus(runRow.status)
          ? { outcome: "busy", run: toRun(runRow) }
          : { outcome: "cancelled" };
      }
      if (conversation.activeRunId !== runRow.id) return { outcome: "cancelled" };

      const timestamp = input.now ?? new Date().toISOString();
      const botId = conversation.botIds[0] ?? runRow.botId;
      let updatedRun: typeof runs.$inferSelect | undefined;
      let updatedAction: typeof pendingActions.$inferSelect | undefined;

      if (input.decision === "approve") {
        [updatedRun] = await tx.update(runs)
          .set({ status: "queued", attempt: runRow.attempt + 1, fence: runRow.fence + 1, actionId: actionRow.id, botId, updatedAt: timestamp })
          .where(eq(runs.id, runRow.id)).returning();
        [updatedAction] = await tx.update(pendingActions)
          .set({ status: "resuming" })
          .where(eq(pendingActions.id, actionRow.id)).returning();
        await upsertStartHandoffTimer(tx, {
          userId: input.userId,
          runId: runRow.id,
          timestamp,
        });
        await tx.update(conversations)
          .set({ activeRunId: runRow.id, runStatus: "queued", updatedAt: timestamp })
          .where(eq(conversations.id, input.conversationId));
      } else {
        [updatedRun] = await tx.update(runs)
          .set({ status: "cancelled", fence: runRow.fence + 1, actionId: actionRow.id, botId, updatedAt: timestamp })
          .where(eq(runs.id, runRow.id)).returning();
        [updatedAction] = await tx.update(pendingActions)
          .set({ status: "cancelled" })
          .where(eq(pendingActions.id, actionRow.id)).returning();
        await tx.update(conversations)
          .set({ activeRunId: null, runStatus: "idle", updatedAt: timestamp })
          .where(eq(conversations.id, input.conversationId));
        await tx.insert(messages).values({
          id: `msg_${crypto.randomUUID()}`,
          conversationId: input.conversationId,
          userId: input.userId,
          senderType: "system",
          senderId: "system",
          content: `Approval denied: ${actionRow.summary}`,
          status: "complete",
          error: null,
        });
        await this.appendEventTx(tx, runRow.id, "approval_denied", { actionId: actionRow.id, summary: actionRow.summary }, null, timestamp);
      }

      if (input.idempotencyKey) {
        await tx.insert(runClaims).values({ userId: input.userId, idempotencyKey: input.idempotencyKey, runId: runRow.id });
      }

      if (!updatedRun) throw new Error("Could not resolve approval.");
      return {
        outcome: "claimed",
        run: toRun(updatedRun),
        message: null,
        action: updatedAction ? toPendingAction(updatedAction) : null,
      };
    });
  }

  private async claimScheduledRun(input: ClaimScheduledRunInput): Promise<ClaimRunResult> {
    return this.db.transaction<ClaimRunResult>(async (tx) => {
      const [conversation] = await tx.select().from(conversations)
        .where(and(eq(conversations.userId, input.userId), eq(conversations.id, input.conversationId)))
        .for("update").limit(1);
      if (!conversation) throw new StoreDomainError("not_found", "Conversation not found.");

      if (input.idempotencyKey) {
        const [claim] = await tx.select().from(runClaims)
          .where(and(eq(runClaims.userId, input.userId), eq(runClaims.idempotencyKey, input.idempotencyKey)))
          .limit(1);
        const [run] = claim
          ? await tx.select().from(runs).where(eq(runs.id, claim.runId)).limit(1)
          : await tx.select().from(runs)
              .where(and(eq(runs.userId, input.userId), eq(runs.idempotencyKey, input.idempotencyKey)))
              .limit(1);
        if (run) {
          assertIdempotentRunMatches(toRun(run), input);
          return { outcome: "claimed", run: toRun(run), message: null, action: null };
        }
      }

      const [active] = await tx.select().from(runs)
        .where(and(eq(runs.conversationId, input.conversationId), inArray(runs.status, ACTIVE_RUN_STATUSES)))
        .limit(1);
      if (active) return { outcome: "busy", run: toRun(active) };

      const botId = conversation.botIds[0];
      if (!botId) throw new StoreDomainError("not_found", "Conversation has no bot.");

      const timestamp = input.now ?? new Date().toISOString();
      const runId = `run_${crypto.randomUUID()}`;
      const [runRow] = await tx.insert(runs).values({
        id: runId,
        userId: input.userId,
        conversationId: input.conversationId,
        botId,
        status: "queued",
        trigger: { kind: "scheduled", ...input.trigger } as RunTrigger,
        attempt: 0,
        fence: 0,
        idempotencyKey: input.idempotencyKey ?? null,
        messageId: null,
        actionId: null,
        workflowRunId: null,
        outputMessageId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        error: null,
      }).returning();
      if (!runRow) throw new Error("Could not create run.");

      await upsertStartHandoffTimer(tx, {
        userId: input.userId,
        runId,
        timestamp,
      });

      await tx.update(conversations)
        .set({ activeRunId: runId, runStatus: "queued", updatedAt: timestamp })
        .where(eq(conversations.id, input.conversationId));

      if (input.idempotencyKey) {
        await tx.insert(runClaims).values({ userId: input.userId, idempotencyKey: input.idempotencyKey, runId });
      }

      return { outcome: "claimed", run: toRun(runRow), message: null, action: null };
    });
  }

  private async getRun(userId: string, runId: string): Promise<Run | null> {
    const [row] = await this.db.select().from(runs)
      .where(and(eq(runs.userId, userId), eq(runs.id, runId))).limit(1);
    return row ? toRun(row) : null;
  }

  private async listRuns(input: ListRunsInput): Promise<Run[]> {
    const conditions = [eq(runs.userId, input.userId)];
    if (input.conversationId) conditions.push(eq(runs.conversationId, input.conversationId));
    if (input.statuses && input.statuses.length > 0) conditions.push(inArray(runs.status, input.statuses));
    if (input.createdBefore) conditions.push(lt(runs.createdAt, input.createdBefore));
    const rows = await this.db.select().from(runs)
      .where(and(...conditions))
      .orderBy(desc(runs.createdAt))
      .limit(input.limit ?? 50);
    return rows.map(toRun);
  }

  private async transitionRun(input: TransitionRunInput): Promise<TransitionRunResult> {
    return this.db.transaction<TransitionRunResult>(async (tx) => {
      const [pre] = await tx.select({ conversationId: runs.conversationId }).from(runs)
        .where(and(eq(runs.userId, input.userId), eq(runs.id, input.runId))).limit(1);
      if (!pre) return { outcome: "stale" };

      // Lock the conversation before the run to match claim ordering and avoid deadlocks.
      const [conversation] = await tx.select().from(conversations)
        .where(eq(conversations.id, pre.conversationId)).for("update").limit(1);
      const [runRow] = await tx.select().from(runs)
        .where(eq(runs.id, input.runId)).for("update").limit(1);
      if (!runRow) return { outcome: "stale" };
      if (runRow.status !== input.expectedStatus || runRow.fence !== input.expectedFence) {
        return { outcome: "stale" };
      }

      const timestamp = new Date().toISOString();
      const [updated] = await tx.update(runs)
        .set({
          status: input.status,
          fence: runRow.fence + 1,
          error: input.error !== undefined ? input.error : runRow.error,
          ...(input.botId !== undefined ? { botId: input.botId } : {}),
          ...(input.workflowRunId !== undefined ? { workflowRunId: input.workflowRunId } : {}),
          ...(input.outputMessageId !== undefined ? { outputMessageId: input.outputMessageId } : {}),
          ...(input.leaseOwner !== undefined ? { leaseOwner: input.leaseOwner } : {}),
          ...(input.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
          updatedAt: timestamp,
        })
        .where(and(eq(runs.id, runRow.id), eq(runs.status, input.expectedStatus), eq(runs.fence, input.expectedFence)))
        .returning();
      if (!updated) return { outcome: "stale" };

      if (conversation && conversation.activeRunId === runRow.id) {
        const projection = conversationProjectionFor(input.status);
        await tx.update(conversations)
          .set({
            runStatus: projection.runStatus,
            activeRunId: projection.active ? runRow.id : null,
            updatedAt: timestamp,
          })
          .where(eq(conversations.id, runRow.conversationId));
      }

      if (input.action) {
        const actionUpdate = input.action;
        await tx.update(pendingActions)
          .set({ status: actionUpdate.status })
          .where(and(eq(pendingActions.userId, input.userId), eq(pendingActions.id, actionUpdate.id)));
      }

      if (input.timers) {
        for (const patch of input.timers) {
          await tx.update(runTimers)
            .set({ status: patch.status })
            .where(and(eq(runTimers.runId, runRow.id), eq(runTimers.kind, patch.kind)));
        }
      }

      const event = input.event
        ? await this.appendEventTx(tx, runRow.id, input.event.type, input.event.data ?? null, input.event.dedupeKey ?? null, timestamp)
        : null;

      return { outcome: "applied", run: toRun(updated), event };
    });
  }

  private async completeWithMessage(
    input: CompleteRunWithMessageInput,
  ): Promise<CompleteRunWithMessageResult> {
    return this.db.transaction<CompleteRunWithMessageResult>(async (tx) => {
      const [pre] = await tx.select({ conversationId: runs.conversationId }).from(runs)
        .where(and(eq(runs.userId, input.userId), eq(runs.id, input.runId))).limit(1);
      if (!pre) return { outcome: "stale" };

      // Lock the conversation before the run to match claim ordering and avoid deadlocks.
      const [conversation] = await tx.select().from(conversations)
        .where(eq(conversations.id, pre.conversationId)).for("update").limit(1);
      const [runRow] = await tx.select().from(runs)
        .where(eq(runs.id, input.runId)).for("update").limit(1);
      if (!runRow) return { outcome: "stale" };

      if (runRow.status === "succeeded" && runRow.outputMessageId) {
        const [existing] = await tx.select().from(messages)
          .where(eq(messages.id, runRow.outputMessageId)).limit(1);
        if (existing) {
          return { outcome: "idempotent", run: toRun(runRow), message: toMessage(existing) };
        }
      }
      if (runRow.status !== input.expectedStatus || runRow.fence !== input.expectedFence) {
        return { outcome: "stale" };
      }

      // Reuse an already-persisted bot output for this run instead of inserting
      // a duplicate. The partial unique index is the final backstop.
      let [messageRow] = await tx.select().from(messages)
        .where(and(eq(messages.runId, runRow.id), eq(messages.senderType, "bot"))).limit(1);
      if (!messageRow) {
        [messageRow] = await tx.insert(messages).values({
          id: `msg_${crypto.randomUUID()}`,
          conversationId: runRow.conversationId,
          userId: input.userId,
          senderType: "bot",
          senderId: runRow.botId,
          content: input.content,
          status: "complete",
          error: null,
          runId: runRow.id,
        }).onConflictDoNothing().returning();
        if (!messageRow) {
          [messageRow] = await tx.select().from(messages)
            .where(and(eq(messages.runId, runRow.id), eq(messages.senderType, "bot"))).limit(1);
        }
      }
      if (!messageRow) throw new Error("Could not save bot message.");

      const timestamp = new Date().toISOString();
      const [updated] = await tx.update(runs)
        .set({
          status: "succeeded",
          fence: runRow.fence + 1,
          outputMessageId: messageRow.id,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: timestamp,
        })
        .where(and(
          eq(runs.id, runRow.id),
          eq(runs.status, input.expectedStatus),
          eq(runs.fence, input.expectedFence),
        ))
        .returning();
      // The row is locked and was checked above, so a miss is an internal
      // inconsistency. Throw so the message insert rolls back with it.
      if (!updated) throw new Error("Run changed during completion.");

      if (conversation) {
        const projection = conversationProjectionFor("succeeded");
        await tx.update(conversations)
          .set({
            ...(conversation.activeRunId === runRow.id
              ? {
                  runStatus: projection.runStatus,
                  activeRunId: projection.active ? runRow.id : null,
                }
              : {}),
            updatedAt: timestamp,
          })
          .where(eq(conversations.id, runRow.conversationId));
      }

      if (input.action) {
        await tx.update(pendingActions)
          .set({ status: input.action.status })
          .where(and(eq(pendingActions.userId, input.userId), eq(pendingActions.id, input.action.id)));
      }

      if (input.timers) {
        for (const patch of input.timers) {
          await tx.update(runTimers)
            .set({ status: patch.status })
            .where(and(eq(runTimers.runId, runRow.id), eq(runTimers.kind, patch.kind)));
        }
      }

      const event = input.event
        ? await this.appendEventTx(
            tx,
            runRow.id,
            input.event.type,
            eventDataWithMessageId(input.event.data, messageRow.id),
            input.event.dedupeKey ?? null,
            timestamp,
          )
        : null;

      return { outcome: "applied", run: toRun(updated), message: toMessage(messageRow), event };
    });
  }

  private async appendEvent(input: {
    userId: string;
    runId: string;
    type: string;
    data?: unknown;
    dedupeKey?: string;
  }): Promise<RunEvent> {
    return this.db.transaction(async (tx) => {
      const [run] = await tx.select({ id: runs.id }).from(runs)
        .where(and(eq(runs.userId, input.userId), eq(runs.id, input.runId)))
        .for("update").limit(1);
      if (!run) throw new Error("Run not found.");
      return this.appendEventTx(tx, input.runId, input.type, input.data ?? null, input.dedupeKey ?? null, new Date().toISOString());
    });
  }

  private async appendEventTx(
    tx: Tx,
    runId: string,
    type: string,
    data: unknown,
    dedupeKey: string | null,
    timestamp: string,
  ): Promise<RunEvent> {
    if (dedupeKey) {
      const [existing] = await tx.select().from(runEvents)
        .where(and(eq(runEvents.runId, runId), eq(runEvents.dedupeKey, dedupeKey))).limit(1);
      if (existing) return toRunEvent(existing);
    }
    const [maxRow] = await tx.select({ max: sql<number>`coalesce(max(${runEvents.seq}), 0)` })
      .from(runEvents).where(eq(runEvents.runId, runId));
    const seq = Number(maxRow?.max ?? 0) + 1;
    const [row] = await tx.insert(runEvents).values({
      id: `evt_${crypto.randomUUID()}`,
      runId,
      seq,
      type,
      data,
      dedupeKey,
      createdAt: timestamp,
    }).returning();
    if (!row) throw new Error("Could not append run event.");
    return toRunEvent(row);
  }

  private async listEvents(userId: string, runId: string): Promise<RunEvent[]> {
    const [run] = await this.db.select({ id: runs.id }).from(runs)
      .where(and(eq(runs.userId, userId), eq(runs.id, runId))).limit(1);
    if (!run) return [];
    const rows = await this.db.select().from(runEvents)
      .where(eq(runEvents.runId, runId)).orderBy(runEvents.seq);
    return rows.map(toRunEvent);
  }

  private async upsertTimer(input: {
    userId: string;
    runId: string;
    kind: string;
    dueAt: string;
  }): Promise<RunTimer> {
    return this.db.transaction(async (tx) => {
      const [run] = await tx.select({ id: runs.id }).from(runs)
        .where(and(eq(runs.userId, input.userId), eq(runs.id, input.runId))).limit(1);
      if (!run) throw new Error("Run not found.");
      const [row] = await tx.insert(runTimers).values({
        id: `timer_${crypto.randomUUID()}`,
        userId: input.userId,
        runId: input.runId,
        kind: input.kind,
        dueAt: input.dueAt,
        status: "pending",
        claimedAt: null,
      }).onConflictDoUpdate({
        target: [runTimers.runId, runTimers.kind],
        set: { dueAt: input.dueAt, status: "pending", claimedAt: null },
      }).returning();
      if (!row) throw new Error("Could not upsert timer.");
      return toRunTimer(row);
    });
  }

  private async claimDueTimers(input: { now?: string; limit?: number } = {}): Promise<RunTimer[]> {
    const at = input.now ?? new Date().toISOString();
    const limit = input.limit ?? 50;
    return this.db.transaction<RunTimer[]>(async (tx) => {
      const rows = await tx.select().from(runTimers)
        .where(and(eq(runTimers.status, "pending"), lte(runTimers.dueAt, at)))
        .orderBy(runTimers.dueAt)
        .limit(limit)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return [];

      const runIds = [...new Set(rows.map((row) => row.runId))];
      const runRows = await tx.select({ id: runs.id, status: runs.status }).from(runs)
        .where(inArray(runs.id, runIds));
      const statusById = new Map(runRows.map((row) => [row.id, row.status]));

      const activeIds: string[] = [];
      const inactiveIds: string[] = [];
      for (const row of rows) {
        const status = statusById.get(row.runId);
        if (status && isActiveRunStatus(status)) activeIds.push(row.id);
        else inactiveIds.push(row.id);
      }

      if (inactiveIds.length > 0) {
        // Never let a stale lease/approval timer resurrect a terminal run.
        await tx.update(runTimers)
          .set({ status: "cancelled", claimedAt: at })
          .where(inArray(runTimers.id, inactiveIds));
      }
      if (activeIds.length > 0) {
        await tx.update(runTimers)
          .set({ status: "claimed", claimedAt: at })
          .where(inArray(runTimers.id, activeIds));
      }

      const active = new Set(activeIds);
      return rows
        .filter((row) => active.has(row.id))
        .map((row) => toRunTimer({ ...row, status: "claimed", claimedAt: at }));
    });
  }

  private async releaseRunTimer(input: ReleaseRunTimerInput): Promise<void> {
    const at = input.now ?? new Date().toISOString();
    const retryAfterMs = Math.max(1_000, input.retryAfterMs ?? 30_000);
    const dueAt = new Date(Date.parse(at) + retryAfterMs).toISOString();
    await this.db.transaction(async (tx) => {
      const [timer] = await tx.select().from(runTimers)
        .where(and(eq(runTimers.id, input.timerId), eq(runTimers.status, "claimed")))
        .for("update").limit(1);
      if (!timer) return;
      const [run] = await tx.select({ status: runs.status }).from(runs)
        .where(eq(runs.id, timer.runId)).limit(1);
      if (!run || !isActiveRunStatus(run.status)) {
        // A terminal run must never be resurrected by a retried timer.
        await tx.update(runTimers)
          .set({ status: "cancelled", claimedAt: null })
          .where(eq(runTimers.id, timer.id));
        return;
      }
      await tx.update(runTimers)
        .set({ status: "pending", claimedAt: null, dueAt })
        .where(eq(runTimers.id, timer.id));
    });
  }

  private async listRecoverableRuns(input: ListRecoverableRunsInput): Promise<Run[]> {
    const rows = await this.db.select().from(runs)
      .where(and(
        inArray(runs.status, ACTIVE_RUN_STATUSES),
        isNotNull(runs.leaseExpiresAt),
        lte(runs.leaseExpiresAt, input.now),
      ))
      .orderBy(runs.leaseExpiresAt)
      .limit(input.limit ?? 50);
    return rows.map(toRun);
  }
}

async function upsertStartHandoffTimer(
  tx: Tx,
  input: { userId: string; runId: string; timestamp: string },
): Promise<void> {
  const dueAt = new Date(Date.parse(input.timestamp) + START_HANDOFF_MS).toISOString();
  await tx.insert(runTimers).values({
    id: `timer_${crypto.randomUUID()}`,
    userId: input.userId,
    runId: input.runId,
    kind: "start_handoff",
    dueAt,
    status: "pending",
    claimedAt: null,
  }).onConflictDoUpdate({
    target: [runTimers.runId, runTimers.kind],
    set: { dueAt, status: "pending", claimedAt: null },
  });
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

function assertIdempotentRunMatches(run: Run, input: ClaimRunInput): void {
  if (run.conversationId !== input.conversationId) {
    throw new StoreDomainError(
      "conflict",
      "This idempotency key was already used for a different conversation.",
    );
  }
  if (input.kind === "approval") {
    if (run.actionId !== input.actionId) {
      throw new StoreDomainError(
        "conflict",
        "This idempotency key was already used for a different approval.",
      );
    }
    return;
  }
  if (run.trigger.kind !== input.kind) {
    throw new StoreDomainError(
      "conflict",
      "This idempotency key was already used for a different request.",
    );
  }
}

function compareReadPosition(
  aAt: string,
  aId: string | null,
  bAt: string,
  bId: string | null,
): number {
  const byTime = aAt.localeCompare(bAt);
  if (byTime !== 0) return byTime;
  return (aId ?? "").localeCompare(bId ?? "");
}

function eventDataWithMessageId(data: unknown, messageId: string): Record<string, unknown> {
  const base =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  return { ...base, messageId };
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
    runId: row.runId,
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
    runId: row.runId,
    providerApprovalId: row.providerApprovalId,
    createdAt: iso(row.createdAt),
  };
}

function toRun(row: typeof runs.$inferSelect): Run {
  return {
    id: row.id,
    userId: row.userId,
    conversationId: row.conversationId,
    botId: row.botId,
    status: row.status as RunStatus,
    trigger: row.trigger,
    attempt: row.attempt,
    fence: row.fence,
    idempotencyKey: row.idempotencyKey,
    messageId: row.messageId,
    actionId: row.actionId,
    workflowRunId: row.workflowRunId,
    outputMessageId: row.outputMessageId,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt ? iso(row.leaseExpiresAt) : null,
    error: row.error,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toRunEvent(row: typeof runEvents.$inferSelect): RunEvent {
  return {
    id: row.id,
    runId: row.runId,
    seq: row.seq,
    type: row.type,
    data: row.data,
    dedupeKey: row.dedupeKey,
    createdAt: iso(row.createdAt),
  };
}

function toRunTimer(row: typeof runTimers.$inferSelect): RunTimer {
  return {
    id: row.id,
    userId: row.userId,
    runId: row.runId,
    kind: row.kind,
    dueAt: iso(row.dueAt),
    status: row.status as RunTimer["status"],
    claimedAt: row.claimedAt ? iso(row.claimedAt) : null,
    createdAt: iso(row.createdAt),
  };
}

function toAutomationTask(row: typeof automationTasks.$inferSelect): AutomationTask {
  return {
    id: row.id,
    userId: row.userId,
    botId: row.botId,
    conversationId: row.conversationId,
    title: row.title,
    instructions: row.instructions,
    schedule: row.schedule,
    status: row.status,
    nextDueAt: row.nextDueAt ? iso(row.nextDueAt) : null,
    lastOccurredAt: row.lastOccurredAt ? iso(row.lastOccurredAt) : null,
    lastError: row.lastError,
    attempts: row.attempts,
    claimedAt: row.claimedAt ? iso(row.claimedAt) : null,
    revision: row.revision,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toAutomationOccurrence(
  row: typeof automationOccurrences.$inferSelect,
): AutomationOccurrence {
  return {
    id: row.id,
    taskId: row.taskId,
    userId: row.userId,
    occurrenceAt: iso(row.occurrenceAt),
    executionId: row.executionId,
    runId: row.runId,
    workflowRunId: row.workflowRunId,
    status: row.status,
    error: row.error,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
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
