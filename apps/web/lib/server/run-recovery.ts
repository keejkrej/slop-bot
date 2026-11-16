import type { Run, RunTimer } from "@slopbot/contracts";
import type { AppStore, PendingAction } from "@db/types";
import { WorkflowRunNotFoundError } from "workflow/errors";
import type { getRun } from "workflow/api";
import { isGatewayConfigured } from "./auth";
import { admitClaim, defaultStartWorkflow, type RunStartResult } from "./runs";
import { LEASE_MS, scheduleLeaseRecovery } from "./run-timers";
import { isPendingActionExpired } from "./tool-permissions";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Bounded delay before a failed timer is retried, to avoid a hot loop. */
const TIMER_RETRY_MS = 30_000;

/**
 * Status values returned by the installed Workflow SDK (`workflow/api`).
 * `pending`/`running` are live; `completed`/`failed`/`cancelled` are terminal.
 */
export type WorkflowRunStatus = Awaited<ReturnType<typeof getRun>["status"]>;

/**
 * Injected workflow-status seam. The default reads the installed SDK; tests
 * inject a fake so no remote call is made.
 */
export type GetWorkflowStatus = (workflowRunId: string) => Promise<WorkflowRunStatus>;

async function defaultWorkflowStatus(workflowRunId: string): Promise<WorkflowRunStatus> {
  const { getRun } = await import("workflow/api");
  return getRun(workflowRunId).status;
}

function isActiveWorkflowStatus(status: WorkflowRunStatus): boolean {
  return status === "pending" || status === "running";
}

/**
 * Injected admission seam. The default reuses `admitClaim` with the same
 * stable start token as the normal start path, so a retried handoff adopts the
 * existing logical run instead of creating a second one.
 */
export type StartRun = (run: Run, action: PendingAction | null) => Promise<RunStartResult>;

export type RecoverRunsOptions = {
  store: AppStore;
  startRun?: StartRun;
  now?: Date;
  limit?: number;
  /** Injected workflow-status lookup; defaults to the installed SDK. */
  getWorkflowStatus?: GetWorkflowStatus;
};

export type RecoverRunsResult = {
  timersClaimed: number;
  approvalExpired: number;
  leaseExpired: number;
  /** Live workflow runs whose lease was refreshed instead of expired. */
  leaseRenewed: number;
  /** Workflow status lookups that failed; the run is left for a later tick. */
  leaseRenewalErrors: number;
  handoffRetried: number;
  handoffReconciled: number;
  safetyNetExpired: number;
  skipped: number;
  errors: number;
};

function defaultStartRun(store: AppStore, now: () => Date): StartRun {
  return (run, action) =>
    admitClaim(
      { outcome: "claimed", run, message: null, action },
      { store, startWorkflow: defaultStartWorkflow, now, useGateway: isGatewayConfigured() },
    );
}

function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * Durable run recovery. It consumes due `run_timers` and then applies a
 * bounded safety net for active runs whose lease expired without a timer row.
 * Each timer is isolated: one failure never aborts the rest of the batch.
 */
