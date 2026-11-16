/**
 * Durable file-memory adapter.
 *
 * The store persists validated plans; this module owns identity and
 * authorization. Every scope is derived from an authenticated user plus a
 * conversation and bot that the store confirms belong to that user. A model
 * tool never supplies a raw user id, and a path that belongs to another scope
 * is simply not found rather than leaked.
 */

import type { AppStore, MemoryScope } from "@db/types";
import { ApiError } from "./http";
import {
  buildCoreContext,
  exportMemorySnapshot,
  listMemoryDirectory,
  MemoryConflictError,
  MemoryError,
  MemoryLimitError,
  MemoryPathError,
  MemoryPolicyError,
  MemorySecretError,
  parseMemoryPath,
  planMemoryOperation,
  planMemoryWrite,
  readMemoryFile,
  type MemoryCoreContext,
  type MemoryDirectoryEntry,
  type MemoryFile,
  type MemoryOperationRequest,
  type MemoryReadOptions,
  type MemoryReadResult,
  type MemorySnapshot,
  type MemoryWriteContext,
} from "./memory-files";

export const INSTRUCTIONS_PATH = "instructions.md";

/** Global user instructions are stored outside any conversation/bot scope. */
export function globalMemoryScope(userId: string): MemoryScope {
  return { userId, conversationId: "", botId: "" };
}

export function conversationMemoryScope(
  userId: string,
  conversationId: string,
  botId: string,
): MemoryScope {
  return { userId, conversationId, botId };
}

/**
 * Confirm that the conversation and bot belong to the authenticated user and
 * that the bot is actually part of the conversation. Returns the derived scope.
 */
export async function resolveMemoryScope(
  store: AppStore,
  userId: string,
  conversationId: string,
  botId: string,
): Promise<MemoryScope> {
  if (!conversationId || !botId) {
    throw new ApiError(400, "A conversation and bot are required.");
  }
  const conversation = await store.getConversation(userId, conversationId);
  if (!conversation) throw new ApiError(404, "Conversation not found.");
  if (!conversation.botIds.includes(botId)) {
    throw new ApiError(403, "That bot is not part of this conversation.");
  }
  const bot = await store.getBot(userId, botId);
  if (!bot) throw new ApiError(404, "Bot not found.");
  return conversationMemoryScope(userId, conversationId, botId);
}

async function scopedFiles(store: AppStore, scope: MemoryScope): Promise<MemoryFile[]> {
  return store.memory.list(scope);
}

/**
 * Load the always-on core for a turn: global user instructions plus the
 * conversation's `index.md` and `reported.md`. Notes and progress are never
 * preloaded.
 */
export async function loadCoreMemory(
  store: AppStore,
  userId: string,
  conversationId: string,
  botId: string,
): Promise<MemoryCoreContext> {
  const [globalFiles, conversationFiles] = await Promise.all([
    store.memory.list(globalMemoryScope(userId)),
    store.memory.list(conversationMemoryScope(userId, conversationId, botId)),
  ]);
  const instructions = globalFiles.filter((file) => file.path === INSTRUCTIONS_PATH);
  const scoped = conversationFiles.filter((file) => file.path !== INSTRUCTIONS_PATH);
  return buildCoreContext([...instructions, ...scoped]);
}

export type MemoryDirectoryView = {
  scope: { conversationId: string; botId: string } | null;
  instructions: { content: string; version: number; updatedAt: string } | null;
  files: MemoryDirectoryEntry[];
  scopes: Array<{ conversationId: string; botId: string }>;
};

/**
 * Directory listing for the user-facing browser. With no scope selected it
 * returns global instructions plus the user's permitted conversation scopes.
 */
export async function listMemoryDirectoryForUser(
  store: AppStore,
  userId: string,
  conversationId?: string,
  botId?: string,
): Promise<MemoryDirectoryView> {
  const globalFiles = await store.memory.list(globalMemoryScope(userId));
  const instructions = globalFiles.find((file) => file.path === INSTRUCTIONS_PATH) ?? null;

  if (!conversationId || !botId) {
    const conversations = await store.listConversations(userId);
    const scopes = conversations.flatMap((conversation) =>
      conversation.botIds.map((id) => ({ conversationId: conversation.id, botId: id })),
    );
    return {
      scope: null,
      instructions: instructions
        ? { content: instructions.content, version: instructions.version, updatedAt: instructions.updatedAt }
        : null,
      files: [],
      scopes,
    };
  }

  const scope = await resolveMemoryScope(store, userId, conversationId, botId);
  const files = await scopedFiles(store, scope);
  return {
    scope: { conversationId, botId },
    instructions: instructions
      ? { content: instructions.content, version: instructions.version, updatedAt: instructions.updatedAt }
      : null,
    files: listMemoryDirectory(files),
    scopes: [],
  };
}

