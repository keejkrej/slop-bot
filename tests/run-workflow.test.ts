import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HookConflictError, WorkflowStartError } from "workflow/errors";
import { FileStore } from "../db/file-store";
import type { ClaimRunResult } from "../db/types";
import { admitClaim, startToken, type AdmitClaimDeps, type StartWorkflow } from "../apps/web/lib/server/runs";
import { recoverRuns } from "../apps/web/lib/server/run-recovery";
import { approvalRequestOf, buildResumeMessages, failureTransitionFrom, isNoReply } from "../workflows/group-chat";

let directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

async function makeStore() {
  const directory = await mkdtemp(join(tmpdir(), "slop-workflow-"));
  directories.push(directory);
  return new FileStore(join(directory, "store.json"));
}

async function makeConversation(store: FileStore) {
  return store.createConversation("demo-user", { title: "Runs", botIds: ["bot_nova"] });
}

function claimed(result: ClaimRunResult) {
  if (result.outcome !== "claimed") throw new Error(`Expected claimed, got ${result.outcome}`);
  return result;
}

function deps(store: FileStore, startWorkflow: StartWorkflow): AdmitClaimDeps {
  return {
    store,
    startWorkflow,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    useGateway: true,
  };
}

async function awaitingApproval(store: FileStore) {
  const conversation = await makeConversation(store);
  const claim = claimed(
    await store.runs.claimRun({
      kind: "message",
      userId: "demo-user",
      conversationId: conversation.id,
      message: { senderType: "user", senderId: "demo-user", content: "Delete the memory file" },
    }),
  );
  const running = await store.runs.transitionRun({
    userId: "demo-user",
    runId: claim.run.id,
    expectedStatus: "queued",
    expectedFence: claim.run.fence,
    status: "running",
    workflowRunId: "wf_initial",
    leaseOwner: "wf_initial",
    leaseExpiresAt: "2026-01-01T00:05:00.000Z",
  });
  if (running.outcome !== "applied") throw new Error("Could not start run");
  const action = await store.createPendingAction({
    userId: "demo-user",
    conversationId: conversation.id,
    botId: "bot_nova",
    kind: "tool_approval",
    summary: "memory_delete notes/example.md",
    modelMessages: [{ role: "user", content: "Delete the memory file" }],
    runId: claim.run.id,
    providerApprovalId: "provider-approval-1",
  });
  const waiting = await store.runs.transitionRun({
    userId: "demo-user",
    runId: claim.run.id,
    expectedStatus: "running",
    expectedFence: running.run.fence,
    status: "awaiting_approval",
    leaseOwner: null,
    leaseExpiresAt: null,
  });
  if (waiting.outcome !== "applied") throw new Error("Could not await approval");
  return { conversation, run: waiting.run, action };
}

