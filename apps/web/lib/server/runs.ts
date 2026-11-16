import { Effect } from "effect";
import { start } from "workflow/api";
import { HookConflictError, WorkflowStartError } from "workflow/errors";
import type { ChatMessage, Run, RunStatus } from "@slopbot/contracts";
import type { AppStore, ClaimRunResult, PendingAction } from "@db/types";
import { runGroupTurn, type GroupTurnInput, type ScheduledTrigger } from "@workflows/group-chat";
import { ApiError } from "./http";
import { isGatewayConfigured } from "./auth";
import { fromPromise, StoreService, type AppEffect } from "./effect";
import {
  cancelAllTimers,
  cancelTimers,
  LEASE_MS,
  scheduleLeaseRecovery,
  scheduleStartHandoff,
  START_HOOK_RETENTION_MS,
} from "./run-timers";

export type StartWorkflow = (input: GroupTurnInput) => Promise<{ runId: string }>;

export type RunStartResult = {
  runId: string;
  status: RunStatus;
  message: ChatMessage | null;
  action: PendingAction | null;
};

export type StartRunOptions = {
  idempotencyKey?: string;
  startWorkflow?: StartWorkflow;
  now?: () => Date;
};

export type AdmitClaimDeps = {
  store: AppStore;
  startWorkflow: StartWorkflow;
  now: () => Date;
  useGateway: boolean;
};

/**
 * Stable per-durable-attempt token so duplicate starts of the same attempt
 * cannot create a second owner, while an approval resume (attempt 1) gets a
 * fresh token instead of adopting the finished attempt-0 workflow.
 */
export function startToken(runId: string, attempt: number): string {
  return `slopbot-run-${runId}-a${attempt}`;
}

export const defaultStartWorkflow: StartWorkflow = async (input) => {
  const run = await start(runGroupTurn, [input], {
    experimental_hook: {
      token: input.startToken,
      experimental_minRetention: START_HOOK_RETENTION_MS,
    },
  });
  return { runId: run.runId };
};

export function startMessageRun(
  userId: string,
  conversationId: string,
  content: string,
  options: StartRunOptions = {},
): AppEffect<RunStartResult, StoreService> {
  return Effect.gen(function* () {
    const store = yield* StoreService;
    const claim = yield* fromPromise(() => store.runs.claimRun({
      kind: "message",
      userId,
      conversationId,
      message: { senderType: "user", senderId: userId, content },
      idempotencyKey: options.idempotencyKey,
    }));
    return yield* fromPromise(() => admitClaim(claim, depsFor(store, options)));
  });
}

export function startApprovalRun(
  userId: string,
  conversationId: string,
  actionId: string,
  decision: "approve" | "deny",
  options: StartRunOptions = {},
): AppEffect<RunStartResult, StoreService> {
  return Effect.gen(function* () {
    const store = yield* StoreService;
    const claim = yield* fromPromise(() => store.runs.claimRun({
      kind: "approval",
      userId,
      conversationId,
      actionId,
      decision,
      idempotencyKey: options.idempotencyKey,
    }));
    return yield* fromPromise(() => admitClaim(claim, depsFor(store, options)));
  });
}

export function startScheduledRun(
  userId: string,
  conversationId: string,
  trigger: ScheduledTrigger & Record<string, unknown>,
  options: StartRunOptions = {},
): AppEffect<RunStartResult, StoreService> {
  return Effect.gen(function* () {
    const store = yield* StoreService;
    const claim = yield* fromPromise(() => store.runs.claimRun({
      kind: "scheduled",
      userId,
      conversationId,
      trigger,
      idempotencyKey: options.idempotencyKey,
    }));
    return yield* fromPromise(() => admitClaim(claim, depsFor(store, options)));
  });
}

function depsFor(store: AppStore, options: StartRunOptions): AdmitClaimDeps {
  return {
    store,
    startWorkflow: options.startWorkflow ?? defaultStartWorkflow,
    now: options.now ?? (() => new Date()),
    useGateway: isGatewayConfigured(),
  };
}

/**
 * Admits a claimed run into the workflow runtime. The durable run is the
 * source of truth: a duplicate claim of an already-admitted run is returned
 * as-is, and a stable start token makes concurrent starts adopt the existing
 * owner instead of creating a second workflow.
 */
