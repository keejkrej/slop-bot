import { describe, expect, it } from "vitest";
import {
  conversationRunStatusSchema,
  conversationSchema,
  pendingActionStatusSchema,
  runEventSchema,
  runSchema,
  runStatusSchema,
  runTimerSchema,
} from "@slopbot/contracts";

describe("run contracts", () => {
  it("accepts every durable run status", () => {
    for (const status of ["queued", "running", "awaiting_approval", "succeeded", "failed", "cancelled", "expired"]) {
      expect(runStatusSchema.parse(status)).toBe(status);
    }
  });

  it("accepts every conversation projection status", () => {
    for (const status of ["idle", "queued", "running", "awaiting_approval", "failed"]) {
      expect(conversationRunStatusSchema.parse(status)).toBe(status);
    }
  });

  it("accepts every pending action status", () => {
    for (const status of ["pending", "resuming", "completed", "cancelled", "expired"]) {
      expect(pendingActionStatusSchema.parse(status)).toBe(status);
    }
  });

  it("parses a run with extensible trigger metadata", () => {
    const run = runSchema.parse({
      id: "run_1",
      userId: "demo-user",
      conversationId: "conv_1",
      botId: "bot_1",
      status: "queued",
      trigger: { kind: "message", messageId: "msg_1", futureField: true },
      attempt: 0,
      fence: 0,
      idempotencyKey: null,
      messageId: "msg_1",
      actionId: null,
      workflowRunId: null,
      outputMessageId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(run.trigger.kind).toBe("message");
    expect(run.trigger.futureField).toBe(true);
    expect(run.botId).toBe("bot_1");
  });

  it("parses run events and timers", () => {
    expect(
      runEventSchema.parse({
        id: "evt_1",
        runId: "run_1",
        seq: 1,
        type: "log",
        data: { ok: true },
        dedupeKey: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      }).seq,
    ).toBe(1);
    expect(
      runTimerSchema.parse({
        id: "timer_1",
        userId: "demo-user",
        runId: "run_1",
        kind: "lease_recovery",
        dueAt: "2026-01-01T00:00:00.000Z",
        status: "pending",
        claimedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      }).status,
    ).toBe("pending");
  });

  it("accepts the new conversation projection statuses", () => {
    const conversation = conversationSchema.parse({
      id: "conv_1",
      title: "Chat",
      botIds: ["bot_1"],
      activeRunId: "run_1",
      runStatus: "awaiting_approval",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(conversation.runStatus).toBe("awaiting_approval");
  });
});
