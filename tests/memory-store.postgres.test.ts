import { randomUUID } from "node:crypto";
import { initSchema } from "../db/schema-init";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MemoryConflictError,
  planMemoryOperation,
  type MemoryWriteContext,
} from "../apps/web/lib/server/memory-files";

/**
 * Optional Postgres integration suite for durable file memory. Runs only when
 * TEST_DATABASE_URL is set; applies db/schema.sql first.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PostgresStore memory (integration)", () => {
  const userId = `test-memory-${randomUUID()}`;
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
      await sql`delete from memory_files where user_id = ${userId}`;
      await sql`delete from conversations where user_id = ${userId}`;
      await sql`delete from bots where user_id = ${userId}`;
      await sql.end();
    }
    const client = (store as unknown as { client?: { end(): Promise<void> } } | undefined)?.client;
    await client?.end();
  });

  it("creates, compare-and-swaps, isolates, and deletes scoped files", async () => {
    const bot = await store.createBot(userId, {
      name: "Memory",
      handle: `mem_${userId.slice(-8)}`,
      persona: "A testing bot with clear answers.",
      model: "openai/test",
      integrationIds: [],
    });
    const conversation = await store.createConversation(userId, { title: "Memory", botIds: [bot.id] });
    const scope = { userId, conversationId: conversation.id, botId: bot.id };
    const now = "2026-01-02T00:00:00.000Z";
    const ctx: MemoryWriteContext = { actor: "model", source: "assistant", now };

    const create = planMemoryOperation([], { op: "create", path: "notes/a.md", content: "hello" }, ctx);
    const created = await store.memory.apply(scope, create);
    expect(created).toMatchObject({ path: "notes/a.md", content: "hello", version: 1 });

    const files = await store.memory.list(scope);
    const update = planMemoryOperation(
      files,
      { op: "str_replace", path: "notes/a.md", old: "hello", new: "bye" },
      ctx,
    );
    expect(await store.memory.apply(scope, update)).toMatchObject({ content: "bye", version: 2 });
    await expect(store.memory.apply(scope, update)).rejects.toThrow(MemoryConflictError);

    expect(await store.memory.list({ ...scope, userId: "other-user" })).toEqual([]);
    expect(await store.memory.delete(scope, ["notes/a.md"])).toBe(1);
    expect(await store.memory.list(scope)).toEqual([]);
  });

  it("removes a deleted bot's scoped memory but keeps global instructions and other bots", async () => {
    const now = "2026-01-02T00:00:00.000Z";
    const a = await store.createBot(userId, {
      name: "A",
      handle: `a_${userId.slice(-8)}`,
      persona: "A",
      model: "openai/test",
      integrationIds: [],
    });
    const b = await store.createBot(userId, {
      name: "B",
      handle: `b_${userId.slice(-8)}`,
      persona: "B",
      model: "openai/test",
      integrationIds: [],
    });
    const convA = await store.createConversation(userId, { title: "A", botIds: [a.id] });
    const convB = await store.createConversation(userId, { title: "B", botIds: [b.id] });
    const scopeA = { userId, conversationId: convA.id, botId: a.id };
    const scopeB = { userId, conversationId: convB.id, botId: b.id };
    const globalScope = { userId, conversationId: "", botId: "" };
    const modelCtx: MemoryWriteContext = { actor: "model", source: "assistant", now };
    const userCtx: MemoryWriteContext = { actor: "user", source: "user", now };

    await store.memory.apply(
      globalScope,
      planMemoryOperation([], { op: "create", path: "instructions.md", content: "Global rules." }, userCtx),
    );
    await store.memory.apply(
      scopeA,
      planMemoryOperation([], { op: "create", path: "notes/a.md", content: "a" }, modelCtx),
    );
    await store.memory.apply(
      scopeB,
      planMemoryOperation([], { op: "create", path: "notes/b.md", content: "b" }, modelCtx),
    );

    await store.deleteBot(userId, a.id);

    expect(await store.memory.list(scopeA)).toEqual([]);
    expect((await store.memory.list(scopeB)).map((file) => file.path)).toEqual(["notes/b.md"]);
    expect((await store.memory.list(globalScope)).map((file) => file.path)).toEqual(["instructions.md"]);
  });
});
