import { getStore } from "@db/store";
import type { RunStatus } from "@slopbot/contracts";
import type { ScheduledRunStart, ScheduledRunStarter } from "./automations";
import { runService } from "./effect";
import { ApiError } from "./http";
import { startScheduledRun, type RunStartResult } from "./runs";

/**
 * Map an admitted run's durable status to the scheduler's outcome. A terminal
 * failure must surface as a failed occurrence, and an already-succeeded run is
 * an idempotent duplicate rather than a fresh start.
 */
export function scheduledStartOutcome(
  result: Pick<RunStartResult, "runId" | "status">,
  workflowRunId: string | null,
): ScheduledRunStart {
  const status: RunStatus = result.status;
  if (status === "failed" || status === "cancelled" || status === "expired") {
    return { outcome: "failed", error: `Scheduled run ended ${status}.` };
  }
  if (status === "succeeded") {
    return { outcome: "duplicate", runId: result.runId, status, workflowRunId };
  }
  // queued/running/awaiting_approval are admitted; an uncertain queued handoff
  // is retried by durable recovery.
  return { outcome: "started", runId: result.runId, status, workflowRunId };
}

/**
 * Production adapter for the automation scheduler. It delegates to the shared
 * `startScheduledRun` admission path in runs.ts so there is exactly one
 * claim-and-start implementation.
 */
export const scheduledRunStarter: ScheduledRunStarter = async (input) => {
  try {
    const result = await runService(
      startScheduledRun(input.userId, input.conversationId, input.trigger, {
        idempotencyKey: input.idempotencyKey,
      }),
    );
    const run = await getStore().runs.getRun(input.userId, result.runId);
    return scheduledStartOutcome(result, run?.workflowRunId ?? null);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      // Only the conversation-busy conflict is retryable; an idempotency
      // conflict is a real failure and must not be retried as busy forever.
      if (/already responding/i.test(error.message)) return { outcome: "busy" };
      return { outcome: "failed", error: error.message };
    }
    return {
      outcome: "failed",
      error: error instanceof Error ? error.message : "Could not start the scheduled run.",
    };
  }
};
