import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore } from "../db/file-store";
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  runAutomationNow,
  runSchedulerTick,
  updateAutomation,
  type ScheduledRunStart,
  type ScheduledRunStarter,
} from "../apps/web/lib/server/automations";
import { scheduledStartOutcome } from "../apps/web/lib/server/scheduled-run-starter";

let directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

async function makeStore() {
  const directory = await mkdtemp(join(tmpdir(), "slop-automation-service-"));
  directories.push(directory);
  return new FileStore(join(directory, "store.json"));
}

function fakeStarter(handler: (input: Parameters<ScheduledRunStarter>[0]) => ScheduledRunStart) {
  const calls: Array<Parameters<ScheduledRunStarter>[0]> = [];
  const starter: ScheduledRunStarter = async (input) => {
    calls.push(input);
    return handler(input);
  };
  return { starter, calls };
}

const started = (runId = "run_1"): ScheduledRunStart => ({
  outcome: "started",
  runId,
  status: "running",
  workflowRunId: "wf_1",
});

const cron = (expression: string) => ({ kind: "cron" as const, expression, timezone: "UTC" });

describe("automation service: creation", () => {
  it("resolves the bot's conversation server-side and computes the first due time", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "Daily summary",
        botId: "bot_nova",
        instructions: "Summarize the day.",
        schedule: cron("0 9 * * *"),
      },
      new Date("2026-01-15T00:00:00Z"),
    );

    expect(task.conversationId).toBe("conv_nova");
    expect(task.botId).toBe("bot_nova");
    expect(task.status).toBe("active");
    expect(task.nextDueAt).toBe("2026-01-15T09:00:00.000Z");
    expect((await listAutomations(store, "demo-user")).map((item) => item.id)).toEqual([task.id]);
  });

  it("rejects a bot that is not owned by the user", async () => {
    const store = await makeStore();
    await expect(
      createAutomation(store, "demo-user", {
        title: "Nope",
        botId: "bot_missing",
        instructions: "Do something.",
        schedule: cron("0 9 * * *"),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an invalid timezone and a one-time schedule that is already too late", async () => {
    const store = await makeStore();
    await expect(
      createAutomation(store, "demo-user", {
        title: "Bad tz",
        botId: "bot_nova",
        instructions: "Do something.",
        schedule: { kind: "cron", expression: "0 9 * * *", timezone: "Mars/Olympus" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      createAutomation(
        store,
        "demo-user",
        {
          title: "Too late",
          botId: "bot_nova",
          instructions: "Do something.",
          schedule: { kind: "once", localTime: "2026-01-10T09:00:00", timezone: "UTC" },
        },
        new Date("2026-01-12T00:00:00Z"),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("automation service: scheduler tick", () => {
  it("admits a due occurrence exactly once across repeated and parallel ticks", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "Daily summary",
        botId: "bot_nova",
        instructions: "Summarize the day.",
        schedule: cron("0 9 * * *"),
      },
      new Date("2026-01-15T00:00:00Z"),
    );
    const { starter, calls } = fakeStarter(() => started());

    const [a, b] = await Promise.all([
      runSchedulerTick({ store, startScheduledRun: starter, now: new Date("2026-01-15T09:05:00Z") }),
      runSchedulerTick({ store, startScheduledRun: starter, now: new Date("2026-01-15T09:05:00Z") }),
    ]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.trigger.occurrenceAt).toBe("2026-01-15T09:00:00.000Z");

    const occurrences = await store.automations.listOccurrences("demo-user", task.id);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.runId).toBe("run_1");

    const reloaded = await store.automations.getTask("demo-user", task.id);
    expect(reloaded?.nextDueAt).toBe("2026-01-16T09:00:00.000Z");

    await runSchedulerTick({ store, startScheduledRun: starter, now: new Date("2026-01-15T09:05:00Z") });
    expect(calls).toHaveLength(1);
  });

  it("leaves a busy conversation queued without advancing the pointer", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "Daily summary",
        botId: "bot_nova",
        instructions: "Summarize the day.",
        schedule: cron("0 9 * * *"),
      },
      new Date("2026-01-15T00:00:00Z"),
    );
    const busy = fakeStarter(() => ({ outcome: "busy" }));

    const first = await runSchedulerTick({
      store,
      startScheduledRun: busy.starter,
      now: new Date("2026-01-15T09:05:00Z"),
    });
    expect(first.busy).toBe(1);
    expect(busy.calls).toHaveLength(1);

    const afterBusy = await store.automations.getTask("demo-user", task.id);
    expect(afterBusy?.nextDueAt).toBe("2026-01-15T09:00:00.000Z");
    const queued = await store.automations.listOccurrences("demo-user", task.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.status).toBe("queued");
    expect(queued[0]?.runId).toBeNull();

    const ready = fakeStarter(() => started("run_2"));
    const second = await runSchedulerTick({
      store,
      startScheduledRun: ready.starter,
      now: new Date("2026-01-15T09:06:00Z"),
    });
    expect(second.admitted).toBe(1);
    expect(ready.calls).toHaveLength(1);
    expect((await store.automations.getTask("demo-user", task.id))?.nextDueAt).toBe(
      "2026-01-16T09:00:00.000Z",
    );
  });

  it("retries a busy occurrence before computing a newer recurrence", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "Quarter hour",
        botId: "bot_nova",
        instructions: "Check in.",
        schedule: cron("*/15 * * * *"),
      },
      new Date("2026-01-15T08:50:00Z"),
    );
    const busy = fakeStarter(() => ({ outcome: "busy" }));

    const first = await runSchedulerTick({
      store,
      startScheduledRun: busy.starter,
      now: new Date("2026-01-15T09:00:00Z"),
    });
    expect(first.busy).toBe(1);
    const queued = await store.automations.listOccurrences("demo-user", task.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.occurrenceAt).toBe("2026-01-15T09:00:00.000Z");
    expect(queued[0]?.runId).toBeNull();

    const ready = fakeStarter(() => started("run_0900"));
    const second = await runSchedulerTick({
      store,
      startScheduledRun: ready.starter,
      now: new Date("2026-01-15T09:15:00Z"),
    });

    // The reserved 09:00 occurrence is revived; no 09:15 occurrence is created.
    expect(second.admitted).toBe(1);
    expect(ready.calls).toHaveLength(1);
    expect(ready.calls[0]?.trigger.occurrenceAt).toBe("2026-01-15T09:00:00.000Z");
    const occurrences = await store.automations.listOccurrences("demo-user", task.id);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.runId).toBe("run_0900");
    expect((await store.automations.getTask("demo-user", task.id))?.nextDueAt).toBe(
      "2026-01-15T09:30:00.000Z",
    );
  });

  it("retries a busy manual Run Now occurrence without advancing the schedule", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "Daily summary",
        botId: "bot_nova",
        instructions: "Summarize the day.",
        schedule: cron("0 9 * * *"),
      },
      new Date("2026-01-15T10:00:00Z"),
    );
    const busy = fakeStarter(() => ({ outcome: "busy" }));
    const first = await runAutomationNow(
      store,
      "demo-user",
      task.id,
      "request-manual",
      busy.starter,
      new Date("2026-01-15T10:00:00Z"),
    );
    expect(first.outcome).toBe("busy");

    const ready = fakeStarter(() => started("run_manual"));
    const tick = await runSchedulerTick({
      store,
      startScheduledRun: ready.starter,
      now: new Date("2026-01-15T10:05:00Z"),
    });

    expect(tick.admitted).toBe(1);
    expect(ready.calls).toHaveLength(1);
    expect(ready.calls[0]?.idempotencyKey).toBe(`manual:${task.id}:request-manual`);
    const occurrences = await store.automations.listOccurrences("demo-user", task.id);
    expect(occurrences[0]?.runId).toBe("run_manual");
    // Manual runs never move the scheduled pointer.
    expect((await store.automations.getTask("demo-user", task.id))?.nextDueAt).toBe(
      "2026-01-16T09:00:00.000Z",
    );
  });

  it("does not auto-retry a paused task's queued occurrence until it is resumed", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "Quarter hour",
        botId: "bot_nova",
        instructions: "Check in.",
        schedule: cron("*/15 * * * *"),
      },
      new Date("2026-01-15T08:50:00Z"),
    );
    const busy = fakeStarter(() => ({ outcome: "busy" }));
    await runSchedulerTick({
      store,
      startScheduledRun: busy.starter,
      now: new Date("2026-01-15T09:00:00Z"),
    });
    await updateAutomation(store, "demo-user", task.id, { status: "paused" });

    const ready = fakeStarter(() => started("run_resumed"));
    const pausedTick = await runSchedulerTick({
      store,
      startScheduledRun: ready.starter,
      now: new Date("2026-01-15T09:15:00Z"),
    });
    expect(pausedTick.admitted).toBe(0);
    expect(ready.calls).toHaveLength(0);

    await updateAutomation(
      store,
      "demo-user",
      task.id,
      { status: "active" },
      new Date("2026-01-15T09:20:00Z"),
    );
    const resumedTick = await runSchedulerTick({
      store,
      startScheduledRun: ready.starter,
      now: new Date("2026-01-15T09:21:00Z"),
    });
    expect(resumedTick.admitted).toBe(1);
    expect(ready.calls).toHaveLength(1);
  });

  it("does not overwrite a pause made while a tick is dispatching", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "Daily summary",
        botId: "bot_nova",
        instructions: "Summarize the day.",
        schedule: cron("0 9 * * *"),
      },
      new Date("2026-01-15T00:00:00Z"),
    );
    const starter: ScheduledRunStarter = async () => {
      await updateAutomation(store, "demo-user", task.id, { status: "paused" });
      return started("run_1");
    };

    const result = await runSchedulerTick({
      store,
      startScheduledRun: starter,
      now: new Date("2026-01-15T09:05:00Z"),
    });

    expect(result.admitted).toBe(1);
    expect(result.revisionConflicts).toBe(1);
    const reloaded = await store.automations.getTask("demo-user", task.id);
    expect(reloaded?.status).toBe("paused");
    // The occurrence/run linkage is still recorded safely.
    const occurrences = await store.automations.listOccurrences("demo-user", task.id);
    expect(occurrences[0]?.runId).toBe("run_1");
    expect(occurrences[0]?.status).toBe("queued");
  });

  it("advances a recurring task from now, not the occurrence time, so it never bursts", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "Quarter hour",
        botId: "bot_nova",
        instructions: "Check in.",
        schedule: cron("*/15 * * * *"),
      },
      new Date("2026-01-15T05:50:00Z"),
    );
    const { starter, calls } = fakeStarter(() => started());

    await runSchedulerTick({
      store,
      startScheduledRun: starter,
      now: new Date("2026-01-15T06:20:00Z"),
    });

    expect(calls[0]?.trigger.occurrenceAt).toBe("2026-01-15T06:15:00.000Z");
    const reloaded = await store.automations.getTask("demo-user", task.id);
    expect(reloaded?.nextDueAt).toBe("2026-01-15T06:30:00.000Z");
    expect(reloaded?.lastOccurredAt).toBe("2026-01-15T06:15:00.000Z");
  });

  it("marks a one-time task missed after the 24h window without starting a run", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "One shot",
        botId: "bot_nova",
        instructions: "Do it once.",
        schedule: { kind: "once", localTime: "2026-01-10T09:00:00", timezone: "UTC" },
      },
      new Date("2026-01-09T00:00:00Z"),
    );
    const { starter, calls } = fakeStarter(() => started());

    const result = await runSchedulerTick({
      store,
      startScheduledRun: starter,
      now: new Date("2026-01-12T00:00:00Z"),
    });

    expect(result.missed).toBe(1);
    expect(calls).toHaveLength(0);
    const reloaded = await store.automations.getTask("demo-user", task.id);
    expect(reloaded?.status).toBe("missed");
    expect(reloaded?.nextDueAt).toBeNull();
    const occurrences = await store.automations.listOccurrences("demo-user", task.id);
    expect(occurrences[0]?.status).toBe("missed");
  });

  it("runs durable recovery by default and reports its counters", async () => {
    const store = await makeStore();
    const conversation = await store.createConversation("demo-user", {
      title: "Recovery",
      botIds: ["bot_nova"],
    });
    const claim = await store.runs.claimRun({
      kind: "message",
      userId: "demo-user",
      conversationId: conversation.id,
      message: { senderType: "user", senderId: "demo-user", content: "Go" },
    });
    if (claim.outcome !== "claimed") throw new Error("Could not claim run");
    const running = await store.runs.transitionRun({
      userId: "demo-user",
      runId: claim.run.id,
      expectedStatus: "queued",
      expectedFence: claim.run.fence,
      status: "running",
      workflowRunId: "wf_1",
      leaseOwner: "wf_1",
      leaseExpiresAt: "2026-01-15T09:00:00.000Z",
    });
    if (running.outcome !== "applied") throw new Error("Could not start run");
    await store.runs.upsertTimer({
      userId: "demo-user",
      runId: claim.run.id,
      kind: "lease_recovery",
      dueAt: "2026-01-15T09:00:00.000Z",
    });
    const { starter } = fakeStarter(() => started());

    const result = await runSchedulerTick({
      store,
      startScheduledRun: starter,
      now: new Date("2026-01-15T09:05:00Z"),
    });

    expect(result.recovery?.leaseExpired).toBe(1);
    expect((await store.runs.getRun("demo-user", claim.run.id))?.status).toBe("expired");
  });

  it("does not claim paused tasks and removes deleted tasks", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "Daily summary",
        botId: "bot_nova",
        instructions: "Summarize the day.",
        schedule: cron("0 9 * * *"),
      },
      new Date("2026-01-15T00:00:00Z"),
    );
    const { starter, calls } = fakeStarter(() => started());

    await updateAutomation(store, "demo-user", task.id, { status: "paused" });
    const paused = await runSchedulerTick({
      store,
      startScheduledRun: starter,
      now: new Date("2026-01-15T09:05:00Z"),
    });
    expect(paused.claimed).toBe(0);
    expect(calls).toHaveLength(0);

    await deleteAutomation(store, "demo-user", task.id);
    await expect(getAutomation(store, "demo-user", task.id)).rejects.toMatchObject({ status: 404 });
  });

  it("isolates a reconciliation failure so other due tasks still run", async () => {
    const store = await makeStore();
    const first = await createAutomation(
      store,
      "demo-user",
      {
        title: "First",
        botId: "bot_nova",
        instructions: "First task.",
        schedule: cron("0 9 * * *"),
      },
      new Date("2026-01-15T00:00:00Z"),
    );
    const second = await createAutomation(
      store,
      "demo-user",
      {
        title: "Second",
        botId: "bot_nova",
        instructions: "Second task.",
        schedule: cron("0 9 * * *"),
      },
      new Date("2026-01-15T00:00:00Z"),
    );
    const reconcileTask = await createAutomation(
      store,
      "demo-user",
      {
        title: "Reconcile",
        botId: "bot_nova",
        instructions: "Not due.",
        schedule: cron("0 9 * * *"),
      },
      new Date("2026-01-15T00:00:00Z"),
    );
    await store.automations.updateTask("demo-user", reconcileTask.id, {
      nextDueAt: "2030-01-01T00:00:00.000Z",
    });

    const conversation = await store.createConversation("demo-user", {
      title: "Reconcile run",
      botIds: ["bot_nova"],
    });
    const claim = await store.runs.claimRun({
      kind: "message",
      userId: "demo-user",
      conversationId: conversation.id,
      message: { senderType: "user", senderId: "demo-user", content: "Go" },
    });
    if (claim.outcome !== "claimed") throw new Error("Could not claim run");
    const { occurrence } = await store.automations.admitOccurrence({
      userId: "demo-user",
      taskId: reconcileTask.id,
      occurrenceAt: "2026-01-15T09:00:00.000Z",
      executionId: "auto:reconcile:1",
      now: "2026-01-15T09:00:00.000Z",
    });
    await store.automations.completeOccurrence({
      userId: "demo-user",
      taskId: reconcileTask.id,
      occurrenceId: occurrence.id,
      occurrenceStatus: "running",
      runId: claim.run.id,
      now: "2026-01-15T09:00:00.000Z",
    });

    const original = store.automations.updateOccurrence;
    store.automations.updateOccurrence = async (userId, occurrenceId, patch) => {
      if (occurrenceId === occurrence.id) throw new Error("reconcile boom");
      return original(userId, occurrenceId, patch);
    };

    const { starter, calls } = fakeStarter(() => started());
    const result = await runSchedulerTick({
      store,
      startScheduledRun: starter,
      now: new Date("2026-01-15T09:05:00Z"),
    });

    expect(result.reconcileErrors).toBe(1);
    expect(result.admitted).toBe(2);
    expect(calls).toHaveLength(2);
    expect((await store.automations.getTask("demo-user", first.id))?.nextDueAt).toBe(
      "2026-01-16T09:00:00.000Z",
    );
    expect((await store.automations.getTask("demo-user", second.id))?.nextDueAt).toBe(
      "2026-01-16T09:00:00.000Z",
    );
  });

  it("surfaces a terminal failed scheduled run as a failed occurrence", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "Fails",
        botId: "bot_nova",
        instructions: "Fail.",
        schedule: cron("0 9 * * *"),
      },
      new Date("2026-01-15T00:00:00Z"),
    );
    const { starter } = fakeStarter(() => ({ outcome: "failed", error: "run expired" }));

    const result = await runSchedulerTick({
      store,
      startScheduledRun: starter,
      now: new Date("2026-01-15T09:05:00Z"),
    });

    expect(result.failed).toBe(1);
    expect(result.admitted).toBe(0);
    const occurrences = await store.automations.listOccurrences("demo-user", task.id);
    expect(occurrences[0]?.status).toBe("failed");
    expect(occurrences[0]?.error).toBe("run expired");
    expect((await store.automations.getTask("demo-user", task.id))?.status).toBe("failed");
  });

  it("reconciles an already-succeeded scheduled run as a duplicate instead of a fresh start", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "Once",
        botId: "bot_nova",
        instructions: "Do it once.",
        schedule: { kind: "once", localTime: "2026-01-15T09:00:00", timezone: "UTC" },
      },
      new Date("2026-01-15T00:00:00Z"),
    );
    const { starter } = fakeStarter(() => ({
      outcome: "duplicate",
      runId: "run_dup",
      status: "succeeded",
      workflowRunId: "wf_dup",
    }));

    const result = await runSchedulerTick({
      store,
      startScheduledRun: starter,
      now: new Date("2026-01-15T09:05:00Z"),
    });

    expect(result.duplicate).toBe(1);
    expect(result.admitted).toBe(0);
    const occurrences = await store.automations.listOccurrences("demo-user", task.id);
    expect(occurrences[0]?.status).toBe("succeeded");
    expect(occurrences[0]?.runId).toBe("run_dup");
    const reloaded = await store.automations.getTask("demo-user", task.id);
    expect(reloaded?.status).toBe("completed");
    expect(reloaded?.nextDueAt).toBeNull();
  });
});

