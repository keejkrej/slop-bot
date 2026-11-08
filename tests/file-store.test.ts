import { mkdtemp, rm } from "node:fs/promises";
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
  const directory = await mkdtemp(join(tmpdir(), "slop-store-"));
  directories.push(directory);
  return new FileStore(join(directory, "store.json"));
}

describe("FileStore", () => {
  it("persists owned bots, rooms, messages, and encrypted secrets", async () => {
    const store = await makeStore();
    const bot = await store.createBot("demo-user", { name: "Test", handle: "test", persona: "A testing bot with clear answers.", model: "openai/test", integrationIds: [] });
    const conversation = await store.createConversation("demo-user", { title: "Test room", botIds: [bot.id] });
    await store.addMessage("demo-user", { conversationId: conversation.id, senderType: "user", senderId: "demo-user", content: "Hello" });
    const integration = await store.createIntegration("demo-user", { kind: "mcp", name: "Notes", url: "https://example.com/mcp", description: "Notes", status: "connected" });
    await store.setSecret("demo-user", integration.id, { tokens: { access_token: "not-plaintext" } });

    const reloaded = new FileStore(join(directories[0]!, "store.json"));
    expect((await reloaded.listMessages("demo-user", conversation.id))[0]?.content).toBe("Hello");
    expect(await reloaded.getSecret("demo-user", integration.id)).toEqual({ tokens: { access_token: "not-plaintext" } });
    expect(JSON.stringify(await reloaded.listIntegrations("demo-user"))).not.toContain("not-plaintext");
  });

  it("tracks pending desktop connections until Electrobun claims them", async () => {
    const store = await makeStore();
    const integration = await store.createIntegration("demo-user", {
      kind: "desktop",
      name: "Local MCP",
      url: "http://127.0.0.1:3030/mcp",
      description: "Local",
      status: "authorization_required",
    });
    await store.setSecret("demo-user", integration.id, { pending: true, tools: [] });
    expect(await store.listPendingDesktopConnections("demo-user")).toHaveLength(1);
    await store.setSecret("demo-user", integration.id, { pending: false, deviceId: "device-1", tools: [] });
    expect(await store.listPendingDesktopConnections("demo-user")).toHaveLength(0);
  });

  it("persists and completes signed approval state", async () => {
    const store = await makeStore();
    const action = await store.createPendingAction({
      userId: "demo-user",
      conversationId: "conv_1",
      botId: "bot_1",
      kind: "tool_approval",
      summary: "send_email to owner@example.com",
      modelMessages: [{ role: "user", content: "Send it" }],
    });
    expect(action.status).toBe("pending");
    expect((await store.listPendingActions("demo-user", "conv_1"))[0]?.summary).toContain("owner@example.com");
    await store.setPendingActionStatus("demo-user", action.id, "completed");
    expect(await store.listPendingActions("demo-user", "conv_1")).toHaveLength(0);
  });

  it("expires OAuth state and completes a desktop job once", async () => {
    const store = await makeStore();
    const job = await store.createDesktopJob({ userId: "demo-user", deviceId: "device-123456", integrationId: "integration", toolName: "read", args: {} });
    expect(await store.listPendingDesktopJobs("demo-user", "device-123456")).toHaveLength(1);
    expect((await store.completeDesktopJob("demo-user", job.id, { ok: true, output: { read: true } }))?.status).toBe("completed");
    expect(await store.completeDesktopJob("demo-user", job.id, { ok: true })).toBeNull();
    expect(await store.listPendingDesktopJobs("demo-user", "device-123456")).toHaveLength(0);
  });
});
