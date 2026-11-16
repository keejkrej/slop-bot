import type {
  AutomationOccurrenceStatus,
  AutomationSchedule,
  CreateAutomationInput,
  RunStatus,
  UpdateAutomationInput,
} from "@slopbot/contracts";
import type {
  AppStore,
  AutomationOccurrence,
  AutomationTask,
  AutomationTaskPatch,
} from "@db/types";
import { ApiError } from "./http";
import { recoverRuns, type RecoverRunsResult } from "./run-recovery";
import {
  computeNextDue,
  ScheduleInputError,
  type NextDue,
  type ScheduleInput,
} from "./schedule-time";

export type ScheduledRunStart =
  | { outcome: "started"; runId: string; status: RunStatus; workflowRunId: string | null }
  | { outcome: "duplicate"; runId: string; status: RunStatus; workflowRunId: string | null }
  | { outcome: "busy" }
  | { outcome: "failed"; error: string };

/**
 * The shared scheduled-run admission seam. The production adapter wraps
 * `startScheduledRun` from runs.ts; tests inject a fake.
 */
export type ScheduledRunStarter = (input: {
  userId: string;
  conversationId: string;
  trigger: { automationId: string; occurrenceAt: string; prompt: string };
  idempotencyKey: string;
}) => Promise<ScheduledRunStart>;

const MAX_ATTEMPTS = 5;
const DEFAULT_TICK_LIMIT = 25;
const MAX_TICK_LIMIT = 100;

export type SchedulerTickResult = {
  claimed: number;
  admitted: number;
  duplicate: number;
  busy: number;
  missed: number;
  failed: number;
  skipped: number;
  reconciled: number;
  /** Occurrences whose reconciliation failed; isolated from the task pass. */
  reconcileErrors: number;
  reconcileError?: string;
  /**
   * Task advances skipped because a user edit bumped the task revision while
   * the tick was dispatching. The occurrence/run linkage is still recorded.
   */
  revisionConflicts: number;
  /** Durable run recovery counters for this tick. */
  recovery?: RecoverRunsResult;
  recoveryError?: string;
};

export type ManualRunResult =
  | { outcome: "started"; occurrence: AutomationOccurrence; runId: string; status: RunStatus }
  | { outcome: "duplicate"; occurrence: AutomationOccurrence }
  | { outcome: "busy"; occurrence: AutomationOccurrence }
  | { outcome: "failed"; occurrence: AutomationOccurrence };

function computeDue(schedule: AutomationSchedule, now: Date, since?: Date): NextDue {
  try {
    return computeNextDue(schedule as ScheduleInput, now, since ? { since } : {});
  } catch (error) {
    if (error instanceof ScheduleInputError) throw new ApiError(400, error.message);
    throw error;
  }
}

function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_TICK_LIMIT;
  return Math.min(MAX_TICK_LIMIT, Math.max(1, Math.floor(limit)));
}

async function resolveOwnedConversation(store: AppStore, userId: string, botId: string) {
  const bot = await store.getBot(userId, botId);
  if (!bot) throw new ApiError(400, "The bot must belong to this workspace.");
  const conversations = await store.listConversations(userId);
  const conversation = conversations.find((item) => item.botIds.includes(botId));
  if (!conversation) throw new ApiError(400, "This bot has no conversation yet.");
  return { bot, conversation };
}

export async function createAutomation(
  store: AppStore,
  userId: string,
  input: CreateAutomationInput,
  now: Date = new Date(),
): Promise<AutomationTask> {
  const { conversation } = await resolveOwnedConversation(store, userId, input.botId);
  const due = computeDue(input.schedule, now, now);
  if (due.status === "missed") {
    throw new ApiError(400, "That one-time schedule is more than 24 hours in the past.");
  }
  return store.automations.createTask({
    userId,
    botId: input.botId,
    conversationId: conversation.id,
    title: input.title,
    instructions: input.instructions,
    schedule: input.schedule,
    nextDueAt: due.nextDueAt,
  });
}

export function listAutomations(store: AppStore, userId: string): Promise<AutomationTask[]> {
  return store.automations.listTasks(userId);
}

export async function getAutomation(
  store: AppStore,
  userId: string,
  taskId: string,
): Promise<AutomationTask> {
  const task = await store.automations.getTask(userId, taskId);
  if (!task) throw new ApiError(404, "Automation not found.");
  return task;
}

