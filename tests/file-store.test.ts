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
  const directory = await mkdtemp(join(tmpdir(), "slop-store-"));
  directories.push(directory);
  return new FileStore(join(directory, "store.json"));
}

async function setMessageTimes(file: string, times: string[]) {
  const state = JSON.parse(await readFile(file, "utf8")) as { messages: Array<{ createdAt: string }> };
  state.messages.forEach((message, index) => {
    const time = times[index];
    if (time) message.createdAt = time;
  });
  await writeFile(file, JSON.stringify(state));
}

describe("FileStore", () => {
  it("persists owned bots, chats, messages, and encrypted secrets", async () => {
    const store = await makeStore();
    const bot = await store.createBot("demo-user", { name: "Test", handle: "test", persona: "A testing bot with clear answers.", model: "openai/test", integrationIds: [] });
    const conversation = await store.createConversation("demo-user", { title: "Test chat", botIds: [bot.id] });
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

  it("previews the latest bot reply per bot across conversations", async () => {
    const store = await makeStore();
    const file = join(directories[0]!, "store.json");
    const bot = await store.createBot("demo-user", { name: "Test", handle: "test", persona: "A testing bot with clear answers.", model: "openai/test", integrationIds: [] });
    const first = await store.createConversation("demo-user", { title: "First", botIds: [bot.id] });
    const second = await store.createConversation("demo-user", { title: "Second", botIds: [bot.id] });
    await store.addMessage("demo-user", { conversationId: first.id, senderType: "bot", senderId: bot.id, content: "Older reply" });
    await store.addMessage("demo-user", { conversationId: second.id, senderType: "bot", senderId: bot.id, content: "Newest reply\nwith a second line" });
    await setMessageTimes(file, ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);

    const previews = await new FileStore(file).listBotPreviews("demo-user");
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({ botId: bot.id, content: "Newest reply\nwith a second line" });
  });

  it("ignores newer user and system messages when previewing a bot", async () => {
    const store = await makeStore();
    const file = join(directories[0]!, "store.json");
    const bot = await store.createBot("demo-user", { name: "Test", handle: "test", persona: "A testing bot with clear answers.", model: "openai/test", integrationIds: [] });
    const conversation = await store.createConversation("demo-user", { title: "Test chat", botIds: [bot.id] });
    await store.addMessage("demo-user", { conversationId: conversation.id, senderType: "bot", senderId: bot.id, content: "Bot reply" });
    await store.addMessage("demo-user", { conversationId: conversation.id, senderType: "user", senderId: "demo-user", content: "Newer user message" });
    await store.addMessage("demo-user", { conversationId: conversation.id, senderType: "system", senderId: "system", content: "Newer system message" });
    await setMessageTimes(file, ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"]);

    const previews = await new FileStore(file).listBotPreviews("demo-user");
    expect(previews).toHaveLength(1);
    expect(previews[0]?.content).toBe("Bot reply");
  });

  it("isolates bot previews by user", async () => {
    const store = await makeStore();
    const mine = await store.createBot("demo-user", { name: "Mine", handle: "mine", persona: "A testing bot with clear answers.", model: "openai/test", integrationIds: [] });
    const theirs = await store.createBot("other-user", { name: "Theirs", handle: "theirs", persona: "A testing bot with clear answers.", model: "openai/test", integrationIds: [] });
    const myConversation = await store.createConversation("demo-user", { title: "Mine", botIds: [mine.id] });
    const theirConversation = await store.createConversation("other-user", { title: "Theirs", botIds: [theirs.id] });
    await store.addMessage("demo-user", { conversationId: myConversation.id, senderType: "bot", senderId: mine.id, content: "My reply" });
    await store.addMessage("other-user", { conversationId: theirConversation.id, senderType: "bot", senderId: theirs.id, content: "Their reply" });

    const previews = await store.listBotPreviews("demo-user");
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({ botId: mine.id, content: "My reply" });
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
