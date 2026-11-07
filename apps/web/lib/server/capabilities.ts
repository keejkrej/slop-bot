import { AgentMailClient } from "agentmail";
import MemoryClient from "mem0ai";
import Parallel from "parallel-web";
import { Sandbox } from "@vercel/sandbox";
import { getStepMetadata } from "workflow";

export const APP_MEMORY_ID = "slop-bot";

export async function webSearch(input: { objective: string; queries: string[] }): Promise<unknown> {
  if (!process.env.PARALLEL_API_KEY) throw new Error("PARALLEL_API_KEY is not configured.");
  const client = new Parallel({ apiKey: process.env.PARALLEL_API_KEY });
  const response = await client.search({
    objective: input.objective,
    search_queries: input.queries,
    mode: "fast",
  });
  return response.results.slice(0, 8).map((result) => ({
    title: result.title,
    url: result.url,
    excerpts: result.excerpts.map((excerpt) => excerpt.slice(0, 1_500)),
    publishDate: result.publish_date,
  }));
}

export async function memorySearch(botId: string, query: string): Promise<unknown> {
  const client = memoryClient();
  const response = await client.search(query, {
    filters: { AND: [{ agent_id: botId }, { app_id: APP_MEMORY_ID }] },
    topK: 6,
  });
  return response.results.map((memory) => ({ id: memory.id, memory: memory.memory, score: memory.score }));
}

export async function memorySave(botId: string, runId: string, fact: string): Promise<unknown> {
  const result = await memoryClient().add([{ role: "assistant", content: fact }], {
    agentId: botId,
    appId: APP_MEMORY_ID,
    runId,
  });
  return { saved: true, count: result.length };
}

export async function sendEmail(input: { to: string; subject: string; text: string }): Promise<unknown> {
  if (!process.env.AGENTMAIL_API_KEY) throw new Error("AGENTMAIL_API_KEY is not configured.");
  const client = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY });
  const inboxId = await agentMailInboxId(client);
  const { stepId } = getStepMetadata();
  const result = await client.inboxes.messages.send(inboxId, {
    to: [input.to],
    subject: input.subject,
    text: input.text,
    labels: ["slop-bot"],
  }, { idempotencyKey: `slop-bot:${stepId}` });
  return { sent: true, messageId: result.messageId, threadId: result.threadId };
}

export async function computerRun(input: { command: string; args: string[] }): Promise<unknown> {
  const sandbox = await Sandbox.create({
    persistent: false,
    timeout: 90_000,
    networkPolicy: "deny-all",
    resources: { vcpus: 1 },
    tags: { app: "slop-bot", purpose: "bounded-computer-tool" },
  });
  try {
    const result = await sandbox.runCommand({
      cmd: input.command,
      args: input.args,
      timeoutMs: 60_000,
    });
    return {
      exitCode: result.exitCode,
      stdout: (await result.stdout()).slice(0, 16_000),
      stderr: (await result.stderr()).slice(0, 4_000),
      durationMs: result.durationMs,
      sandboxId: sandbox.name,
    };
  } finally {
    await sandbox.stop();
  }
}

function memoryClient(): MemoryClient {
  if (!process.env.MEM0_API_KEY) throw new Error("MEM0_API_KEY is not configured.");
  return new MemoryClient({
    apiKey: process.env.MEM0_API_KEY,
    ...(process.env.MEM0_BASE_URL ? { host: process.env.MEM0_BASE_URL } : {}),
  });
}

async function agentMailInboxId(client: AgentMailClient): Promise<string> {
  if (process.env.AGENTMAIL_INBOX_ID) return process.env.AGENTMAIL_INBOX_ID;
  const response = await client.inboxes.list({ limit: 1 });
  const inbox = response.inboxes[0];
  if (!inbox) throw new Error("No AgentMail inbox exists. Set AGENTMAIL_INBOX_ID or create one first.");
  return inbox.inboxId;
}
