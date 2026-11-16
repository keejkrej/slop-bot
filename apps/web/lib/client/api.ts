import type {
  AutomationTask,
  Bootstrap,
  ConversationDetail,
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
