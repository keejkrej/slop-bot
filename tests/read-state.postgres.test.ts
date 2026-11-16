import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Optional Postgres integration suite for read bookmarks. Runs only when
 * TEST_DATABASE_URL is set; applies db/schema.sql first.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PostgresStore read state (integration)", () => {
  const userId = `test-read-${randomUUID()}`;
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
      await sql`delete from conversation_reads where user_id = ${userId}`;
      await sql`delete from messages where user_id = ${userId}`;
      await sql`delete from conversations where user_id = ${userId}`;
      await sql`delete from bots where user_id = ${userId}`;
      await sql.end();
    }
    const client = (store as unknown as { client?: { end(): Promise<void> } } | undefined)?.client;
    await client?.end();
  });

  it("counts bot messages and advances the bookmark forward only", async () => {
    const bot = await store.createBot(userId, {
      name: "Read",
      handle: `read_${userId.slice(-8)}`,
      persona: "A testing bot with clear answers.",
      model: "openai/test",
      integrationIds: [],
    });
    const conversation = await store.createConversation(userId, { title: "Read", botIds: [bot.id] });
    const first = await store.addMessage(userId, { conversationId: conversation.id, senderType: "bot", senderId: bot.id, content: "One" });
    const second = await store.addMessage(userId, { conversationId: conversation.id, senderType: "bot", senderId: bot.id, content: "Two" });
    await store.addMessage(userId, { conversationId: conversation.id, senderType: "user", senderId: userId, content: "Question" });

    expect(await store.readState.getUnreadCounts(userId)).toEqual({ [conversation.id]: 2 });

    await store.readState.markRead(userId, conversation.id, second.id);
    expect(await store.readState.getUnreadCounts(userId)).toEqual({});

    const backwards = await store.readState.markRead(userId, conversation.id, first.id);
    expect(backwards?.lastReadMessageId).toBe(second.id);
    expect(await store.readState.getUnreadCounts(userId)).toEqual({});
  });
});
