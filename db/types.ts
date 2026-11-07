import type {
  Bot,
  ChatMessage,
  Conversation,
  CreateBotInput,
  CreateConversationInput,
  Integration,
  User,
} from "@slopbot/contracts";

export type NewMessage = Pick<
  ChatMessage,
  "conversationId" | "senderType" | "senderId" | "content"
> &
  Partial<Pick<ChatMessage, "status" | "error">>;

export type NewIntegration = Pick<
  Integration,
  "kind" | "name" | "url" | "description" | "status"
> &
  Partial<Pick<Integration, "toolCount" | "lastError">>;

export type DesktopJobStatus = "pending" | "completed" | "failed" | "expired";

export type DesktopJob = {
  id: string;
  userId: string;
  deviceId: string;
  integrationId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: DesktopJobStatus;
  output: unknown;
  error: string | null;
  createdAt: string;
};

export type NewDesktopJob = Omit<DesktopJob, "id" | "status" | "output" | "error" | "createdAt">;

export type OAuthState = {
  state: string;
  integrationId: string;
  userId: string;
  platform: "web" | "android";
  createdAt: string;
  expiresAt: string;
};

export interface AppStore {
  getUser(userId: string): Promise<User>;
  listBots(userId: string): Promise<Bot[]>;
  getBot(userId: string, botId: string): Promise<Bot | null>;
  createBot(userId: string, input: CreateBotInput): Promise<Bot>;
  deleteBot(userId: string, botId: string): Promise<void>;

  listConversations(userId: string): Promise<Conversation[]>;
  getConversation(userId: string, conversationId: string): Promise<Conversation | null>;
  createConversation(userId: string, input: CreateConversationInput): Promise<Conversation>;
  setConversationRun(
    userId: string,
    conversationId: string,
    runId: string | null,
    status: Conversation["runStatus"],
  ): Promise<void>;
  listMessages(userId: string, conversationId: string): Promise<ChatMessage[]>;
  addMessage(userId: string, input: NewMessage): Promise<ChatMessage>;

  listIntegrations(userId: string): Promise<Integration[]>;
  getIntegration(userId: string, integrationId: string): Promise<Integration | null>;
  createIntegration(userId: string, input: NewIntegration): Promise<Integration>;
  updateIntegration(
    userId: string,
    integrationId: string,
    patch: Partial<Pick<Integration, "status" | "toolCount" | "lastError">>,
  ): Promise<void>;
  deleteIntegration(userId: string, integrationId: string): Promise<void>;
  getSecret<T>(userId: string, integrationId: string): Promise<T | null>;
  setSecret(userId: string, integrationId: string, value: unknown): Promise<void>;

  putOAuthState(value: OAuthState): Promise<void>;
  getOAuthState(state: string): Promise<OAuthState | null>;
  deleteOAuthState(state: string): Promise<void>;

  createDesktopJob(input: NewDesktopJob): Promise<DesktopJob>;
  getDesktopJob(userId: string, jobId: string): Promise<DesktopJob | null>;
  listPendingDesktopJobs(userId: string, deviceId: string): Promise<DesktopJob[]>;
  completeDesktopJob(
    userId: string,
    jobId: string,
    result: { ok: boolean; output?: unknown; error?: string },
  ): Promise<DesktopJob | null>;
}
