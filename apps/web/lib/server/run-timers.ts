import type { Run, RunTimerStatus } from "@slopbot/contracts";
import type { AppStore } from "@db/types";
import { START_HANDOFF_MS } from "@db/types";

/** Default lease refresh window; matches the existing 5 minute policy. */
export const LEASE_MS = 5 * 60_000;

/** Bounded deadline for a claimed run to hand off to the workflow runtime. */
export { START_HANDOFF_MS };

/** Explicit long horizon for a human approval decision. */
export const APPROVAL_TIMEOUT_MS = 7 * 24 * 60 * 60_000;

/**
 * Keep the start token unavailable long enough that a late duplicate cannot
 * start a second workflow run after the first one ends.
 */
export const START_HOOK_RETENTION_MS = 7 * 24 * 60 * 60_000;

export const TIMER_KINDS = ["start_handoff", "lease_recovery", "approval_timeout"] as const;

export type TimerPatch = { kind: string; status: RunTimerStatus };

export function cancelTimers(...kinds: string[]): TimerPatch[] {
  return kinds.map((kind) => ({ kind, status: "cancelled" as const }));
}

export function cancelAllTimers(): TimerPatch[] {
  return cancelTimers(...TIMER_KINDS);
}

export async function scheduleStartHandoff(store: AppStore, run: Run, now: Date): Promise<void> {
  await store.runs.upsertTimer({
    userId: run.userId,
    runId: run.id,
    kind: "start_handoff",
    dueAt: new Date(now.getTime() + START_HANDOFF_MS).toISOString(),
  });
}

export async function scheduleLeaseRecovery(
  store: AppStore,
  run: Run,
  leaseExpiresAt: string,
): Promise<void> {
  await store.runs.upsertTimer({
    userId: run.userId,
    runId: run.id,
    kind: "lease_recovery",
    dueAt: leaseExpiresAt,
  });
}

export async function scheduleApprovalTimeout(store: AppStore, run: Run, now: Date): Promise<void> {
  await store.runs.upsertTimer({
    userId: run.userId,
    runId: run.id,
    kind: "approval_timeout",
    dueAt: new Date(now.getTime() + APPROVAL_TIMEOUT_MS).toISOString(),
  });
}