export async function recoverRuns(options: RecoverRunsOptions): Promise<RecoverRunsResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = clampLimit(options.limit);
  const startRun = options.startRun ?? defaultStartRun(options.store, () => now);
  const getWorkflowStatus = options.getWorkflowStatus ?? defaultWorkflowStatus;
  const result: RecoverRunsResult = {
    timersClaimed: 0,
    approvalExpired: 0,
    leaseExpired: 0,
    leaseRenewed: 0,
    leaseRenewalErrors: 0,
    handoffRetried: 0,
    handoffReconciled: 0,
    safetyNetExpired: 0,
    skipped: 0,
    errors: 0,
  };

  const timers = await options.store.runs.claimDueTimers({ now: nowIso, limit });
  result.timersClaimed = timers.length;
  const handledRunIds = new Set<string>();

  for (const timer of timers) {
    handledRunIds.add(timer.runId);
    try {
      await handleTimer({
        store: options.store,
        timer,
        now,
        nowIso,
        startRun,
        getWorkflowStatus,
        result,
      });
    } catch {
      result.errors += 1;
      // Return the claimed timer to pending with a bounded backoff so a later
      // tick retries it instead of leaving it claimed forever. Terminal runs
      // are cancelled by the store instead of being resurrected.
      try {
        await options.store.runs.releaseRunTimer({
          timerId: timer.id,
          now: nowIso,
          retryAfterMs: TIMER_RETRY_MS,
        });
      } catch {
        result.errors += 1;
      }
    }
  }

  // Safety net for runs that predate timer rows. The query only returns active
  // runs whose lease is already due, so an idle tick never scans or fires.
  let recoverable: Run[] = [];
  try {
    recoverable = await options.store.runs.listRecoverableRuns({ now: nowIso, limit });
  } catch {
    result.errors += 1;
  }
  for (const run of recoverable) {
    if (handledRunIds.has(run.id)) continue;
    try {
      await expireLease({
        store: options.store,
        run,
        nowIso,
        getWorkflowStatus,
        result,
        reason: "lease_safety_net",
      });
    } catch {
      result.errors += 1;
    }
  }

  return result;
}

async function handleTimer(input: {
  store: AppStore;
  timer: RunTimer;
  now: Date;
  nowIso: string;
  startRun: StartRun;
  getWorkflowStatus: GetWorkflowStatus;
  result: RecoverRunsResult;
}): Promise<void> {
  const { store, timer, now, nowIso, startRun, getWorkflowStatus, result } = input;
  const run = await store.runs.getRun(timer.userId, timer.runId);
  if (!run) {
    result.skipped += 1;
    return;
  }

  switch (timer.kind) {
    case "approval_timeout":
      await handleApprovalTimeout({ store, run, result });
      return;
    case "lease_recovery":
      await expireLease({
        store,
        run,
        nowIso,
        getWorkflowStatus,
        result,
        reason: "lease_recovery",
      });
      return;
    case "start_handoff":
      await handleStartHandoff({ store, run, now, startRun, result });
      return;
    default:
      result.skipped += 1;
  }
}

async function handleApprovalTimeout(input: {
  store: AppStore;
  run: Run;
  result: RecoverRunsResult;
}): Promise<void> {
  const { store, run, result } = input;
  if (run.status !== "awaiting_approval") {
    result.skipped += 1;
    return;
  }

  const action = await findActionForRun(store, run);
  const transition = await store.runs.transitionRun({
    userId: run.userId,
    runId: run.id,
    expectedStatus: "awaiting_approval",
    expectedFence: run.fence,
    status: "expired",
    error: "Approval timed out.",
    leaseOwner: null,
    leaseExpiresAt: null,
    action: action ? { id: action.id, status: "expired" } : undefined,
    event: {
      type: "expired",
      data: { reason: "approval_timeout", actionId: action?.id ?? null },
      dedupeKey: `expired:${run.id}`,
    },
    timers: [
      { kind: "approval_timeout", status: "cancelled" },
      { kind: "lease_recovery", status: "cancelled" },
      { kind: "start_handoff", status: "cancelled" },
    ],
  });
  if (transition.outcome === "applied") result.approvalExpired += 1;
  else result.skipped += 1;
}

