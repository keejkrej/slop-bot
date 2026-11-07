import type { Bootstrap, ConversationDetail } from "@slopbot/contracts";

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