export async function updateAutomation(
  store: AppStore,
  userId: string,
  taskId: string,
  patch: UpdateAutomationInput,
  now: Date = new Date(),
): Promise<AutomationTask> {
  const task = await getAutomation(store, userId, taskId);
  const next: AutomationTaskPatch = {};

  if (patch.title !== undefined) next.title = patch.title;
  if (patch.instructions !== undefined) next.instructions = patch.instructions;

  if (patch.schedule !== undefined) {
    const due = computeDue(patch.schedule, now, now);
    if (due.status === "missed") {
      throw new ApiError(400, "That one-time schedule is more than 24 hours in the past.");
    }
    next.schedule = patch.schedule;
    next.nextDueAt = due.nextDueAt;
  }

  if (patch.status !== undefined) {
    next.status = patch.status;
    if (patch.status === "active" && task.status !== "active") {
      const schedule = patch.schedule ?? task.schedule;
      // A finished one-time task has no future occurrence. Resuming it would
      // replay a historical run, so reject instead of silently re-executing.
      if (schedule.kind === "once" && (task.status === "completed" || task.status === "missed")) {
        throw new ApiError(409, "This one-time automation already finished and cannot be resumed.");
      }
      // Resuming recomputes from now so missed occurrences are not replayed.
      const due = computeDue(schedule, now, now);
      if (due.status === "missed") {
        next.status = "missed";
        next.nextDueAt = null;
      } else {
        next.nextDueAt = due.nextDueAt;
      }
    }
  }

  const updated = await store.automations.updateTask(userId, taskId, next);
  if (!updated) throw new ApiError(404, "Automation not found.");
  return updated;
}

export async function deleteAutomation(
  store: AppStore,
  userId: string,
  taskId: string,
): Promise<void> {
  await getAutomation(store, userId, taskId);
  await store.automations.deleteTask(userId, taskId);
}

/**
 * Run one task immediately. The request id makes the call idempotent: a
 * redelivered request reuses the same occurrence and run instead of starting a
 * second agent turn. It never advances the task's scheduled pointer.
 */
export async function runAutomationNow(
  store: AppStore,
  userId: string,
  taskId: string,
  requestId: string,
  startScheduledRun: ScheduledRunStarter,
  now: Date = new Date(),
): Promise<ManualRunResult> {
  const task = await getAutomation(store, userId, taskId);
  if (task.status === "completed" || task.status === "missed" || task.status === "failed") {
    throw new ApiError(409, "This automation has finished and cannot be run again.");
  }
  const nowIso = now.toISOString();
  const executionId = `manual:${task.id}:${requestId}`;
  const { occurrence } = await store.automations.admitOccurrence({
    userId,
    taskId: task.id,
    occurrenceAt: nowIso,
    executionId,
    now: nowIso,
  });

  if (occurrence.status === "succeeded" || occurrence.status === "failed" || occurrence.status === "missed") {
    return { outcome: "duplicate", occurrence };
  }
  if (occurrence.runId) return { outcome: "duplicate", occurrence };

  const result = await startScheduledRun({
    userId,
    conversationId: task.conversationId,
    trigger: { automationId: task.id, occurrenceAt: nowIso, prompt: task.instructions },
    idempotencyKey: executionId,
  });

  if (result.outcome === "busy") return { outcome: "busy", occurrence };
  if (result.outcome === "failed") {
    const failed = await store.automations.completeOccurrence({
      userId,
      taskId: task.id,
      occurrenceId: occurrence.id,
      occurrenceStatus: "failed",
      error: result.error,
      expectedRevision: task.revision,
      now: nowIso,
    });
    return { outcome: "failed", occurrence: failed ?? occurrence };
  }
  if (result.outcome === "duplicate") {
    // The run already reached a terminal success; reconcile the occurrence
    // instead of reporting a fresh start.
    const completed = await store.automations.completeOccurrence({
      userId,
      taskId: task.id,
      occurrenceId: occurrence.id,
      occurrenceStatus: "succeeded",
      runId: result.runId,
      workflowRunId: result.workflowRunId,
      expectedRevision: task.revision,
      now: nowIso,
    });
    return { outcome: "duplicate", occurrence: completed ?? occurrence };
  }

  const updated = await store.automations.completeOccurrence({
    userId,
    taskId: task.id,
    occurrenceId: occurrence.id,
    occurrenceStatus: "queued",
    runId: result.runId,
    workflowRunId: result.workflowRunId,
    expectedRevision: task.revision,
    now: nowIso,
  });
  return {
    outcome: "started",
    occurrence: updated ?? occurrence,
    runId: result.runId,
    status: result.status,
  };
}

