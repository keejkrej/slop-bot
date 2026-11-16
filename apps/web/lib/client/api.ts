import type {
  AutomationTask,
  Bootstrap,
  ConversationDetail,
  MemoryDirectoryResponse,
  MemoryExportResponse,
  MemoryFileResponse,
  MemoryInstructions,
  RunStatus,
  RunTrigger,
} from "@slopbot/contracts";

let accessToken: string | null = null;

export function setWebAccessToken(token: string | null): void {
  accessToken = token;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  const response = await fetch(path, { ...init, headers });
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(payload?.error ?? `Request failed (${response.status}).`);
  return payload as T;
}

export const getBootstrap = () => api<Bootstrap>("/api/bootstrap");
export const getConversation = (id: string) => api<ConversationDetail>(`/api/conversations/${id}`);
export const markConversationRead = (id: string, messageId?: string | null) =>
  api<{ conversationId: string; lastReadAt: string; lastReadMessageId: string | null }>(
    `/api/conversations/${id}/read`,
    { method: "POST", body: JSON.stringify({ messageId: messageId ?? null }) },
  );

/** A run projection safe to render in the activity list. */
export type ActivityRun = {
  id: string;
  conversationId: string;
  botId: string;
  status: RunStatus;
  trigger: RunTrigger;
  outputMessageId: string | null;
  workflowRunId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export const getAutomations = () => api<{ automations: AutomationTask[] }>("/api/automations");
export const getActivity = (limit = 50) => api<{ runs: ActivityRun[] }>(`/api/activity?limit=${limit}`);

/** One sanitized trace event for the run detail view. */
export type ActivityTrace = {
  seq: number;
  type: string;
  at: string;
  category: "run" | "model" | "tool" | "approval";
  phase: "start" | "end";
  status?: "ok" | "error" | "blocked" | "pending" | "skipped";
  outcome?: "reply" | "silent" | "suppressed" | "approval" | "failed";
  toolName?: string;
  integrationId?: string;
  toolCallId?: string;
  model?: string;
  durationMs?: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  error?: { kind: string; message: string };
  approvalId?: string;
  stepNumber?: number;
  attempt?: number;
};

export type ActivityRunDetail = {
  run: ActivityRun;
  traces: ActivityTrace[];
};

export const getActivityRun = (runId: string) =>
  api<ActivityRunDetail>(`/api/activity/${encodeURIComponent(runId)}`);

function memoryQuery(conversationId?: string, botId?: string): string {
  const params = new URLSearchParams();
  if (conversationId) params.set("conversationId", conversationId);
  if (botId) params.set("botId", botId);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const getMemory = (conversationId?: string, botId?: string) =>
  api<MemoryDirectoryResponse>(`/api/memory${memoryQuery(conversationId, botId)}`);

export const getMemoryFile = (conversationId: string, botId: string, path: string) =>
  api<MemoryFileResponse>(
    `/api/memory/file${memoryQuery(conversationId, botId)}&path=${encodeURIComponent(path)}`,
  );

export const saveMemoryInstructions = (content: string, expectedVersion: number | null) =>
  api<{ instructions: MemoryInstructions }>("/api/memory/instructions", {
    method: "PATCH",
    body: JSON.stringify({ content, expectedVersion }),
  });

export const exportMemory = (conversationId: string, botId: string) =>
  api<MemoryExportResponse>(`/api/memory/export${memoryQuery(conversationId, botId)}`);

export const forgetMemory = (conversationId: string, botId: string, paths: string[]) =>
  api<{ deleted: number }>("/api/memory/forget", {
    method: "POST",
    body: JSON.stringify({ conversationId, botId, paths }),
  });
