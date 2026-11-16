import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore } from "../db/file-store";
import { StoreDomainError, type ClaimRunResult } from "../db/types";
import { normalizeError } from "../apps/web/lib/server/effect";

let directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

async function makeStore() {
  const directory = await mkdtemp(join(tmpdir(), "slop-runs-"));
  directories.push(directory);
  return { store: new FileStore(join(directory, "store.json")), directory };
}

async function makeConversation(store: FileStore) {
  return store.createConversation("demo-user", { title: "Runs", botIds: ["bot_nova"] });
}

function claimed(result: ClaimRunResult) {
  if (result.outcome !== "claimed") throw new Error(`Expected claimed, got ${result.outcome}`);
  return result;
}

async function awaitingApproval(store: FileStore) {
  const conversation = await makeConversation(store);
  const claim = claimed(
    await store.runs.claimRun({
      kind: "message",
      userId: "demo-user",
      conversationId: conversation.id,
      message: { senderType: "user", senderId: "demo-user", content: "Send the email" },
    }),
  );
  const running = await store.runs.transitionRun({
    userId: "demo-user",
    runId: claim.run.id,
    expectedStatus: "queued",
    expectedFence: claim.run.fence,
    status: "running",
  });
  if (running.outcome !== "applied") throw new Error("Could not start run");
  const action = await store.createPendingAction({
    userId: "demo-user",
    conversationId: conversation.id,
    botId: "bot_nova",
    kind: "tool_approval",
    summary: "send_email to owner@example.com",
    modelMessages: [],
    runId: claim.run.id,
  });
  const waiting = await store.runs.transitionRun({
    userId: "demo-user",
    runId: claim.run.id,
    expectedStatus: "running",
    expectedFence: running.run.fence,
    status: "awaiting_approval",
  });
  if (waiting.outcome !== "applied") throw new Error("Could not await approval");
  return { conversation, run: waiting.run, action };
}