/**
 * One scheduler pass. It reconciles open occurrences, leases due tasks, and
 * admits at most one occurrence per task. A single task failure never blocks
 * the rest of the batch.
 */
export async function runSchedulerTick(options: {
  store: AppStore;
  startScheduledRun: ScheduledRunStarter;
  now?: Date;
  limit?: number;
  /**
   * Durable run recovery seam. Defaults to `recoverRuns` with the same store,
   * clock, and bounded limit. It runs after automation tasks so a timer
   * failure cannot block them.
   */
  recoverRuns?: (context: {
    store: AppStore;
    now: Date;
    limit: number;
  }) => Promise<RecoverRunsResult>;
}): Promise<SchedulerTickResult> {
  const now = options.now ?? new Date();
  const limit = clampLimit(options.limit);
  const result: SchedulerTickResult = {
    claimed: 0,
    admitted: 0,
    duplicate: 0,
    busy: 0,
    missed: 0,
    failed: 0,
    skipped: 0,
    reconciled: 0,
    reconcileErrors: 0,
    revisionConflicts: 0,
  };

  try {
    const reconciliation = await reconcileOccurrences(options.store, limit);
    result.reconciled = reconciliation.reconciled;
    result.reconcileErrors = reconciliation.errors;
  } catch (error) {
    // A broken reconciliation batch must not prevent due tasks from running.
    result.reconcileErrors += 1;
    result.reconcileError = error instanceof Error ? error.message : "Occurrence reconciliation failed.";
  }

  // Drain durably reserved occurrences that never got a run (busy conversation,
  // manual Run Now, etc.) before computing any newer recurrence. This is
  // independent of task.nextDueAt so a busy occurrence is never lost.
  const retriedTasks = await retryPendingOccurrences({
    store: options.store,
    now,
    limit,
    startScheduledRun: options.startScheduledRun,
    result,
  });

  const tasks = await options.store.automations.claimDueTasks({
    now: now.toISOString(),
    limit,
  });
  const runnable = tasks.filter((task) => !retriedTasks.has(task.id));
  result.claimed = runnable.length;
  // Release the lease for tasks already handled by the pending-occurrence pass.
  for (const task of tasks) {
    if (!retriedTasks.has(task.id)) continue;
    await options.store.automations.updateTask(
      task.userId,
      task.id,
      { claimedAt: null },
      task.revision,
    );
  }

  for (const task of runnable) {
    try {
      const outcome = await processTask({
        store: options.store,
        task,
        now,
        startScheduledRun: options.startScheduledRun,
      });
      result[outcome.outcome] += 1;
      if (outcome.revisionConflict) result.revisionConflicts += 1;
    } catch (error) {
      result.failed += 1;
      await recordTaskFailure(options.store, task, error);
    }
  }

  const recover =
    options.recoverRuns ??
    ((context: { store: AppStore; now: Date; limit: number }) => recoverRuns(context));
  try {
    result.recovery = await recover({ store: options.store, now, limit });
  } catch (error) {
    result.recoveryError = error instanceof Error ? error.message : "Run recovery failed.";
  }

  return result;
}

type TaskOutcome = "admitted" | "duplicate" | "busy" | "missed" | "failed" | "skipped";

type TaskResult = { outcome: TaskOutcome; revisionConflict?: boolean };