export async function admitClaim(claim: ClaimRunResult, deps: AdmitClaimDeps): Promise<RunStartResult> {
  if (claim.outcome === "busy") {
    throw new ApiError(409, "This chat is already responding. Wait for the reply to finish.");
  }
  if (claim.outcome === "approval_missing") {
    throw new ApiError(404, "Approval not found or already completed.");
  }
  if (claim.outcome === "cancelled") {
    throw new ApiError(409, "This approval can no longer be resumed.");
  }

  const { run, message, action } = claim;
  if (run.status !== "queued") {
    // Already admitted (or terminal): never enqueue another timer or start.
    return { runId: run.id, status: run.status, message, action };
  }

  const now = deps.now();
  const input: GroupTurnInput = {
    userId: run.userId,
    conversationId: run.conversationId,
    runId: run.id,
    attempt: run.attempt,
    startToken: startToken(run.id, run.attempt),
    useGateway: deps.useGateway,
    resumeActionId: action?.id,
    scheduled: scheduledTriggerOf(run) ?? undefined,
  };

  // Durable handoff deadline. If this process dies before the workflow is
  // admitted, recovery retries the same attempt/token instead of starting a
  // second owner.
  await scheduleStartHandoff(deps.store, run, now);

  let workflowRunId: string;
  try {
    const started = await deps.startWorkflow(input);
    workflowRunId = started.runId;
  } catch (error) {
    if (HookConflictError.is(error) && error.conflictingRunId) {
      workflowRunId = error.conflictingRunId;
    } else if (WorkflowStartError.is(error)) {
      // The candidate may still be admitted. Leave the run queued and let the
      // durable start_handoff timer retry the same token; never start a new run.
      return { runId: run.id, status: "queued", message, action };
    } else {
      await failStart(deps.store, run, action, error);
      throw new ApiError(502, "Could not start the reply. Please try again.");
    }
  }

  const leaseExpiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
  await scheduleLeaseRecovery(deps.store, run, leaseExpiresAt);
  let running = await deps.store.runs.transitionRun({
    userId: run.userId,
    runId: run.id,
    expectedStatus: "queued",
    expectedFence: run.fence,
    status: "running",
    workflowRunId,
    leaseOwner: workflowRunId,
    leaseExpiresAt,
    botId: run.botId,
    timers: cancelTimers("start_handoff"),
  });
  if (running.outcome === "stale") {
    const current = await deps.store.runs.getRun(run.userId, run.id);
    if (!current) throw new ApiError(500, "The run disappeared before it could start.");
    if (current.status === "queued") {
      running = await deps.store.runs.transitionRun({
        userId: run.userId,
        runId: run.id,
        expectedStatus: "queued",
        expectedFence: current.fence,
        status: "running",
        workflowRunId,
        leaseOwner: workflowRunId,
        leaseExpiresAt,
        botId: run.botId,
        timers: cancelTimers("start_handoff"),
      });
    }
  }
  if (running.outcome === "stale") {
    const current = await deps.store.runs.getRun(run.userId, run.id);
    if (!current) throw new ApiError(500, "The run disappeared before it could start.");
    return { runId: current.id, status: current.status, message, action };
  }
  return { runId: running.run.id, status: running.run.status, message, action };
}

async function failStart(
  store: AppStore,
  run: Run,
  action: PendingAction | null,
  error: unknown,
): Promise<void> {
  const message = safeError(error);
  await store.runs.transitionRun({
    userId: run.userId,
    runId: run.id,
    expectedStatus: "queued",
    expectedFence: run.fence,
    status: "failed",
    error: message,
    leaseOwner: null,
    leaseExpiresAt: null,
    action: action ? { id: action.id, status: "cancelled" } : undefined,
    event: { type: "failed", data: { error: message }, dedupeKey: `failed:${run.id}` },
    timers: cancelAllTimers(),
  });
}

function scheduledTriggerOf(run: Run): ScheduledTrigger | null {
  if (run.trigger.kind !== "scheduled") return null;
  const prompt = typeof run.trigger.prompt === "string" ? run.trigger.prompt : "";
  if (!prompt) return null;
  return {
    automationId: typeof run.trigger.automationId === "string" ? run.trigger.automationId : "",
    occurrenceAt: typeof run.trigger.occurrenceAt === "string" ? run.trigger.occurrenceAt : "",
    prompt,
  };
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Could not start the run.").slice(0, 500);
}
