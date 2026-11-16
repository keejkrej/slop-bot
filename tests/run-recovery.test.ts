import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Run } from "@slopbot/contracts";
import { FileStore } from "../db/file-store";
import type { ClaimRunResult, PendingAction } from "../db/types";
import { recoverRuns, type StartRun } from "../apps/web/lib/server/run-recovery";

let directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

async function makeStore() {
  const directory = await mkdtemp(join(tmpdir(), "slop-recovery-"));
  directories.push(directory);
  return new FileStore(join(directory, "store.json"));
}

async function makeConversation(store: FileStore) {
  return store.createConversation("demo-user", { title: "Recovery", botIds: ["bot_nova"] });
}

function claimed(result: ClaimRunResult) {
  if (result.outcome !== "claimed") throw new Error(`Expected claimed, got ${result.outcome}`);
  return result;
}

async function queuedRun(store: FileStore) {
  const conversation = await makeConversation(store);
  const claim = claimed(
    await store.runs.claimRun({
      kind: "message",
      userId: "demo-user",
      conversationId: conversation.id,
      message: { senderType: "user", senderId: "demo-user", content: "Go" },
    }),
  );
  return { conversation, run: claim.run };
}

async function runningRun(store: FileStore, leaseExpiresAt: string) {
  const { conversation, run } = await queuedRun(store);
  const running = await store.runs.transitionRun({
    userId: "demo-user",
    runId: run.id,
    expectedStatus: "queued",
    expectedFence: run.fence,
    status: "running",
    workflowRunId: "wf_1",
    leaseOwner: "wf_1",
    leaseExpiresAt,
  });
  if (running.outcome !== "applied") throw new Error("Could not start run");
  return { conversation, run: running.run };
}

async function awaitingApproval(store: FileStore) {
  const { conversation, run } = await runningRun(store, "2026-01-01T00:05:00.000Z");
  const action = await store.createPendingAction({
    userId: "demo-user",
    conversationId: conversation.id,
    botId: "bot_nova",
    kind: "tool_approval",
    summary: "memory_delete notes/example.md",
    modelMessages: [],
    runId: run.id,
    providerApprovalId: "provider-approval-1",
  });
  const waiting = await store.runs.transitionRun({
    userId: "demo-user",
    runId: run.id,
    expectedStatus: "running",
    expectedFence: run.fence,
    status: "awaiting_approval",
    leaseOwner: null,
    leaseExpiresAt: null,
  });
  if (waiting.outcome !== "applied") throw new Error("Could not await approval");
  return { conversation, run: waiting.run, action };
}

async function queuedApprovalRun(
  store: FileStore,
  options: { expiresAt?: string; now?: string; providerApprovalId?: string | null } = {},
) {
  const { conversation, run } = await runningRun(store, "2026-01-01T00:05:00.000Z");
  const action = await store.createPendingAction({
    userId: "demo-user",
    conversationId: conversation.id,
    botId: "bot_nova",
    kind: "tool_approval",
    summary: "memory_delete notes/example.md",
    modelMessages: [],
    runId: run.id,
    expiresAt: options.expiresAt ?? "2026-01-01T00:05:00.000Z",
    providerApprovalId: options.providerApprovalId ?? null,
  });
  const waiting = await store.runs.transitionRun({
    userId: "demo-user",
    runId: run.id,
    expectedStatus: "running",
    expectedFence: run.fence,
    status: "awaiting_approval",
    leaseOwner: null,
    leaseExpiresAt: null,
  });
  if (waiting.outcome !== "applied") throw new Error("Could not await approval");
  const approved = claimed(
    await store.runs.claimRun({
      kind: "approval",
      userId: "demo-user",
      conversationId: conversation.id,
      actionId: action.id,
      decision: "approve",
      now: options.now ?? "2026-01-01T00:00:00.000Z",
    }),
  );
  return { conversation, run: approved.run, action };
}

