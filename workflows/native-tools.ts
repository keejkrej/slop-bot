import { Effect } from "effect";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { PendingAction } from "@db/types";
import { computerRun, webSearch } from "../apps/web/lib/server/capabilities";
import { normalizeError, runService, withStore } from "../apps/web/lib/server/effect";
import {
  applyMemoryOperationForUser,
  listMemoryDirectoryForUser,
  readMemoryForUser,
} from "../apps/web/lib/server/memory";
import type { MemoryOperationRequest } from "../apps/web/lib/server/memory-files";
import { isPendingActionExpired } from "../apps/web/lib/server/tool-permissions";

export type NativeToolContext = {
  userId: string;
  botId: string;
  conversationId: string;
  runId: string;
  /** The persisted approval being resumed, if this turn is an approval resume. */
  approval?: PendingAction | null;
};

export function nativeTools(context: NativeToolContext): ToolSet {
  return {
    web_search: tool({
      description: "Search the live web with Parallel for current information and cited sources.",
      inputSchema: z.object({
        objective: z.string().min(3).max(2_000),
        queries: z.array(z.string().min(1).max(300)).max(6).default([]),
      }),
      execute: async (input) => executeNativeStep("web_search", input),
    }),
    memory_view: tool({
      description:
        "List the memory directory or read one memory file. Notes and progress are loaded on demand; instructions.md is user-confirmed and read-only.",
      inputSchema: z.object({
        path: z.string().max(128).optional(),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      }),
      execute: async (input) => executeMemoryStep(context, { kind: "view", ...input }),
    }),
    memory_create: tool({
      description:
        "Create a new memory file under notes/ or progress/, or create index.md. Never write instructions.md or reported.md.",
      inputSchema: z.object({
        path: z.string().min(1).max(128),
        content: z.string().max(200_000),
      }),
      execute: async (input) =>
        executeMemoryStep(context, { kind: "create", path: input.path, content: input.content }),
    }),
    memory_str_replace: tool({
      description:
        "Replace exactly one occurrence of old text in an existing memory file. Fails when the text is missing or ambiguous.",
      inputSchema: z.object({
        path: z.string().min(1).max(128),
        old: z.string().min(1).max(200_000),
        new: z.string().max(200_000),
      }),
      execute: async (input) =>
        executeMemoryStep(context, {
          kind: "str_replace",
          path: input.path,
          old: input.old,
          new: input.new,
        }),
    }),
    memory_insert: tool({
      description: "Insert text at a 1-based line in an existing memory file.",
      inputSchema: z.object({
        path: z.string().min(1).max(128),
        line: z.number().int().min(1),
        content: z.string().max(200_000),
      }),
      execute: async (input) =>
        executeMemoryStep(context, {
          kind: "insert",
          path: input.path,
          line: input.line,
          content: input.content,
        }),
    }),
    memory_delete: tool({
      description:
        "Delete one memory file. This requires explicit user approval and never deletes instructions.md.",
      inputSchema: z.object({ path: z.string().min(1).max(128) }),
      needsApproval: true,
      execute: async (input) => {
        assertMemoryDeleteApproved(context, input.path);
        return executeMemoryStep(context, { kind: "delete", path: input.path });
      },
    }),
    memory_rename: tool({
      description: "Rename or move one memory file. The destination must not already exist.",
      inputSchema: z.object({
        from: z.string().min(1).max(128),
        to: z.string().min(1).max(128),
      }),
      execute: async (input) =>
        executeMemoryStep(context, { kind: "rename", from: input.from, to: input.to }),
    }),
    computer_run: tool({
      description: "Run a bounded command in an isolated deny-network Vercel Sandbox. The sandbox stops immediately afterward.",
      inputSchema: z.object({
        command: z.string().min(1).max(100),
        args: z.array(z.string().max(1_000)).max(20).default([]),
      }),
      execute: async (input) => executeNativeStep("computer_run", input),
    }),
  };
}

