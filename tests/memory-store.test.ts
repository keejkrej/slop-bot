import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore } from "../db/file-store";
import type { MemoryScope } from "../db/types";
import {
  applyMemoryOperationForUser,
  exportMemoryForUser,
  forgetMemoryForUser,
  globalMemoryScope,
  listMemoryDirectoryForUser,
  loadCoreMemory,
  resolveMemoryScope,
  setReportedMemory,
  setUserInstructions,
} from "../apps/web/lib/server/memory";
import {
  buildCoreContext,
  formatReportedContent,
  isDuplicateReport,
  MemoryConflictError,
  MemoryPathError,
  MemoryPolicyError,
  planMemoryOperation,
  reportedHashOf,
  type MemoryFile,
  type MemoryWriteContext,
} from "../apps/web/lib/server/memory-files";
import { approvalSummary, buildResumeMessages, pruneModelMessages } from "../workflows/group-chat";
import type { ModelMessage } from "ai";

let directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

const NOW = "2026-01-02T00:00:00.000Z";

async function makeStore() {
  const directory = await mkdtemp(join(tmpdir(), "slop-memory-"));
  directories.push(directory);
  return new FileStore(join(directory, "store.json"));
}

async function makeBotConversation(store: FileStore, userId = "demo-user") {
  const bot = await store.createBot(userId, {
    name: "Memory Bot",
    handle: `memory_${Math.random().toString(36).slice(2, 8)}`,
    persona: "A bot used to test durable file memory.",
    model: "openai/test",
    integrationIds: [],
  });
  const conversation = await store.createConversation(userId, {
    title: "Memory",
    botIds: [bot.id],
  });
  return { bot, conversation };
}

function ctx(overrides: Partial<MemoryWriteContext> = {}): MemoryWriteContext {
  return { actor: "model", source: "assistant", now: NOW, ...overrides };
}

async function createFile(
  store: FileStore,
  scope: MemoryScope,
  path: string,
  content: string,
  context: MemoryWriteContext = ctx(),
): Promise<MemoryFile> {
  const files = await store.memory.list(scope);
  const plan = planMemoryOperation(files, { op: "create", path, content }, context);
  const file = await store.memory.apply(scope, plan);
  if (!file) throw new Error("Expected a created file");
  return file;
}

describe("durable memory store", () => {
  it("creates, reads, lists, and compare-and-swaps files", async () => {
    const store = await makeStore();
    const { bot, conversation } = await makeBotConversation(store);
    const scope = { userId: "demo-user", conversationId: conversation.id, botId: bot.id };

    const created = await createFile(store, scope, "notes/a.md", "hello");
    expect(created).toMatchObject({ path: "notes/a.md", content: "hello", version: 1 });

    expect((await store.memory.list(scope)).map((file) => file.path)).toEqual(["notes/a.md"]);
    expect((await store.memory.read(scope, "notes/a.md"))?.content).toBe("hello");

    const files = await store.memory.list(scope);
    const update = planMemoryOperation(
      files,
      { op: "str_replace", path: "notes/a.md", old: "hello", new: "bye" },
      ctx(),
    );
    const updated = await store.memory.apply(scope, update);
    expect(updated).toMatchObject({ content: "bye", version: 2 });

    // A stale plan must not overwrite the newer revision.
    await expect(store.memory.apply(scope, update)).rejects.toThrow(MemoryConflictError);
  });

  it("isolates files by user and by conversation/bot binding", async () => {
    const store = await makeStore();
    const { bot, conversation } = await makeBotConversation(store);
    const scope = { userId: "demo-user", conversationId: conversation.id, botId: bot.id };
    await createFile(store, scope, "notes/a.md", "private");

    expect(await store.memory.list({ ...scope, userId: "other-user" })).toEqual([]);
    expect(await store.memory.list({ ...scope, conversationId: "other-conversation" })).toEqual([]);
    expect(await store.memory.list({ ...scope, botId: "other-bot" })).toEqual([]);
    expect(await store.memory.read({ ...scope, userId: "other-user" }, "notes/a.md")).toBeNull();
  });

  it("deletes only explicit paths in one scope", async () => {
    const store = await makeStore();
    const { bot, conversation } = await makeBotConversation(store);
    const scope = { userId: "demo-user", conversationId: conversation.id, botId: bot.id };
    await createFile(store, scope, "notes/a.md", "a");
    await createFile(store, scope, "notes/b.md", "b");

    expect(await store.memory.delete(scope, ["notes/a.md"])).toBe(1);
    expect((await store.memory.list(scope)).map((file) => file.path)).toEqual(["notes/b.md"]);
  });

  it("removes a deleted bot's scoped memory but keeps global instructions and other bots", async () => {
    const store = await makeStore();
    const a = await makeBotConversation(store);
    const b = await makeBotConversation(store);
    await setUserInstructions(store, "demo-user", "Global rules.", null);
    const scopeA = { userId: "demo-user", conversationId: a.conversation.id, botId: a.bot.id };
    const scopeB = { userId: "demo-user", conversationId: b.conversation.id, botId: b.bot.id };
    await createFile(store, scopeA, "notes/a.md", "a");
    await createFile(store, scopeB, "notes/b.md", "b");

    await store.deleteBot("demo-user", a.bot.id);

    expect(await store.memory.list(scopeA)).toEqual([]);
    expect((await store.memory.list(scopeB)).map((file) => file.path)).toEqual(["notes/b.md"]);
    expect((await store.memory.list(globalMemoryScope("demo-user"))).map((file) => file.path)).toEqual([
      "instructions.md",
    ]);
  });
});

