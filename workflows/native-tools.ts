import { Effect } from "effect";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { computerRun, memorySave, memorySearch, sendEmail, webSearch } from "../apps/web/lib/server/capabilities";
import { normalizeError, runService } from "../apps/web/lib/server/effect";

export function nativeTools(botId: string, conversationId: string): ToolSet {
  return {
    web_search: tool({
      description: "Search the live web with Parallel for current information and cited sources.",
      inputSchema: z.object({
        objective: z.string().min(3).max(2_000),
        queries: z.array(z.string().min(1).max(300)).max(6).default([]),
      }),
      execute: async (input) => executeNativeStep("web_search", botId, conversationId, input),
    }),
    memory_search: tool({
      description: "Search this bot's long-term Mem0 memories for preferences and learned context.",
      inputSchema: z.object({ query: z.string().min(2).max(1_000) }),
      execute: async (input) => executeNativeStep("memory_search", botId, conversationId, input),
    }),
    memory_save: tool({
      description: "Save a durable preference or learned fact to this bot's Mem0 namespace. Do not save secrets.",
      inputSchema: z.object({ fact: z.string().min(3).max(2_000) }),
      execute: async (input) => executeNativeStep("memory_save", botId, conversationId, input),
    }),
    send_email: tool({
      description: "Send one plain-text email through AgentMail after the user explicitly approves it.",
      inputSchema: z.object({
        to: z.string().email(),
        subject: z.string().min(1).max(200),
        text: z.string().min(1).max(10_000),
      }),
      needsApproval: true,
      execute: async (input) => executeNativeStep("send_email", botId, conversationId, input),
    }),
    computer_run: tool({
      description: "Run a bounded command in an isolated deny-network Vercel Sandbox. The sandbox stops immediately afterward.",
      inputSchema: z.object({
        command: z.string().min(1).max(100),
        args: z.array(z.string().max(1_000)).max(20).default([]),
      }),
      execute: async (input) => executeNativeStep("computer_run", botId, conversationId, input),
    }),
  };
}

type NativeInput = {
  name: "web_search" | "memory_search" | "memory_save" | "send_email" | "computer_run";
  botId: string;
  conversationId: string;
  input: any;
};

async function executeNativeStep(name: NativeInput["name"], botId: string, conversationId: string, input: any): Promise<unknown> {
  "use step";
  return runService(Effect.tryPromise({
    try: async () => {
      switch (name) {
        case "web_search": return webSearch(input);
        case "memory_search": return memorySearch(botId, input.query);
        case "memory_save": return memorySave(botId, conversationId, input.fact);
        case "send_email": return sendEmail(input);
        case "computer_run": return computerRun(input);
      }
    },
    catch: normalizeError,
  }));
}
