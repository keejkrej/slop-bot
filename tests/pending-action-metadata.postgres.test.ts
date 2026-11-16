import { randomUUID } from "node:crypto";
import { initSchema } from "../db/schema-init";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Optional Postgres integration suite for the new approval metadata and
 * per-integration write allowlist. Skipped unless TEST_DATABASE_URL is set.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PostgresStore approval metadata (integration)", () => {
  const userId = `test-approval-${randomUUID()}`;
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
      await sql`delete from integrations where user_id = ${userId}`;
      await sql.end();
    }
    const client = (store as unknown as { client?: { end(): Promise<void> } } | undefined)?.client;
    await client?.end();
  });

  async function awaitingApproval(expiresAt: string) {
    const conversation = await store.createConversation(userId, { title: "Approval", botIds: ["bot_nova"] });
    const claim = await store.runs.claimRun({
      kind: "message",
      userId,
      conversationId: conversation.id,
      message: { senderType: "user", senderId: userId, content: "Go" },
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
      conversationId: conversation.id,
      botId: "bot_nova",
      kind: "tool_approval",
      summary: "Create an issue",
      modelMessages: [],
      runId: claim.run.id,
      toolName: "GITHUB_CREATE_ISSUE",
      toolArgsRedacted: { title: "Bug", token: "[REDACTED]" },
      toolRisk: "write",
      idempotencyKey: "opaque-key",
      expiresAt,
      integrationId: "mcp_1",
      integrationName: "GitHub",
    });
    const waiting = await store.runs.transitionRun({
      userId,
      runId: claim.run.id,
      expectedStatus: "running",
      expectedFence: running.run.fence,
      status: "awaiting_approval",
    });
    if (waiting.outcome !== "applied") throw new Error("not waiting");
    return { conversation, run: waiting.run, action };
  }

  it("roundtrips structured approval metadata", async () => {
    const conversation = await store.createConversation(userId, { title: "Meta", botIds: ["bot_nova"] });
    const action = await store.createPendingAction({
      userId,
      conversationId: conversation.id,
      botId: "bot_nova",
      kind: "tool_approval",
      summary: "Create an issue",
      modelMessages: [],
      toolName: "GITHUB_CREATE_ISSUE",
      toolArgsRedacted: { title: "Bug" },
      toolRisk: "write",
      idempotencyKey: "opaque-key",
      integrationId: "mcp_1",
      integrationName: "GitHub",
    });
    const loaded = await store.getPendingAction(userId, action.id);
    expect(loaded?.toolName).toBe("GITHUB_CREATE_ISSUE");
    expect(loaded?.toolRisk).toBe("write");
    expect(loaded?.toolArgsRedacted).toEqual({ title: "Bug" });
    expect(loaded?.idempotencyKey).toBe("opaque-key");
    expect(loaded?.expiresAt).toBeTruthy();
  });

  it("refuses to resume an expired action and expires its run", async () => {
    const { conversation, run, action } = await awaitingApproval("2026-01-01T00:00:00.000Z");
    const claim = await store.runs.claimRun({
      kind: "approval",
      userId,
      conversationId: conversation.id,
      actionId: action.id,
      decision: "approve",
      now: "2026-01-02T00:00:00.000Z",
    });
    expect(claim.outcome).toBe("cancelled");
    expect((await store.getPendingAction(userId, action.id))?.status).toBe("expired");
    expect((await store.runs.getRun(userId, run.id))?.status).toBe("expired");
    const projected = await store.getConversation(userId, conversation.id);
    expect(projected?.activeRunId).toBeNull();
    expect(projected?.runStatus).toBe("idle");
  });

  it("roundtrips the per-integration write allowlist", async () => {
    const created = await store.createIntegration(userId, {
      kind: "mcp",
      name: "GitHub",
      url: "https://example.com/mcp",
      description: "",
      status: "connected",
    });
    expect(created.allowedWriteTools).toEqual([]);
    await store.updateIntegration(userId, created.id, { allowedWriteTools: ["GITHUB_CREATE_ISSUE"] });
    expect((await store.getIntegration(userId, created.id))?.allowedWriteTools).toEqual(["GITHUB_CREATE_ISSUE"]);
  });
});