/**
 * A memory delete only runs when the persisted approval is for this exact
 * run/conversation/bot, is still pending, has not expired, and names the same
 * file. A model-supplied path can never borrow an unrelated approval.
 */
export function assertMemoryDeleteApproved(
  context: Pick<NativeToolContext, "runId" | "conversationId" | "botId" | "approval">,
  path: string,
  now: Date = new Date(),
): void {
  const action = context.approval;
  if (!action) throw new Error("This memory delete requires approval.");
  if (action.toolName !== "memory_delete") {
    throw new Error("Approval is for a different tool.");
  }
  if (action.runId !== context.runId) {
    throw new Error("Approval belongs to a different run.");
  }
  if (action.conversationId !== context.conversationId) {
    throw new Error("Approval belongs to a different conversation.");
  }
  if (action.botId !== context.botId) {
    throw new Error("Approval belongs to a different bot.");
  }
  if (action.status !== "pending" && action.status !== "resuming") {
    throw new Error("Approval is no longer pending.");
  }
  if (isPendingActionExpired(action, now)) {
    throw new Error("Approval has expired.");
  }
  if (action.toolRisk !== "destructive") {
    throw new Error("The approval does not cover a destructive delete operation.");
  }
  const approvedPath = action.toolArgsRedacted?.path;
  if (typeof approvedPath !== "string" || approvedPath !== path) {
    throw new Error("Approval is for a different memory file.");
  }
}

type NativeStepName = "web_search" | "computer_run";

async function executeNativeStep(name: NativeStepName, input: any): Promise<unknown> {
  "use step";
  return runService(Effect.tryPromise({
    try: async () => {
      switch (name) {
        case "web_search": return webSearch(input);
        case "computer_run": return computerRun(input);
      }
    },
    catch: normalizeError,
  }));
}

type MemoryStepInput =
  | { kind: "view"; path?: string; startLine?: number; endLine?: number }
  | { kind: "create"; path: string; content: string }
  | { kind: "str_replace"; path: string; old: string; new: string }
  | { kind: "insert"; path: string; line: number; content: string }
  | { kind: "delete"; path: string }
  | { kind: "rename"; from: string; to: string };

async function executeMemoryStep(
  context: NativeToolContext,
  input: MemoryStepInput,
): Promise<unknown> {
  "use step";
  return runService(withStore(async (store) => {
    if (input.kind === "view") {
      if (!input.path) {
        const directory = await listMemoryDirectoryForUser(
          store,
          context.userId,
          context.conversationId,
          context.botId,
        );
        return {
          instructions: directory.instructions
            ? { version: directory.instructions.version, updatedAt: directory.instructions.updatedAt }
            : null,
          files: directory.files,
        };
      }
      const file = await readMemoryForUser(
        store,
        context.userId,
        context.conversationId,
        context.botId,
        input.path,
        { startLine: input.startLine, endLine: input.endLine },
      );
      return file ?? { error: `Memory file not found: ${input.path}` };
    }

    const request: MemoryOperationRequest =
      input.kind === "create"
        ? { op: "create", path: input.path, content: input.content }
        : input.kind === "str_replace"
          ? { op: "str_replace", path: input.path, old: input.old, new: input.new }
          : input.kind === "insert"
            ? { op: "insert", path: input.path, line: input.line, content: input.content }
            : input.kind === "delete"
              ? { op: "delete", path: input.path }
              : { op: "rename", from: input.from, to: input.to };

    const file = await applyMemoryOperationForUser(
      store,
      context.userId,
      context.conversationId,
      context.botId,
      request,
      {
        actor: "model",
        source: "assistant",
        sourceRunId: context.runId,
        provenance: "memory tool",
      },
    );
    return file
      ? { path: file.path, version: file.version, updatedAt: file.updatedAt }
      : { deleted: true };
  }));
}