describe("FileStore run store", () => {
  it("creates an atomic start_handoff timer with a new claim and not on an idempotent replay", async () => {
    const { store, directory } = await makeStore();
    const conversation = await makeConversation(store);

    const first = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Hello" },
        idempotencyKey: "send-atomic",
        now: "2026-01-01T00:00:00.000Z",
      }),
    );

    const readTimers = async () => {
      const raw = JSON.parse(await readFile(join(directory, "store.json"), "utf8")) as {
        runTimers: Array<{ runId: string; kind: string; dueAt: string; status: string }>;
      };
      return raw.runTimers.filter((timer) => timer.runId === first.run.id);
    };

    const timers = await readTimers();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.kind).toBe("start_handoff");
    expect(timers[0]?.dueAt).toBe("2026-01-01T00:01:00.000Z");
    expect(timers[0]?.status).toBe("pending");

    // An idempotent replay must not add a second timer.
    claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Hello" },
        idempotencyKey: "send-atomic",
        now: "2026-01-01T00:00:30.000Z",
      }),
    );
    expect(await readTimers()).toHaveLength(1);
  });

  it("refreshes the handoff timer on approval and leaves it untouched on deny", async () => {
    const { store, directory } = await makeStore();
    const { conversation, run, action } = await awaitingApproval(store);

    const readTimers = async () => {
      const raw = JSON.parse(await readFile(join(directory, "store.json"), "utf8")) as {
        runTimers: Array<{ runId: string; kind: string; dueAt: string; status: string }>;
      };
      return raw.runTimers.filter((timer) => timer.runId === run.id);
    };

    const before = await readTimers();
    expect(before).toHaveLength(1);

    const approved = claimed(
      await store.runs.claimRun({
        kind: "approval",
        userId: "demo-user",
        conversationId: conversation.id,
        actionId: action.id,
        decision: "approve",
        now: "2026-01-01T00:20:00.000Z",
      }),
    );
    expect(approved.run.status).toBe("queued");
    const afterApprove = await readTimers();
    expect(afterApprove).toHaveLength(1);
    expect(afterApprove[0]?.dueAt).toBe("2026-01-01T00:21:00.000Z");
    expect(afterApprove[0]?.status).toBe("pending");

    // A denied approval never creates a new handoff timer.
    const denied = await awaitingApproval(store);
    const deniedBefore = (await readTimers()).length;
    claimed(
      await store.runs.claimRun({
        kind: "approval",
        userId: "demo-user",
        conversationId: denied.conversation.id,
        actionId: denied.action.id,
        decision: "deny",
        now: "2026-01-01T00:30:00.000Z",
      }),
    );
    const raw = JSON.parse(await readFile(join(directory, "store.json"), "utf8")) as {
      runTimers: Array<{ runId: string; kind: string }>;
    };
    expect(raw.runTimers.filter((timer) => timer.runId === denied.run.id)).toHaveLength(deniedBefore);
  });

  it("claims a message turn atomically and dedupes a duplicate idempotency key", async () => {
    const { store } = await makeStore();
    const conversation = await makeConversation(store);

    const first = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Hello" },
        idempotencyKey: "send-1",
      }),
    );
    expect(first.run.status).toBe("queued");
    expect(first.run.fence).toBe(0);
    expect(first.message?.content).toBe("Hello");

    const duplicate = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Hello" },
        idempotencyKey: "send-1",
      }),
    );
    expect(duplicate.run.id).toBe(first.run.id);
    expect(duplicate.message?.id).toBe(first.message?.id);

    expect(await store.listMessages("demo-user", conversation.id)).toHaveLength(1);
    const projected = await store.getConversation("demo-user", conversation.id);
    expect(projected?.runStatus).toBe("queued");
    expect(projected?.activeRunId).toBe(first.run.id);
  });

  it("serializes concurrent claims for one conversation into one claimed and one busy", async () => {
    const { store } = await makeStore();
    const conversation = await makeConversation(store);

    const [a, b] = await Promise.all([
      store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "First" },
      }),
      store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Second" },
      }),
    ]);

    expect([a.outcome, b.outcome].sort()).toEqual(["busy", "claimed"]);
    expect(await store.listMessages("demo-user", conversation.id)).toHaveLength(1);
  });

  it("rejects stale status/fence writes and advances the fence on success", async () => {
    const { store } = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Go" },
      }),
    );

    const applied = await store.runs.transitionRun({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "queued",
      expectedFence: claim.run.fence,
      status: "running",
    });
    expect(applied.outcome).toBe("applied");
    if (applied.outcome !== "applied") return;
    expect(applied.run.status).toBe("running");
    expect(applied.run.fence).toBe(claim.run.fence + 1);

    const stale = await store.runs.transitionRun({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "queued",
      expectedFence: claim.run.fence,
      status: "failed",
    });
    expect(stale.outcome).toBe("stale");
    expect((await store.runs.getRun("demo-user", claim.run.id))?.status).toBe("running");
  });

  it("projects terminal runs back to idle and frees the conversation slot", async () => {
    const { store } = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Go" },
      }),
    );
    const running = await store.runs.transitionRun({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "queued",
      expectedFence: claim.run.fence,
      status: "running",
    });
    if (running.outcome !== "applied") throw new Error("Could not start run");

    const done = await store.runs.transitionRun({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "running",
      expectedFence: running.run.fence,
      status: "succeeded",
      event: { type: "succeeded", data: { ok: true } },
    });
    expect(done.outcome).toBe("applied");
    if (done.outcome !== "applied") return;
    expect(done.event?.seq).toBe(1);
    expect(done.event?.type).toBe("succeeded");

    const projected = await store.getConversation("demo-user", conversation.id);
    expect(projected?.runStatus).toBe("idle");
    expect(projected?.activeRunId).toBeNull();

    const next = await store.runs.claimRun({
      kind: "message",
      userId: "demo-user",
      conversationId: conversation.id,
      message: { senderType: "user", senderId: "demo-user", content: "Again" },
    });
    expect(next.outcome).toBe("claimed");
  });

  it("assigns monotonic per-run event sequence numbers and dedupes by key", async () => {
    const { store } = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Go" },
      }),
    );

    const first = await store.runs.appendEvent({
      userId: "demo-user",
      runId: claim.run.id,
      type: "log",
      data: { step: 1 },
      dedupeKey: "step-1",
    });
    const duplicate = await store.runs.appendEvent({
      userId: "demo-user",
      runId: claim.run.id,
      type: "log",
      data: { step: 1 },
      dedupeKey: "step-1",
    });
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.seq).toBe(first.seq);

    const second = await store.runs.appendEvent({
      userId: "demo-user",
      runId: claim.run.id,
      type: "log",
      data: { step: 2 },
    });
    expect(second.seq).toBe(first.seq + 1);

    const events = await store.runs.listEvents("demo-user", claim.run.id);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("claims only due timers and never re-claims them", async () => {
    const { store } = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Go" },
      }),
    );

    const due = await store.runs.upsertTimer({
      userId: "demo-user",
      runId: claim.run.id,
      kind: "lease_recovery",
      dueAt: "2020-01-01T00:00:00.000Z",
    });
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: claim.run.id,
      kind: "future",
      dueAt: "2030-01-01T00:00:00.000Z",
    });

    const claimedTimers = await store.runs.claimDueTimers({ now: "2020-01-02T00:00:00.000Z" });
    expect(claimedTimers.map((timer) => timer.id)).toEqual([due.id]);
    expect(claimedTimers[0]?.status).toBe("claimed");

    const again = await store.runs.claimDueTimers({ now: "2020-01-02T00:00:00.000Z" });
    expect(again).toHaveLength(0);
  });

  it("approves a pending action, resuming the same logical run with a new attempt and fence", async () => {
    const { store } = await makeStore();
    const { conversation, run, action } = await awaitingApproval(store);

    const approved = claimed(
      await store.runs.claimRun({
        kind: "approval",
        userId: "demo-user",
        conversationId: conversation.id,
        actionId: action.id,
        decision: "approve",
      }),
    );
    expect(approved.run.id).toBe(run.id);
    expect(approved.run.status).toBe("queued");
    expect(approved.run.attempt).toBe(1);
    expect(approved.run.fence).toBe(run.fence + 1);
    expect(approved.action?.status).toBe("resuming");

    const projected = await store.getConversation("demo-user", conversation.id);
    expect(projected?.runStatus).toBe("queued");
    expect(projected?.activeRunId).toBe(run.id);
  });

  it("denies a pending action, cancelling the run and recording denial context", async () => {
    const { store } = await makeStore();
    const { conversation, run, action } = await awaitingApproval(store);

    const denied = claimed(
      await store.runs.claimRun({
        kind: "approval",
        userId: "demo-user",
        conversationId: conversation.id,
        actionId: action.id,
        decision: "deny",
      }),
    );
    expect(denied.run.status).toBe("cancelled");
    expect(denied.action?.status).toBe("cancelled");

    const projected = await store.getConversation("demo-user", conversation.id);
    expect(projected?.runStatus).toBe("idle");
    expect(projected?.activeRunId).toBeNull();

    const messages = await store.listMessages("demo-user", conversation.id);
    expect(messages.some((message) => message.senderType === "system" && /denied/i.test(message.content))).toBe(true);
    expect((await store.runs.getRun("demo-user", run.id))?.status).toBe("cancelled");
  });

  it("rejects a second resolution of the same approval", async () => {
    const { store } = await makeStore();
    const { conversation, action } = await awaitingApproval(store);

    expect(
      (
        await store.runs.claimRun({
          kind: "approval",
          userId: "demo-user",
          conversationId: conversation.id,
          actionId: action.id,
          decision: "approve",
        })
      ).outcome,
    ).toBe("claimed");

    expect(
      (
        await store.runs.claimRun({
          kind: "approval",
          userId: "demo-user",
          conversationId: conversation.id,
          actionId: action.id,
          decision: "deny",
        })
      ).outcome,
    ).toBe("approval_missing");
  });

  it("refuses approval when the run already failed to start", async () => {
    const { store } = await makeStore();
    const { conversation, run, action } = await awaitingApproval(store);

    const failed = await store.runs.transitionRun({
      userId: "demo-user",
      runId: run.id,
      expectedStatus: "awaiting_approval",
      expectedFence: run.fence,
      status: "failed",
      error: "start failed",
    });
    expect(failed.outcome).toBe("applied");

    const result = await store.runs.claimRun({
      kind: "approval",
      userId: "demo-user",
      conversationId: conversation.id,
      actionId: action.id,
      decision: "approve",
    });
    expect(result.outcome).toBe("cancelled");
  });

  it("persists runId and providerApprovalId on pending actions", async () => {
    const { store } = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Send" },
      }),
    );

    const action = await store.createPendingAction({
      userId: "demo-user",
      conversationId: conversation.id,
      botId: "bot_nova",
      kind: "tool_approval",
      summary: "send_email",
      modelMessages: [{ role: "user", content: "Send it" }],
      runId: claim.run.id,
      providerApprovalId: "provider-approval-123",
    });

    const loaded = await store.getPendingAction("demo-user", action.id);
    expect(loaded?.runId).toBe(claim.run.id);
    expect(loaded?.providerApprovalId).toBe("provider-approval-123");
    // The provider approval id is distinct from the database action id.
    expect(loaded?.providerApprovalId).not.toBe(loaded?.id);
  });

  it("initializes legacy store files that predate run persistence", async () => {
    const { store, directory } = await makeStore();
    const conversation = await makeConversation(store);
    const action = await store.createPendingAction({
      userId: "demo-user",
      conversationId: conversation.id,
      botId: "bot_nova",
      kind: "tool_approval",
      summary: "send_email",
      modelMessages: [],
    });

    const file = join(directory, "store.json");
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown> & {
      pendingActions: Array<Record<string, unknown>>;
    };
    delete raw.runs;
    delete raw.runEvents;
    delete raw.runTimers;
    delete raw.runClaims;
    for (const pending of raw.pendingActions) {
      delete pending.runId;
      delete pending.providerApprovalId;
    }
    await writeFile(file, JSON.stringify(raw));

    const reloaded = new FileStore(file);
    const loaded = await reloaded.getPendingAction("demo-user", action.id);
    expect(loaded?.runId).toBeNull();
    expect(loaded?.providerApprovalId).toBeNull();

    const claim = await reloaded.runs.claimRun({
      kind: "message",
      userId: "demo-user",
      conversationId: conversation.id,
      message: { senderType: "user", senderId: "demo-user", content: "After upgrade" },
    });
    expect(claim.outcome).toBe("claimed");
  });

  it("selects botId from the conversation and admits scheduled occurrences without a user message", async () => {
    const { store } = await makeStore();
    const conversation = await makeConversation(store);

    const claim = claimed(
      await store.runs.claimRun({
        kind: "scheduled",
        userId: "demo-user",
        conversationId: conversation.id,
        trigger: {
          automationId: "auto_1",
          occurrenceAt: "2026-01-01T00:00:00.000Z",
          prompt: "Daily summary",
        },
        idempotencyKey: "occ-1",
      }),
    );
    expect(claim.run.trigger.kind).toBe("scheduled");
    expect(claim.run.trigger.automationId).toBe("auto_1");
    expect(claim.run.trigger.prompt).toBe("Daily summary");
    expect(claim.run.botId).toBe(conversation.botIds[0]);
    expect(claim.message).toBeNull();
    expect(await store.listMessages("demo-user", conversation.id)).toHaveLength(0);

    const busy = await store.runs.claimRun({
      kind: "scheduled",
      userId: "demo-user",
      conversationId: conversation.id,
      trigger: {
        automationId: "auto_1",
        occurrenceAt: "2026-01-02T00:00:00.000Z",
        prompt: "Next occurrence",
      },
    });
    expect(busy.outcome).toBe("busy");
  });

  it("round-trips workflowRunId, outputMessageId, and lease fields through transitions", async () => {
    const { store } = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Go" },
      }),
    );
    expect(claim.run.botId).toBe(conversation.botIds[0]);

    const started = await store.runs.transitionRun({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "queued",
      expectedFence: claim.run.fence,
      status: "running",
      workflowRunId: "wf_123",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-01-01T00:05:00.000Z",
    });
    expect(started.outcome).toBe("applied");
    if (started.outcome !== "applied") return;
    expect(started.run.workflowRunId).toBe("wf_123");
    expect(started.run.leaseOwner).toBe("worker-1");
    expect(started.run.leaseExpiresAt).toBe("2026-01-01T00:05:00.000Z");

    const done = await store.runs.transitionRun({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "running",
      expectedFence: started.run.fence,
      status: "succeeded",
      outputMessageId: "msg_out_1",
    });
    expect(done.outcome).toBe("applied");
    if (done.outcome !== "applied") return;
    expect(done.run.outputMessageId).toBe("msg_out_1");
    expect(done.run.workflowRunId).toBe("wf_123");

    const reloaded = await store.runs.getRun("demo-user", claim.run.id);
    expect(reloaded?.outputMessageId).toBe("msg_out_1");
    expect(reloaded?.workflowRunId).toBe("wf_123");
  });

  it("lists runs scoped to the user with conversation, status, time, and limit filters", async () => {
    const { store } = await makeStore();
    const first = await makeConversation(store);
    const second = await makeConversation(store);

    const a = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: first.id,
        message: { senderType: "user", senderId: "demo-user", content: "A" },
      }),
    );
    const running = await store.runs.transitionRun({
      userId: "demo-user",
      runId: a.run.id,
      expectedStatus: "queued",
      expectedFence: a.run.fence,
      status: "running",
    });
    if (running.outcome !== "applied") throw new Error("Could not start run");
    await store.runs.transitionRun({
      userId: "demo-user",
      runId: a.run.id,
      expectedStatus: "running",
      expectedFence: running.run.fence,
      status: "succeeded",
    });

    const b = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: second.id,
        message: { senderType: "user", senderId: "demo-user", content: "B" },
      }),
    );

    const otherConversation = await store.createConversation("other-user", {
      title: "Other",
      botIds: ["bot_nova"],
    });
    await store.runs.claimRun({
      kind: "message",
      userId: "other-user",
      conversationId: otherConversation.id,
      message: { senderType: "user", senderId: "other-user", content: "Theirs" },
    });

    const all = await store.runs.listRuns({ userId: "demo-user" });
    expect(all.map((run) => run.id).sort()).toEqual([a.run.id, b.run.id].sort());

    const byConversation = await store.runs.listRuns({ userId: "demo-user", conversationId: second.id });
    expect(byConversation.map((run) => run.id)).toEqual([b.run.id]);

    const byStatus = await store.runs.listRuns({ userId: "demo-user", statuses: ["succeeded"] });
    expect(byStatus.map((run) => run.id)).toEqual([a.run.id]);

    expect(await store.runs.listRuns({ userId: "demo-user", limit: 1 })).toHaveLength(1);
    expect(
      await store.runs.listRuns({ userId: "demo-user", createdBefore: "2000-01-01T00:00:00.000Z" }),
    ).toHaveLength(0);
  });

  it("does not claim due timers for terminal runs and parks them", async () => {
    const { store, directory } = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Go" },
      }),
    );
    const running = await store.runs.transitionRun({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "queued",
      expectedFence: claim.run.fence,
      status: "running",
    });
    if (running.outcome !== "applied") throw new Error("Could not start run");

    const timer = await store.runs.upsertTimer({
      userId: "demo-user",
      runId: claim.run.id,
      kind: "lease_recovery",
      dueAt: "2020-01-01T00:00:00.000Z",
    });
    const done = await store.runs.transitionRun({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "running",
      expectedFence: running.run.fence,
      status: "succeeded",
    });
    expect(done.outcome).toBe("applied");

    expect(await store.runs.claimDueTimers({ now: "2020-01-02T00:00:00.000Z" })).toHaveLength(0);
    expect(await store.runs.claimDueTimers({ now: "2020-01-02T00:00:00.000Z" })).toHaveLength(0);

    const raw = JSON.parse(await readFile(join(directory, "store.json"), "utf8")) as {
      runTimers: Array<{ id: string; status: string }>;
    };
    expect(raw.runTimers.find((item) => item.id === timer.id)?.status).toBe("cancelled");
  });

  it("applies an optional timer patch atomically with a transition", async () => {
    const { store, directory } = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Go" },
      }),
    );
    const timer = await store.runs.upsertTimer({
      userId: "demo-user",
      runId: claim.run.id,
      kind: "lease_recovery",
      dueAt: "2030-01-01T00:00:00.000Z",
    });

    const done = await store.runs.transitionRun({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "queued",
      expectedFence: claim.run.fence,
      status: "cancelled",
      timers: [{ kind: "lease_recovery", status: "cancelled" }],
    });
    expect(done.outcome).toBe("applied");

    const raw = JSON.parse(await readFile(join(directory, "store.json"), "utf8")) as {
      runTimers: Array<{ id: string; status: string }>;
    };
    expect(raw.runTimers.find((item) => item.id === timer.id)?.status).toBe("cancelled");
  });

  it("atomically completes a run with one bot message and is idempotent on repeat", async () => {
    const { store } = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Go" },
      }),
    );
    const running = await store.runs.transitionRun({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "queued",
      expectedFence: claim.run.fence,
      status: "running",
    });
    if (running.outcome !== "applied") throw new Error("Could not start run");

    const first = await store.runs.completeWithMessage({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "running",
      expectedFence: running.run.fence,
      content: "The answer",
      event: { type: "succeeded", dedupeKey: `succeeded:${claim.run.id}` },
    });
    expect(first.outcome).toBe("applied");
    if (first.outcome !== "applied") return;
    expect(first.message.runId).toBe(claim.run.id);
    expect(first.run.status).toBe("succeeded");
    expect(first.run.outputMessageId).toBe(first.message.id);
    expect(first.event?.type).toBe("succeeded");

    const repeat = await store.runs.completeWithMessage({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "running",
      expectedFence: running.run.fence,
      content: "The answer",
      event: { type: "succeeded", dedupeKey: `succeeded:${claim.run.id}` },
    });
    expect(repeat.outcome).toBe("idempotent");
    if (repeat.outcome !== "idempotent") return;
    expect(repeat.message.id).toBe(first.message.id);

    const messages = await store.listMessages("demo-user", conversation.id);
    expect(messages.filter((message) => message.senderType === "bot")).toHaveLength(1);
    const events = await store.runs.listEvents("demo-user", claim.run.id);
    expect(events.filter((event) => event.type === "succeeded")).toHaveLength(1);
    const projected = await store.getConversation("demo-user", conversation.id);
    expect(projected?.runStatus).toBe("idle");
    expect(projected?.activeRunId).toBeNull();
  });

  it("returns stale from completeWithMessage when the run fence is not current", async () => {
    const { store } = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Go" },
      }),
    );
    const running = await store.runs.transitionRun({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "queued",
      expectedFence: claim.run.fence,
      status: "running",
    });
    if (running.outcome !== "applied") throw new Error("Could not start run");

    const result = await store.runs.completeWithMessage({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "running",
      expectedFence: running.run.fence + 1,
      content: "The answer",
    });

    expect(result.outcome).toBe("stale");
    expect(await store.listMessages("demo-user", conversation.id)).toHaveLength(1);
    expect((await store.runs.getRun("demo-user", claim.run.id))?.status).toBe("running");
  });

  it("leaves memory unchanged when completeWithMessage persistence fails", async () => {
    const { store, directory } = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Go" },
      }),
    );
    const running = await store.runs.transitionRun({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "queued",
      expectedFence: claim.run.fence,
      status: "running",
    });
    if (running.outcome !== "applied") throw new Error("Could not start run");
    const before = await store.listMessages("demo-user", conversation.id);

    await rm(directory, { recursive: true, force: true });
    await writeFile(directory, "blocker");

    await expect(
      store.runs.completeWithMessage({
        userId: "demo-user",
        runId: claim.run.id,
        expectedStatus: "running",
        expectedFence: running.run.fence,
        content: "The answer",
      }),
    ).rejects.toThrow();

    expect((await store.runs.getRun("demo-user", claim.run.id))?.status).toBe("running");
    expect(await store.listMessages("demo-user", conversation.id)).toHaveLength(before.length);
  });

  it("initializes legacy run records with safe defaults for new lifecycle fields", async () => {
    const { store, directory } = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Go" },
      }),
    );

    const file = join(directory, "store.json");
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      runs: Array<Record<string, unknown>>;
    };
    for (const run of raw.runs) {
      delete run.botId;
      delete run.workflowRunId;
      delete run.outputMessageId;
      delete run.leaseOwner;
      delete run.leaseExpiresAt;
    }
    await writeFile(file, JSON.stringify(raw));

    const reloaded = new FileStore(file);
    const run = await reloaded.runs.getRun("demo-user", claim.run.id);
    expect(run?.botId).toBe("");
    expect(run?.workflowRunId).toBeNull();
    expect(run?.outputMessageId).toBeNull();
    expect(run?.leaseOwner).toBeNull();
    expect(run?.leaseExpiresAt).toBeNull();
  });

  it("leaves in-memory state unchanged when persistence fails", async () => {
    const { store, directory } = await makeStore();
    await store.createBot("demo-user", {
      name: "Stable",
      handle: "stable",
      persona: "A bot that must survive a failed write.",
      model: "openai/test",
      integrationIds: [],
    });
    const before = await store.listBots("demo-user");

    // Replace the store directory with a file so the next persist cannot create it.
    await rm(directory, { recursive: true, force: true });
    await writeFile(directory, "blocker");

    await expect(
      store.createBot("demo-user", {
        name: "Lost",
        handle: "lost",
        persona: "A bot that must not appear after a failed write.",
        model: "openai/test",
        integrationIds: [],
      }),
    ).rejects.toThrow();

    const after = await store.listBots("demo-user");
    expect(after.map((bot) => bot.id)).toEqual(before.map((bot) => bot.id));
  });

  it("raises a store-domain not-found error for a missing claim conversation and maps it to 404", async () => {
    const { store } = await makeStore();

    const error = await store.runs
      .claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: "conv_missing",
        message: { senderType: "user", senderId: "demo-user", content: "Hello" },
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(StoreDomainError);
    expect((error as StoreDomainError).code).toBe("not_found");
    expect(normalizeError(error).status).toBe(404);
  });

  it("rejects an idempotency key reused for a different conversation or trigger kind", async () => {
    const { store } = await makeStore();
    const first = await makeConversation(store);
    const second = await makeConversation(store);

    claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: first.id,
        message: { senderType: "user", senderId: "demo-user", content: "Hello" },
        idempotencyKey: "shared-key",
      }),
    );

    await expect(
      store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: second.id,
        message: { senderType: "user", senderId: "demo-user", content: "Hello" },
        idempotencyKey: "shared-key",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await expect(
      store.runs.claimRun({
        kind: "scheduled",
        userId: "demo-user",
        conversationId: first.id,
        trigger: { automationId: "auto_1", occurrenceAt: "2026-01-01T00:00:00.000Z", prompt: "Go" },
        idempotencyKey: "shared-key",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("derives the output conversation and bot from the run and rejects a mismatched user", async () => {
    const { store } = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Go" },
      }),
    );
    const running = await store.runs.transitionRun({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "queued",
      expectedFence: claim.run.fence,
      status: "running",
    });
    if (running.outcome !== "applied") throw new Error("Could not start run");

    const wrongUser = await store.runs.completeWithMessage({
      userId: "other-user",
      runId: claim.run.id,
      expectedStatus: "running",
      expectedFence: running.run.fence,
      content: "Hijacked",
    });
    expect(wrongUser.outcome).toBe("stale");
    expect(await store.listMessages("demo-user", conversation.id)).toHaveLength(1);

    const done = await store.runs.completeWithMessage({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "running",
      expectedFence: running.run.fence,
      content: "The answer",
    });
    expect(done.outcome).toBe("applied");
    if (done.outcome !== "applied") return;
    expect(done.message.conversationId).toBe(conversation.id);
    expect(done.message.senderId).toBe(claim.run.botId);
  });

  it("releases a failed timer back to pending with a bounded retry and cancels it for terminal runs", async () => {
    const { store, directory } = await makeStore();
    const conversation = await makeConversation(store);
    const claim = claimed(
      await store.runs.claimRun({
        kind: "message",
        userId: "demo-user",
        conversationId: conversation.id,
        message: { senderType: "user", senderId: "demo-user", content: "Go" },
      }),
    );
    const timer = await store.runs.upsertTimer({
      userId: "demo-user",
      runId: claim.run.id,
      kind: "start_handoff",
      dueAt: "2026-01-01T00:00:00.000Z",
    });

    const claimedTimers = await store.runs.claimDueTimers({ now: "2026-01-01T00:01:00.000Z" });
    expect(claimedTimers.map((item) => item.id)).toEqual([timer.id]);

    await store.runs.releaseRunTimer({
      timerId: timer.id,
      now: "2026-01-01T00:01:00.000Z",
      retryAfterMs: 30_000,
    });
    expect(await store.runs.claimDueTimers({ now: "2026-01-01T00:01:29.000Z" })).toHaveLength(0);
    expect(
      (await store.runs.claimDueTimers({ now: "2026-01-01T00:01:30.000Z" })).map((item) => item.id),
    ).toEqual([timer.id]);

    const done = await store.runs.transitionRun({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "queued",
      expectedFence: claim.run.fence,
      status: "succeeded",
    });
    expect(done.outcome).toBe("applied");

    await store.runs.releaseRunTimer({ timerId: timer.id, now: "2026-01-01T00:02:00.000Z" });
    const raw = JSON.parse(await readFile(join(directory, "store.json"), "utf8")) as {
      runTimers: Array<{ id: string; status: string }>;
    };
    expect(raw.runTimers.find((item) => item.id === timer.id)?.status).toBe("cancelled");
  });
});