async function expireLease(input: {
  store: AppStore;
  run: Run;
  nowIso: string;
  getWorkflowStatus: GetWorkflowStatus;
  result: RecoverRunsResult;
  reason: "lease_recovery" | "lease_safety_net";
}): Promise<void> {
  const { store, run, nowIso, getWorkflowStatus, result, reason } = input;
  if (run.status !== "queued" && run.status !== "running") {
    result.skipped += 1;
    return;
  }
  if (!run.leaseExpiresAt || run.leaseExpiresAt > nowIso) {
    result.skipped += 1;
    return;
  }

  // A long but valid Workflow turn can outlive the 5 minute lease. Before
  // expiring a running run, ask the installed SDK whether the workflow is
  // still live. Only persisted run metadata is used for the lookup.
  if (run.status === "running" && run.workflowRunId) {
    let status: WorkflowRunStatus | null = null;
    try {
      status = await getWorkflowStatus(run.workflowRunId);
    } catch (error) {
      if (WorkflowRunNotFoundError.is(error)) {
        // The owner is gone; fall through to normal expiry.
        status = null;
      } else {
        // Unknown/unreachable: never expire or restart a possibly live
        // workflow. Extend the lease by a short backoff and schedule a retry so
        // the safety net does not hot-loop on the same run.
        result.leaseRenewalErrors += 1;
        await refreshLease({
          store,
          run,
          nowIso,
          leaseMs: TIMER_RETRY_MS,
          reason: "workflow_status_unknown",
        });
        return;
      }
    }
    if (status !== null && isActiveWorkflowStatus(status)) {
      const renewed = await refreshLease({
        store,
        run,
        nowIso,
        leaseMs: LEASE_MS,
        reason: "workflow_active",
      });
      if (renewed) result.leaseRenewed += 1;
      else result.skipped += 1;
      return;
    }
  }

  const transition = await store.runs.transitionRun({
    userId: run.userId,
    runId: run.id,
    expectedStatus: run.status,
    expectedFence: run.fence,
    status: "expired",
    error: "Run lease expired.",
    leaseOwner: null,
    leaseExpiresAt: null,
    event: {
      type: "expired",
      data: { reason },
      dedupeKey: `expired:${run.id}`,
    },
    timers: [
      { kind: "lease_recovery", status: "cancelled" },
      { kind: "approval_timeout", status: "cancelled" },
      { kind: "start_handoff", status: "cancelled" },
    ],
  });
  if (transition.outcome !== "applied") {
    result.skipped += 1;
    return;
  }
  if (reason === "lease_safety_net") result.safetyNetExpired += 1;
  else result.leaseExpired += 1;
}

/**
 * Refresh a live run's lease and its recovery timer without changing status.
 * The transition is fenced, so a concurrent completion wins and this becomes a
 * no-op instead of resurrecting a finished run.
 */
async function refreshLease(input: {
  store: AppStore;
  run: Run;
  nowIso: string;
  leaseMs: number;
  reason: "workflow_active" | "workflow_status_unknown";
}): Promise<boolean> {
  const { store, run, nowIso, leaseMs, reason } = input;
  const leaseExpiresAt = new Date(Date.parse(nowIso) + leaseMs).toISOString();
  const transition = await store.runs.transitionRun({
    userId: run.userId,
    runId: run.id,
    expectedStatus: run.status,
    expectedFence: run.fence,
    status: run.status,
    leaseOwner: run.leaseOwner,
    leaseExpiresAt,
    event: {
      type: "lease_renewed",
      data: { reason, leaseExpiresAt },
      dedupeKey: `lease_renewed:${run.id}:${leaseExpiresAt}`,
    },
  });
  if (transition.outcome !== "applied") return false;
  await store.runs.upsertTimer({
    userId: run.userId,
    runId: run.id,
    kind: "lease_recovery",
    dueAt: leaseExpiresAt,
  });
  return true;
}