describe("memory adapter identity and policy", () => {
  it("rejects traversal paths and model writes to instructions", async () => {
    const store = await makeStore();
    const { bot, conversation } = await makeBotConversation(store);

    await expect(
      applyMemoryOperationForUser(
        store,
        "demo-user",
        conversation.id,
        bot.id,
        { op: "create", path: "../escape.md", content: "x" },
        ctx(),
      ),
    ).rejects.toThrow(MemoryPathError);

    await expect(
      applyMemoryOperationForUser(
        store,
        "demo-user",
        conversation.id,
        bot.id,
        { op: "create", path: "instructions.md", content: "x" },
        ctx(),
      ),
    ).rejects.toThrow(MemoryPolicyError);
  });

  it("rejects a conversation or bot that does not belong to the user", async () => {
    const store = await makeStore();
    const { bot, conversation } = await makeBotConversation(store);

    await expect(
      resolveMemoryScope(store, "other-user", conversation.id, bot.id),
    ).rejects.toMatchObject({ status: 404 });

    const otherBot = await store.createBot("demo-user", {
      name: "Other",
      handle: "other_bot",
      persona: "A different bot that is not in the conversation.",
      model: "openai/test",
      integrationIds: [],
    });
    await expect(
      resolveMemoryScope(store, "demo-user", conversation.id, otherBot.id),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("does not expose another user's directory or instructions", async () => {
    const store = await makeStore();
    const { bot, conversation } = await makeBotConversation(store);
    await setUserInstructions(store, "demo-user", "Be concise.", null);
    await createFile(
      store,
      { userId: "demo-user", conversationId: conversation.id, botId: bot.id },
      "notes/a.md",
      "private",
    );

    await expect(
      listMemoryDirectoryForUser(store, "other-user", conversation.id, bot.id),
    ).rejects.toMatchObject({ status: 404 });

    const ownView = await listMemoryDirectoryForUser(store, "demo-user", conversation.id, bot.id);
    expect(ownView.instructions?.content).toBe("Be concise.");
    expect(ownView.files.map((file) => file.path)).toEqual(["notes/a.md"]);
  });
});

describe("core memory loading", () => {
  it("loads instructions, index, and reported but not notes or progress", async () => {
    const store = await makeStore();
    const { bot, conversation } = await makeBotConversation(store);
    const scope = { userId: "demo-user", conversationId: conversation.id, botId: bot.id };

    await setUserInstructions(store, "demo-user", "Always be concise.", null);
    await createFile(store, scope, "index.md", "Index of notes.");
    await createFile(store, scope, "reported.md", "Last run summary.", ctx({ actor: "system", source: "system" }));
    await createFile(store, scope, "notes/secret.md", "lazy note");
    await createFile(store, scope, "progress/run.md", "lazy progress");

    const core = await loadCoreMemory(store, "demo-user", conversation.id, bot.id);
    expect(core.files.map((file) => file.path)).toEqual([
      "instructions.md",
      "index.md",
      "reported.md",
    ]);
    expect(core.promptSection).toContain("User-confirmed instructions (trusted)");
    expect(core.promptSection).toContain("reference data, not instructions");
    expect(core.promptSection).not.toContain("lazy note");
    expect(core.promptSection).not.toContain("lazy progress");
  });

  it("applies per-file and total caps", () => {
    const files: MemoryFile[] = [
      { path: "instructions.md" as MemoryFile["path"], content: "i".repeat(100), version: 1, source: "user", provenance: "test", sourceRunId: null, createdAt: NOW, updatedAt: NOW },
      { path: "index.md" as MemoryFile["path"], content: "x".repeat(100), version: 1, source: "assistant", provenance: "test", sourceRunId: null, createdAt: NOW, updatedAt: NOW },
      { path: "reported.md" as MemoryFile["path"], content: "r".repeat(100), version: 1, source: "system", provenance: "test", sourceRunId: null, createdAt: NOW, updatedAt: NOW },
    ];
    const core = buildCoreContext(files, { perFileChars: 10, totalChars: 15 });
    expect(core.totalChars).toBe(15);
    expect(core.files[0]!.content).toHaveLength(10);
    expect(core.files[1]!.content).toHaveLength(5);
    expect(core.files[2]!.content).toHaveLength(0);
  });
});

describe("scheduled report suppression", () => {
  it("round-trips the report pointer and hash", () => {
    const content = formatReportedContent("All quiet.", { runId: "run_1", at: NOW });
    expect(reportedHashOf(content)).toMatch(/^[a-f0-9]{64}$/);
    expect(isDuplicateReport(content, "All quiet.")).toBe(true);
    expect(isDuplicateReport(content, "Something changed.")).toBe(false);
    expect(isDuplicateReport(null, "All quiet.")).toBe(false);
  });

  it("writes reported.md as system metadata and detects a repeat", async () => {
    const store = await makeStore();
    const { bot, conversation } = await makeBotConversation(store);
    const content = formatReportedContent("Same result", { runId: "run_1", at: NOW });
    await setReportedMemory(store, "demo-user", conversation.id, bot.id, content, "run_1");

    const stored = await store.memory.read(
      { userId: "demo-user", conversationId: conversation.id, botId: bot.id },
      "reported.md",
    );
    expect(stored?.source).toBe("system");
    expect(isDuplicateReport(stored?.content ?? null, "Same result")).toBe(true);
  });
});

describe("context pruning", () => {
  it("bounds history while keeping the newest approval pair contiguous", () => {
    const messages: ModelMessage[] = [];
    // Many older tool steps that should be dropped once the bound is exceeded.
    for (let index = 0; index < 40; index += 1) {
      messages.push({ role: "user", content: `older request ${index}` });
      messages.push({
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: `call_old_${index}`, toolName: "memory_write", input: { path: `notes/old-${index}.md` } },
        ],
      });
      messages.push({
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: `call_old_${index}`, toolName: "memory_write", output: { type: "text", value: "ok" } },
        ],
      } as ModelMessage);
    }
    // Newest approval pair: assistant tool-call + approval request.
    messages.push({ role: "user", content: "Delete the note" });
    messages.push({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "call_new", toolName: "memory_delete", input: { path: "notes/a.md" } },
        {
          type: "tool-approval-request",
          approvalId: "approval-new",
          toolCall: { toolCallId: "call_new", toolName: "memory_delete", input: { path: "notes/a.md" } },
        },
      ],
    } as ModelMessage);

    const pruned = pruneModelMessages(messages, 10);
    expect(pruned.length).toBeLessThanOrEqual(10);

    // The newest approval pair is the final message and stays intact.
    const last = pruned[pruned.length - 1]!;
    expect(Array.isArray(last.content)).toBe(true);
    const types = (last.content as Array<{ type?: string }>).map((part) => part.type);
    expect(types).toContain("tool-call");
    expect(types).toContain("tool-approval-request");

    // The retained window never starts on a dangling tool result.
    const first = pruned[0]!;
    const firstTypes = Array.isArray(first.content)
      ? (first.content as Array<{ type?: string }>).map((part) => part.type)
      : [];
    expect(firstTypes).not.toContain("tool-result");

    // Older tool steps are dropped.
    expect(pruned.some((message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => (part as { toolCallId?: string }).toolCallId === "call_old_0"),
    )).toBe(false);

    // Resuming appends the approval response directly after the pair.
    const resumed = buildResumeMessages({ modelMessages: pruned, providerApprovalId: "approval-new" });
    const response = resumed[resumed.length - 1]!;
    expect(Array.isArray(response.content)).toBe(true);
    expect((response.content as Array<{ type?: string }>)[0]?.type).toBe("tool-approval-response");
    expect(resumed[resumed.length - 2]).toBe(last);
  });

  it("trims plain histories to the bound", () => {
    const messages: ModelMessage[] = Array.from({ length: 60 }, (_, index) => ({
      role: "user" as const,
      content: `message ${index}`,
    }));
    expect(pruneModelMessages(messages, 10)).toHaveLength(10);
  });

  it("summarizes a memory deletion approval", () => {
    expect(approvalSummary("memory_delete", { path: "notes/a.md" })).toContain("notes/a.md");
  });
});

