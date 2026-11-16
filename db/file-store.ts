import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  botColor,
  DEFAULT_MODEL,
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
  type RunTimer,
  type RunTrigger,
  type User,
} from "@slopbot/contracts";
import { decryptSecret, encryptSecret } from "./crypto";
import { defaultApprovalExpiresAt, isPendingActionExpired } from "../apps/web/lib/server/tool-permissions";
import {
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
  type ClaimDesktopJobInput,
  type ClaimDueAutomationTasksInput,
  type ClaimMessageRunInput,
  type ClaimRunInput,
  type ClaimRunResult,
  type ClaimScheduledRunInput,
  type CompleteAutomationOccurrenceInput,
  type CompleteRunWithMessageInput,
  type CompleteRunWithMessageResult,
  type DesktopJob,
  type DesktopJobDelivery,
  type NewAutomationTask,
  type NewDesktopJob,
  type NewIntegration,
  type NewMessage,
  type NewPendingAction,
  type OAuthState,
  type PendingAction,
  type ListRecoverableRunsInput,
  type MemoryScope,
  type MemoryStore,
  type ReadStateStore,
  type ReleaseRunTimerInput,
  type RunStore,
  type TransitionRunInput,
  type TransitionRunResult,
  StoreDomainError,
} from "./types";
import type { IntegrationSecret } from "../apps/web/lib/server/mcp";
import {
  MemoryConflictError,
  type MemoryFile,
  type MemoryWritePlan,
} from "../apps/web/lib/server/memory-files";

type RunClaim = {
  userId: string;
  idempotencyKey: string;
  runId: string;
  createdAt: string;
};

type ConversationRead = ConversationReadState & { userId: string };

type ScopedMemoryFile = MemoryFile & {
  userId: string;
  conversationId: string;
  botId: string;
};

type FileState = {
  bots: Array<Bot & { userId: string }>;
  conversations: Array<Conversation & { userId: string }>;
  messages: Array<ChatMessage & { userId: string }>;
  readStates: ConversationRead[];
  integrations: Array<Integration & { userId: string }>;
  secrets: Record<string, string>;
  oauthStates: OAuthState[];
  desktopJobs: DesktopJob[];
  pendingActions: PendingAction[];
  runs: Run[];
  runEvents: RunEvent[];
  runTimers: RunTimer[];
  runClaims: RunClaim[];
  automationTasks: AutomationTask[];
  automationOccurrences: AutomationOccurrence[];
  memoryFiles: ScopedMemoryFile[];
};

/** A tick lease older than this may be reclaimed after a crashed tick. */
const AUTOMATION_CLAIM_LEASE_MS = 5 * 60 * 1000;

const now = () => new Date().toISOString();
const publicBot = ({ userId: _userId, ...bot }: Bot & { userId: string }): Bot => bot;
const publicConversation = ({ userId: _userId, ...item }: Conversation & { userId: string }): Conversation => item;
const publicMessage = ({ userId: _userId, ...item }: ChatMessage & { userId: string }): ChatMessage => item;
const publicIntegration = ({ userId: _userId, ...item }: Integration & { userId: string }): Integration => item;
const publicMemoryFile = ({
  userId: _userId,
  conversationId: _conversationId,
  botId: _botId,
  ...file
}: ScopedMemoryFile): MemoryFile => file;
const memoryInScope = (file: ScopedMemoryFile, scope: MemoryScope): boolean =>
  file.userId === scope.userId &&
  file.conversationId === scope.conversationId &&
  file.botId === scope.botId;

export class FileStore implements AppStore {
  private state: FileState | undefined;
  private writeChain: Promise<unknown> = Promise.resolve();

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

  readonly memory: MemoryStore = {
    list: (scope) => this.listMemory(scope),
    read: (scope, path) => this.readMemory(scope, path),
    apply: (scope, plan) => this.applyMemory(scope, plan),
    delete: (scope, paths) => this.deleteMemory(scope, paths),
  };

  constructor(private readonly file = resolve(process.cwd(), ".data", "store.json")) {}