/** Read one file. `instructions.md` resolves to the global scope. */
export async function readMemoryForUser(
  store: AppStore,
  userId: string,
  conversationId: string,
  botId: string,
  path: string,
  options: MemoryReadOptions = {},
): Promise<MemoryReadResult | null> {
  const parsed = parseMemoryPath(path);
  if (parsed === INSTRUCTIONS_PATH) {
    const files = await store.memory.list(globalMemoryScope(userId));
    return readMemoryFile(files, parsed, options);
  }
  const scope = await resolveMemoryScope(store, userId, conversationId, botId);
  const files = await scopedFiles(store, scope);
  return readMemoryFile(files, parsed, options);
}

/** Full file record for the user-facing browser. */
export async function getMemoryFileForUser(
  store: AppStore,
  userId: string,
  conversationId: string,
  botId: string,
  path: string,
): Promise<MemoryFile | null> {
  const parsed = parseMemoryPath(path);
  if (parsed === INSTRUCTIONS_PATH) {
    return store.memory.read(globalMemoryScope(userId), parsed);
  }
  const scope = await resolveMemoryScope(store, userId, conversationId, botId);
  return store.memory.read(scope, parsed);
}

/** Full export snapshot for the selected conversation scope plus instructions. */
export async function exportMemoryForUser(
  store: AppStore,
  userId: string,
  conversationId: string,
  botId: string,
): Promise<MemorySnapshot> {
  const scope = await resolveMemoryScope(store, userId, conversationId, botId);
  const [globalFiles, conversationFiles] = await Promise.all([
    store.memory.list(globalMemoryScope(userId)),
    scopedFiles(store, scope),
  ]);
  const instructions = globalFiles.filter((file) => file.path === INSTRUCTIONS_PATH);
  return exportMemorySnapshot([...instructions, ...conversationFiles]);
}

/**
 * Replace global user instructions with compare-and-swap on the revision the
 * editor loaded. A null revision means "create only".
 */
export async function setUserInstructions(
  store: AppStore,
  userId: string,
  content: string,
  expectedVersion: number | null,
): Promise<MemoryFile> {
  const scope = globalMemoryScope(userId);
  const files = await store.memory.list(scope);
  const existing = files.find((file) => file.path === INSTRUCTIONS_PATH) ?? null;
  if ((existing?.version ?? null) !== expectedVersion) {
    throw new ApiError(
      409,
      "Instructions changed since you loaded them. Reload and try again.",
    );
  }
  const plan = planMemoryWrite(files, INSTRUCTIONS_PATH, content, {
    actor: "user",
    source: "user",
    provenance: "user settings",
    now: new Date().toISOString(),
  });
  const file = await store.memory.apply(scope, plan);
  if (!file) throw new ApiError(500, "Could not save instructions.");
  return file;
}

/**
 * Apply one validated model memory operation inside the resolved scope. The
 * caller supplies the actor/source context; policy is enforced by
 * `planMemoryOperation`, not by the prompt.
 */
export async function applyMemoryOperationForUser(
  store: AppStore,
  userId: string,
  conversationId: string,
  botId: string,
  request: MemoryOperationRequest,
  context: Omit<MemoryWriteContext, "now"> & { now?: string },
): Promise<MemoryFile | null> {
  const scope = await resolveMemoryScope(store, userId, conversationId, botId);
  const files = await scopedFiles(store, scope);
  const plan = planMemoryOperation(files, request, {
    ...context,
    now: context.now ?? new Date().toISOString(),
  });
  return store.memory.apply(scope, plan);
}

/**
 * Write `reported.md` as system run-completion metadata. The model can never
 * call this path; only the workflow's scheduled completion does.
 */
export async function setReportedMemory(
  store: AppStore,
  userId: string,
  conversationId: string,
  botId: string,
  content: string,
  runId: string,
): Promise<MemoryFile> {
  const scope = await resolveMemoryScope(store, userId, conversationId, botId);
  const files = await scopedFiles(store, scope);
  const plan = planMemoryWrite(files, "reported.md", content, {
    actor: "system",
    source: "system",
    sourceRunId: runId,
    provenance: "scheduled run completion",
    now: new Date().toISOString(),
  });
  const file = await store.memory.apply(scope, plan);
  if (!file) throw new ApiError(500, "Could not save the run report.");
  return file;
}

/**
 * Explicit user forget. Only conversation-scoped paths are accepted; global
 * instructions are changed through the instructions editor, never inferred
 * from chat.
 */
export async function forgetMemoryForUser(
  store: AppStore,
  userId: string,
  conversationId: string,
  botId: string,
  paths: string[],
): Promise<number> {
  const scope = await resolveMemoryScope(store, userId, conversationId, botId);
  const validated = paths.map((path) => parseMemoryPath(path));
  if (validated.some((path) => path === INSTRUCTIONS_PATH)) {
    throw new ApiError(400, "Use the instructions editor to change global instructions.");
  }
  return store.memory.delete(scope, validated);
}

/** Map memory-domain failures to API status codes without leaking internals. */
export function memoryErrorStatus(error: unknown): number | null {
  if (error instanceof MemoryConflictError) return 409;
  if (error instanceof MemoryPolicyError) return 403;
  if (error instanceof MemoryPathError) return 400;
  if (error instanceof MemoryLimitError) return 400;
  if (error instanceof MemorySecretError) return 400;
  if (error instanceof MemoryError) return 400;
  return null;
}
