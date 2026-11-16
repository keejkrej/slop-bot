import { randomUUID } from "node:crypto";
import { initSchema } from "../db/schema-init";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Optional Postgres integration suite for automation storage. Runs only when
 * TEST_DATABASE_URL is set; it applies db/schema.sql first.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PostgresStore automation store (integration)", () => {
  const userId = `test-user-${randomUUID()}`;
  let store!: import("../db/postgres-store").PostgresStore;
  let sql: import("postgres").Sql | undefined;
  let conversationId = "";

  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    sql = postgres(url!, { max: 1 });
    await initSchema(sql);
    const { PostgresStore } = await import("../db/postgres-store");
    store = new PostgresStore(url!);
    const conversation = await store.createConversation(userId, {
      title: "Automations",
      botIds: ["bot_nova"],
    });
    conversationId = conversation.id;
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from automation_occurrences where user_id = ${userId}`;
      await sql`delete from automation_tasks where user_id = ${userId}`;
      await sql`delete from conversations where user_id = ${userId}`;
      await sql.end();
    }
    const client = (store as unknown as { client?: { end(): Promise<void> } } | undefined)?.client;
    await client?.end();
  });

  function taskInput(nextDueAt: string) {
    return {
      userId,
      botId: "bot_nova",
      conversationId,
      title: "Daily",
      instructions: "Summarize.",
      schedule: { kind: "cron" as const, expression: "0 9 * * *", timezone: "UTC" },
      nextDueAt,
    };
  }

  it("leases a due task once under parallel claims", async () => {
    const task = await store.automations.createTask(taskInput("2026-01-01T09:00:00.000Z"));
    const [a, b] = await Promise.all([
      store.automations.claimDueTasks({ now: "2026-01-02T00:00:00.000Z" }),
      store.automations.claimDueTasks({ now: "2026-01-02T00:00:00.000Z" }),
    ]);
    expect([...a, ...b].map((item) => item.id)).toEqual([task.id]);
  });

  it("materializes one occurrence under parallel admission", async () => {
    const task = await store.automations.createTask(taskInput("2026-01-01T09:00:00.000Z"));
    const input = {
      userId,
      taskId: task.id,
      occurrenceAt: "2026-01-01T09:00:00.000Z",
      executionId: `auto:${task.id}:2026-01-01T09:00:00.000Z`,
      now: "2026-01-01T09:00:01.000Z",
    };
    const [a, b] = await Promise.all([
      store.automations.admitOccurrence(input),
      store.automations.admitOccurrence(input),
    ]);
    expect(a.occurrence.id).toBe(b.occurrence.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });

  it("completes an occurrence and its task together", async () => {
    const task = await store.automations.createTask(taskInput("2026-01-01T09:00:00.000Z"));
    const { occurrence } = await store.automations.admitOccurrence({
      userId,
      taskId: task.id,
      occurrenceAt: "2026-01-01T09:00:00.000Z",
      executionId: `auto:${task.id}:2026-01-01T09:00:00.000Z`,
      now: "2026-01-01T09:00:01.000Z",
    });
    const completed = await store.automations.completeOccurrence({
      userId,
      taskId: task.id,
      occurrenceId: occurrence.id,
      occurrenceStatus: "queued",
      runId: "run_1",
      taskStatus: "active",
      nextDueAt: "2026-01-02T09:00:00.000Z",
      now: "2026-01-01T09:00:02.000Z",
    });
    expect(completed?.runId).toBe("run_1");
    expect((await store.automations.getTask(userId, task.id))?.nextDueAt).toBe(
      "2026-01-02T09:00:00.000Z",
    );
  });

  it("enforces expectedRevision on task updates and occurrence completion", async () => {
    const task = await store.automations.createTask(taskInput("2026-01-01T09:00:00.000Z"));
    expect(task.revision).toBe(0);

    const updated = await store.automations.updateTask(userId, task.id, { title: "Renamed" });
    expect(updated?.revision).toBe(1);
    expect(await store.automations.updateTask(userId, task.id, { title: "Stale" }, 0)).toBeNull();

    const [claimed] = await store.automations.claimDueTasks({ now: "2026-01-02T00:00:00.000Z" });
    if (!claimed) throw new Error("Expected a claimed task");
    const { occurrence } = await store.automations.admitOccurrence({
      userId,
      taskId: task.id,
      occurrenceAt: "2026-01-01T09:00:00.000Z",
      executionId: `auto:${task.id}:revision`,
      now: "2026-01-02T00:00:00.000Z",
    });
    await store.automations.updateTask(userId, task.id, { status: "paused" });

    const completed = await store.automations.completeOccurrence({
      userId,
      taskId: task.id,
      occurrenceId: occurrence.id,
      occurrenceStatus: "queued",
      runId: "run_rev",
      taskStatus: "active",
      nextDueAt: "2026-01-03T09:00:00.000Z",
      expectedRevision: claimed.revision,
      now: "2026-01-02T00:00:01.000Z",
    });
    expect(completed?.runId).toBe("run_rev");
    const reloaded = await store.automations.getTask(userId, task.id);
    expect(reloaded?.status).toBe("paused");
    expect(reloaded?.nextDueAt).toBe("2026-01-01T09:00:00.000Z");
  });

  it("lists queued occurrences without a run oldest first", async () => {
    const task = await store.automations.createTask(taskInput("2026-01-01T09:00:00.000Z"));
    const later = await store.automations.admitOccurrence({
      userId,
      taskId: task.id,
      occurrenceAt: "2026-01-01T10:00:00.000Z",
      executionId: `auto:${task.id}:later`,
      now: "2026-01-01T10:00:00.000Z",
    });
    const earlier = await store.automations.admitOccurrence({
      userId,
      taskId: task.id,
      occurrenceAt: "2026-01-01T09:00:00.000Z",
      executionId: `auto:${task.id}:earlier`,
      now: "2026-01-01T09:00:00.000Z",
    });
    await store.automations.completeOccurrence({
      userId,
      taskId: task.id,
      occurrenceId: later.occurrence.id,
      occurrenceStatus: "queued",
      runId: "run_later",
      now: "2026-01-01T10:00:01.000Z",
    });

    const pending = await store.automations.listPendingOccurrences();
    expect(pending.map((item) => item.id)).toContain(earlier.occurrence.id);
    expect(pending.map((item) => item.id)).not.toContain(later.occurrence.id);
  });
});
