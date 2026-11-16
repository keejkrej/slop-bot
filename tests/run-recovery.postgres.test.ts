import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Optional Postgres integration suite for run recovery. Runs only when
 * TEST_DATABASE_URL is set; without it the whole suite is skipped.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PostgresStore run recovery (integration)", () => {
  const userId = `test-recovery-${randomUUID()}`;
  let store!: import("../db/postgres-store").PostgresStore;
  let sql: import("postgres").Sql | undefined;

  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    sql = postgres(url!, { max: 1 });
    const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
    await sql.unsafe(schema);
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

  async function runningRun(leaseExpiresAt: string) {
    const conversation = await store.createConversation(userId, { title: "Recovery", botIds: ["bot_nova"] });
    const claim = await store.runs.claimRun({
      kind: "message",
      userId,
      conversationId: conversation.id,
      message: { senderType: "user", senderId: userId, content: "Go" },
    });
    if (claim.outcome !== "claimed") throw new Error("Could not claim run");
    const running = await store.runs.transitionRun({
      userId,
      runId: claim.run.id,
      expectedStatus: "queued",
      expectedFence: claim.run.fence,
      status: "running",
      workflowRunId: "wf_1",
      leaseOwner: "wf_1",
      leaseExpiresAt,
    });
    if (running.outcome !== "applied") throw new Error("Could not start run");
    return running.run;
  }

  it("lists only active runs whose lease is due", async () => {
    const due = await runningRun("2026-01-01T00:05:00.000Z");
    const future = await runningRun("2026-01-01T00:30:00.000Z");

    const recoverable = await store.runs.listRecoverableRuns({
      now: "2026-01-01T00:06:00.000Z",
      limit: 10,
    });

    const ids = recoverable.map((run) => run.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(future.id);
  });

  it("expires a due run through recoverRuns", async () => {
    const { recoverRuns } = await import("../apps/web/lib/server/run-recovery");
    const run = await runningRun("2026-01-01T00:05:00.000Z");

    const result = await recoverRuns({
      store,
      now: new Date("2026-01-01T00:06:00.000Z"),
      startRun: async () => {
        throw new Error("should not start");
      },
    });

    expect(result.safetyNetExpired).toBeGreaterThanOrEqual(1);
    expect((await store.runs.getRun(userId, run.id))?.status).toBe("expired");
  });
});
