import { boundDesktopResult, redactDesktopText } from "@db/desktop-result";
import type { AppStore } from "@db/types";
import { hookTokenForJob } from "@workflows/desktop-tools";

export type DesktopJobResultInput = {
  deviceId: string;
  ok: boolean;
  output?: unknown;
  error?: string;
};

export type DesktopJobDeliveryOutcome = {
  status: number;
  body: {
    ok: boolean;
    delivered: boolean;
    reason?: string;
    error?: string;
  };
};

/**
 * Record a desktop result and deliver it to the waiting workflow hook.
 *
 * Job execution and hook delivery are tracked separately: a completed job can
 * be re-posted to retry delivery, and a job whose result was already delivered
 * is acknowledged without resuming the hook again. Delivery is at-least-once;
 * the stored delivery status is the evidence.
 */
export async function recordDesktopJobResult(input: {
  store: AppStore;
  userId: string;
  jobId: string;
  result: DesktopJobResultInput;
  resume: (token: string, payload: unknown) => Promise<unknown>;
  isHookMissing?: (error: unknown) => boolean;
}): Promise<DesktopJobDeliveryOutcome> {
  const { store, userId, jobId, result, resume } = input;
  const job = await store.getDesktopJob(userId, jobId);
  if (!job || job.deviceId !== result.deviceId) {
    return { status: 404, body: { ok: false, delivered: false, error: "Desktop job not found." } };
  }

  let current = job;
  if (current.status === "pending") {
    const completed = await store.completeDesktopJob(
      userId,
      jobId,
      {
        ok: result.ok,
        output: result.ok ? boundDesktopResult(result.output) : undefined,
        error: result.ok
          ? undefined
          : redactDesktopText(result.error ?? "Desktop tool failed.").slice(0, 1_000),
      },
      result.deviceId,
    );
    if (completed) {
      current = completed;
    } else {
      const reread = await store.getDesktopJob(userId, jobId);
      if (!reread) {
        return { status: 404, body: { ok: false, delivered: false, error: "Desktop job not found." } };
      }
      if (reread.status === "pending") {
        return {
          status: 409,
          body: { ok: false, delivered: false, error: "Desktop job is already claimed." },
        };
      }
      current = reread;
    }
  }

  if (current.status === "expired") {
    return { status: 200, body: { ok: true, delivered: false, reason: "expired" } };
  }
  if (current.deliveryStatus === "delivered") {
    return { status: 200, body: { ok: true, delivered: true } };
  }

  try {
    await resume(hookTokenForJob(current), {
      ok: current.status === "completed",
      output: current.output,
      error: current.error,
    });
    await store.markDesktopJobDelivery(userId, jobId, { status: "delivered" });
    return { status: 200, body: { ok: true, delivered: true } };
  } catch (error) {
    const message = redactDesktopText(
      error instanceof Error ? error.message : "Could not deliver desktop result.",
    ).slice(0, 1_000);
    await store.markDesktopJobDelivery(userId, jobId, { status: "failed", error: message });
    if (input.isHookMissing?.(error)) {
      // The workflow is no longer waiting. Keep the stored result and stop
      // retrying instead of stalling the bridge forever.
      return { status: 200, body: { ok: true, delivered: false, reason: "hook_unavailable" } };
    }
    return { status: 503, body: { ok: false, delivered: false, error: message } };
  }
}