async function processTask(options: {
  store: AppStore;
  task: AutomationTask;
  now: Date;
  startScheduledRun: ScheduledRunStarter;
}): Promise<TaskResult> {
  const { store, task, now, startScheduledRun } = options;
  const nowIso = now.toISOString();

  if (!task.nextDueAt) {
    const released = await store.automations.updateTask(
      task.userId,
      task.id,
      { claimedAt: null },
      task.revision,
    );
    return { outcome: "skipped", revisionConflict: released === null };
  }

  // A durably reserved occurrence (queued/running/awaiting_approval) wins over
  // recurrence coalescing. Wait for it instead of starting a newer occurrence
  // or marking the task missed.
  const open = await store.automations.listOpenOccurrencesForTask(task.userId, task.id);
  if (open.length > 0) {
    const released = await store.automations.updateTask(
      task.userId,
      task.id,
      { claimedAt: null },
      task.revision,
    );
    return { outcome: "skipped", revisionConflict: released === null };
  }

  // The stored pointer is the next occurrence to dispatch. Treat it as the
  // inclusive lower bound so a late tick coalesces to the latest missed
  // occurrence without replaying history.
  const since = new Date(Date.parse(task.nextDueAt) - 1);
  const due = computeDue(task.schedule, now, since);

  if (due.status === "missed") {
    const { occurrence } = await store.automations.admitOccurrence({
      userId: task.userId,
      taskId: task.id,
      occurrenceAt: task.nextDueAt,
      executionId: `auto:${task.id}:${task.nextDueAt}`,
      now: nowIso,
    });
    const conflict = await revisionChanged(store, task);
    await store.automations.completeOccurrence({
      userId: task.userId,
      taskId: task.id,
      occurrenceId: occurrence.id,
      occurrenceStatus: "missed",
      taskStatus: "missed",
      nextDueAt: null,
      lastError: "Schedule expired before it could run.",
      expectedRevision: task.revision,
      now: nowIso,
    });
    return { outcome: "missed", revisionConflict: conflict };
  }

  const occurrenceAt = due.nextDueAt;
  if (occurrenceAt > nowIso) {
    // Nothing is actually due; just move the pointer forward.
    const advanced = await store.automations.updateTask(
      task.userId,
      task.id,
      { nextDueAt: occurrenceAt, claimedAt: null },
      task.revision,
    );
    return { outcome: "skipped", revisionConflict: advanced === null };
  }

  const executionId = `auto:${task.id}:${occurrenceAt}`;
  const { occurrence } = await store.automations.admitOccurrence({
    userId: task.userId,
    taskId: task.id,
    occurrenceAt,
    executionId,
    now: nowIso,
  });

  if (
    occurrence.status === "succeeded" ||
    occurrence.status === "failed" ||
    occurrence.status === "missed"
  ) {
    // A terminal occurrence must not pin the pointer forever. Advance past it
    // (respecting the revision CAS) so a later tick can schedule the next one.
    const conflict = await revisionChanged(store, task);
    const next = terminalAdvance(task, now, occurrence.status);
    await store.automations.completeOccurrence({
      userId: task.userId,
      taskId: task.id,
      occurrenceId: occurrence.id,
      occurrenceStatus: occurrence.status,
      taskStatus: next.status,
      nextDueAt: next.nextDueAt,
      ...(occurrence.status === "succeeded"
        ? { lastOccurredAt: occurrenceAt, lastError: null, attempts: 0 }
        : {}),
      expectedRevision: task.revision,
      now: nowIso,
    });
    return { outcome: "skipped", revisionConflict: conflict };
  }
  if (occurrence.runId) {
    // Already admitted; never start a second agent run for the same occurrence.
    const released = await store.automations.updateTask(
      task.userId,
      task.id,
      { claimedAt: null },
      task.revision,
    );
    return { outcome: "skipped", revisionConflict: released === null };
  }

  const result = await startScheduledRun({
    userId: task.userId,
    conversationId: task.conversationId,
    trigger: { automationId: task.id, occurrenceAt, prompt: task.instructions },
    idempotencyKey: executionId,
  });

  if (result.outcome === "busy") {
    // Leave the occurrence queued and the pointer unchanged for a later tick.
    const released = await store.automations.updateTask(
      task.userId,
      task.id,
      { claimedAt: null },
      task.revision,
    );
    return { outcome: "busy", revisionConflict: released === null };
  }

  const conflict = await revisionChanged(store, task);

  if (result.outcome === "failed") {
    await store.automations.completeOccurrence({
      userId: task.userId,
      taskId: task.id,
      occurrenceId: occurrence.id,
      occurrenceStatus: "failed",
      error: result.error,
      taskStatus: "failed",
      lastError: result.error,
      expectedRevision: task.revision,
      now: nowIso,
    });
    return { outcome: "failed", revisionConflict: conflict };
  }

  const next =
    task.schedule.kind === "once"
      ? { status: "completed" as const, nextDueAt: null }
      : nextRecurring(task.schedule, now);

  if (result.outcome === "duplicate") {
    // The run already succeeded; reconcile the occurrence and advance the
    // pointer without pretending a new run started.
    await store.automations.completeOccurrence({
      userId: task.userId,
      taskId: task.id,
      occurrenceId: occurrence.id,
      occurrenceStatus: "succeeded",
      runId: result.runId,
      workflowRunId: result.workflowRunId,
      taskStatus: next.status,
      nextDueAt: next.nextDueAt,
      lastOccurredAt: occurrenceAt,
      lastError: null,
      attempts: 0,
      expectedRevision: task.revision,
      now: nowIso,
    });
    return { outcome: "duplicate", revisionConflict: conflict };
  }

  await store.automations.completeOccurrence({
    userId: task.userId,
    taskId: task.id,
    occurrenceId: occurrence.id,
    occurrenceStatus: "queued",
    runId: result.runId,
    workflowRunId: result.workflowRunId,
    taskStatus: next.status,
    nextDueAt: next.nextDueAt,
    lastOccurredAt: occurrenceAt,
    lastError: null,
    attempts: 0,
    expectedRevision: task.revision,
    now: nowIso,
  });
  return { outcome: "admitted", revisionConflict: conflict };
}

