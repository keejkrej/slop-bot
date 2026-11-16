import { randomUUID } from "node:crypto";
import { initSchema } from "../db/schema-init";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Optional Postgres integration suite.
 *
 * Runs only when TEST_DATABASE_URL is set (for example a disposable local
 * Postgres). It applies db/schema.sql first, so the database may be empty.
 * Without TEST_DATABASE_URL the whole suite is skipped and no Postgres
 * dependency is imported.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PostgresStore run store (integration)", () => {
  const userId = `test-user-${randomUUID()}`;
  let store!: import("../db/postgres-store").PostgresStore;
  let sql: import("postgres").Sql | undefined;

  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    sql = postgres(url!, { max: 1 });
    await initSchema(sql);
    const { PostgresStore } = await import("../db/postgres-store");
    store = new PostgresStore(url!);
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from run_claims where user_id = ${userId}`;
      await sql`delete from run_timers where user_id = ${userId}`;
      await sql`delete from run_events where run_id in (select id from runs where user_id = ${userId})`;
      await sql`delete from runs where user_id = ${userId}`;
      await sql`delete from pending_actions where user_id = ${userId}`;
      await sql`delete from messages where user_id = ${userId}`;
      await sql`delete from conversations where user_id = ${userId}`;
      await sql.end();
    }
    const client = (store as unknown as { client?: { end(): Promise<void> } } | undefined)?.client;
    await client?.end();
  });

  async function conversation() {
    return store.createConversation(userId, { title: "Runs", botIds: ["bot_nova"] });
  }

  it("claims one of two concurrent message turns and dedupes idempotency keys", async () => {
    const conv = await conversation();
    const [a, b] = await Promise.all([
      store.runs.claimRun({
        kind: "message",
        userId,
        conversationId: conv.id,
        message: { senderType: "user", senderId: userId, content: "First" },
      }),
      store.runs.claimRun({
        kind: "message",
        userId,
        conversationId: conv.id,
        message: { senderType: "user", senderId: userId, content: "Second" },
      }),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["busy", "claimed"]);

    const conv2 = await conversation();
    const first = await store.runs.claimRun({
      kind: "message",
      userId,
      conversationId: conv2.id,
      message: { senderType: "user", senderId: userId, content: "Hello" },
      idempotencyKey: "key-1",
    });
    const duplicate = await store.runs.claimRun({
      kind: "message",
      userId,
      conversationId: conv2.id,
      message: { senderType: "user", senderId: userId, content: "Hello" },
      idempotencyKey: "key-1",
    });
    expect(first.outcome).toBe("claimed");
    expect(duplicate.outcome).toBe("claimed");
    if (first.outcome !== "claimed" || duplicate.outcome !== "claimed") return;
    expect(duplicate.run.id).toBe(first.run.id);
  });

  it("CASes transitions, appends ordered events, and claims due timers", async () => {
    const conv = await conversation();
    const claim = await store.runs.claimRun({
      kind: "message",
      userId,
      conversationId: conv.id,
      message: { senderType: "user", senderId: userId, content: "Go" },
    });
    if (claim.outcome !== "claimed") throw new Error("not claimed");

    const applied = await store.runs.transitionRun({
      userId,
      runId: claim.run.id,
      expectedStatus: "queued",
      expectedFence: claim.run.fence,
      status: "running",
      event: { type: "started" },
    });
    expect(applied.outcome).toBe("applied");

    const stale = await store.runs.transitionRun({
      userId,
      runId: claim.run.id,
      expectedStatus: "queued",
      expectedFence: claim.run.fence,
      status: "failed",
    });
    expect(stale.outcome).toBe("stale");

    const first = await store.runs.appendEvent({ userId, runId: claim.run.id, type: "log", dedupeKey: "d" });
    const duplicate = await store.runs.appendEvent({ userId, runId: claim.run.id, type: "log", dedupeKey: "d" });
    expect(duplicate.id).toBe(first.id);
    const events = await store.runs.listEvents(userId, claim.run.id);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);

    const timer = await store.runs.upsertTimer({
      userId,
      runId: claim.run.id,
      kind: "lease_recovery",
      dueAt: "2020-01-01T00:00:00.000Z",
    });
    const due = await store.runs.claimDueTimers({ now: "2020-01-02T00:00:00.000Z" });
    expect(due.map((item) => item.id)).toContain(timer.id);
    expect(await store.runs.claimDueTimers({ now: "2020-01-02T00:00:00.000Z" })).toHaveLength(0);
  });

  it("approves and denies pending actions with correct run/action states", async () => {
    const conv = await conversation();
    const claim = await store.runs.claimRun({
      kind: "message",
      userId,
      conversationId: conv.id,
      message: { senderType: "user", senderId: userId, content: "Send" },
    });
    if (claim.outcome !== "claimed") throw new Error("not claimed");
    const running = await store.runs.transitionRun({
      userId,
      runId: claim.run.id,
      expectedStatus: "queued",
      expectedFence: claim.run.fence,
      status: "running",
    });
    if (running.outcome !== "applied") throw new Error("not running");
    const action = await store.createPendingAction({
      userId,
      conversationId: conv.id,
      botId: "bot_nova",
      kind: "tool_approval",
      summary: "memory_delete notes/example.md",
      modelMessages: [],
      runId: claim.run.id,
      providerApprovalId: "provider-approval-123",
    });
    const storedAction = await store.getPendingAction(userId, action.id);
    expect(storedAction?.runId).toBe(claim.run.id);
    expect(storedAction?.providerApprovalId).toBe("provider-approval-123");
    const waiting = await store.runs.transitionRun({
      userId,
      runId: claim.run.id,
      expectedStatus: "running",
      expectedFence: running.run.fence,
      status: "awaiting_approval",
    });
    if (waiting.outcome !== "applied") throw new Error("not waiting");

    const approved = await store.runs.claimRun({
      kind: "approval",
      userId,
      conversationId: conv.id,
      actionId: action.id,
      decision: "approve",
    });
    expect(approved.outcome).toBe("claimed");
    if (approved.outcome !== "claimed") return;
    expect(approved.run.status).toBe("queued");
    expect(approved.run.attempt).toBe(1);
    expect(approved.action?.status).toBe("resuming");

    const second = await store.runs.claimRun({
      kind: "approval",
      userId,
      conversationId: conv.id,
      actionId: action.id,
      decision: "deny",
    });
    expect(second.outcome).toBe("approval_missing");
  });

  it("creates the start_handoff timer atomically with a new claim", async () => {
    const conv = await conversation();
    const claim = await store.runs.claimRun({
      kind: "message",
      userId,
      conversationId: conv.id,
      message: { senderType: "user", senderId: userId, content: "Atomic" },
      now: "2026-01-01T00:00:00.000Z",
    });
    if (claim.outcome !== "claimed") throw new Error("not claimed");

    const due = await store.runs.claimDueTimers({ now: "2026-01-01T00:01:00.000Z" });
    const handoff = due.find((timer) => timer.runId === claim.run.id);
    expect(handoff?.kind).toBe("start_handoff");
    expect(handoff?.dueAt).toBe("2026-01-01T00:01:00.000Z");
  });
});