async function handleStartHandoff(input: {
  store: AppStore;
  run: Run;
  now: Date;
  startRun: StartRun;
  result: RecoverRunsResult;
}): Promise<void> {
  const { store, run, now, startRun, result } = input;
  if (run.status !== "queued") {
    result.skipped += 1;
    return;
  }

  if (run.workflowRunId && !isApprovalResume(run)) {
    // The workflow was already started; adopt it as running instead of
    // starting a second owner for the same logical run.
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
    await scheduleLeaseRecovery(store, run, leaseExpiresAt);
    const transition = await store.runs.transitionRun({
      userId: run.userId,
      runId: run.id,
      expectedStatus: "queued",
      expectedFence: run.fence,
      status: "running",
      workflowRunId: run.workflowRunId,
      leaseOwner: run.workflowRunId,
      leaseExpiresAt,
      botId: run.botId,
      event: {
        type: "reconciled",
        data: { reason: "start_handoff", workflowRunId: run.workflowRunId },
        dedupeKey: `reconciled:${run.id}`,
      },
      timers: [{ kind: "start_handoff", status: "cancelled" }],
    });
    if (transition.outcome === "applied") result.handoffReconciled += 1;
    else result.skipped += 1;
    return;
  }

  const action = run.actionId ? await store.getPendingAction(run.userId, run.actionId) : null;
  const actionLive =
    action !== null &&
    (action.status === "pending" || action.status === "resuming") &&
    !isPendingActionExpired(action, now);
  // A provider approval id is the signature the resumed workflow needs. Without
  // it the handoff must not start a fresh workflow with no approval context.
  const hasProviderApproval =
    typeof action?.providerApprovalId === "string" && action.providerApprovalId.length > 0;
  const resumable = actionLive && hasProviderApproval;
  if (isApprovalResume(run) && !resumable) {
    // An approval-resume handoff whose action is missing, terminal, past its
    // deadline, or missing its provider approval id must never start a fresh
    // workflow without provider approval context. Expire the queued run
    // instead of resurrecting it.
    await expireUnresumableHandoff({
      store,
      run,
      action,
      result,
      reason: actionLive && !hasProviderApproval ? "provider_approval_id_required" : "approval_unresumable",
    });
    return;
  }
  const started = await startRun(run, resumable ? action : null);
  if (started.status === "running") result.handoffRetried += 1;
  else result.skipped += 1;
}

/**
 * Expire a queued approval-resume handoff that can no longer be resumed. The
 * run, any still-pending action, and all timers are closed together so a later
 * tick cannot start a workflow with no approval context.
 */
async function expireUnresumableHandoff(input: {
  store: AppStore;
  run: Run;
  action: PendingAction | null;
  result: RecoverRunsResult;
  reason: "approval_unresumable" | "provider_approval_id_required";
}): Promise<void> {
  const { store, run, action, result, reason } = input;
  const related =
    action && (action.status === "pending" || action.status === "resuming") ? action : null;
  const transition = await store.runs.transitionRun({
    userId: run.userId,
    runId: run.id,
    expectedStatus: "queued",
    expectedFence: run.fence,
    status: "expired",
    error:
      reason === "provider_approval_id_required"
        ? "Approval is missing a provider approval id."
        : "Approval is no longer resumable.",
    leaseOwner: null,
    leaseExpiresAt: null,
    action: related ? { id: related.id, status: "expired" } : undefined,
    event: {
      type: "expired",
      data: { reason, actionId: action?.id ?? null },
      dedupeKey: `expired:${run.id}`,
    },
    timers: [
      { kind: "approval_timeout", status: "cancelled" },
      { kind: "lease_recovery", status: "cancelled" },
      { kind: "start_handoff", status: "cancelled" },
    ],
  });
  if (transition.outcome === "applied") result.approvalExpired += 1;
  else result.skipped += 1;
}

function isApprovalResume(run: Run): boolean {
  return run.trigger.kind === "approval" || run.actionId !== null;
}

async function findActionForRun(store: AppStore, run: Run): Promise<PendingAction | null> {
  const pending = await store.listPendingActions(run.userId, run.conversationId);
  const match = pending.find((action) => action.runId === run.id);
  if (match) return match;
  if (run.actionId) {
    const action = await store.getPendingAction(run.userId, run.actionId);
    if (action && (action.status === "pending" || action.status === "resuming") && !isPendingActionExpired(action)) return action;
  }
  return null;
}
