import type {
  AutomationOccurrenceStatus,
  AutomationSchedule,
  AutomationStatus,
  Bot,
  BotPreview,
  ChatMessage,
  Conversation,
  ConversationReadState,
  ConversationRunStatus,
  CreateBotInput,
  CreateConversationInput,
  Integration,
  PendingActionStatus,
  Run,
  RunEvent,
  RunStatus,
  RunTimer,
  RunTimerStatus,
  ToolRisk,
  User,
} from "@slopbot/contracts";
import type { MemoryFile, MemoryWritePlan } from "../apps/web/lib/server/memory-files";

export type NewMessage = Pick<
  ChatMessage,
  "conversationId" | "senderType" | "senderId" | "content"
> &
  Partial<Pick<ChatMessage, "status" | "error">>;

export type NewIntegration = Pick<
  Integration,
  "kind" | "name" | "url" | "description" | "status"
> &
  Partial<Pick<Integration, "toolCount" | "lastError" | "allowedWriteTools">>;

export type PendingAction = {
  id: string;
  userId: string;
  conversationId: string;
  botId: string;
  kind: "tool_approval";
  summary: string;
  modelMessages: unknown;
  status: PendingActionStatus;
  runId: string | null;
  providerApprovalId: string | null;
  /** Tool identity for a generic approval card. Legacy rows may be null. */
  toolName: string | null;
  /** Sanitized, bounded argument preview. Never the raw tool payload. */
  toolArgsRedacted: Record<string, unknown> | null;
  /** Safe default is `read` for legacy rows that predate risk metadata. */
  toolRisk: ToolRisk;
  /** Opaque server-generated key; never regenerated from user input. */
  idempotencyKey: string | null;
  /** Null only for legacy rows; new actions always receive a deadline. */
  expiresAt: string | null;
  integrationId: string | null;
  integrationName: string | null;
  /**
   * Canonical digest of the exact approved arguments. Null for legacy rows;
   * gated writes fail closed when it is missing.
   */
  argsDigest?: string | null;
  createdAt: string;
};

export type NewPendingAction = Omit<
  PendingAction,
  | "id"
  | "status"
  | "createdAt"
  | "runId"
  | "providerApprovalId"
  | "toolName"
  | "toolArgsRedacted"
  | "toolRisk"
  | "idempotencyKey"
  | "expiresAt"
  | "integrationId"
  | "integrationName"
  | "argsDigest"
> & {
  runId?: string | null;
  providerApprovalId?: string | null;
  toolName?: string | null;
  toolArgsRedacted?: Record<string, unknown> | null;
  toolRisk?: ToolRisk;
  idempotencyKey?: string | null;
  expiresAt?: string | null;
  integrationId?: string | null;
  integrationName?: string | null;
  argsDigest?: string | null;
};

export type DesktopJobStatus = "pending" | "completed" | "failed" | "expired";
export type DesktopJobDeliveryStatus = "pending" | "delivered" | "failed";

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
  /** Logical run id when the caller can supply it. */
  runId: string | null;
  /** Stable workflow-step identity (workflow run id + step id). */
  stepKey: string | null;
  /** Persisted workflow attempt, when known. */
  attempt: number | null;
  /** Device that currently owns the execution lease. */
  claimedBy: string | null;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  /** Hook delivery is tracked separately from job execution. */
  deliveryStatus: DesktopJobDeliveryStatus;
  deliveryAttempts: number;
  deliveryError: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

export type NewDesktopJob = Omit<
  DesktopJob,
  | "id"
  | "status"
  | "output"
  | "error"
  | "createdAt"
  | "runId"
  | "stepKey"
  | "attempt"
  | "claimedBy"
  | "claimedAt"
  | "leaseExpiresAt"
  | "deliveryStatus"
  | "deliveryAttempts"
  | "deliveryError"
  | "deliveredAt"
> & {
  id?: string;
  runId?: string | null;
  stepKey?: string | null;
  attempt?: number | null;
};

export type ClaimDesktopJobInput = {
  userId: string;
  jobId: string;
  deviceId: string;
  leaseMs: number;
  now?: string;
};

export type DesktopJobDelivery = {
  status: DesktopJobDeliveryStatus;
  error?: string | null;
};

export type OAuthState = {
  state: string;
  integrationId: string;
  userId: string;
  platform: "web" | "android";
  createdAt: string;
  expiresAt: string;
};

/**
 * A compact store-domain failure that the API boundary can map to a status
 * without the database layer importing web-only error types.
 */
export class StoreDomainError extends Error {
  constructor(
    public readonly code: "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "StoreDomainError";
  }
}

