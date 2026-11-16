import { randomUUID } from "node:crypto";
import { initSchema } from "../db/schema-init";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Optional Postgres integration suite for desktop job idempotency and claims.
 * Runs only when TEST_DATABASE_URL is set; applies db/schema.sql first.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PostgresStore desktop jobs (integration)", () => {
  const userId = `test-user-${randomUUID()}`;
  const otherUserId = `test-user-${randomUUID()}`;
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
      await sql`delete from desktop_jobs where user_id in (${userId}, ${otherUserId})`;
      await sql.end();
    }
    const client = (store as unknown as { client?: { end(): Promise<void> } } | undefined)?.client;
    await client?.end();
  });

  const baseJob = {
    userId,
    deviceId: "device-123456",
    integrationId: "integration",
    toolName: "read",
    args: {},
  };

  it("returns the existing job for the same run and step identity", async () => {
    const first = await store.createDesktopJob({ ...baseJob, runId: "run-1", stepKey: "wf:step" });
    const second = await store.createDesktopJob({ ...baseJob, runId: "run-1", stepKey: "wf:step" });
    expect(second.id).toBe(first.id);
  });

  it("scopes the run/step identity per user", async () => {
    const first = await store.createDesktopJob({ ...baseJob, runId: "run-shared", stepKey: "wf:step" });
    const second = await store.createDesktopJob({
      ...baseJob,
      userId: otherUserId,
      runId: "run-shared",
      stepKey: "wf:step",
    });
    expect(second.id).not.toBe(first.id);
    expect(second.userId).toBe(otherUserId);

    const rows = await sql!`
      select user_id, count(*)::int as count
      from desktop_jobs
      where run_id = 'run-shared' and step_key = 'wf:step'
      group by user_id
      order by user_id
    `;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.count === 1)).toBe(true);
    expect(new Set(rows.map((row) => row.user_id))).toEqual(new Set([userId, otherUserId]));
  });

  it("accepts only one concurrent claim", async () => {
    const job = await store.createDesktopJob({ ...baseJob, runId: "run-2", stepKey: "wf:step" });
    const [a, b] = await Promise.all([
      store.claimDesktopJob({ userId, jobId: job.id, deviceId: "device-123456", leaseMs: 60_000 }),
      store.claimDesktopJob({ userId, jobId: job.id, deviceId: "device-123456", leaseMs: 60_000 }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("does not steal a claimed job whose lease deadline is missing", async () => {
    const job = await store.createDesktopJob({ ...baseJob, runId: "run-4", stepKey: "wf:step" });
    await store.claimDesktopJob({ userId, jobId: job.id, deviceId: "device-123456", leaseMs: 60_000 });
    await sql!`update desktop_jobs set lease_expires_at = null where id = ${job.id}`;

    expect(await store.claimDesktopJob({
      userId,
      jobId: job.id,
      deviceId: "device-123456",
      leaseMs: 60_000,
    })).toBeNull();
    const pending = await store.listPendingDesktopJobs(userId, "device-123456");
    expect(pending.some((item) => item.id === job.id)).toBe(false);
  });

  it("completes once and records delivery separately", async () => {
    const job = await store.createDesktopJob({ ...baseJob, runId: "run-3", stepKey: "wf:step" });
    const completed = await store.completeDesktopJob(userId, job.id, { ok: true, output: { read: true } }, "device-123456");
    expect(completed?.status).toBe("completed");
    expect(await store.completeDesktopJob(userId, job.id, { ok: true }, "device-123456")).toBeNull();

    const delivered = await store.markDesktopJobDelivery(userId, job.id, { status: "delivered" });
    expect(delivered?.deliveryStatus).toBe("delivered");
    expect(delivered?.deliveryAttempts).toBe(1);
  });
});