/** Re-read the task to detect a user edit made while the tick was dispatching. */
async function revisionChanged(store: AppStore, task: AutomationTask): Promise<boolean> {
  const current = await store.automations.getTask(task.userId, task.id);
  return !current || current.revision !== task.revision;
}

/**
 * Retry durably reserved occurrences that never got a run. This runs before
 * the due-task pass so an old busy occurrence is dispatched before a newer
 * recurrence is computed. Returns the task ids it touched so the due-task pass
 * does not dispatch them twice in the same tick.
 */
async function retryPendingOccurrences(options: {
  store: AppStore;
  now: Date;
  limit: number;
  startScheduledRun: ScheduledRunStarter;
  result: SchedulerTickResult;
}): Promise<Set<string>> {
  const { store, now, limit, startScheduledRun, result } = options;
  const nowIso = now.toISOString();
  const pending = await store.automations.listPendingOccurrences(limit);
  const touched = new Set<string>();

  for (const occurrence of pending) {
    try {
      const task = await store.automations.getTask(occurrence.userId, occurrence.taskId);
      if (!task) continue;
      const manual = occurrence.executionId.startsWith("manual:");
      // Automatic retries never run a paused task; an explicit manual Run Now
      // may still drain while paused.
      if (manual) {
        if (task.status !== "active" && task.status !== "paused") continue;
      } else if (task.status !== "active") {
        continue;
      }
      touched.add(task.id);
      const outcome = await dispatchPendingOccurrence({
        store,
        task,
        occurrence,
        now,
        nowIso,
        startScheduledRun,
      });
      result[outcome.outcome] += 1;
      if (outcome.revisionConflict) result.revisionConflicts += 1;
    } catch {
      // Leave the occurrence queued for a later tick; one bad row must not
      // block the rest of the batch.
      result.failed += 1;
    }
  }

  return touched;
}

async function dispatchPendingOccurrence(options: {
  store: AppStore;
  task: AutomationTask;
  occurrence: AutomationOccurrence;
  now: Date;
  nowIso: string;
  startScheduledRun: ScheduledRunStarter;
}): Promise<TaskResult> {
  const { store, task, occurrence, now, nowIso, startScheduledRun } = options;
  const manual = occurrence.executionId.startsWith("manual:");
  const result = await startScheduledRun({
    userId: task.userId,
    conversationId: task.conversationId,
    trigger: {
      automationId: task.id,
      occurrenceAt: occurrence.occurrenceAt,
      prompt: task.instructions,
    },
    idempotencyKey: occurrence.executionId,
  });

  if (result.outcome === "busy") return { outcome: "busy" };

  const conflict = manual ? false : await revisionChanged(store, task);

  if (result.outcome === "failed") {
    await store.automations.completeOccurrence({
      userId: task.userId,
      taskId: task.id,
      occurrenceId: occurrence.id,
      occurrenceStatus: "failed",
      error: result.error,
      ...(manual ? {} : { taskStatus: "failed" as const, lastError: result.error }),
      expectedRevision: task.revision,
      now: nowIso,
    });
    return { outcome: "failed", revisionConflict: conflict };
  }

  if (result.outcome === "duplicate") {
    await store.automations.completeOccurrence({
      userId: task.userId,
      taskId: task.id,
      occurrenceId: occurrence.id,
      occurrenceStatus: "succeeded",
      runId: result.runId,
      workflowRunId: result.workflowRunId,
      ...(manual ? {} : advanceTaskFields(task, now, occurrence.occurrenceAt)),
      expectedRevision: task.revision,
      now: nowIso,
    });
    return { outcome: "duplicate", revisionConflict: conflict };
  }

  await store.automations.completeOccurrence({
    userId: task.userId,
    taskId: task.id,
    occurrenceId: occurrence.id,
    occurrenceStatus: "queued",
    runId: result.runId,
    workflowRunId: result.workflowRunId,
    ...(manual ? {} : advanceTaskFields(task, now, occurrence.occurrenceAt)),
    expectedRevision: task.revision,
    now: nowIso,
  });
  return { outcome: "admitted", revisionConflict: conflict };
}