export const ACTIVE_RUN_STATUSES: RunStatus[] = ["queued", "running", "awaiting_approval"];

/**
 * Bounded deadline for a claimed run to hand off to the workflow runtime.
 * Centralized here so the store can create the initial `start_handoff` timer
 * atomically with the run without importing web-only modules.
 */
export const START_HANDOFF_MS = 60_000;

export function isActiveRunStatus(status: RunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

export function conversationProjectionFor(status: RunStatus): {
  runStatus: ConversationRunStatus;
  active: boolean;
} {
  switch (status) {
    case "queued":
      return { runStatus: "queued", active: true };
    case "running":
      return { runStatus: "running", active: true };
    case "awaiting_approval":
      return { runStatus: "awaiting_approval", active: true };
    case "failed":
      return { runStatus: "failed", active: false };
    default:
      return { runStatus: "idle", active: false };
  }
}

export type ClaimMessageRunInput = {
  kind: "message";
  userId: string;
  conversationId: string;
  message: Pick<NewMessage, "senderType" | "senderId" | "content"> &
    Partial<Pick<NewMessage, "status" | "error">>;
  idempotencyKey?: string;
  /** Extensible trigger metadata persisted on the run (scheduled turns reuse this). */
  trigger?: Record<string, unknown>;
  /** Optional deterministic clock for the claim and its initial handoff timer. */
  now?: string;
};

export type ClaimApprovalRunInput = {
  kind: "approval";
  userId: string;
  conversationId: string;
  actionId: string;
  decision: "approve" | "deny";
  idempotencyKey?: string;
  trigger?: Record<string, unknown>;
  /** Optional deterministic clock for the claim and its initial handoff timer. */
  now?: string;
};

/**
 * Admits a scheduled occurrence into an existing bot conversation without
 * creating a visible user message. Trigger metadata is non-secret and carries
 * the standalone prompt plus automation/occurrence identity.
 */
export type ClaimScheduledRunInput = {
  kind: "scheduled";
  userId: string;
  conversationId: string;
  trigger: {
    automationId: string;
    occurrenceAt: string;
    prompt: string;
  } & Record<string, unknown>;
  idempotencyKey?: string;
  /** Optional deterministic clock for the claim and its initial handoff timer. */
  now?: string;
};

export type ClaimRunInput =
  | ClaimMessageRunInput
  | ClaimApprovalRunInput
  | ClaimScheduledRunInput;

export type ClaimRunResult =
  | {
      outcome: "claimed";
      run: Run;
      message: ChatMessage | null;
      action: PendingAction | null;
    }
  | { outcome: "busy"; run: Run | null }
  | { outcome: "approval_missing" }
  | { outcome: "cancelled" };

export type TransitionRunInput = {
  userId: string;
  runId: string;
  expectedStatus: RunStatus;
  expectedFence: number;
  status: RunStatus;
  error?: string | null;
  botId?: string;
  workflowRunId?: string | null;
  outputMessageId?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  action?: { id: string; status: PendingActionStatus };
  event?: { type: string; data?: unknown; dedupeKey?: string };
  /** Optional timer-state patch applied atomically with the transition. */
  timers?: Array<{ kind: string; status: RunTimerStatus }>;
};

export type TransitionRunResult =
  | { outcome: "applied"; run: Run; event: RunEvent | null }
  | { outcome: "stale" };

/**
 * Atomically persists a bot output message and the run's succeeded transition.
 * The message insert, run CAS, conversation projection, action/timer patches,
 * and event all commit together so a crash cannot duplicate a bot reply.
 */
export type CompleteRunWithMessageInput = {
  userId: string;
  runId: string;
  expectedStatus: RunStatus;
  expectedFence: number;
  content: string;
  action?: { id: string; status: PendingActionStatus };
  event?: { type: string; data?: unknown; dedupeKey?: string };
  timers?: Array<{ kind: string; status: RunTimerStatus }>;
};

export type CompleteRunWithMessageResult =
  | { outcome: "applied"; run: Run; message: ChatMessage; event: RunEvent | null }
  | { outcome: "idempotent"; run: Run; message: ChatMessage }
  | { outcome: "stale" };

export type ListRunsInput = {
  userId: string;
  conversationId?: string;
  statuses?: RunStatus[];
  createdBefore?: string;
  limit?: number;
};

export type AppendEventInput = {
  userId: string;
  runId: string;
  type: string;
  data?: unknown;
  dedupeKey?: string;
};

export type UpsertTimerInput = {
  userId: string;
  runId: string;
  kind: string;
  dueAt: string;
};

export type ClaimDueTimersInput = {
  now?: string;
  limit?: number;
};

export type ReleaseRunTimerInput = {
  timerId: string;
  /** Clock used to compute the retry deadline. */
  now?: string;
  /** Bounded delay before the timer is due again, to avoid a hot retry loop. */
  retryAfterMs?: number;
};

export type ListRecoverableRunsInput = {
  now: string;
  limit?: number;
};

export interface RunStore {
  claimRun(input: ClaimRunInput): Promise<ClaimRunResult>;
  getRun(userId: string, runId: string): Promise<Run | null>;
  listRuns(input: ListRunsInput): Promise<Run[]>;
  transitionRun(input: TransitionRunInput): Promise<TransitionRunResult>;
  /** Atomically insert the bot output message and transition the run to succeeded. */
  completeWithMessage(input: CompleteRunWithMessageInput): Promise<CompleteRunWithMessageResult>;
  appendEvent(input: AppendEventInput): Promise<RunEvent>;
  listEvents(userId: string, runId: string): Promise<RunEvent[]>;
  upsertTimer(input: UpsertTimerInput): Promise<RunTimer>;
  claimDueTimers(input?: ClaimDueTimersInput): Promise<RunTimer[]>;
  /**
   * Return a claimed timer to `pending` after a handler failure so a later
   * tick retries it. Terminal runs cancel the timer instead of resurrecting it.
   */
  releaseRunTimer(input: ReleaseRunTimerInput): Promise<void>;
  /**
   * Cross-user bounded scan of active runs whose lease has expired. Recovery
   * uses it as a safety net for runs that predate timer rows.
   */
  listRecoverableRuns(input: ListRecoverableRunsInput): Promise<Run[]>;
}

export type AutomationTask = {
  id: string;
  userId: string;
  botId: string;
  conversationId: string;
  title: string;
  instructions: string;
  schedule: AutomationSchedule;
  status: AutomationStatus;
  nextDueAt: string | null;
  lastOccurredAt: string | null;
  lastError: string | null;
  attempts: number;
  /** Tick lease marker; prevents parallel ticks from processing one task twice. */
  claimedAt: string | null;
  /**
   * Monotonic revision bumped on every task write. A tick that claimed an
   * occurrence advances the task only when this still matches, so a user edit
   * (pause/resume/schedule/title) made mid-tick is never overwritten.
   */
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type NewAutomationTask = Omit<
  AutomationTask,
  | "id"
  | "status"
  | "lastOccurredAt"
  | "lastError"
  | "attempts"
  | "claimedAt"
  | "revision"
  | "createdAt"
  | "updatedAt"
> & {
  status?: AutomationStatus;
};

export type AutomationTaskPatch = Partial<
  Pick<
    AutomationTask,
    | "title"
    | "instructions"
    | "schedule"
    | "status"
    | "nextDueAt"
    | "lastOccurredAt"
    | "lastError"
    | "attempts"
    | "claimedAt"
  >
>;

export type AutomationOccurrence = {
  id: string;
  taskId: string;
  userId: string;
  occurrenceAt: string;
  /** Stable admission key; also used as the run idempotency key. */
  executionId: string;
  runId: string | null;
  workflowRunId: string | null;
  status: AutomationOccurrenceStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AutomationOccurrencePatch = Partial<
  Pick<AutomationOccurrence, "status" | "runId" | "workflowRunId" | "error">
>;

export type ClaimDueAutomationTasksInput = {
  now: string;
  limit?: number;
};

export type AdmitAutomationOccurrenceInput = {
  userId: string;
  taskId: string;
  occurrenceAt: string;
  executionId: string;
  now: string;
};

export type CompleteAutomationOccurrenceInput = {
  userId: string;
  taskId: string;
  occurrenceId: string;
  occurrenceStatus: AutomationOccurrenceStatus;
  runId?: string | null;
  workflowRunId?: string | null;
  error?: string | null;
  taskStatus?: AutomationStatus;
  nextDueAt?: string | null;
  lastOccurredAt?: string | null;
  lastError?: string | null;
  attempts?: number;
  /**
   * When set, the task fields are only written if the task still has this
   * revision. The occurrence is always updated so run linkage stays safe.
   */
  expectedRevision?: number;
  now: string;
};

export interface AutomationStore {
  createTask(input: NewAutomationTask): Promise<AutomationTask>;
  listTasks(userId: string): Promise<AutomationTask[]>;
  getTask(userId: string, taskId: string): Promise<AutomationTask | null>;
  /**
   * Update a task and bump its revision. When `expectedRevision` is supplied
   * the write is a compare-and-swap: a mismatch returns null and leaves the
   * task untouched.
   */
  updateTask(
    userId: string,
    taskId: string,
    patch: AutomationTaskPatch,
    expectedRevision?: number,
  ): Promise<AutomationTask | null>;
  deleteTask(userId: string, taskId: string): Promise<void>;
  /** Atomically lease due active tasks so parallel ticks never process one twice. */
  claimDueTasks(input: ClaimDueAutomationTasksInput): Promise<AutomationTask[]>;
  /** Durably materialize one occurrence, deduping by the stable executionId. */
  admitOccurrence(
    input: AdmitAutomationOccurrenceInput,
  ): Promise<{ occurrence: AutomationOccurrence; created: boolean }>;
  /** Update the occurrence and its task together, clearing the tick lease. */
  completeOccurrence(input: CompleteAutomationOccurrenceInput): Promise<AutomationOccurrence | null>;
  /** Update only an occurrence, leaving the task lease untouched. */
  updateOccurrence(
    userId: string,
    occurrenceId: string,
    patch: AutomationOccurrencePatch,
  ): Promise<AutomationOccurrence | null>;
  listOccurrences(userId: string, taskId: string): Promise<AutomationOccurrence[]>;
  /** Occurrences that have a run and are not terminal, for lifecycle reconciliation. */
  listOpenOccurrences(limit?: number): Promise<AutomationOccurrence[]>;
  /**
   * Queued occurrences that were durably reserved but never got a run (for
   * example a busy conversation). Ordered oldest first so a retry pass drains
   * them before computing a newer recurrence.
   */
  listPendingOccurrences(limit?: number): Promise<AutomationOccurrence[]>;
  /** Open (queued/running/awaiting_approval) occurrences for one task. */
  listOpenOccurrencesForTask(userId: string, taskId: string): Promise<AutomationOccurrence[]>;
}

/**
 * Identity scope for one memory tree. Global user instructions use empty
 * `conversationId`/`botId`; conversation memory is bound to one bot in one
 * conversation. The adapter derives this from authenticated ownership, never
 * from model input.
 */
export type MemoryScope = {
  userId: string;
  conversationId: string;
  botId: string;
};

/**
 * Durable file-backed memory. The store only persists validated plans and
 * enforces compare-and-swap on `version`; path policy, secret checks, and
 * identity resolution live in the server adapter.
 */
export interface MemoryStore {
  list(scope: MemoryScope): Promise<MemoryFile[]>;
  read(scope: MemoryScope, path: string): Promise<MemoryFile | null>;
  /** Apply a validated plan atomically. Returns the resulting file, or null for delete. */
  apply(scope: MemoryScope, plan: MemoryWritePlan): Promise<MemoryFile | null>;
  /** Delete explicit paths in one scope. Returns the number removed. */
  delete(scope: MemoryScope, paths: string[]): Promise<number>;
}

/**
 * Durable per-user read bookmarks. `markRead` only moves forward and is
 * idempotent; `getUnreadCounts` counts only bot messages after the bookmark.
 */
export interface ReadStateStore {
  markRead(
    userId: string,
    conversationId: string,
    messageId?: string | null,
  ): Promise<ConversationReadState | null>;
  getUnreadCounts(userId: string): Promise<Record<string, number>>;
}

export interface AppStore {
  runs: RunStore;
  automations: AutomationStore;
  readState: ReadStateStore;
  memory: MemoryStore;

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
  listBotPreviews(userId: string): Promise<BotPreview[]>;
  addMessage(userId: string, input: NewMessage): Promise<ChatMessage>;

  listIntegrations(userId: string): Promise<Integration[]>;
  getIntegration(userId: string, integrationId: string): Promise<Integration | null>;
  createIntegration(userId: string, input: NewIntegration): Promise<Integration>;
  updateIntegration(
    userId: string,
    integrationId: string,
    patch: Partial<Pick<Integration, "status" | "toolCount" | "lastError" | "allowedWriteTools">>,
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
  claimDesktopJob(input: ClaimDesktopJobInput): Promise<DesktopJob | null>;
  completeDesktopJob(
    userId: string,
    jobId: string,
    result: { ok: boolean; output?: unknown; error?: string },
    deviceId?: string,
  ): Promise<DesktopJob | null>;
  markDesktopJobDelivery(
    userId: string,
    jobId: string,
    delivery: DesktopJobDelivery,
  ): Promise<DesktopJob | null>;

  createPendingAction(input: NewPendingAction): Promise<PendingAction>;
  getPendingAction(userId: string, actionId: string): Promise<PendingAction | null>;
  listPendingActions(userId: string, conversationId: string): Promise<PendingAction[]>;
  listPendingDesktopConnections(userId: string): Promise<Integration[]>;
  setPendingActionStatus(userId: string, actionId: string, status: PendingAction["status"]): Promise<void>;
}