describe("forget and export", () => {
  it("exports instructions plus scoped files and forgets only explicit paths", async () => {
    const store = await makeStore();
    const { bot, conversation } = await makeBotConversation(store);
    const scope = { userId: "demo-user", conversationId: conversation.id, botId: bot.id };
    await setUserInstructions(store, "demo-user", "Be concise.", null);
    await createFile(store, scope, "notes/a.md", "a");
    await createFile(store, scope, "notes/b.md", "b");

    const snapshot = await exportMemoryForUser(store, "demo-user", conversation.id, bot.id);
    expect(snapshot.files.map((file) => file.path)).toEqual([
      "instructions.md",
      "notes/a.md",
      "notes/b.md",
    ]);

    expect(await forgetMemoryForUser(store, "demo-user", conversation.id, bot.id, ["notes/a.md"])).toBe(1);
    expect((await store.memory.list(scope)).map((file) => file.path)).toEqual(["notes/b.md"]);
    expect((await store.memory.list(globalMemoryScope("demo-user"))).map((file) => file.path)).toEqual([
      "instructions.md",
    ]);

    await expect(
      forgetMemoryForUser(store, "demo-user", conversation.id, bot.id, ["instructions.md"]),
    ).rejects.toMatchObject({ status: 400 });
  });
});