function advanceTaskFields(
  task: AutomationTask,
  now: Date,
  occurrenceAt: string,
): {
  taskStatus: "active" | "completed" | "missed";
  nextDueAt: string | null;
  lastOccurredAt: string;
  lastError: null;
  attempts: number;
} {
  const next =
    task.schedule.kind === "once"
      ? { status: "completed" as const, nextDueAt: null }
      : nextRecurring(task.schedule, now);
  return {
    taskStatus: next.status,
    nextDueAt: next.nextDueAt,
    lastOccurredAt: occurrenceAt,
    lastError: null,
    attempts: 0,
  };
}

function terminalAdvance(
  task: AutomationTask,
  now: Date,
  occurrenceStatus: "succeeded" | "failed" | "missed",
): { status: "active" | "completed" | "missed" | "failed"; nextDueAt: string | null } {
  if (task.schedule.kind !== "once") return nextRecurring(task.schedule, now);
  if (occurrenceStatus === "succeeded") return { status: "completed", nextDueAt: null };
  if (occurrenceStatus === "missed") return { status: "missed", nextDueAt: null };
  return { status: "failed", nextDueAt: null };
}

function nextRecurring(
  schedule: AutomationSchedule,
  now: Date,
): { status: "active" | "missed"; nextDueAt: string | null } {
  // Advance from `now`, not the occurrence time, so a slow tick never bursts.
  const due = computeDue(schedule, now, now);
  return due.status === "scheduled"
    ? { status: "active", nextDueAt: due.nextDueAt }
    : { status: "missed", nextDueAt: null };
}

async function recordTaskFailure(
  store: AppStore,
  task: AutomationTask,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : "Automation tick failed.").slice(0, 500);
  const attempts = task.attempts + 1;
  await store.automations.updateTask(
    task.userId,
    task.id,
    {
      attempts,
      lastError: message,
      claimedAt: null,
      ...(attempts >= MAX_ATTEMPTS ? { status: "failed" as const } : {}),
    },
    task.revision,
  );
}

async function reconcileOccurrences(
  store: AppStore,
  limit: number,
): Promise<{ reconciled: number; errors: number }> {
  const open = await store.automations.listOpenOccurrences(limit);
  let reconciled = 0;
  let errors = 0;
  for (const occurrence of open) {
    if (!occurrence.runId) continue;
    try {
      const run = await store.runs.getRun(occurrence.userId, occurrence.runId);
      if (!run) continue;
      const status = occurrenceStatusForRun(run.status);
      if (status === occurrence.status && run.workflowRunId === occurrence.workflowRunId) continue;
      // Update only the occurrence so a concurrent tick's task lease is untouched.
      await store.automations.updateOccurrence(occurrence.userId, occurrence.id, {
        status,
        workflowRunId: run.workflowRunId,
        error: run.error,
      });
      reconciled += 1;
    } catch {
      // One bad occurrence must not block the rest of reconciliation or the
      // task pass that follows.
      errors += 1;
    }
  }
  return { reconciled, errors };
}

function occurrenceStatusForRun(status: RunStatus): AutomationOccurrenceStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "awaiting_approval":
      return "awaiting_approval";
    case "succeeded":
      return "succeeded";
    case "failed":
    case "cancelled":
    case "expired":
      return "failed";
  }
}
