import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore } from "../db/file-store";

let directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

async function makeStore() {
  const directory = await mkdtemp(join(tmpdir(), "slop-automations-"));
  directories.push(directory);
  return { store: new FileStore(join(directory, "store.json")), directory };
}

function taskInput(overrides: Partial<Parameters<FileStore["automations"]["createTask"]>[0]> = {}) {
  return {
    userId: "demo-user",
    botId: "bot_nova",
    conversationId: "conv_nova",
    title: "Daily summary",
    instructions: "Summarize the day.",
    schedule: { kind: "cron" as const, expression: "0 9 * * *", timezone: "UTC" },
    nextDueAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  };
}

describe("FileStore automation store", () => {
  it("creates, lists, gets, updates, and deletes tasks scoped to the owner", async () => {
    const { store } = await makeStore();
    const task = await store.automations.createTask(taskInput());
    expect(task.status).toBe("active");
    expect(task.attempts).toBe(0);
    expect(task.claimedAt).toBeNull();

    expect((await store.automations.listTasks("demo-user")).map((item) => item.id)).toEqual([task.id]);
    expect(await store.automations.listTasks("other-user")).toHaveLength(0);
    expect(await store.automations.getTask("other-user", task.id)).toBeNull();

    const updated = await store.automations.updateTask("demo-user", task.id, {
      title: "Renamed",
      status: "paused",
    });
    expect(updated?.title).toBe("Renamed");
    expect(updated?.status).toBe("paused");

    await store.automations.deleteTask("demo-user", task.id);
    expect(await store.automations.getTask("demo-user", task.id)).toBeNull();
  });

  it("leases only due active tasks and never leases one twice in parallel", async () => {
    const { store } = await makeStore();
    const due = await store.automations.createTask(taskInput());
    await store.automations.createTask(taskInput({ nextDueAt: "2030-01-01T00:00:00.000Z" }));
    await store.automations.createTask(taskInput({ status: "paused" }));

    const [a, b] = await Promise.all([
      store.automations.claimDueTasks({ now: "2026-01-02T00:00:00.000Z" }),
      store.automations.claimDueTasks({ now: "2026-01-02T00:00:00.000Z" }),
    ]);
    const claimedIds = [...a, ...b].map((task) => task.id);
    expect(claimedIds).toEqual([due.id]);

    // The lease blocks an immediate second claim.
    expect(await store.automations.claimDueTasks({ now: "2026-01-02T00:00:00.000Z" })).toHaveLength(0);
    // A stale lease is reclaimable after the lease window.
    expect(
      (await store.automations.claimDueTasks({ now: "2026-01-02T00:06:00.000Z" })).map((task) => task.id),
    ).toEqual([due.id]);
  });

  it("materializes an occurrence once per stable execution id", async () => {
    const { store } = await makeStore();
    const task = await store.automations.createTask(taskInput());

    const first = await store.automations.admitOccurrence({
      userId: "demo-user",
      taskId: task.id,
      occurrenceAt: "2026-01-01T09:00:00.000Z",
      executionId: "auto:1",
      now: "2026-01-01T09:00:01.000Z",
    });
    expect(first.created).toBe(true);
    expect(first.occurrence.status).toBe("queued");

    const duplicate = await store.automations.admitOccurrence({
      userId: "demo-user",
      taskId: task.id,
      occurrenceAt: "2026-01-01T09:00:00.000Z",
      executionId: "auto:1",
      now: "2026-01-01T09:00:02.000Z",
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.occurrence.id).toBe(first.occurrence.id);

    const manual = await store.automations.admitOccurrence({
      userId: "demo-user",
      taskId: task.id,
      occurrenceAt: "2026-01-01T09:00:00.000Z",
      executionId: "manual:request-1",
      now: "2026-01-01T09:00:03.000Z",
    });
    expect(manual.created).toBe(true);
    expect(manual.occurrence.id).not.toBe(first.occurrence.id);
  });

  it("completes an occurrence and its task together, clearing the lease", async () => {
    const { store } = await makeStore();
    const task = await store.automations.createTask(taskInput());
    await store.automations.claimDueTasks({ now: "2026-01-02T00:00:00.000Z" });
    const { occurrence } = await store.automations.admitOccurrence({
      userId: "demo-user",
      taskId: task.id,
      occurrenceAt: "2026-01-01T09:00:00.000Z",
      executionId: "auto:1",
      now: "2026-01-02T00:00:00.000Z",
    });

    const completed = await store.automations.completeOccurrence({
      userId: "demo-user",
      taskId: task.id,
      occurrenceId: occurrence.id,
      occurrenceStatus: "queued",
      runId: "run_1",
      workflowRunId: "wf_1",
      taskStatus: "active",
      nextDueAt: "2026-01-03T09:00:00.000Z",
      lastOccurredAt: "2026-01-01T09:00:00.000Z",
      now: "2026-01-02T00:00:01.000Z",
    });
    expect(completed?.runId).toBe("run_1");
    expect(completed?.workflowRunId).toBe("wf_1");

    const reloaded = await store.automations.getTask("demo-user", task.id);
    expect(reloaded?.nextDueAt).toBe("2026-01-03T09:00:00.000Z");
    expect(reloaded?.lastOccurredAt).toBe("2026-01-01T09:00:00.000Z");
    expect(reloaded?.claimedAt).toBeNull();
  });

  it("lists open occurrences for lifecycle reconciliation", async () => {
    const { store } = await makeStore();
    const task = await store.automations.createTask(taskInput());
    const { occurrence } = await store.automations.admitOccurrence({
      userId: "demo-user",
      taskId: task.id,
      occurrenceAt: "2026-01-01T09:00:00.000Z",
      executionId: "auto:1",
      now: "2026-01-01T09:00:00.000Z",
    });
    expect(await store.automations.listOpenOccurrences()).toHaveLength(0);

    await store.automations.completeOccurrence({
      userId: "demo-user",
      taskId: task.id,
      occurrenceId: occurrence.id,
      occurrenceStatus: "running",
      runId: "run_1",
      now: "2026-01-01T09:00:01.000Z",
    });
    expect((await store.automations.listOpenOccurrences()).map((item) => item.id)).toEqual([occurrence.id]);
  });

  it("bumps revision on every write and enforces expectedRevision", async () => {
    const { store } = await makeStore();
    const task = await store.automations.createTask(taskInput());
    expect(task.revision).toBe(0);

    const updated = await store.automations.updateTask("demo-user", task.id, { title: "Renamed" });
    expect(updated?.revision).toBe(1);

    const stale = await store.automations.updateTask("demo-user", task.id, { title: "Stale" }, 0);
    expect(stale).toBeNull();
    expect((await store.automations.getTask("demo-user", task.id))?.title).toBe("Renamed");

    const fresh = await store.automations.updateTask("demo-user", task.id, { title: "Fresh" }, 1);
    expect(fresh?.revision).toBe(2);
  });

  it("keeps occurrence linkage but skips task fields on a revision mismatch", async () => {
    const { store } = await makeStore();
    const task = await store.automations.createTask(taskInput());
    const [claimedTask] = await store.automations.claimDueTasks({ now: "2026-01-02T00:00:00.000Z" });
    if (!claimedTask) throw new Error("Expected a claimed task");
    const { occurrence } = await store.automations.admitOccurrence({
      userId: "demo-user",
      taskId: task.id,
      occurrenceAt: "2026-01-01T09:00:00.000Z",
      executionId: "auto:1",
      now: "2026-01-02T00:00:00.000Z",
    });

    // A user pause bumps the revision after the tick claimed the task.
    await store.automations.updateTask("demo-user", task.id, { status: "paused" });

    const completed = await store.automations.completeOccurrence({
      userId: "demo-user",
      taskId: task.id,
      occurrenceId: occurrence.id,
      occurrenceStatus: "queued",
      runId: "run_1",
      taskStatus: "active",
      nextDueAt: "2026-01-03T09:00:00.000Z",
      expectedRevision: claimedTask.revision,
      now: "2026-01-02T00:00:01.000Z",
    });
    expect(completed?.runId).toBe("run_1");

    const reloaded = await store.automations.getTask("demo-user", task.id);
    expect(reloaded?.status).toBe("paused");
    expect(reloaded?.nextDueAt).toBe("2026-01-01T09:00:00.000Z");
  });

  it("lists queued occurrences without a run oldest first", async () => {
    const { store } = await makeStore();
    const task = await store.automations.createTask(taskInput());
    const later = await store.automations.admitOccurrence({
      userId: "demo-user",
      taskId: task.id,
      occurrenceAt: "2026-01-01T10:00:00.000Z",
      executionId: "auto:later",
      now: "2026-01-01T10:00:00.000Z",
    });
    const earlier = await store.automations.admitOccurrence({
      userId: "demo-user",
      taskId: task.id,
      occurrenceAt: "2026-01-01T09:00:00.000Z",
      executionId: "auto:earlier",
      now: "2026-01-01T09:00:00.000Z",
    });
    await store.automations.completeOccurrence({
      userId: "demo-user",
      taskId: task.id,
      occurrenceId: later.occurrence.id,
      occurrenceStatus: "queued",
      runId: "run_later",
      now: "2026-01-01T10:00:01.000Z",
    });

    const pending = await store.automations.listPendingOccurrences();
    expect(pending.map((item) => item.id)).toEqual([earlier.occurrence.id]);
    expect((await store.automations.listOpenOccurrencesForTask("demo-user", task.id)).map((item) => item.id)).toEqual([
      earlier.occurrence.id,
      later.occurrence.id,
    ]);
  });

  it("normalizes legacy tasks that predate the revision field", async () => {
    const { store, directory } = await makeStore();
    const task = await store.automations.createTask(taskInput());

    const file = join(directory, "store.json");
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      automationTasks: Array<Record<string, unknown>>;
    };
    for (const item of raw.automationTasks) delete item.revision;
    await writeFile(file, JSON.stringify(raw));

    const reloaded = new FileStore(file);
    expect((await reloaded.automations.getTask("demo-user", task.id))?.revision).toBe(0);
  });

  it("normalizes legacy store files that predate automations", async () => {
    const { store, directory } = await makeStore();
    await store.automations.createTask(taskInput());

    const file = join(directory, "store.json");
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    delete raw.automationTasks;
    delete raw.automationOccurrences;
    await writeFile(file, JSON.stringify(raw));

    const reloaded = new FileStore(file);
    expect(await reloaded.automations.listTasks("demo-user")).toHaveLength(0);
    const created = await reloaded.automations.createTask(taskInput());
    expect(created.status).toBe("active");
    expect(created.claimedAt).toBeNull();
  });
});