describe("run orchestration", () => {
  it("starts a message run once and treats a duplicate claim as idempotent", async () => {
    const store = await makeStore();
    const conversation = await makeConversation(store);
    const startWorkflow = vi.fn<StartWorkflow>(async (input) => ({ runId: `wf_${input.runId}` }));

    const first = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Hello" },
        idempotencyKey: "send-1",
      }),
    );
    const result = await admitClaim(first, deps(store, startWorkflow));

    expect(result.status).toBe("running");
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    const run = await store.runs.getRun("demo-user", result.runId);
    expect(run?.workflowRunId).toBe(`wf_${result.runId}`);
    expect(run?.leaseOwner).toBe(`wf_${result.runId}`);
    expect(run?.leaseExpiresAt).toBe("2026-01-01T00:05:00.000Z");

    const duplicate = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Hello" },
        idempotencyKey: "send-1",
      }),
    );
    const again = await admitClaim(duplicate, deps(store, startWorkflow));

    expect(again.runId).toBe(result.runId);
    expect(again.status).toBe("running");
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    expect(await store.listMessages("demo-user", conversation.id)).toHaveLength(1);
  });

  it("adopts the conflicting workflow owner when the stable start token is already held", async () => {
    const store = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Hello" },
      }),
    );
    const startWorkflow = vi.fn<StartWorkflow>(async () => {
      throw new HookConflictError(startToken(claim.run.id, claim.run.attempt), "wf_owner", { kind: "start" });
    });

    const result = await admitClaim(claim, deps(store, startWorkflow));

    expect(result.status).toBe("running");
    const run = await store.runs.getRun("demo-user", claim.run.id);
    expect(run?.workflowRunId).toBe("wf_owner");
    expect(run?.leaseOwner).toBe("wf_owner");
  });

  it("leaves an uncertain start queued with a durable start_handoff timer", async () => {
    const store = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Hello" },
      }),
    );
    const startWorkflow = vi.fn<StartWorkflow>(async () => {
      throw new WorkflowStartError("wf_candidate", "admission");
    });

    const result = await admitClaim(claim, deps(store, startWorkflow));

    expect(result.status).toBe("queued");
    expect((await store.runs.getRun("demo-user", claim.run.id))?.status).toBe("queued");
    const timers = await store.runs.claimDueTimers({ now: "2026-01-01T00:02:00.000Z" });
    expect(timers.map((timer) => timer.kind)).toContain("start_handoff");
  });

  it("recovery retries the queued handoff with the same attempt token", async () => {
    const store = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Hello" },
      }),
    );
    await admitClaim(
      claim,
      deps(store, async () => {
        throw new WorkflowStartError("wf_candidate", "queue");
      }),
    );

    const startRun = vi.fn(async (candidate: typeof claim.run) => {
      expect(candidate.attempt).toBe(0);
      const applied = await store.runs.transitionRun({
        userId: candidate.userId,
        runId: candidate.id,
        expectedStatus: "queued",
        expectedFence: candidate.fence,
        status: "running",
        workflowRunId: "wf_retried",
        leaseOwner: "wf_retried",
        leaseExpiresAt: "2026-01-01T00:10:00.000Z",
      });
      if (applied.outcome !== "applied") throw new Error("stale");
      return { runId: applied.run.id, status: applied.run.status, message: null, action: null };
    });

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:02:00.000Z"),
      startRun,
    });

    expect(result.handoffRetried).toBe(1);
    expect(startRun).toHaveBeenCalledTimes(1);
    expect((await store.runs.getRun("demo-user", claim.run.id))?.status).toBe("running");
  });

  it("uses a distinct start token for an approval resume attempt", async () => {
    const store = await makeStore();
    const { conversation, run, action } = await awaitingApproval(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "approval",
        userId: "demo-user",
        conversationId: conversation.id,
        actionId: action.id,
        decision: "approve",
      }),
    );
    const startWorkflow = vi.fn<StartWorkflow>(async (input) => ({ runId: `wf_${input.runId}` }));

    await admitClaim(claim, deps(store, startWorkflow));

    expect(startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        startToken: startToken(run.id, 1),
      }),
    );
    expect(startToken(run.id, 1)).not.toBe(startToken(run.id, 0));
  });

  it("does not start a second workflow for a duplicate approval request", async () => {
    const store = await makeStore();
    const { conversation, action } = await awaitingApproval(store);
    const idempotencyKey = `approval:${action.id}:approve`;
    const first = claimed(
      await store.runs.claimRun({
        kind: "approval",
        userId: "demo-user",
        conversationId: conversation.id,
        actionId: action.id,
        decision: "approve",
        idempotencyKey,
      }),
    );
    const startWorkflow = vi.fn<StartWorkflow>(async (input) => ({ runId: `wf_${input.runId}` }));

    await admitClaim(first, deps(store, startWorkflow));
    const duplicate = claimed(
      await store.runs.claimRun({
        kind: "approval",
        userId: "demo-user",
        conversationId: conversation.id,
        actionId: action.id,
        decision: "approve",
        idempotencyKey,
      }),
    );
    const again = await admitClaim(duplicate, deps(store, startWorkflow));

    expect(again.status).toBe("running");
    expect(startWorkflow).toHaveBeenCalledTimes(1);
  });

  it("marks the run failed and cancels the approval when the workflow cannot start", async () => {
    const store = await makeStore();
    const { conversation, run, action } = await awaitingApproval(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "approval",
        userId: "demo-user",
        conversationId: conversation.id,
        actionId: action.id,
        decision: "approve",
      }),
    );
    const startWorkflow = vi.fn<StartWorkflow>(async () => {
      throw new Error("workflow unavailable");
    });

    await expect(admitClaim(claim, deps(store, startWorkflow))).rejects.toThrow(/Could not start/);

    const failed = await store.runs.getRun("demo-user", run.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("workflow unavailable");
    expect(failed?.leaseOwner).toBeNull();
    expect((await store.getPendingAction("demo-user", action.id))?.status).toBe("cancelled");
    const projected = await store.getConversation("demo-user", conversation.id);
    expect(projected?.runStatus).toBe("failed");
    expect(projected?.activeRunId).toBeNull();
  });

  it("starts an approved run with the action id as resume context", async () => {
    const store = await makeStore();
    const { conversation, action } = await awaitingApproval(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "approval",
        userId: "demo-user",
        conversationId: conversation.id,
        actionId: action.id,
        decision: "approve",
      }),
    );
    const startWorkflow = vi.fn<StartWorkflow>(async (input) => ({ runId: `wf_${input.runId}` }));

    const result = await admitClaim(claim, deps(store, startWorkflow));

    expect(result.status).toBe("running");
    expect(startWorkflow).toHaveBeenCalledWith(expect.objectContaining({ resumeActionId: action.id }));
    expect((await store.getPendingAction("demo-user", action.id))?.status).toBe("resuming");
  });

  it("does not start a workflow for a denied approval", async () => {
    const store = await makeStore();
    const { conversation, action } = await awaitingApproval(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "approval",
        userId: "demo-user",
        conversationId: conversation.id,
        actionId: action.id,
        decision: "deny",
      }),
    );
    const startWorkflow = vi.fn<StartWorkflow>(async (input) => ({ runId: `wf_${input.runId}` }));

    const result = await admitClaim(claim, deps(store, startWorkflow));

    expect(result.status).toBe("cancelled");
    expect(startWorkflow).not.toHaveBeenCalled();
    expect((await store.getPendingAction("demo-user", action.id))?.status).toBe("cancelled");
  });

  it("claims a scheduled run without inserting a visible user message and passes the prompt to the workflow", async () => {
    const store = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "scheduled",
        userId: "demo-user",
        conversationId: conversation.id,
        trigger: { automationId: "auto-1", occurrenceAt: "2026-01-01T00:00:00.000Z", prompt: "Do the thing" },
      }),
    );
    expect(claim.message).toBeNull();
    expect(await store.listMessages("demo-user", conversation.id)).toHaveLength(0);

    const startWorkflow = vi.fn<StartWorkflow>(async (input) => ({ runId: `wf_${input.runId}` }));
    const result = await admitClaim(claim, deps(store, startWorkflow));

    expect(result.status).toBe("running");
    expect(startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduled: expect.objectContaining({ prompt: "Do the thing", automationId: "auto-1" }),
      }),
    );
  });

  it("projects awaiting_approval and clears the lease", async () => {
    const store = await makeStore();
    const { conversation, run } = await awaitingApproval(store);

    const projected = await store.getConversation("demo-user", conversation.id);
    expect(projected?.runStatus).toBe("awaiting_approval");
    expect(projected?.activeRunId).toBe(run.id);
    expect(run.leaseOwner).toBeNull();
    expect(run.leaseExpiresAt).toBeNull();
  });
});

