import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it, vi } from "vitest";
import { store, storeDirectory } from "./helpers/workflow-store";
import { runGroupTurn } from "../workflows/group-chat";
import { readMemoryForUser, setReportedMemory } from "../apps/web/lib/server/memory";
import { formatReportedContent } from "../apps/web/lib/server/memory-files";

// The workflow reads its run identity from the Workflow SDK context. Focused
// tests drive the real steps directly, so provide a stable identity.
vi.mock("workflow", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "wf_test" }),
  getStepMetadata: () => ({ stepId: "step_test" }),
  createHook: () => ({ await: async () => undefined }),
  sleep: async () => undefined,
}));

const USER = "demo-user";
const PROMPT = "Report status";

afterAll(async () => {
  await rm(storeDirectory, { recursive: true, force: true });
});

async function seed() {
  const bot = await store.createBot(USER, {
    name: "Nova",
    handle: `nova_${Math.random().toString(36).slice(2, 8)}`,
    persona: "Reports status.",
    model: "test/model",
    integrationIds: [],
  });
  const conversation = await store.createConversation(USER, {
    title: "Scheduled reports",
    botIds: [bot.id],
  });
  return { bot, conversation };
}

async function claimScheduled(conversationId: string) {
  const claim = await store.runs.claimRun({
    kind: "scheduled",
    userId: USER,
    conversationId,
    trigger: {
      automationId: "auto-1",
      occurrenceAt: "2026-01-01T00:00:00.000Z",
      prompt: PROMPT,
    },
  });
  if (claim.outcome !== "claimed") throw new Error(`Expected claimed, got ${claim.outcome}`);
  return claim.run;
}

function turn(conversationId: string, runId: string) {
  return runGroupTurn({
    userId: USER,
    conversationId,
    runId,
    attempt: 0,
    startToken: `slopbot-run-${runId}-a0`,
    useGateway: false,
    scheduled: {
      automationId: "auto-1",
      occurrenceAt: "2026-01-01T00:00:00.000Z",
      prompt: PROMPT,
    },
  });
}

async function reported(conversationId: string, botId: string) {
  const file = await readMemoryForUser(store, USER, conversationId, botId, "reported.md");
  return file?.content ?? null;
}

describe("scheduled report pointer ordering", () => {
  it("does not advance reported.md when the outbox is stale, and still delivers later", async () => {
    const { bot, conversation } = await seed();
    await setReportedMemory(
      store,
      USER,
      conversation.id,
      bot.id,
      formatReportedContent("old report", { runId: "run_prev", at: "2026-01-01T00:00:00.000Z" }),
      "run_prev",
    );

    // Force the first delivery to lose the completion CAS (stale outbox).
    const original = store.runs.completeWithMessage;
    let stale = true;
    (store.runs as { completeWithMessage: typeof original }).completeWithMessage = async (input) => {
      if (stale) {
        stale = false;
        return { outcome: "stale" };
      }
      return original(input);
    };

    const first = await claimScheduled(conversation.id);
    const firstResult = await turn(conversation.id, first.id);
    expect(firstResult.outcome).toBe("skipped");

    // The failed/stale delivery must not advance the duplicate pointer.
    expect(await reported(conversation.id, bot.id)).toContain("old report");
    expect(await store.listMessages(USER, conversation.id)).toHaveLength(0);

    // Free the conversation for the retry.
    const current = await store.runs.getRun(USER, first.id);
    if (!current) throw new Error("First run disappeared");
    await store.runs.transitionRun({
      userId: USER,
      runId: first.id,
      expectedStatus: "running",
      expectedFence: current.fence,
      status: "failed",
      error: "stale outbox",
    });

    // A later delivery of the same report must still be visible.
    const second = await claimScheduled(conversation.id);
    const secondResult = await turn(conversation.id, second.id);
    expect(secondResult.outcome).toBe("completed");
    const messages = await store.listMessages(USER, conversation.id);
    expect(messages.filter((message) => message.senderType === "bot")).toHaveLength(1);
    expect(await reported(conversation.id, bot.id)).toContain("Report status");

    // A genuinely identical second delivery is legitimately suppressed.
    const third = await claimScheduled(conversation.id);
    const thirdResult = await turn(conversation.id, third.id);
    expect(thirdResult.outcome).toBe("completed_silent");
    expect(await store.listMessages(USER, conversation.id)).toHaveLength(1);
    const thirdRun = await store.runs.getRun(USER, third.id);
    expect(thirdRun?.status).toBe("succeeded");
    const events = await store.runs.listEvents(USER, third.id);
    expect(events.some((event) => event.type === "report_suppressed")).toBe(true);
  });
});