function startRunThatStarts(store: FileStore): StartRun {
  return vi.fn(async (candidate: Run) => {
    const applied = await store.runs.transitionRun({
      userId: candidate.userId,
      runId: candidate.id,
      expectedStatus: "queued",
      expectedFence: candidate.fence,
      status: "running",
      workflowRunId: `wf_${candidate.id}`,
      leaseOwner: `wf_${candidate.id}`,
      leaseExpiresAt: "2026-01-01T00:10:00.000Z",
    });
    if (applied.outcome !== "applied") throw new Error("stale");
    return { runId: applied.run.id, status: applied.run.status, message: null, action: null };
  });
}

describe("recoverRuns", () => {
  it("expires an awaiting_approval run and its pending action when the approval timer is due", async () => {
    const store = await makeStore();
    const { conversation, run, action } = await awaitingApproval(store);
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: run.id,
      kind: "approval_timeout",
      dueAt: "2026-01-01T00:10:00.000Z",
    });

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:11:00.000Z"),
      startRun: vi.fn(),
    });

    expect(result.timersClaimed).toBe(1);
    expect(result.approvalExpired).toBe(1);
    const expired = await store.runs.getRun("demo-user", run.id);
    expect(expired?.status).toBe("expired");
    expect(expired?.leaseOwner).toBeNull();
    expect(expired?.leaseExpiresAt).toBeNull();
    expect((await store.getPendingAction("demo-user", action.id))?.status).toBe("expired");
    const projected = await store.getConversation("demo-user", conversation.id);
    expect(projected?.runStatus).toBe("idle");
    expect(projected?.activeRunId).toBeNull();
    const events = await store.runs.listEvents("demo-user", run.id);
    expect(events.some((event) => event.type === "expired")).toBe(true);
    expect(await store.runs.claimDueTimers({ now: "2026-01-01T00:12:00.000Z" })).toHaveLength(0);
  });

  it("expires a running run whose lease is genuinely past", async () => {
    const store = await makeStore();
    const { run } = await runningRun(store, "2026-01-01T00:05:00.000Z");
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: run.id,
      kind: "lease_recovery",
      dueAt: "2026-01-01T00:05:00.000Z",
    });

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun: vi.fn(),
    });

    expect(result.leaseExpired).toBe(1);
    const expired = await store.runs.getRun("demo-user", run.id);
    expect(expired?.status).toBe("expired");
    expect(expired?.leaseOwner).toBeNull();
    expect(expired?.leaseExpiresAt).toBeNull();
  });

  it("does not expire a run whose lease is still in the future even if the timer is due", async () => {
    const store = await makeStore();
    const { run } = await runningRun(store, "2026-01-01T00:30:00.000Z");
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: run.id,
      kind: "lease_recovery",
      dueAt: "2026-01-01T00:05:00.000Z",
    });

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun: vi.fn(),
    });

    expect(result.leaseExpired).toBe(0);
    expect((await store.runs.getRun("demo-user", run.id))?.status).toBe("running");
  });

  it("does not touch completed runs with due timers", async () => {
    const store = await makeStore();
    const { run } = await runningRun(store, "2026-01-01T00:05:00.000Z");
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: run.id,
      kind: "lease_recovery",
      dueAt: "2026-01-01T00:05:00.000Z",
    });
    const done = await store.runs.transitionRun({
      userId: "demo-user",
      runId: run.id,
      expectedStatus: "running",
      expectedFence: run.fence,
      status: "succeeded",
    });
    expect(done.outcome).toBe("applied");
    const before = await store.runs.listEvents("demo-user", run.id);

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun: vi.fn(),
    });

    expect(result.leaseExpired).toBe(0);
    expect(result.approvalExpired).toBe(0);
    expect((await store.runs.getRun("demo-user", run.id))?.status).toBe("succeeded");
    expect(await store.runs.listEvents("demo-user", run.id)).toHaveLength(before.length);
  });

  it("retries a stuck queued handoff once with the injected admission seam", async () => {
    const store = await makeStore();
    const { run } = await queuedRun(store);
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: run.id,
      kind: "start_handoff",
      dueAt: "2026-01-01T00:05:00.000Z",
    });
    const startRun = startRunThatStarts(store);

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun,
    });

    expect(result.handoffRetried).toBe(1);
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(startRun.mock.calls[0]?.[0].id).toBe(run.id);
    const current = await store.runs.getRun("demo-user", run.id);
    expect(current?.status).toBe("running");
    expect(current?.workflowRunId).toBe(`wf_${run.id}`);
  });

  it("reconciles a queued run that already has a workflowRunId without starting a second workflow", async () => {
    const store = await makeStore();
    const { run } = await queuedRun(store);
    const patched = await store.runs.transitionRun({
      userId: "demo-user",
      runId: run.id,
      expectedStatus: "queued",
      expectedFence: run.fence,
      status: "queued",
      workflowRunId: "wf_existing",
    });
    expect(patched.outcome).toBe("applied");
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: run.id,
      kind: "start_handoff",
      dueAt: "2026-01-01T00:05:00.000Z",
    });
    const startRun = vi.fn();

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun,
    });

    expect(result.handoffReconciled).toBe(1);
    expect(startRun).not.toHaveBeenCalled();
    const current = await store.runs.getRun("demo-user", run.id);
    expect(current?.status).toBe("running");
    expect(current?.workflowRunId).toBe("wf_existing");
  });

  it("retries an approval-resumed handoff with the resuming action instead of adopting the stale workflow", async () => {
    const store = await makeStore();
    const { conversation, action } = await awaitingApproval(store);
    const approved = claimed(
      await store.runs.claimRun({
        kind: "approval",
        userId: "demo-user",
        conversationId: conversation.id,
        actionId: action.id,
        decision: "approve",
      }),
    );
    expect(approved.run.status).toBe("queued");
    expect(approved.run.workflowRunId).toBe("wf_1");
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: approved.run.id,
      kind: "start_handoff",
      dueAt: "2026-01-01T00:05:00.000Z",
    });
    const startRun = vi.fn(async (candidate: Run, resumeAction: PendingAction | null) => {
      expect(resumeAction?.id).toBe(action.id);
      const applied = await store.runs.transitionRun({
        userId: candidate.userId,
        runId: candidate.id,
        expectedStatus: "queued",
        expectedFence: candidate.fence,
        status: "running",
        workflowRunId: "wf_resumed",
        leaseOwner: "wf_resumed",
        leaseExpiresAt: "2026-01-01T00:10:00.000Z",
      });
      if (applied.outcome !== "applied") throw new Error("stale");
      return { runId: applied.run.id, status: applied.run.status, message: null, action: resumeAction };
    });

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun,
    });

    expect(result.handoffRetried).toBe(1);
    expect(result.handoffReconciled).toBe(0);
    expect(startRun).toHaveBeenCalledTimes(1);
    const current = await store.runs.getRun("demo-user", approved.run.id);
    expect(current?.status).toBe("running");
    expect(current?.workflowRunId).toBe("wf_resumed");
  });

  it("expires a queued approval handoff whose action deadline passed instead of starting a workflow", async () => {
    const store = await makeStore();
    const { conversation, run, action } = await queuedApprovalRun(store, {
      expiresAt: "2026-01-01T00:05:00.000Z",
      now: "2026-01-01T00:00:00.000Z",
    });
    const startRun = vi.fn();

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun,
    });

    expect(startRun).not.toHaveBeenCalled();
    expect(result.approvalExpired).toBe(1);
    const expired = await store.runs.getRun("demo-user", run.id);
    expect(expired?.status).toBe("expired");
    expect(expired?.leaseOwner).toBeNull();
    expect(expired?.leaseExpiresAt).toBeNull();
    expect((await store.getPendingAction("demo-user", action.id))?.status).toBe("expired");
    const projected = await store.getConversation("demo-user", conversation.id);
    expect(projected?.runStatus).toBe("idle");
    expect(projected?.activeRunId).toBeNull();
    const events = await store.runs.listEvents("demo-user", run.id);
    expect(
      events.some(
        (event) =>
          event.type === "expired" &&
          (event.data as { reason?: string } | null)?.reason === "approval_unresumable",
      ),
    ).toBe(true);
    expect(await store.runs.claimDueTimers({ now: "2026-01-01T00:07:00.000Z" })).toHaveLength(0);
  });

  it("expires a queued approval handoff whose provider approval id is null", async () => {
    const store = await makeStore();
    const { conversation, run, action } = await queuedApprovalRun(store, {
      expiresAt: "2026-01-02T00:00:00.000Z",
      providerApprovalId: null,
    });
    const startRun = vi.fn();

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun,
    });

    expect(startRun).not.toHaveBeenCalled();
    expect(result.approvalExpired).toBe(1);
    const expired = await store.runs.getRun("demo-user", run.id);
    expect(expired?.status).toBe("expired");
    expect(expired?.leaseOwner).toBeNull();
    expect(expired?.leaseExpiresAt).toBeNull();
    expect((await store.getPendingAction("demo-user", action.id))?.status).toBe("expired");
    const projected = await store.getConversation("demo-user", conversation.id);
    expect(projected?.runStatus).toBe("idle");
    expect(projected?.activeRunId).toBeNull();
    const events = await store.runs.listEvents("demo-user", run.id);
    expect(
      events.some(
        (event) =>
          event.type === "expired" &&
          (event.data as { reason?: string } | null)?.reason === "provider_approval_id_required",
      ),
    ).toBe(true);
    expect(await store.runs.claimDueTimers({ now: "2026-01-01T00:07:00.000Z" })).toHaveLength(0);
  });

  it("expires a queued approval handoff whose provider approval id is absent", async () => {
    const store = await makeStore();
    const { run, action } = await queuedApprovalRun(store, {
      expiresAt: "2026-01-02T00:00:00.000Z",
    });
    const startRun = vi.fn();

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun,
    });

    expect(startRun).not.toHaveBeenCalled();
    expect(result.approvalExpired).toBe(1);
    expect((await store.runs.getRun("demo-user", run.id))?.status).toBe("expired");
    expect((await store.getPendingAction("demo-user", action.id))?.status).toBe("expired");
  });

  it("resumes a non-expired approval handoff with a provider approval id", async () => {
    const store = await makeStore();
    const { run, action } = await queuedApprovalRun(store, {
      expiresAt: "2026-01-02T00:00:00.000Z",
      providerApprovalId: "provider-approval-1",
    });
    const startRun = vi.fn(async (candidate: Run, resumeAction: PendingAction | null) => {
      expect(resumeAction?.providerApprovalId).toBe("provider-approval-1");
      const applied = await store.runs.transitionRun({
        userId: candidate.userId,
        runId: candidate.id,
        expectedStatus: "queued",
        expectedFence: candidate.fence,
        status: "running",
        workflowRunId: "wf_resumed",
        leaseOwner: "wf_resumed",
        leaseExpiresAt: "2026-01-01T00:10:00.000Z",
      });
      if (applied.outcome !== "applied") throw new Error("stale");
      return { runId: applied.run.id, status: applied.run.status, message: null, action: resumeAction };
    });

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun,
    });

    expect(result.handoffRetried).toBe(1);
    expect(startRun).toHaveBeenCalledTimes(1);
    expect((await store.runs.getRun("demo-user", run.id))?.status).toBe("running");
    expect((await store.getPendingAction("demo-user", action.id))?.status).toBe("resuming");
  });

  it("does not start a queued approval handoff whose action already completed", async () => {
    const store = await makeStore();
    const { run, action } = await queuedApprovalRun(store);
    await store.setPendingActionStatus("demo-user", action.id, "completed");
    const startRun = vi.fn();

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun,
    });

    expect(startRun).not.toHaveBeenCalled();
    expect(result.approvalExpired).toBe(1);
    expect((await store.runs.getRun("demo-user", run.id))?.status).toBe("expired");
    // A terminal action is never rewritten.
    expect((await store.getPendingAction("demo-user", action.id))?.status).toBe("completed");
  });

  it("does not start a queued approval handoff whose action is missing", async () => {
    const store = await makeStore();
    const { run } = await queuedApprovalRun(store);
    const missingActionStore = {
      ...store,
      getPendingAction: async () => null,
    } as unknown as FileStore;
    const startRun = vi.fn();

    const result = await recoverRuns({
      store: missingActionStore,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun,
    });

    expect(startRun).not.toHaveBeenCalled();
    expect(result.approvalExpired).toBe(1);
    expect((await store.runs.getRun("demo-user", run.id))?.status).toBe("expired");
  });

  it("safety net expires a running run with an expired lease but no timer row", async () => {
    const store = await makeStore();
    const { run } = await runningRun(store, "2026-01-01T00:05:00.000Z");

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun: vi.fn(),
    });

    expect(result.safetyNetExpired).toBe(1);
    expect((await store.runs.getRun("demo-user", run.id))?.status).toBe("expired");
  });

  it("safety net does not scan when no lease is due", async () => {
    const store = await makeStore();
    const { run } = await runningRun(store, "2026-01-01T00:30:00.000Z");

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun: vi.fn(),
    });

    expect(result.safetyNetExpired).toBe(0);
    expect((await store.runs.getRun("demo-user", run.id))?.status).toBe("running");
  });

  it("one failing timer does not abort the rest of the batch", async () => {
    const store = await makeStore();
    const { run: handoffRun } = await queuedRun(store);
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: handoffRun.id,
      kind: "start_handoff",
      dueAt: "2026-01-01T00:05:00.000Z",
    });
    const { run: approvalRun, action } = await awaitingApproval(store);
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: approvalRun.id,
      kind: "approval_timeout",
      dueAt: "2026-01-01T00:05:00.000Z",
    });
    const startRun = vi.fn(async () => {
      throw new Error("boom");
    });

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun,
    });

    expect(result.errors).toBe(1);
    expect(result.approvalExpired).toBe(1);
    expect((await store.runs.getRun("demo-user", approvalRun.id))?.status).toBe("expired");
    expect((await store.getPendingAction("demo-user", action.id))?.status).toBe("expired");
  });

  it("releases a failed timer back to pending so a later tick retries it", async () => {
    const store = await makeStore();
    const { run } = await queuedRun(store);
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: run.id,
      kind: "start_handoff",
      dueAt: "2026-01-01T00:05:00.000Z",
    });

    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    const first = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun: failing,
    });
    expect(first.errors).toBe(1);
    expect(failing).toHaveBeenCalledTimes(1);

    // The timer is pending again but not due until the bounded retry delay.
    expect(await store.runs.claimDueTimers({ now: "2026-01-01T00:06:29.000Z" })).toHaveLength(0);

    const retry = startRunThatStarts(store);
    const second = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:31.000Z"),
      startRun: retry,
    });
    expect(second.handoffRetried).toBe(1);
    expect(retry).toHaveBeenCalledTimes(1);
    expect((await store.runs.getRun("demo-user", run.id))?.status).toBe("running");
  });

  it("respects the due cutoff and the batch limit", async () => {
    const store = await makeStore();
    const { run: a } = await queuedRun(store);
    const { run: b } = await queuedRun(store);
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: a.id,
      kind: "start_handoff",
      dueAt: "2026-01-01T00:05:00.000Z",
    });
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: b.id,
      kind: "start_handoff",
      dueAt: "2026-01-01T00:30:00.000Z",
    });
    const startRun = startRunThatStarts(store);

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      limit: 1,
      startRun,
    });

    expect(result.timersClaimed).toBe(1);
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(startRun.mock.calls[0]?.[0].id).toBe(a.id);
    expect((await store.runs.getRun("demo-user", b.id))?.status).toBe("queued");
  });

  it("recovers a claimed run from its atomic handoff timer before admission", async () => {
    const store = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Go" },
        now: "2026-01-01T00:00:00.000Z",
      }),
    );
    // No admit and no lease: the atomic timer is the only recovery path.
    const startRun = startRunThatStarts(store);

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:02:00.000Z"),
      startRun,
    });

    expect(result.timersClaimed).toBe(1);
    expect(result.handoffRetried).toBe(1);
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(startRun.mock.calls[0]?.[0].id).toBe(claim.run.id);
    expect((await store.runs.getRun("demo-user", claim.run.id))?.status).toBe("running");
  });

  it("renews the lease of a running run whose workflow is still active", async () => {
    const store = await makeStore();
    const { run } = await runningRun(store, "2026-01-01T00:05:00.000Z");
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: run.id,
      kind: "lease_recovery",
      dueAt: "2026-01-01T00:05:00.000Z",
    });
    const getWorkflowStatus = vi.fn(async () => "running" as const);

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun: vi.fn(),
      getWorkflowStatus,
    });

    expect(result.leaseRenewed).toBe(1);
    expect(result.leaseExpired).toBe(0);
    expect(getWorkflowStatus).toHaveBeenCalledWith("wf_1");
    const current = await store.runs.getRun("demo-user", run.id);
    expect(current?.status).toBe("running");
    expect(current?.leaseExpiresAt).toBe("2026-01-01T00:11:00.000Z");
    // The recovery timer was refreshed, not duplicated.
    expect(await store.runs.claimDueTimers({ now: "2026-01-01T00:10:59.000Z" })).toHaveLength(0);
    expect(
      (await store.runs.claimDueTimers({ now: "2026-01-01T00:11:00.000Z" })).map((timer) => timer.kind),
    ).toEqual(["lease_recovery"]);
  });

  it("expires a running run once its workflow is terminal", async () => {
    const store = await makeStore();
    const { run } = await runningRun(store, "2026-01-01T00:05:00.000Z");
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: run.id,
      kind: "lease_recovery",
      dueAt: "2026-01-01T00:05:00.000Z",
    });

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun: vi.fn(),
      getWorkflowStatus: async () => "completed",
    });

    expect(result.leaseExpired).toBe(1);
    expect(result.leaseRenewed).toBe(0);
    expect((await store.runs.getRun("demo-user", run.id))?.status).toBe("expired");
  });

  it("expires a running run when the workflow owner is absent", async () => {
    const store = await makeStore();
    const { run } = await runningRun(store, "2026-01-01T00:05:00.000Z");
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: run.id,
      kind: "lease_recovery",
      dueAt: "2026-01-01T00:05:00.000Z",
    });
    const { WorkflowRunNotFoundError } = await import("workflow/errors");

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun: vi.fn(),
      getWorkflowStatus: async () => {
        throw new WorkflowRunNotFoundError("wf_1");
      },
    });

    expect(result.leaseExpired).toBe(1);
    expect((await store.runs.getRun("demo-user", run.id))?.status).toBe("expired");
  });

  it("does not expire a running run when the workflow status lookup fails, and backs off", async () => {
    const store = await makeStore();
    const { run } = await runningRun(store, "2026-01-01T00:05:00.000Z");
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: run.id,
      kind: "lease_recovery",
      dueAt: "2026-01-01T00:05:00.000Z",
    });

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun: vi.fn(),
      getWorkflowStatus: async () => {
        throw new Error("network down");
      },
    });

    expect(result.leaseRenewalErrors).toBe(1);
    expect(result.leaseExpired).toBe(0);
    expect((await store.runs.getRun("demo-user", run.id))?.status).toBe("running");
    // The timer backed off instead of hot-looping.
    expect(await store.runs.claimDueTimers({ now: "2026-01-01T00:06:29.000Z" })).toHaveLength(0);
    expect(
      (await store.runs.claimDueTimers({ now: "2026-01-01T00:06:30.000Z" })).map((timer) => timer.kind),
    ).toEqual(["lease_recovery"]);
  });
});
