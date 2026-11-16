import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileStore } from "../db/file-store";
import { boundDesktopResult, redactDesktopText } from "../db/desktop-result";
import { recordDesktopJobResult } from "../apps/web/lib/server/desktop-jobs";
import { hookTokenForIdentity, hookTokenForJob } from "../workflows/desktop-tools";

let directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

async function makeStore() {
  const directory = await mkdtemp(join(tmpdir(), "slop-desktop-"));
  directories.push(directory);
  return new FileStore(join(directory, "store.json"));
}

const baseJob = {
  userId: "demo-user",
  deviceId: "device-123456",
  integrationId: "integration",
  toolName: "read",
  args: {},
};

describe("desktop job idempotency", () => {
  it("returns the existing job for repeated creation with the same identity", async () => {
    const store = await makeStore();
    const first = await store.createDesktopJob({
      ...baseJob,
      id: "desktop_job_fixed",
      runId: "run-1",
      stepKey: "wf:step",
      attempt: 0,
    });
    const second = await store.createDesktopJob({
      ...baseJob,
      id: "desktop_job_fixed",
      runId: "run-1",
      stepKey: "wf:step",
      attempt: 0,
    });

    expect(second.id).toBe(first.id);
    expect(await store.listPendingDesktopJobs("demo-user", "device-123456")).toHaveLength(1);
  });

  it("dedupes by runId and stepKey even when the id differs", async () => {
    const store = await makeStore();
    const first = await store.createDesktopJob({ ...baseJob, runId: "run-1", stepKey: "wf:step" });
    const second = await store.createDesktopJob({ ...baseJob, runId: "run-1", stepKey: "wf:step" });

    expect(second.id).toBe(first.id);
  });

  it("keeps distinct jobs for distinct workflow attempts", async () => {
    const store = await makeStore();
    const first = await store.createDesktopJob({ ...baseJob, runId: "run-1", stepKey: "wf-a:step" });
    const second = await store.createDesktopJob({ ...baseJob, runId: "run-1", stepKey: "wf-b:step" });

    expect(second.id).not.toBe(first.id);
  });

  it("never reuses another user's job for a colliding id or run/step identity", async () => {
    const store = await makeStore();
    const first = await store.createDesktopJob({
      ...baseJob,
      userId: "user-a",
      id: "desktop_job_shared",
      runId: "run-1",
      stepKey: "wf:step",
    });
    const sameId = await store.createDesktopJob({
      ...baseJob,
      userId: "user-b",
      id: "desktop_job_shared",
      runId: "run-1",
      stepKey: "wf:step",
    });
    const sameRunStep = await store.createDesktopJob({
      ...baseJob,
      userId: "user-c",
      id: "desktop_job_other",
      runId: "run-1",
      stepKey: "wf:step",
    });

    expect(first.userId).toBe("user-a");
    expect(sameId.userId).toBe("user-b");
    expect(sameRunStep.userId).toBe("user-c");
    expect(sameRunStep.id).not.toBe(first.id);
    expect(await store.getDesktopJob("user-a", first.id)).toMatchObject({ userId: "user-a" });
    expect(await store.getDesktopJob("user-b", sameId.id)).toMatchObject({ userId: "user-b" });
    expect(await store.getDesktopJob("user-c", sameRunStep.id)).toMatchObject({ userId: "user-c" });
  });
});