  private async load(): Promise<FileState> {
    if (this.state) return this.state;
    try {
      this.state = JSON.parse(await readFile(this.file, "utf8")) as FileState;
      this.state.desktopJobs ??= [];
      this.state.desktopJobs = this.state.desktopJobs.map((job) => ({
        ...job,
        runId: job.runId ?? null,
        stepKey: job.stepKey ?? null,
        attempt: job.attempt ?? null,
        claimedBy: job.claimedBy ?? null,
        claimedAt: job.claimedAt ?? null,
        leaseExpiresAt: job.leaseExpiresAt ?? null,
        deliveryStatus: job.deliveryStatus ?? "pending",
        deliveryAttempts: job.deliveryAttempts ?? 0,
        deliveryError: job.deliveryError ?? null,
        deliveredAt: job.deliveredAt ?? null,
      }));
      this.state.pendingActions ??= [];
      this.state.readStates ??= [];
      this.state.runs ??= [];
      this.state.runEvents ??= [];
      this.state.runTimers ??= [];
      this.state.runClaims ??= [];
      this.state.automationTasks ??= [];
      this.state.automationOccurrences ??= [];
      this.state.memoryFiles ??= [];
      this.state.automationTasks = this.state.automationTasks.map((task) => ({
        ...task,
        status: task.status ?? "active",
        nextDueAt: task.nextDueAt ?? null,
        lastOccurredAt: task.lastOccurredAt ?? null,
        lastError: task.lastError ?? null,
        attempts: task.attempts ?? 0,
        claimedAt: task.claimedAt ?? null,
        revision: task.revision ?? 0,
      }));
      this.state.automationOccurrences = this.state.automationOccurrences.map((occurrence) => ({
        ...occurrence,
        runId: occurrence.runId ?? null,
        workflowRunId: occurrence.workflowRunId ?? null,
        error: occurrence.error ?? null,
      }));
      this.state.runs = this.state.runs.map((run) => ({
        ...run,
        botId: run.botId ?? "",
        workflowRunId: run.workflowRunId ?? null,
        outputMessageId: run.outputMessageId ?? null,
        leaseOwner: run.leaseOwner ?? null,
        leaseExpiresAt: run.leaseExpiresAt ?? null,
      }));
      this.state.pendingActions = this.state.pendingActions.map((action) => ({
        ...action,
        runId: action.runId ?? null,
        providerApprovalId: action.providerApprovalId ?? null,
        toolName: action.toolName ?? null,
        toolArgsRedacted: action.toolArgsRedacted ?? null,
        toolRisk: action.toolRisk ?? "read",
        idempotencyKey: action.idempotencyKey ?? null,
        expiresAt: action.expiresAt ?? null,
        integrationId: action.integrationId ?? null,
        integrationName: action.integrationName ?? null,
        argsDigest: action.argsDigest ?? null,
      }));
      this.state.integrations = this.state.integrations.map((integration) => ({
        ...integration,
        allowedWriteTools: integration.allowedWriteTools ?? [],
      }));
      this.state.messages = this.state.messages.map((message) => ({
        ...message,
        runId: message.runId ?? null,
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const createdAt = now();
      this.state = {
        bots: [
          {
            id: "bot_nova",
            userId: "demo-user",
            name: "Nova",
            handle: "nova",
            persona: "You are Nova, an optimistic product strategist. Give useful, concrete ideas and build on other bots' strongest points. Be concise and warmly opinionated.",
            model: DEFAULT_MODEL,
            color: "#ff6b35",
            integrationIds: [],
            createdAt,
          },
          {
            id: "bot_patch",
            userId: "demo-user",
            name: "Patch",
            handle: "patch",
            persona: "You are Patch, a pragmatic senior engineer. Find edge cases, challenge vague claims, and turn ideas into shippable steps. Be concise and constructive with other bots.",
            model: DEFAULT_MODEL,
            color: "#6c5ce7",
            integrationIds: [],
            createdAt,
          },
        ],
        conversations: [
          {
            id: "conv_nova",
            userId: "demo-user",
            title: "Nova",
            botIds: ["bot_nova"],
            activeRunId: null,
            runStatus: "idle",
            createdAt,
            updatedAt: createdAt,
          },
          {
            id: "conv_patch",
            userId: "demo-user",
            title: "Patch",
            botIds: ["bot_patch"],
            activeRunId: null,
            runStatus: "idle",
            createdAt,
            updatedAt: createdAt,
          },
        ],
        messages: [],
        readStates: [],
        integrations: [],
        secrets: {},
        oauthStates: [],
        desktopJobs: [],
        pendingActions: [],
        runs: [],
        runEvents: [],
        runTimers: [],
        runClaims: [],
        automationTasks: [],
        automationOccurrences: [],
        memoryFiles: [],
      };
      await this.persistState(this.state);
    }
    return this.state;
  }

  private async persistState(state: FileState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, this.file);
  }

  private async commit<T>(operation: (state: FileState) => T | Promise<T>): Promise<T> {
    const result = this.writeChain.then(async () => {
      const current = await this.load();
      // Copy-on-write: a failed persist must never mutate the live in-memory state.
      const draft = structuredClone(current);
      const value = await operation(draft);
      await this.persistState(draft);
      this.state = draft;
      return value;
    });
    this.writeChain = result.catch(() => undefined);
    return result;
  }

  async getUser(userId: string): Promise<User> {
    return { id: userId, name: userId === "demo-user" ? "Local human" : "Member", email: null, avatarUrl: null };
  }

  async listBots(userId: string): Promise<Bot[]> {
    return (await this.load()).bots.filter((bot) => bot.userId === userId).map(publicBot);
  }

  async getBot(userId: string, botId: string): Promise<Bot | null> {
    const bot = (await this.load()).bots.find((item) => item.userId === userId && item.id === botId);
    return bot ? publicBot(bot) : null;
  }

  async createBot(userId: string, input: CreateBotInput): Promise<Bot> {
    return this.commit((state) => {
      if (state.bots.some((bot) => bot.userId === userId && bot.handle === input.handle)) {
        throw new Error(`@${input.handle} is already in use.`);
      }
      const id = `bot_${randomUUID()}`;
      const bot = { ...input, id, userId, color: botColor(id), createdAt: now() };
      state.bots.push(bot);
      return publicBot(bot);
    });
  }

  async deleteBot(userId: string, botId: string): Promise<void> {
    await this.commit((state) => {
      state.bots = state.bots.filter((bot) => !(bot.userId === userId && bot.id === botId));
      // Remove this bot's scoped memory so it cannot outlive the bot. Global
      // instructions (empty botId) and other bots' scopes are preserved.
      if (botId) {
        state.memoryFiles = state.memoryFiles.filter(
          (file) => !(file.userId === userId && file.botId === botId),
        );
      }
      state.integrations.forEach((integration) => {
        if (integration.userId === userId) void integration;
      });
    });
  }

  async listConversations(userId: string): Promise<Conversation[]> {
    return (await this.load()).conversations
      .filter((item) => item.userId === userId)
      .map(publicConversation)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getConversation(userId: string, conversationId: string): Promise<Conversation | null> {
    const item = (await this.load()).conversations.find(
      (conversation) => conversation.userId === userId && conversation.id === conversationId,
    );
    return item ? publicConversation(item) : null;
  }

  async createConversation(userId: string, input: CreateConversationInput): Promise<Conversation> {
    return this.commit((state) => {
      const timestamp = now();
      const item: Conversation & { userId: string } = {
        ...input,
        id: `conv_${randomUUID()}`,
        userId,
        activeRunId: null,
        runStatus: "idle",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.conversations.push(item);
      return publicConversation(item);
    });
  }

  async setConversationRun(
    userId: string,
    conversationId: string,
    runId: string | null,
    status: Conversation["runStatus"],
  ): Promise<void> {
    await this.commit((state) => {
      const item = state.conversations.find(
        (conversation) => conversation.userId === userId && conversation.id === conversationId,
      );
      if (!item) throw new Error("Conversation not found.");
      item.activeRunId = runId;
      item.runStatus = status;
      item.updatedAt = now();
    });
  }

  async listMessages(userId: string, conversationId: string): Promise<ChatMessage[]> {
    return (await this.load()).messages
      .filter((message) => message.userId === userId && message.conversationId === conversationId)
      .map(publicMessage)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listBotPreviews(userId: string): Promise<BotPreview[]> {
    const latest = new Map<string, ChatMessage & { userId: string }>();
    for (const message of (await this.load()).messages) {
      if (message.userId !== userId || message.senderType !== "bot") continue;
      const current = latest.get(message.senderId);
      if (!current || message.createdAt.localeCompare(current.createdAt) > 0) {
        latest.set(message.senderId, message);
      }
    }
    return [...latest.values()].map(({ senderId, content, createdAt }) => ({
      botId: senderId,
      content,
      createdAt,
    }));
  }

  async addMessage(userId: string, input: NewMessage): Promise<ChatMessage> {
    return this.commit((state) => {
      const conversation = state.conversations.find(
        (item) => item.userId === userId && item.id === input.conversationId,
      );
      if (!conversation) throw new Error("Conversation not found.");
      const message: ChatMessage & { userId: string } = {
        ...input,
        id: `msg_${randomUUID()}`,
        userId,
        status: input.status ?? "complete",
        error: input.error ?? null,
        runId: null,
        createdAt: now(),
      };
      state.messages.push(message);
      conversation.updatedAt = message.createdAt;
      return publicMessage(message);
    });
  }

  async markRead(
    userId: string,
    conversationId: string,
    messageId?: string | null,
  ): Promise<ConversationReadState | null> {
    return this.commit((state) => {
      const conversation = state.conversations.find(
        (item) => item.userId === userId && item.id === conversationId,
      );
      if (!conversation) return null;

      let targetAt: string;
      let targetId: string | null;
      if (messageId) {
        const message = state.messages.find(
          (item) =>
            item.userId === userId &&
            item.conversationId === conversationId &&
            item.id === messageId,
        );
        if (!message) throw new Error("Message not found.");
        targetAt = message.createdAt;
        targetId = message.id;
      } else {
        // No explicit message: mark the whole conversation read at its newest
        // message (any sender), or now when it has no messages yet.
        const newest = state.messages
          .filter((item) => item.userId === userId && item.conversationId === conversationId)
          .sort((a, b) => compareReadPosition(b.createdAt, b.id, a.createdAt, a.id))[0];
        targetAt = newest?.createdAt ?? now();
        targetId = newest?.id ?? null;
      }

      const existing = state.readStates.find(
        (item) => item.userId === userId && item.conversationId === conversationId,
      );
      if (existing) {
        // Forward-only in the same (createdAt, id) order used for unread counts,
        // so an equal-timestamp message can never move the bookmark backwards.
        const forward =
          compareReadPosition(targetAt, targetId, existing.lastReadAt, existing.lastReadMessageId) > 0;
        if (!forward) {
          return {
            conversationId,
            lastReadAt: existing.lastReadAt,
            lastReadMessageId: existing.lastReadMessageId,
          };
        }
        existing.lastReadAt = targetAt;
        existing.lastReadMessageId = targetId;
        return {
          conversationId,
          lastReadAt: existing.lastReadAt,
          lastReadMessageId: existing.lastReadMessageId,
        };
      }

      state.readStates.push({ userId, conversationId, lastReadAt: targetAt, lastReadMessageId: targetId });
      return { conversationId, lastReadAt: targetAt, lastReadMessageId: targetId };
    });
  }

  async getUnreadCounts(userId: string): Promise<Record<string, number>> {
    const state = await this.load();
    const owned = new Set(
      state.conversations.filter((item) => item.userId === userId).map((item) => item.id),
    );
    const reads = new Map(
      state.readStates
        .filter((item) => item.userId === userId)
        .map((item) => [item.conversationId, item]),
    );
    const counts: Record<string, number> = {};
    for (const message of state.messages) {
      if (message.userId !== userId || message.senderType !== "bot") continue;
      if (!owned.has(message.conversationId)) continue;
      const read = reads.get(message.conversationId);
      const unread =
        !read ||
        compareReadPosition(
          message.createdAt,
          message.id,
          read.lastReadAt,
          read.lastReadMessageId,
        ) > 0;
      if (unread) counts[message.conversationId] = (counts[message.conversationId] ?? 0) + 1;
    }
    return counts;
  }

  private async listMemory(scope: MemoryScope): Promise<MemoryFile[]> {
    return (await this.load()).memoryFiles
      .filter((file) => memoryInScope(file, scope))
      .map(publicMemoryFile)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private async readMemory(scope: MemoryScope, path: string): Promise<MemoryFile | null> {
    const file = (await this.load()).memoryFiles.find(
      (item) => memoryInScope(item, scope) && item.path === path,
    );
    return file ? publicMemoryFile(file) : null;
  }

  private async applyMemory(scope: MemoryScope, plan: MemoryWritePlan): Promise<MemoryFile | null> {
    return this.commit((state) => {
      if (plan.op === "create") {
        if (plan.expectedVersion !== null) {
          throw new MemoryConflictError("create must not carry an expected version");
        }
        if (state.memoryFiles.some((file) => memoryInScope(file, scope) && file.path === plan.path)) {
          throw new MemoryConflictError(`Memory file already exists: ${plan.path}`);
        }
        const file: ScopedMemoryFile = {
          ...scope,
          path: plan.path,
          content: plan.content ?? "",
          version: 1,
          source: plan.source,
          provenance: plan.provenance,
          sourceRunId: plan.sourceRunId,
          createdAt: plan.now,
          updatedAt: plan.now,
        };
        state.memoryFiles.push(file);
        return publicMemoryFile(file);
      }

      const sourcePath = plan.op === "rename" ? plan.fromPath : plan.path;
      if (!sourcePath) throw new MemoryConflictError("rename plan is missing its source path");
      const index = state.memoryFiles.findIndex(
        (file) => memoryInScope(file, scope) && file.path === sourcePath,
      );
      if (index < 0) throw new MemoryConflictError(`Memory file does not exist: ${sourcePath}`);
      const current = state.memoryFiles[index]!;
      if (current.version !== plan.expectedVersion) {
        throw new MemoryConflictError(
          `Memory file ${sourcePath} changed (expected version ${plan.expectedVersion}, found ${current.version})`,
        );
      }

      if (plan.op === "delete") {
        state.memoryFiles.splice(index, 1);
        return null;
      }

      if (plan.op === "rename") {
        if (state.memoryFiles.some((file) => memoryInScope(file, scope) && file.path === plan.path)) {
          throw new MemoryConflictError(`Memory file already exists: ${plan.path}`);
        }
        const renamed: ScopedMemoryFile = {
          ...current,
          path: plan.path,
          version: current.version + 1,
          source: plan.source,
          provenance: plan.provenance,
          sourceRunId: plan.sourceRunId,
          updatedAt: plan.now,
        };
        state.memoryFiles[index] = renamed;
        return publicMemoryFile(renamed);
      }

      const updated: ScopedMemoryFile = {
        ...current,
        content: plan.content ?? "",
        version: current.version + 1,
        source: plan.source,
        provenance: plan.provenance,
        sourceRunId: plan.sourceRunId,
        updatedAt: plan.now,
      };
      state.memoryFiles[index] = updated;
      return publicMemoryFile(updated);
    });
  }

  private async deleteMemory(scope: MemoryScope, paths: string[]): Promise<number> {
    if (paths.length === 0) return 0;
    const targets = new Set(paths);
    return this.commit((state) => {
      const before = state.memoryFiles.length;
      state.memoryFiles = state.memoryFiles.filter(
        (file) => !(memoryInScope(file, scope) && targets.has(file.path)),
      );
      return before - state.memoryFiles.length;
    });
  }

  async listIntegrations(userId: string): Promise<Integration[]> {
    return (await this.load()).integrations.filter((item) => item.userId === userId).map(publicIntegration);
  }

  async getIntegration(userId: string, integrationId: string): Promise<Integration | null> {
    const item = (await this.load()).integrations.find(
      (integration) => integration.userId === userId && integration.id === integrationId,
    );
    return item ? publicIntegration(item) : null;
  }

  async createIntegration(userId: string, input: NewIntegration): Promise<Integration> {
    return this.commit((state) => {
      const item: Integration & { userId: string } = {
        ...input,
        id: `mcp_${randomUUID()}`,
        userId,
        toolCount: input.toolCount ?? 0,
        lastError: input.lastError ?? null,
        allowedWriteTools: input.allowedWriteTools ?? [],
        createdAt: now(),
      };
      state.integrations.push(item);
      return publicIntegration(item);
    });
  }

  async updateIntegration(
    userId: string,
    integrationId: string,
    patch: Partial<Pick<Integration, "status" | "toolCount" | "lastError">>,
  ): Promise<void> {
    await this.commit((state) => {
      const item = state.integrations.find(
        (integration) => integration.userId === userId && integration.id === integrationId,
      );
      if (!item) throw new Error("Connection not found.");
      Object.assign(item, patch);
    });
  }

  async deleteIntegration(userId: string, integrationId: string): Promise<void> {
    await this.commit((state) => {
      state.integrations = state.integrations.filter(
        (item) => !(item.userId === userId && item.id === integrationId),
      );
      delete state.secrets[`${userId}:${integrationId}`];
      state.bots.forEach((bot) => {
        if (bot.userId === userId) bot.integrationIds = bot.integrationIds.filter((id) => id !== integrationId);
      });
    });
  }

  async getSecret<T>(userId: string, integrationId: string): Promise<T | null> {
    const encrypted = (await this.load()).secrets[`${userId}:${integrationId}`];
    return encrypted ? decryptSecret<T>(encrypted) : null;
  }

  async setSecret(userId: string, integrationId: string, value: unknown): Promise<void> {
    await this.commit((state) => {
      state.secrets[`${userId}:${integrationId}`] = encryptSecret(value);
    });
  }

  async putOAuthState(value: OAuthState): Promise<void> {
    await this.commit((state) => {
      state.oauthStates = state.oauthStates.filter((item) => item.state !== value.state);
      state.oauthStates.push(value);
    });
  }

  async getOAuthState(stateValue: string): Promise<OAuthState | null> {
    const item = (await this.load()).oauthStates.find((entry) => entry.state === stateValue);
    if (!item || Date.parse(item.expiresAt) <= Date.now()) return null;
    return item;
  }

  async deleteOAuthState(stateValue: string): Promise<void> {
    await this.commit((state) => {
      state.oauthStates = state.oauthStates.filter((item) => item.state !== stateValue);
    });
  }

  async createDesktopJob(input: NewDesktopJob): Promise<DesktopJob> {
    return this.commit((state) => {
      const existing = state.desktopJobs.find(
        (job) =>
          job.userId === input.userId &&
          ((input.id !== undefined && job.id === input.id) ||
            (input.runId != null &&
              input.stepKey != null &&
              job.runId === input.runId &&
              job.stepKey === input.stepKey)),
      );
      if (existing) return existing;
      const job: DesktopJob = {
        userId: input.userId,
        deviceId: input.deviceId,
        integrationId: input.integrationId,
        toolName: input.toolName,
        args: input.args,
        id: input.id ?? `desktop_job_${randomUUID()}`,
        runId: input.runId ?? null,
        stepKey: input.stepKey ?? null,
        attempt: input.attempt ?? null,
        status: "pending",
        output: null,
        error: null,
        claimedBy: null,
        claimedAt: null,
        leaseExpiresAt: null,
        deliveryStatus: "pending",
        deliveryAttempts: 0,
        deliveryError: null,
        deliveredAt: null,
        createdAt: now(),
      };
      state.desktopJobs.push(job);
      return job;
    });
  }

  async getDesktopJob(userId: string, jobId: string): Promise<DesktopJob | null> {
    return (await this.load()).desktopJobs.find((job) => job.userId === userId && job.id === jobId) ?? null;
  }

  async listPendingDesktopJobs(userId: string, deviceId: string): Promise<DesktopJob[]> {
    const at = Date.now();
    return (await this.load()).desktopJobs.filter(
      (job) =>
        job.userId === userId &&
        job.deviceId === deviceId &&
        job.status === "pending" &&
        (!job.claimedBy || (job.leaseExpiresAt != null && Date.parse(job.leaseExpiresAt) <= at)),
    );
  }

  async claimDesktopJob(input: ClaimDesktopJobInput): Promise<DesktopJob | null> {
    return this.commit((state) => {
      const job = state.desktopJobs.find((item) => item.userId === input.userId && item.id === input.jobId);
      if (!job || job.status !== "pending" || job.deviceId !== input.deviceId) return null;
      const at = input.now ?? now();
      // A claimed job with no lease deadline is not stealable: only an active
      // lease that has actually expired may transfer to another claim.
      if (job.claimedBy) {
        if (job.leaseExpiresAt == null) return null;
        if (Date.parse(job.leaseExpiresAt) > Date.parse(at)) return null;
      }
      job.claimedBy = input.deviceId;
      job.claimedAt = at;
      job.leaseExpiresAt = new Date(Date.parse(at) + input.leaseMs).toISOString();
      return job;
    });
  }

  async completeDesktopJob(
    userId: string,
    jobId: string,
    result: { ok: boolean; output?: unknown; error?: string },
    deviceId?: string,
  ): Promise<DesktopJob | null> {
    return this.commit((state) => {
      const job = state.desktopJobs.find((item) => item.userId === userId && item.id === jobId);
      if (!job || job.status !== "pending") return null;
      if (deviceId && job.deviceId !== deviceId) return null;
      if (deviceId && job.claimedBy && job.claimedBy !== deviceId) return null;
      job.status = result.ok ? "completed" : "failed";
      job.output = result.output ?? null;
      job.error = result.error ?? null;
      job.claimedBy = null;
      job.claimedAt = null;
      job.leaseExpiresAt = null;
      return job;
    });
  }

  async markDesktopJobDelivery(
    userId: string,
    jobId: string,
    delivery: DesktopJobDelivery,
  ): Promise<DesktopJob | null> {
    return this.commit((state) => {
      const job = state.desktopJobs.find((item) => item.userId === userId && item.id === jobId);
      if (!job) return null;
      job.deliveryStatus = delivery.status;
      job.deliveryAttempts += 1;
      job.deliveryError = delivery.error ?? null;
      if (delivery.status === "delivered") job.deliveredAt = now();
      return job;
    });
  }

  async createPendingAction(input: NewPendingAction): Promise<PendingAction> {
    return this.commit((state) => {
      const action: PendingAction = {
        ...input,
        id: `approval_${randomUUID()}`,
        status: "pending",
        runId: input.runId ?? null,
        providerApprovalId: input.providerApprovalId ?? null,
        toolName: input.toolName ?? null,
        toolArgsRedacted: input.toolArgsRedacted ?? null,
        toolRisk: input.toolRisk ?? "read",
        idempotencyKey: input.idempotencyKey ?? null,
        expiresAt: input.expiresAt ?? defaultApprovalExpiresAt(),
        integrationId: input.integrationId ?? null,
        integrationName: input.integrationName ?? null,
        argsDigest: input.argsDigest ?? null,
        createdAt: now(),
      };
      state.pendingActions.push(action);
      return action;
    });
  }

  async getPendingAction(userId: string, actionId: string): Promise<PendingAction | null> {
    return (await this.load()).pendingActions.find((action) => action.userId === userId && action.id === actionId) ?? null;
  }

  async listPendingActions(userId: string, conversationId: string): Promise<PendingAction[]> {
    return (await this.load()).pendingActions.filter(
      (action) => action.userId === userId && action.conversationId === conversationId && action.status === "pending",
    );
  }

  async listPendingDesktopConnections(userId: string): Promise<Integration[]> {
    const state = await this.load();
    const pending: Integration[] = [];
    for (const integration of state.integrations) {
      if (integration.userId !== userId || integration.kind !== "desktop") continue;
      const secret = await this.getSecret<IntegrationSecret>(userId, integration.id);
      if (secret?.pending) pending.push(publicIntegration(integration));
    }
    return pending;
  }

  async setPendingActionStatus(userId: string, actionId: string, status: PendingAction["status"]): Promise<void> {
    await this.commit((state) => {
      const action = state.pendingActions.find((item) => item.userId === userId && item.id === actionId);
      if (action) action.status = status;
    });
  }

  private async createAutomationTask(input: NewAutomationTask): Promise<AutomationTask> {
    return this.commit((state) => {
      const timestamp = now();
      const task: AutomationTask = {
        ...input,
        id: `auto_${randomUUID()}`,
        status: input.status ?? "active",
        lastOccurredAt: null,
        lastError: null,
        attempts: 0,
        claimedAt: null,
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.automationTasks.push(task);
      return task;
    });
  }

  private async listAutomationTasks(userId: string): Promise<AutomationTask[]> {
    return (await this.load()).automationTasks
      .filter((task) => task.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async getAutomationTask(userId: string, taskId: string): Promise<AutomationTask | null> {
    return (
      (await this.load()).automationTasks.find(
        (task) => task.userId === userId && task.id === taskId,
      ) ?? null
    );
  }

  private async updateAutomationTask(
    userId: string,
    taskId: string,
    patch: AutomationTaskPatch,
    expectedRevision?: number,
  ): Promise<AutomationTask | null> {
    return this.commit((state) => {
      const task = state.automationTasks.find(
        (item) => item.userId === userId && item.id === taskId,
      );
      if (!task) return null;
      if (expectedRevision !== undefined && task.revision !== expectedRevision) return null;
      Object.assign(task, patch);
      task.revision += 1;
      task.updatedAt = now();
      return task;
    });
  }

  private async deleteAutomationTask(userId: string, taskId: string): Promise<void> {
    await this.commit((state) => {
      state.automationTasks = state.automationTasks.filter(
        (task) => !(task.userId === userId && task.id === taskId),
      );
      state.automationOccurrences = state.automationOccurrences.filter(
        (occurrence) => !(occurrence.userId === userId && occurrence.taskId === taskId),
      );
    });
  }

  private async claimDueAutomationTasks(
    input: ClaimDueAutomationTasksInput,
  ): Promise<AutomationTask[]> {
    return this.commit((state) => {
      const at = input.now;
      const limit = input.limit ?? 25;
      const leaseCutoff = new Date(
        Date.parse(at) - AUTOMATION_CLAIM_LEASE_MS,
      ).toISOString();
      const due = state.automationTasks
        .filter(
          (task) =>
            task.status === "active" &&
            task.nextDueAt !== null &&
            task.nextDueAt <= at &&
            (task.claimedAt === null || task.claimedAt < leaseCutoff),
        )
        .sort((a, b) => (a.nextDueAt ?? "").localeCompare(b.nextDueAt ?? ""))
        .slice(0, limit);
      for (const task of due) {
        task.claimedAt = at;
        task.revision += 1;
        task.updatedAt = at;
      }
      return due.map((task) => ({ ...task }));
    });
  }

  private async admitAutomationOccurrence(
    input: AdmitAutomationOccurrenceInput,
  ): Promise<{ occurrence: AutomationOccurrence; created: boolean }> {
    return this.commit((state) => {
      const existing = state.automationOccurrences.find(
        (occurrence) => occurrence.executionId === input.executionId,
      );
      if (existing) return { occurrence: existing, created: false };

      const occurrence: AutomationOccurrence = {
        id: `occ_${randomUUID()}`,
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
      };
      state.automationOccurrences.push(occurrence);
      return { occurrence, created: true };
    });
  }

  private async completeAutomationOccurrence(
    input: CompleteAutomationOccurrenceInput,
  ): Promise<AutomationOccurrence | null> {
    return this.commit((state) => {
      const occurrence = state.automationOccurrences.find(
        (item) => item.userId === input.userId && item.id === input.occurrenceId,
      );
      if (!occurrence) return null;

      occurrence.status = input.occurrenceStatus;
      if (input.runId !== undefined) occurrence.runId = input.runId;
      if (input.workflowRunId !== undefined) occurrence.workflowRunId = input.workflowRunId;
      if (input.error !== undefined) occurrence.error = input.error;
      occurrence.updatedAt = input.now;

      const task = state.automationTasks.find(
        (item) => item.userId === input.userId && item.id === input.taskId,
      );
      if (task) {
        const revisionMatches =
          input.expectedRevision === undefined || task.revision === input.expectedRevision;
        if (revisionMatches) {
          if (input.taskStatus !== undefined) task.status = input.taskStatus;
          if (input.nextDueAt !== undefined) task.nextDueAt = input.nextDueAt;
          if (input.lastOccurredAt !== undefined) task.lastOccurredAt = input.lastOccurredAt;
          if (input.lastError !== undefined) task.lastError = input.lastError;
          if (input.attempts !== undefined) task.attempts = input.attempts;
          task.claimedAt = null;
          task.revision += 1;
          task.updatedAt = input.now;
        }
      }
      return occurrence;
    });
  }

  private async updateAutomationOccurrence(
    userId: string,
    occurrenceId: string,
    patch: AutomationOccurrencePatch,
  ): Promise<AutomationOccurrence | null> {
    return this.commit((state) => {
      const occurrence = state.automationOccurrences.find(
        (item) => item.userId === userId && item.id === occurrenceId,
      );
      if (!occurrence) return null;
      Object.assign(occurrence, patch);
      occurrence.updatedAt = now();
      return occurrence;
    });
  }

  private async listAutomationOccurrences(
    userId: string,
    taskId: string,
  ): Promise<AutomationOccurrence[]> {
    return (await this.load()).automationOccurrences
      .filter((occurrence) => occurrence.userId === userId && occurrence.taskId === taskId)
      .sort((a, b) => b.occurrenceAt.localeCompare(a.occurrenceAt));
  }

  private async listOpenAutomationOccurrences(limit = 50): Promise<AutomationOccurrence[]> {
    return (await this.load()).automationOccurrences
      .filter(
        (occurrence) =>
          occurrence.runId !== null &&
          (occurrence.status === "queued" ||
            occurrence.status === "running" ||
            occurrence.status === "awaiting_approval"),
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit);
  }

  private async listPendingAutomationOccurrences(limit = 50): Promise<AutomationOccurrence[]> {
    return (await this.load()).automationOccurrences
      .filter((occurrence) => occurrence.status === "queued" && occurrence.runId === null)
      .sort((a, b) => a.occurrenceAt.localeCompare(b.occurrenceAt))
      .slice(0, limit);
  }

  private async listOpenAutomationOccurrencesForTask(
    userId: string,
    taskId: string,
  ): Promise<AutomationOccurrence[]> {
    return (await this.load()).automationOccurrences
      .filter(
        (occurrence) =>
          occurrence.userId === userId &&
          occurrence.taskId === taskId &&
          (occurrence.status === "queued" ||
            occurrence.status === "running" ||
            occurrence.status === "awaiting_approval"),
      )
      .sort((a, b) => a.occurrenceAt.localeCompare(b.occurrenceAt));
  }

  private async claimRun(input: ClaimRunInput): Promise<ClaimRunResult> {
    return this.commit((state) => {
      if (input.kind === "message") return claimMessageRun(state, input);
      if (input.kind === "approval") return claimApprovalRun(state, input);
      return claimScheduledRun(state, input);
    });
  }

  private async getRun(userId: string, runId: string): Promise<Run | null> {
    return (await this.load()).runs.find((run) => run.userId === userId && run.id === runId) ?? null;
  }

  private async listRuns(input: {
    userId: string;
    conversationId?: string;
    statuses?: Run["status"][];
    createdBefore?: string;
    limit?: number;
  }): Promise<Run[]> {
    const limit = input.limit ?? 50;
    return (await this.load()).runs
      .filter((run) => run.userId === input.userId)
      .filter((run) => !input.conversationId || run.conversationId === input.conversationId)
      .filter((run) => !input.statuses || input.statuses.includes(run.status))
      .filter((run) => !input.createdBefore || run.createdAt < input.createdBefore)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  private async transitionRun(input: TransitionRunInput): Promise<TransitionRunResult> {
    return this.commit<TransitionRunResult>((state) => {
      const run = state.runs.find((item) => item.userId === input.userId && item.id === input.runId);
      if (!run) return { outcome: "stale" };
      if (run.status !== input.expectedStatus || run.fence !== input.expectedFence) {
        return { outcome: "stale" };
      }

      const timestamp = now();
      run.status = input.status;
      run.fence += 1;
      if (input.error !== undefined) run.error = input.error;
      if (input.botId !== undefined) run.botId = input.botId;
      if (input.workflowRunId !== undefined) run.workflowRunId = input.workflowRunId;
      if (input.outputMessageId !== undefined) run.outputMessageId = input.outputMessageId;
      if (input.leaseOwner !== undefined) run.leaseOwner = input.leaseOwner;
      if (input.leaseExpiresAt !== undefined) run.leaseExpiresAt = input.leaseExpiresAt;
      run.updatedAt = timestamp;

      const conversation = state.conversations.find(
        (item) => item.userId === input.userId && item.id === run.conversationId,
      );
      if (conversation && conversation.activeRunId === run.id) {
        const projection = conversationProjectionFor(input.status);
        conversation.runStatus = projection.runStatus;
        conversation.activeRunId = projection.active ? run.id : null;
        conversation.updatedAt = timestamp;
      }

      if (input.action) {
        const actionUpdate = input.action;
        const action = state.pendingActions.find(
          (item) => item.userId === input.userId && item.id === actionUpdate.id,
        );
        if (action) action.status = actionUpdate.status;
      }

      if (input.timers) {
        for (const patch of input.timers) {
          const timer = state.runTimers.find(
            (item) => item.runId === run.id && item.kind === patch.kind,
          );
          if (timer) timer.status = patch.status;
        }
      }

      const event = input.event
        ? appendRunEvent(state, run.id, input.event.type, input.event.data ?? null, input.event.dedupeKey ?? null, timestamp)
        : null;

      return { outcome: "applied", run, event };
    });
  }

  private async completeWithMessage(
    input: CompleteRunWithMessageInput,
  ): Promise<CompleteRunWithMessageResult> {
    return this.commit<CompleteRunWithMessageResult>((state) => {
      const run = state.runs.find((item) => item.userId === input.userId && item.id === input.runId);
      if (!run) return { outcome: "stale" };

      if (run.status === "succeeded" && run.outputMessageId) {
        const existing = state.messages.find((item) => item.id === run.outputMessageId);
        if (existing) return { outcome: "idempotent", run, message: publicMessage(existing) };
      }
      if (run.status !== input.expectedStatus || run.fence !== input.expectedFence) {
        return { outcome: "stale" };
      }

      // Reuse an already-persisted bot output for this run (for example after
      // a crash in an older non-atomic path) instead of inserting a duplicate.
      let message = state.messages.find(
        (item) => item.runId === run.id && item.senderType === "bot",
      );
      if (!message) {
        message = {
          id: `msg_${randomUUID()}`,
          userId: input.userId,
          conversationId: run.conversationId,
          senderType: "bot",
          senderId: run.botId,
          content: input.content,
          status: "complete",
          error: null,
          runId: run.id,
          createdAt: now(),
        };
        state.messages.push(message);
      }

      const timestamp = now();
      run.status = "succeeded";
      run.fence += 1;
      run.outputMessageId = message.id;
      run.leaseOwner = null;
      run.leaseExpiresAt = null;
      run.updatedAt = timestamp;

      const conversation = state.conversations.find(
        (item) => item.userId === input.userId && item.id === run.conversationId,
      );
      if (conversation) {
        if (conversation.activeRunId === run.id) {
          const projection = conversationProjectionFor("succeeded");
          conversation.runStatus = projection.runStatus;
          conversation.activeRunId = projection.active ? run.id : null;
        }
        conversation.updatedAt = timestamp;
      }

      if (input.action) {
        const actionUpdate = input.action;
        const action = state.pendingActions.find(
          (item) => item.userId === input.userId && item.id === actionUpdate.id,
        );
        if (action) action.status = actionUpdate.status;
      }

      if (input.timers) {
        for (const patch of input.timers) {
          const timer = state.runTimers.find(
            (item) => item.runId === run.id && item.kind === patch.kind,
          );
          if (timer) timer.status = patch.status;
        }
      }

      const event = input.event
        ? appendRunEvent(
            state,
            run.id,
            input.event.type,
            eventDataWithMessageId(input.event.data, message.id),
            input.event.dedupeKey ?? null,
            timestamp,
          )
        : null;

      return { outcome: "applied", run, message: publicMessage(message), event };
    });
  }

  private async appendEvent(input: {
    userId: string;
    runId: string;
    type: string;
    data?: unknown;
    dedupeKey?: string;
  }): Promise<RunEvent> {
    return this.commit((state) => {
      const run = state.runs.find((item) => item.userId === input.userId && item.id === input.runId);
      if (!run) throw new Error("Run not found.");
      return appendRunEvent(state, input.runId, input.type, input.data ?? null, input.dedupeKey ?? null, now());
    });
  }

  private async listEvents(userId: string, runId: string): Promise<RunEvent[]> {
    const state = await this.load();
    const run = state.runs.find((item) => item.userId === userId && item.id === runId);
    if (!run) return [];
    return state.runEvents
      .filter((event) => event.runId === runId)
      .sort((a, b) => a.seq - b.seq);
  }

  private async upsertTimer(input: {
    userId: string;
    runId: string;
    kind: string;
    dueAt: string;
  }): Promise<RunTimer> {
    return this.commit((state) => {
      const run = state.runs.find((item) => item.userId === input.userId && item.id === input.runId);
      if (!run) throw new Error("Run not found.");
      const existing = state.runTimers.find(
        (timer) => timer.runId === input.runId && timer.kind === input.kind,
      );
      if (existing) {
        existing.dueAt = input.dueAt;
        existing.status = "pending";
        existing.claimedAt = null;
        return existing;
      }
      const timer: RunTimer = {
        id: `timer_${randomUUID()}`,
        userId: input.userId,
        runId: input.runId,
        kind: input.kind,
        dueAt: input.dueAt,
        status: "pending",
        claimedAt: null,
        createdAt: now(),
      };
      state.runTimers.push(timer);
      return timer;
    });
  }

  private async claimDueTimers(input: { now?: string; limit?: number } = {}): Promise<RunTimer[]> {
    return this.commit((state) => {
      const at = input.now ?? now();
      const limit = input.limit ?? 50;
      const due = state.runTimers
        .filter((timer) => timer.status === "pending" && timer.dueAt <= at)
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
        .slice(0, limit);
      const claimed: RunTimer[] = [];
      for (const timer of due) {
        const run = state.runs.find((item) => item.id === timer.runId);
        if (run && isActiveRunStatus(run.status)) {
          timer.status = "claimed";
          timer.claimedAt = at;
          claimed.push(timer);
        } else {
          // Never let a stale lease/approval timer resurrect a terminal run.
          timer.status = "cancelled";
          timer.claimedAt = at;
        }
      }
      return claimed;
    });
  }

  private async releaseRunTimer(input: ReleaseRunTimerInput): Promise<void> {
    await this.commit((state) => {
      const timer = state.runTimers.find((item) => item.id === input.timerId);
      if (!timer || timer.status !== "claimed") return;
      const run = state.runs.find((item) => item.id === timer.runId);
      if (!run || !isActiveRunStatus(run.status)) {
        // A terminal run must never be resurrected by a retried timer.
        timer.status = "cancelled";
        timer.claimedAt = null;
        return;
      }
      const at = input.now ?? now();
      const retryAfterMs = Math.max(1_000, input.retryAfterMs ?? 30_000);
      timer.status = "pending";
      timer.claimedAt = null;
      timer.dueAt = new Date(Date.parse(at) + retryAfterMs).toISOString();
    });
  }

  private async listRecoverableRuns(input: { now: string; limit?: number }): Promise<Run[]> {
    const limit = input.limit ?? 50;
    return (await this.load()).runs
      .filter((run) => isActiveRunStatus(run.status))
      .filter((run) => run.leaseExpiresAt !== null && run.leaseExpiresAt <= input.now)
      .sort((a, b) => (a.leaseExpiresAt ?? "").localeCompare(b.leaseExpiresAt ?? ""))
      .slice(0, limit);
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

function appendRunEvent(
  state: FileState,
  runId: string,
  type: string,
  data: unknown,
  dedupeKey: string | null,
  timestamp: string,
): RunEvent {
  if (dedupeKey) {
    const existing = state.runEvents.find(
      (event) => event.runId === runId && event.dedupeKey === dedupeKey,
    );
    if (existing) return existing;
  }
  const seq =
    state.runEvents
      .filter((event) => event.runId === runId)
      .reduce((max, event) => Math.max(max, event.seq), 0) + 1;
  const event: RunEvent = {
    id: `evt_${randomUUID()}`,
    runId,
    seq,
    type,
    data,
    dedupeKey,
    createdAt: timestamp,
  };
  state.runEvents.push(event);
  return event;
}

function upsertRunTimerInState(
  state: FileState,
  input: { userId: string; runId: string; kind: string; dueAt: string },
): void {
  const existing = state.runTimers.find(
    (timer) => timer.runId === input.runId && timer.kind === input.kind,
  );
  if (existing) {
    existing.dueAt = input.dueAt;
    existing.status = "pending";
    existing.claimedAt = null;
    return;
  }
  state.runTimers.push({
    id: `timer_${randomUUID()}`,
    userId: input.userId,
    runId: input.runId,
    kind: input.kind,
    dueAt: input.dueAt,
    status: "pending",
    claimedAt: null,
    createdAt: now(),
  });
}

function startHandoffDueAt(timestamp: string): string {
  return new Date(Date.parse(timestamp) + START_HANDOFF_MS).toISOString();
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

function claimMessageRun(state: FileState, input: ClaimMessageRunInput): ClaimRunResult {
  const conversation = state.conversations.find(
    (item) => item.userId === input.userId && item.id === input.conversationId,
  );
  if (!conversation) throw new StoreDomainError("not_found", "Conversation not found.");

  if (input.idempotencyKey) {
    const claim = state.runClaims.find(
      (item) => item.userId === input.userId && item.idempotencyKey === input.idempotencyKey,
    );
    const run =
      (claim ? state.runs.find((item) => item.id === claim.runId) : undefined) ??
      state.runs.find(
        (item) => item.userId === input.userId && item.idempotencyKey === input.idempotencyKey,
      );
    if (run) {
      assertIdempotentRunMatches(run, input);
      const message = run.messageId
        ? state.messages.find((item) => item.id === run.messageId) ?? null
        : null;
      return { outcome: "claimed", run, message, action: null };
    }
  }

  const active = state.runs.find(
    (run) => run.conversationId === input.conversationId && isActiveRunStatus(run.status),
  );
  if (active) return { outcome: "busy", run: active };

  const botId = conversation.botIds[0];
  if (!botId) throw new StoreDomainError("not_found", "Conversation has no bot.");

  const timestamp = input.now ?? now();
  const messageId = `msg_${randomUUID()}`;
  const message: ChatMessage & { userId: string } = {
    ...input.message,
    id: messageId,
    userId: input.userId,
    conversationId: input.conversationId,
    status: input.message.status ?? "complete",
    error: input.message.error ?? null,
    runId: null,
    createdAt: timestamp,
  };
  state.messages.push(message);

  const run: Run = {
    id: `run_${randomUUID()}`,
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
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.runs.push(run);

  // Atomic handoff deadline: a crash after this commit still leaves a due
  // timer that recovery can use to restart exactly this run.
  upsertRunTimerInState(state, {
    userId: input.userId,
    runId: run.id,
    kind: "start_handoff",
    dueAt: startHandoffDueAt(timestamp),
  });

  conversation.activeRunId = run.id;
  conversation.runStatus = "queued";
  conversation.updatedAt = timestamp;

  if (input.idempotencyKey) {
    state.runClaims.push({
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      runId: run.id,
      createdAt: timestamp,
    });
  }

  return { outcome: "claimed", run, message, action: null };
}

function claimApprovalRun(state: FileState, input: ClaimApprovalRunInput): ClaimRunResult {
  const conversation = state.conversations.find(
    (item) => item.userId === input.userId && item.id === input.conversationId,
  );
  if (!conversation) throw new StoreDomainError("not_found", "Conversation not found.");

  if (input.idempotencyKey) {
    const claim = state.runClaims.find(
      (item) => item.userId === input.userId && item.idempotencyKey === input.idempotencyKey,
    );
    if (claim) {
      const run = state.runs.find((item) => item.id === claim.runId);
      if (run) {
        assertIdempotentRunMatches(run, input);
        const action = run.actionId
          ? state.pendingActions.find((item) => item.id === run.actionId) ?? null
          : null;
        return { outcome: "claimed", run, message: null, action };
      }
    }
  }

  const action = state.pendingActions.find(
    (item) =>
      item.userId === input.userId &&
      item.conversationId === input.conversationId &&
      item.id === input.actionId,
  );
  if (!action || action.status !== "pending") return { outcome: "approval_missing" };

  const run = action.runId ? state.runs.find((item) => item.id === action.runId) : undefined;
  if (!run) return { outcome: "approval_missing" };

  const timestamp = input.now ?? now();
  // Atomic expiry guard: a persisted pending run cannot resume an action whose
  // deadline has passed. Legacy null deadlines remain resumable.
  if (isPendingActionExpired(action, new Date(timestamp))) {
    action.status = "expired";
    if (run.status === "awaiting_approval") {
      run.status = "expired";
      run.fence += 1;
      run.leaseOwner = null;
      run.leaseExpiresAt = null;
      run.updatedAt = timestamp;
      if (conversation.activeRunId === run.id) {
        conversation.activeRunId = null;
        conversation.runStatus = "idle";
        conversation.updatedAt = timestamp;
      }
      appendRunEvent(
        state,
        run.id,
        "expired",
        { reason: "approval_expired" },
        `expired:${run.id}`,
        timestamp,
      );
    }
    return { outcome: "cancelled" };
  }

  if (run.status !== "awaiting_approval") {
    return isActiveRunStatus(run.status)
      ? { outcome: "busy", run }
      : { outcome: "cancelled" };
  }
  if (conversation.activeRunId !== run.id) return { outcome: "cancelled" };

  run.botId = conversation.botIds[0] ?? run.botId;
  run.actionId = action.id;
  if (input.decision === "approve") {
    run.status = "queued";
    run.attempt += 1;
    run.fence += 1;
    run.updatedAt = timestamp;
    action.status = "resuming";
    conversation.activeRunId = run.id;
    conversation.runStatus = "queued";
    conversation.updatedAt = timestamp;
    // The resumed attempt needs its own atomic handoff deadline.
    upsertRunTimerInState(state, {
      userId: input.userId,
      runId: run.id,
      kind: "start_handoff",
      dueAt: startHandoffDueAt(timestamp),
    });
  } else {
    run.status = "cancelled";
    run.fence += 1;
    run.updatedAt = timestamp;
    action.status = "cancelled";
    conversation.activeRunId = null;
    conversation.runStatus = "idle";
    conversation.updatedAt = timestamp;
    state.messages.push({
      id: `msg_${randomUUID()}`,
      userId: input.userId,
      conversationId: input.conversationId,
      senderType: "system",
      senderId: "system",
      content: `Approval denied: ${action.summary}`,
      status: "complete",
      error: null,
      runId: null,
      createdAt: timestamp,
    });
    appendRunEvent(
      state,
      run.id,
      "approval_denied",
      { actionId: action.id, summary: action.summary },
      null,
      timestamp,
    );
  }

  if (input.idempotencyKey) {
    state.runClaims.push({
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      runId: run.id,
      createdAt: timestamp,
    });
  }

  return { outcome: "claimed", run, message: null, action };
}

function claimScheduledRun(state: FileState, input: ClaimScheduledRunInput): ClaimRunResult {
  const conversation = state.conversations.find(
    (item) => item.userId === input.userId && item.id === input.conversationId,
  );
  if (!conversation) throw new StoreDomainError("not_found", "Conversation not found.");

  if (input.idempotencyKey) {
    const claim = state.runClaims.find(
      (item) => item.userId === input.userId && item.idempotencyKey === input.idempotencyKey,
    );
    const run =
      (claim ? state.runs.find((item) => item.id === claim.runId) : undefined) ??
      state.runs.find(
        (item) => item.userId === input.userId && item.idempotencyKey === input.idempotencyKey,
      );
    if (run) {
      assertIdempotentRunMatches(run, input);
      return { outcome: "claimed", run, message: null, action: null };
    }
  }

  const active = state.runs.find(
    (run) => run.conversationId === input.conversationId && isActiveRunStatus(run.status),
  );
  if (active) return { outcome: "busy", run: active };

  const botId = conversation.botIds[0];
  if (!botId) throw new StoreDomainError("not_found", "Conversation has no bot.");

  const timestamp = input.now ?? now();
  const run: Run = {
    id: `run_${randomUUID()}`,
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
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.runs.push(run);

  upsertRunTimerInState(state, {
    userId: input.userId,
    runId: run.id,
    kind: "start_handoff",
    dueAt: startHandoffDueAt(timestamp),
  });

  conversation.activeRunId = run.id;
  conversation.runStatus = "queued";
  conversation.updatedAt = timestamp;

  if (input.idempotencyKey) {
    state.runClaims.push({
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      runId: run.id,
      createdAt: timestamp,
    });
  }

  return { outcome: "claimed", run, message: null, action: null };
}
