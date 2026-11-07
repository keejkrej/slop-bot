import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  botColor,
  DEFAULT_MODEL,
  type Bot,
  type ChatMessage,
  type Conversation,
  type CreateBotInput,
  type CreateConversationInput,
  type Integration,
  type User,
} from "@slopbot/contracts";
import { decryptSecret, encryptSecret } from "./crypto";
import type { AppStore, DesktopJob, NewDesktopJob, NewIntegration, NewMessage, NewPendingAction, OAuthState, PendingAction } from "./types";

type FileState = {
  bots: Array<Bot & { userId: string }>;
  conversations: Array<Conversation & { userId: string }>;
  messages: Array<ChatMessage & { userId: string }>;
  integrations: Array<Integration & { userId: string }>;
  secrets: Record<string, string>;
  oauthStates: OAuthState[];
  desktopJobs: DesktopJob[];
  pendingActions: PendingAction[];
};

const now = () => new Date().toISOString();
const publicBot = ({ userId: _userId, ...bot }: Bot & { userId: string }): Bot => bot;
const publicConversation = ({ userId: _userId, ...item }: Conversation & { userId: string }): Conversation => item;
const publicMessage = ({ userId: _userId, ...item }: ChatMessage & { userId: string }): ChatMessage => item;
const publicIntegration = ({ userId: _userId, ...item }: Integration & { userId: string }): Integration => item;

export class FileStore implements AppStore {
  private state: FileState | undefined;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file = resolve(process.cwd(), ".data", "store.json")) {}

  private async load(): Promise<FileState> {
    if (this.state) return this.state;
    try {
      this.state = JSON.parse(await readFile(this.file, "utf8")) as FileState;
      this.state.desktopJobs ??= [];
      this.state.pendingActions ??= [];
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
            id: "conv_brain_trust",
            userId: "demo-user",
            title: "The brain trust",
            botIds: ["bot_nova", "bot_patch"],
            activeRunId: null,
            runStatus: "idle",
            createdAt,
            updatedAt: createdAt,
          },
        ],
        messages: [],
        integrations: [],
        secrets: {},
        oauthStates: [],
        desktopJobs: [],
        pendingActions: [],
      };
      await this.persist();
    }
    return this.state;
  }

  private async persist(): Promise<void> {
    if (!this.state) return;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(temporary, this.file);
  }

  private async commit<T>(operation: (state: FileState) => T | Promise<T>): Promise<T> {
    const result = this.writeChain.then(async () => {
      const state = await this.load();
      const value = await operation(state);
      await this.persist();
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
        createdAt: now(),
      };
      state.messages.push(message);
      conversation.updatedAt = message.createdAt;
      return publicMessage(message);
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
      const job: DesktopJob = {
        ...input,
        id: `desktop_job_${randomUUID()}`,
        status: "pending",
        output: null,
        error: null,
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
    return (await this.load()).desktopJobs.filter(
      (job) => job.userId === userId && job.deviceId === deviceId && job.status === "pending",
    );
  }

  async completeDesktopJob(
    userId: string,
    jobId: string,
    result: { ok: boolean; output?: unknown; error?: string },
  ): Promise<DesktopJob | null> {
    return this.commit((state) => {
      const job = state.desktopJobs.find((item) => item.userId === userId && item.id === jobId);
      if (!job || job.status !== "pending") return null;
      job.status = result.ok ? "completed" : "failed";
      job.output = result.output ?? null;
      job.error = result.error ?? null;
      return job;
    });
  }

  async createPendingAction(input: NewPendingAction): Promise<PendingAction> {
    return this.commit((state) => {
      const action: PendingAction = {
        ...input,
        id: `approval_${randomUUID()}`,
        status: "pending",
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

  async setPendingActionStatus(userId: string, actionId: string, status: PendingAction["status"]): Promise<void> {
    await this.commit((state) => {
      const action = state.pendingActions.find((item) => item.userId === userId && item.id === actionId);
      if (action) action.status = status;
    });
  }
}