describe("desktop job claims", () => {
  it("accepts only one of two concurrent claims", async () => {
    const store = await makeStore();
    const job = await store.createDesktopJob({ ...baseJob });
    const [a, b] = await Promise.all([
      store.claimDesktopJob({ userId: "demo-user", jobId: job.id, deviceId: "device-123456", leaseMs: 60_000 }),
      store.claimDesktopJob({ userId: "demo-user", jobId: job.id, deviceId: "device-123456", leaseMs: 60_000 }),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("rejects a claim from another device", async () => {
    const store = await makeStore();
    const job = await store.createDesktopJob({ ...baseJob });

    expect(await store.claimDesktopJob({
      userId: "demo-user",
      jobId: job.id,
      deviceId: "other-device-123",
      leaseMs: 60_000,
    })).toBeNull();
  });

  it("hides an actively leased job from pending polls", async () => {
    const store = await makeStore();
    const job = await store.createDesktopJob({ ...baseJob });
    await store.claimDesktopJob({ userId: "demo-user", jobId: job.id, deviceId: "device-123456", leaseMs: 60_000 });

    expect(await store.listPendingDesktopJobs("demo-user", "device-123456")).toHaveLength(0);
  });

  it("allows reclaiming after the lease expires", async () => {
    const store = await makeStore();
    const job = await store.createDesktopJob({ ...baseJob });
    await store.claimDesktopJob({
      userId: "demo-user",
      jobId: job.id,
      deviceId: "device-123456",
      leaseMs: 1_000,
      now: "2026-01-01T00:00:00.000Z",
    });

    const reclaimed = await store.claimDesktopJob({
      userId: "demo-user",
      jobId: job.id,
      deviceId: "device-123456",
      leaseMs: 60_000,
      now: "2026-01-01T00:00:02.000Z",
    });
    expect(reclaimed?.id).toBe(job.id);
  });

  it("does not steal a claimed job whose lease deadline is missing", async () => {
    const store = await makeStore();
    const job = await store.createDesktopJob({ ...baseJob });
    await store.claimDesktopJob({ userId: "demo-user", jobId: job.id, deviceId: "device-123456", leaseMs: 60_000 });

    // Simulate a legacy/corrupt row: claimed but with no lease deadline.
    const state = (store as unknown as {
      state: { desktopJobs: Array<{ id: string; leaseExpiresAt: string | null }> };
    }).state;
    const stored = state.desktopJobs.find((item) => item.id === job.id)!;
    stored.leaseExpiresAt = null;

    expect(await store.claimDesktopJob({
      userId: "demo-user",
      jobId: job.id,
      deviceId: "device-123456",
      leaseMs: 60_000,
    })).toBeNull();
    expect(await store.listPendingDesktopJobs("demo-user", "device-123456")).toHaveLength(0);
  });

  it("completes once and clears the lease", async () => {
    const store = await makeStore();
    const job = await store.createDesktopJob({ ...baseJob });
    await store.claimDesktopJob({ userId: "demo-user", jobId: job.id, deviceId: "device-123456", leaseMs: 60_000 });

    const completed = await store.completeDesktopJob(
      "demo-user",
      job.id,
      { ok: true, output: { read: true } },
      "device-123456",
    );
    expect(completed?.status).toBe("completed");
    expect(completed?.claimedBy).toBeNull();
    expect(completed?.leaseExpiresAt).toBeNull();
    expect(await store.completeDesktopJob("demo-user", job.id, { ok: true }, "device-123456")).toBeNull();
  });

  it("rejects completion from a device that does not own the claim", async () => {
    const store = await makeStore();
    const job = await store.createDesktopJob({ ...baseJob });
    await store.claimDesktopJob({ userId: "demo-user", jobId: job.id, deviceId: "device-123456", leaseMs: 60_000 });

    expect(await store.completeDesktopJob("demo-user", job.id, { ok: true }, "other-device-123")).toBeNull();
  });
});

describe("desktop result delivery", () => {
  it("resumes the hook once and records delivery", async () => {
    const store = await makeStore();
    const job = await store.createDesktopJob({ ...baseJob });
    const resume = vi.fn(async () => undefined);

    const first = await recordDesktopJobResult({
      store,
      userId: "demo-user",
      jobId: job.id,
      result: { deviceId: "device-123456", ok: true, output: { read: true } },
      resume,
    });
    expect(first.body.delivered).toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);

    const second = await recordDesktopJobResult({
      store,
      userId: "demo-user",
      jobId: job.id,
      result: { deviceId: "device-123456", ok: true, output: { read: true } },
      resume,
    });
    expect(second.body.delivered).toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("retries delivery for a completed job whose hook failed", async () => {
    const store = await makeStore();
    const job = await store.createDesktopJob({ ...baseJob });
    const resume = vi.fn()
      .mockRejectedValueOnce(new Error("temporary delivery failure"))
      .mockResolvedValueOnce(undefined);

    const first = await recordDesktopJobResult({
      store,
      userId: "demo-user",
      jobId: job.id,
      result: { deviceId: "device-123456", ok: true, output: { read: true } },
      resume,
    });
    expect(first.status).toBe(503);
    expect(first.body.delivered).toBe(false);

    const second = await recordDesktopJobResult({
      store,
      userId: "demo-user",
      jobId: job.id,
      result: { deviceId: "device-123456", ok: true, output: { read: true } },
      resume,
    });
    expect(second.body.delivered).toBe(true);
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it("does not resume again after a result was delivered", async () => {
    const store = await makeStore();
    const job = await store.createDesktopJob({ ...baseJob });
    const resume = vi.fn(async () => undefined);

    await recordDesktopJobResult({
      store,
      userId: "demo-user",
      jobId: job.id,
      result: { deviceId: "device-123456", ok: true },
      resume,
    });
    const again = await recordDesktopJobResult({
      store,
      userId: "demo-user",
      jobId: job.id,
      result: { deviceId: "device-123456", ok: true },
      resume,
    });

    expect(again.body.delivered).toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("treats a missing hook as terminal and records the failure", async () => {
    const store = await makeStore();
    const job = await store.createDesktopJob({ ...baseJob });
    const resume = vi.fn(async () => {
      throw new Error("hook not found");
    });

    const outcome = await recordDesktopJobResult({
      store,
      userId: "demo-user",
      jobId: job.id,
      result: { deviceId: "device-123456", ok: true },
      resume,
      isHookMissing: () => true,
    });

    expect(outcome.status).toBe(200);
    expect(outcome.body.delivered).toBe(false);
    const stored = await store.getDesktopJob("demo-user", job.id);
    expect(stored?.deliveryStatus).toBe("failed");
    expect(stored?.deliveryAttempts).toBe(1);
  });

  it("rejects a result from another device", async () => {
    const store = await makeStore();
    const job = await store.createDesktopJob({ ...baseJob });

    const outcome = await recordDesktopJobResult({
      store,
      userId: "demo-user",
      jobId: job.id,
      result: { deviceId: "other-device-123", ok: true },
      resume: vi.fn(),
    });

    expect(outcome.status).toBe(404);
  });

  it("redacts and bounds the stored output", async () => {
    const store = await makeStore();
    const job = await store.createDesktopJob({ ...baseJob });

    await recordDesktopJobResult({
      store,
      userId: "demo-user",
      jobId: job.id,
      result: {
        deviceId: "device-123456",
        ok: true,
        output: { apiKey: "secret", nested: { password: "hunter2", ok: "visible" } },
      },
      resume: vi.fn(async () => undefined),
    });

    const stored = await store.getDesktopJob("demo-user", job.id);
    const output = stored?.output as Record<string, unknown>;
    expect(output.apiKey).toBe("[REDACTED]");
    expect((output.nested as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((output.nested as Record<string, unknown>).ok).toBe("visible");
  });
});

describe("desktop hook identity", () => {
  it("derives the same token from the workflow identity and the stored job", () => {
    const token = hookTokenForIdentity("run-1", "wf:step");
    expect(hookTokenForJob({ id: "desktop_job_other", runId: "run-1", stepKey: "wf:step" })).toBe(token);
    expect(hookTokenForJob({ id: "desktop_job_other", runId: null, stepKey: "wf:step" })).toBe(
      hookTokenForIdentity(null, "wf:step"),
    );
  });

  it("falls back to the job id for legacy jobs without a step key", () => {
    expect(hookTokenForJob({ id: "desktop_job_legacy", runId: null, stepKey: null })).toBe(
      "slop-bot:desktop-tool:desktop_job_legacy",
    );
  });
});

describe("desktop result bounding", () => {
  it("caps depth and collection counts while staying valid JSON", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 20; index += 1) deep = { child: deep };
    const result = boundDesktopResult({
      deep,
      items: Array.from({ length: 250 }, (_, index) => index),
    }) as Record<string, unknown>;
    const items = result.items as unknown[];
    expect(items).toHaveLength(101);
    expect(items[100]).toMatch(/Truncated/);
    expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();
  });

  it("returns a structured envelope instead of sliced invalid JSON", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`field_${index}`, "x".repeat(4_000)]),
    );
    const result = boundDesktopResult(wide) as Record<string, unknown>;
    expect(result.truncated).toBe(true);
    expect(typeof result.content).toBe("string");
    expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();
  });

  it("redacts secrets in free-form error text", () => {
    expect(redactDesktopText("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
    expect(redactDesktopText("api_key=sk-live-123")).not.toContain("sk-live-123");
  });
});