describe("automation service: resume and manual-run policy", () => {
  it("rejects resuming a completed or missed one-time task", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "Once",
        botId: "bot_nova",
        instructions: "Do it once.",
        schedule: { kind: "once", localTime: "2026-02-01T09:00:00", timezone: "UTC" },
      },
      new Date("2026-01-15T00:00:00Z"),
    );

    await store.automations.updateTask("demo-user", task.id, {
      status: "completed",
      nextDueAt: null,
    });
    await expect(
      updateAutomation(store, "demo-user", task.id, { status: "active" }),
    ).rejects.toMatchObject({ status: 409 });

    await store.automations.updateTask("demo-user", task.id, {
      status: "missed",
      nextDueAt: null,
    });
    await expect(
      updateAutomation(store, "demo-user", task.id, { status: "active" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("resumes a paused one-time task that still has a future occurrence", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "Future once",
        botId: "bot_nova",
        instructions: "Do it later.",
        schedule: { kind: "once", localTime: "2026-02-01T09:00:00", timezone: "UTC" },
      },
      new Date("2026-01-15T00:00:00Z"),
    );
    await updateAutomation(store, "demo-user", task.id, { status: "paused" });

    const resumed = await updateAutomation(
      store,
      "demo-user",
      task.id,
      { status: "active" },
      new Date("2026-01-20T00:00:00Z"),
    );
    expect(resumed.status).toBe("active");
    expect(resumed.nextDueAt).toBe("2026-02-01T09:00:00.000Z");
  });

  it("rejects manual run-now for completed, missed, and failed tasks", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "Finished",
        botId: "bot_nova",
        instructions: "Done.",
        schedule: cron("0 9 * * *"),
      },
      new Date("2026-01-15T00:00:00Z"),
    );
    const { starter, calls } = fakeStarter(() => started());

    for (const status of ["completed", "missed", "failed"] as const) {
      await store.automations.updateTask("demo-user", task.id, { status });
      await expect(
        runAutomationNow(store, "demo-user", task.id, `request-${status}`, starter),
      ).rejects.toMatchObject({ status: 409 });
    }
    expect(calls).toHaveLength(0);
  });

  it("allows manual run-now for a paused task", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "Paused",
        botId: "bot_nova",
        instructions: "Run on demand.",
        schedule: cron("0 9 * * *"),
      },
      new Date("2026-01-15T00:00:00Z"),
    );
    await updateAutomation(store, "demo-user", task.id, { status: "paused" });
    const { starter, calls } = fakeStarter(() => started("run_paused"));

    const result = await runAutomationNow(
      store,
      "demo-user",
      task.id,
      "request-paused",
      starter,
      new Date("2026-01-15T10:00:00Z"),
    );
    expect(result.outcome).toBe("started");
    expect(calls).toHaveLength(1);
  });
});

