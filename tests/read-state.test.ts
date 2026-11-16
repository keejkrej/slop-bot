import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapSchema, markReadSchema, unreadCountsSchema } from "@slopbot/contracts";
import { FileStore } from "../db/file-store";

let directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

async function makeStore() {
  const directory = await mkdtemp(join(tmpdir(), "slop-read-"));
  directories.push(directory);
  const file = join(directory, "store.json");
  return { store: new FileStore(file), file };
}

async function setMessageTimes(file: string, times: string[]) {
  const state = JSON.parse(await readFile(file, "utf8")) as { messages: Array<{ createdAt: string }> };
  state.messages.forEach((message, index) => {
    const time = times[index];
    if (time) message.createdAt = time;
  });
  await writeFile(file, JSON.stringify(state));
}

async function seedConversation(store: FileStore, userId = "demo-user") {
  const bot = await store.createBot(userId, {
    name: "Test",
    handle: `test_${userId.replace(/[^a-z0-9]/g, "")}`,
    persona: "A testing bot with clear answers.",
    model: "openai/test",
    integrationIds: [],
  });
  const conversation = await store.createConversation(userId, { title: "Test chat", botIds: [bot.id] });
  return { bot, conversation };
}

describe("read state", () => {
  it("moves forward only, is idempotent, and rejects wrong owners", async () => {
    const { store, file } = await makeStore();
    const { bot, conversation } = await seedConversation(store);
    const first = await store.addMessage("demo-user", { conversationId: conversation.id, senderType: "bot", senderId: bot.id, content: "One" });
    const second = await store.addMessage("demo-user", { conversationId: conversation.id, senderType: "bot", senderId: bot.id, content: "Two" });
    const third = await store.addMessage("demo-user", { conversationId: conversation.id, senderType: "bot", senderId: bot.id, content: "Three" });
    await setMessageTimes(file, [
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    ]);

    const reloaded = new FileStore(file);
    expect(await reloaded.readState.getUnreadCounts("demo-user")).toEqual({ [conversation.id]: 3 });

    const marked = await reloaded.readState.markRead("demo-user", conversation.id, second.id);
    expect(marked).toMatchObject({ conversationId: conversation.id, lastReadAt: "2026-01-02T00:00:00.000Z", lastReadMessageId: second.id });
    expect(await reloaded.readState.getUnreadCounts("demo-user")).toEqual({ [conversation.id]: 1 });

    // Older bookmark is a no-op.
    const backwards = await reloaded.readState.markRead("demo-user", conversation.id, first.id);
    expect(backwards).toMatchObject({ lastReadAt: "2026-01-02T00:00:00.000Z", lastReadMessageId: second.id });

    // Same bookmark is idempotent.
    const again = await reloaded.readState.markRead("demo-user", conversation.id, second.id);
    expect(again).toMatchObject({ lastReadAt: "2026-01-02T00:00:00.000Z", lastReadMessageId: second.id });

    await reloaded.readState.markRead("demo-user", conversation.id, third.id);
    expect(await reloaded.readState.getUnreadCounts("demo-user")).toEqual({});

    // Wrong owner cannot read another user's conversation.
    const other = await seedConversation(reloaded, "other-user");
    expect(await reloaded.readState.markRead("demo-user", other.conversation.id, null)).toBeNull();

    // A message from another conversation is rejected.
    await expect(reloaded.readState.markRead("demo-user", conversation.id, "msg_missing")).rejects.toThrow("Message not found.");
  });

  it("counts only bot messages and ignores user, system, and silent runs", async () => {
    const { store, file } = await makeStore();
    const { bot, conversation } = await seedConversation(store);
    await store.addMessage("demo-user", { conversationId: conversation.id, senderType: "user", senderId: "demo-user", content: "Question" });
    await store.addMessage("demo-user", { conversationId: conversation.id, senderType: "system", senderId: "system", content: "System note" });
    await store.addMessage("demo-user", { conversationId: conversation.id, senderType: "bot", senderId: bot.id, content: "Answer" });
    await setMessageTimes(file, [
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    ]);

    const reloaded = new FileStore(file);
    expect(await reloaded.readState.getUnreadCounts("demo-user")).toEqual({ [conversation.id]: 1 });

    // A silent scheduled run adds no bot message, so it cannot create unread.
    const silent = await seedConversation(reloaded, "silent-user");
    await reloaded.addMessage("silent-user", { conversationId: silent.conversation.id, senderType: "user", senderId: "silent-user", content: "Trigger" });
    expect(await reloaded.readState.getUnreadCounts("silent-user")).toEqual({});
  });

  it("marks the whole conversation read when no message id is supplied", async () => {
    const { store, file } = await makeStore();
    const { bot, conversation } = await seedConversation(store);
    await store.addMessage("demo-user", { conversationId: conversation.id, senderType: "bot", senderId: bot.id, content: "One" });
    await store.addMessage("demo-user", { conversationId: conversation.id, senderType: "bot", senderId: bot.id, content: "Two" });
    await setMessageTimes(file, ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);

    const reloaded = new FileStore(file);
    const marked = await reloaded.readState.markRead("demo-user", conversation.id, null);
    expect(marked).toMatchObject({ lastReadAt: "2026-01-02T00:00:00.000Z" });
    expect(await reloaded.readState.getUnreadCounts("demo-user")).toEqual({});
  });

  it("uses a stable (createdAt, id) order for equal timestamps so a bookmark never moves backwards", async () => {
    const { store, file } = await makeStore();
    const { bot, conversation } = await seedConversation(store);
    await store.addMessage("demo-user", { conversationId: conversation.id, senderType: "bot", senderId: bot.id, content: "One" });
    await store.addMessage("demo-user", { conversationId: conversation.id, senderType: "bot", senderId: bot.id, content: "Two" });
    await store.addMessage("demo-user", { conversationId: conversation.id, senderType: "bot", senderId: bot.id, content: "Three" });
    await setMessageTimes(file, [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);

    const reloaded = new FileStore(file);
    const messages = (await reloaded.listMessages("demo-user", conversation.id)).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const [first, middle, last] = messages;
    if (!first || !middle || !last) throw new Error("Expected three messages");

    expect(await reloaded.readState.getUnreadCounts("demo-user")).toEqual({ [conversation.id]: 3 });

    const marked = await reloaded.readState.markRead("demo-user", conversation.id, middle.id);
    expect(marked).toMatchObject({ lastReadAt: middle.createdAt, lastReadMessageId: middle.id });
    expect(await reloaded.readState.getUnreadCounts("demo-user")).toEqual({ [conversation.id]: 1 });

    // An equal-timestamp message with a lower id is already read; it must not
    // move the bookmark backwards and make the later message unread again.
    const backwards = await reloaded.readState.markRead("demo-user", conversation.id, first.id);
    expect(backwards).toMatchObject({ lastReadMessageId: middle.id });
    expect(await reloaded.readState.getUnreadCounts("demo-user")).toEqual({ [conversation.id]: 1 });

    await reloaded.readState.markRead("demo-user", conversation.id, last.id);
    expect(await reloaded.readState.getUnreadCounts("demo-user")).toEqual({});
  });

  it("keeps bootstrap unread counts additive and content-free", () => {
    const parsed = bootstrapSchema.parse({
      user: { id: "demo-user", name: "Local human", email: null, avatarUrl: null },
      bots: [],
      conversations: [],
      integrations: [],
      agentMode: "demo",
    });
    expect(parsed.unreadCounts).toEqual({});
    expect(unreadCountsSchema.parse({ conv_1: 2 })).toEqual({ conv_1: 2 });
    expect(markReadSchema.parse({})).toEqual({});
    expect(markReadSchema.parse({ messageId: null })).toEqual({ messageId: null });
  });
});
