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
  const directory = await mkdtemp(join(tmpdir(), "slop-approval-"));
  directories.push(directory);
  const file = join(directory, "store.json");
  return { store: new FileStore(file), file };
}

async function awaitingApproval(store: FileStore, expiresAt: string | null) {
  const conversation = await store.createConversation("demo-user", { title: "Approval", botIds: ["bot_nova"] });
  const claim = await store.runs.claimRun({
    kind: "message",
    userId: "demo-user",
    conversationId: conversation.id,
    message: { senderType: "user", senderId: "demo-user", content: "Go" },
  });
  if (claim.outcome !== "claimed") throw new Error("not claimed");
  const running = await store.runs.transitionRun({
    userId: "demo-user",
    runId: claim.run.id,
    expectedStatus: "queued",
    expectedFence: claim.run.fence,
    status: "running",
  });
  if (running.outcome !== "applied") throw new Error("not running");
  const action = await store.createPendingAction({
    userId: "demo-user",
    conversationId: conversation.id,
    botId: "bot_nova",
    kind: "tool_approval",
    summary: "Create an issue",
    modelMessages: [],
    runId: claim.run.id,
    toolName: "GITHUB_CREATE_ISSUE",
    toolArgsRedacted: { title: "Bug" },
    toolRisk: "write",
    idempotencyKey: "approval-key-1",
    expiresAt,
    integrationId: "mcp_1",
    integrationName: "GitHub",
  });
  const waiting = await store.runs.transitionRun({
    userId: "demo-user",
    runId: claim.run.id,
    expectedStatus: "running",
    expectedFence: running.run.fence,
    status: "awaiting_approval",
  });
  if (waiting.outcome !== "applied") throw new Error("not waiting");
  return { conversation, run: waiting.run, action };
}

describe("pending action metadata", () => {
  it("persists structured tool metadata and defaults a deadline", async () => {
    const { store } = await makeStore();
    const conversation = await store.createConversation("demo-user", { title: "Meta", botIds: ["bot_nova"] });
    const action = await store.createPendingAction({
      userId: "demo-user",
      conversationId: conversation.id,
      botId: "bot_nova",
      kind: "tool_approval",
      summary: "Create an issue",
      modelMessages: [],
      toolName: "GITHUB_CREATE_ISSUE",
      toolArgsRedacted: { title: "Bug", token: "[REDACTED]" },
      toolRisk: "write",
      idempotencyKey: "opaque-key",
      integrationId: "mcp_1",
      integrationName: "GitHub",
    });
    expect(action.toolName).toBe("GITHUB_CREATE_ISSUE");
    expect(action.toolRisk).toBe("write");
    expect(action.idempotencyKey).toBe("opaque-key");
    expect(action.integrationName).toBe("GitHub");
    expect(action.expiresAt).toBeTruthy();

    const loaded = await store.getPendingAction("demo-user", action.id);
    expect(loaded?.toolArgsRedacted).toEqual({ title: "Bug", token: "[REDACTED]" });
    expect(loaded?.expiresAt).toBe(action.expiresAt);
  });

  it("defaults legacy rows to read risk and null tool metadata", async () => {
    const { store, file } = await makeStore();
    const conversation = await store.createConversation("demo-user", { title: "Legacy", botIds: ["bot_nova"] });
    const action = await store.createPendingAction({
      userId: "demo-user",
      conversationId: conversation.id,
      botId: "bot_nova",
      kind: "tool_approval",
      summary: "Legacy approval",
      modelMessages: [],
    });

    const state = JSON.parse(await readFile(file, "utf8")) as {
      pendingActions: Array<Record<string, unknown>>;
    };
    const legacy = state.pendingActions.find((item) => item.id === action.id);
    if (!legacy) throw new Error("missing action");
    delete legacy.toolName;
    delete legacy.toolArgsRedacted;
    delete legacy.toolRisk;
    delete legacy.idempotencyKey;
    delete legacy.expiresAt;
    delete legacy.integrationId;
    delete legacy.integrationName;
    await writeFile(file, JSON.stringify(state), "utf8");

    const reloaded = new FileStore(file);
    const loaded = await reloaded.getPendingAction("demo-user", action.id);
    expect(loaded?.toolRisk).toBe("read");
    expect(loaded?.toolName).toBeNull();
    expect(loaded?.expiresAt).toBeNull();
  });

  it("refuses to resume an expired action and expires its run atomically", async () => {
    const { store } = await makeStore();
    const { conversation, run, action } = await awaitingApproval(store, "2026-01-01T00:00:00.000Z");

    const claim = await store.runs.claimRun({
      kind: "approval",
      userId: "demo-user",
      conversationId: conversation.id,
      actionId: action.id,
      decision: "approve",
      now: "2026-01-02T00:00:00.000Z",
    });

    expect(claim.outcome).toBe("cancelled");
    expect((await store.getPendingAction("demo-user", action.id))?.status).toBe("expired");
    expect((await store.runs.getRun("demo-user", run.id))?.status).toBe("expired");
    const projected = await store.getConversation("demo-user", conversation.id);
    expect(projected?.activeRunId).toBeNull();
    expect(projected?.runStatus).toBe("idle");
    const events = await store.runs.listEvents("demo-user", run.id);
    expect(events.some((event) => event.type === "expired")).toBe(true);
  });

  it("still resumes a legacy action with no deadline", async () => {
    const { store } = await makeStore();
    const { conversation, action } = await awaitingApproval(store, null);
    // createPendingAction assigns a deadline; simulate a legacy row directly.
    const state = (store as unknown as { state: { pendingActions: Array<{ id: string; expiresAt: string | null }> } }).state;
    const stored = state.pendingActions.find((item) => item.id === action.id);
    if (!stored) throw new Error("missing action");
    stored.expiresAt = null;

    const claim = await store.runs.claimRun({
      kind: "approval",
      userId: "demo-user",
      conversationId: conversation.id,
      actionId: action.id,
      decision: "approve",
    });
    expect(claim.outcome).toBe("claimed");
  });
});

describe("integration write allowlist persistence", () => {
  it("roundtrips allowedWriteTools and defaults to empty", async () => {
    const { store } = await makeStore();
    const created = await store.createIntegration("demo-user", {
      kind: "mcp",
      name: "GitHub",
      url: "https://example.com/mcp",
      description: "",
      status: "connected",
    });
    expect(created.allowedWriteTools).toEqual([]);

    await store.updateIntegration("demo-user", created.id, { allowedWriteTools: ["GITHUB_CREATE_ISSUE"] });
    expect((await store.getIntegration("demo-user", created.id))?.allowedWriteTools).toEqual(["GITHUB_CREATE_ISSUE"]);
  });
});