describe("scheduled run starter outcome mapping", () => {
  it("maps terminal statuses to failed or duplicate and admits active statuses", () => {
    expect(scheduledStartOutcome({ runId: "r", status: "running" }, "wf")).toMatchObject({
      outcome: "started",
      status: "running",
    });
    expect(scheduledStartOutcome({ runId: "r", status: "queued" }, null)).toMatchObject({
      outcome: "started",
      status: "queued",
    });
    expect(scheduledStartOutcome({ runId: "r", status: "awaiting_approval" }, "wf")).toMatchObject({
      outcome: "started",
      status: "awaiting_approval",
    });
    expect(scheduledStartOutcome({ runId: "r", status: "failed" }, null)).toMatchObject({
      outcome: "failed",
    });
    expect(scheduledStartOutcome({ runId: "r", status: "cancelled" }, null)).toMatchObject({
      outcome: "failed",
    });
    expect(scheduledStartOutcome({ runId: "r", status: "expired" }, null)).toMatchObject({
      outcome: "failed",
    });
    expect(scheduledStartOutcome({ runId: "r", status: "succeeded" }, "wf")).toMatchObject({
      outcome: "duplicate",
      status: "succeeded",
    });
  });
});

describe("automation service: manual run now", () => {
  it("is idempotent per request and never advances the schedule", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "Daily summary",
        botId: "bot_nova",
        instructions: "Summarize the day.",
        schedule: cron("0 9 * * *"),
      },
      new Date("2026-01-15T00:00:00Z"),
    );
    const { starter, calls } = fakeStarter(() => started("run_manual"));

    const first = await runAutomationNow(
      store,
      "demo-user",
      task.id,
      "request-1",
      starter,
      new Date("2026-01-15T10:00:00Z"),
    );
    expect(first.outcome).toBe("started");
    if (first.outcome !== "started") return;
    expect(first.runId).toBe("run_manual");

    const duplicate = await runAutomationNow(
      store,
      "demo-user",
      task.id,
      "request-1",
      starter,
      new Date("2026-01-15T10:00:01Z"),
    );
    expect(duplicate.outcome).toBe("duplicate");
    expect(duplicate.occurrence.id).toBe(first.occurrence.id);
    expect(calls).toHaveLength(1);

    const reloaded = await store.automations.getTask("demo-user", task.id);
    expect(reloaded?.nextDueAt).toBe("2026-01-15T09:00:00.000Z");
  });

  it("reports busy and can retry the same request once the conversation is free", async () => {
    const store = await makeStore();
    const task = await createAutomation(
      store,
      "demo-user",
      {
        title: "Daily summary",
        botId: "bot_nova",
        instructions: "Summarize the day.",
        schedule: cron("0 9 * * *"),
      },
      new Date("2026-01-15T00:00:00Z"),
    );
    const busy = fakeStarter(() => ({ outcome: "busy" }));

    const first = await runAutomationNow(
      store,
      "demo-user",
      task.id,
      "request-2",
      busy.starter,
      new Date("2026-01-15T10:00:00Z"),
    );
    expect(first.outcome).toBe("busy");

    const ready = fakeStarter(() => started("run_retry"));
    const retry = await runAutomationNow(
      store,
      "demo-user",
      task.id,
      "request-2",
      ready.starter,
      new Date("2026-01-15T10:00:05Z"),
    );
    expect(retry.outcome).toBe("started");
    expect(ready.calls).toHaveLength(1);
  });
});