describe("group-chat approval helpers", () => {
  it("builds resume context from original history and the provider approval id", () => {
    const messages = buildResumeMessages({
      modelMessages: [
        { role: "user", content: "Send it" },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "call_1", toolName: "memory_delete", input: { path: "notes/example.md" } },
          ],
        },
      ],
      providerApprovalId: "provider-123",
    });

    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: "tool",
      content: [{ type: "tool-approval-response", approvalId: "provider-123", approved: true }],
    });
  });

  it("parses manual approval input from toolCall.input and ignores automatic approvals", () => {
    const manual = approvalRequestOf({
      content: [
        {
          type: "tool-approval-request",
          approvalId: "approval-1",
          toolCall: { toolName: "memory_delete", input: { path: "notes/example.md" } },
        },
      ],
    });
    expect(manual?.approvalId).toBe("approval-1");
    expect(manual?.summary).toContain("notes/example.md");

    const automatic = approvalRequestOf({
      content: [
        {
          type: "tool-approval-request",
          approvalId: "approval-2",
          isAutomatic: true,
          toolCall: { toolName: "memory_delete", input: { path: "notes/example.md" } },
        },
      ],
    });
    expect(automatic).toBeNull();
  });

  it("treats only an exact trimmed NO_REPLY as silent", () => {
    expect(isNoReply(" NO_REPLY ")).toBe(true);
    expect(isNoReply("NO_REPLY please")).toBe(false);
    expect(isNoReply("")).toBe(false);
  });

  it("fails a run from running or awaiting_approval but never resurrects a terminal run", () => {
    expect(failureTransitionFrom("running")).toBe("running");
    expect(failureTransitionFrom("awaiting_approval")).toBe("awaiting_approval");
    expect(failureTransitionFrom("queued")).toBeNull();
    expect(failureTransitionFrom("succeeded")).toBeNull();
    expect(failureTransitionFrom("failed")).toBeNull();
    expect(failureTransitionFrom("cancelled")).toBeNull();
    expect(failureTransitionFrom("expired")).toBeNull();
  });
});
