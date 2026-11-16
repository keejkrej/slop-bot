"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpIcon, MicrophoneIcon, PlusIcon, WaveformIcon } from "@phosphor-icons/react";
import type { Bot, ChatMessage, ConversationDetail, ToolRisk } from "@slopbot/contracts";
import { api, getConversation, markConversationRead } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

export function ChatView({ chatId, bots, selectedBotId, onRefresh, onBot }: {
  chatId: string;
  bots: Bot[];
  selectedBotId: string;
  onRefresh: () => Promise<void>;
  onBot: (id: string) => void;
}) {
  const [detail, setDetail] = useState<ConversationDetail>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const endRef = useRef<HTMLDivElement>(null);
  const wasActive = useRef(false);
  const lastMarkedMessageId = useRef<string | null>(null);

  const load = useCallback(async () => {
    try { setDetail(await getConversation(chatId)); setError(undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load chat."); }
  }, [chatId]);

  useEffect(() => { void load(); }, [load]);

  // Mark read only when a newer latest message is observed, never on every poll.
  useEffect(() => {
    const latest = detail?.messages[detail.messages.length - 1];
    if (!latest || lastMarkedMessageId.current === latest.id) return;
    lastMarkedMessageId.current = latest.id;
    void markConversationRead(chatId, latest.id)
      .then(() => onRefresh())
      .catch(() => undefined);
  }, [detail?.messages, chatId, onRefresh]);
  const runStatus = detail?.conversation.runStatus;
  const active = runStatus === "queued" || runStatus === "running" || runStatus === "awaiting_approval";
  const polling = runStatus === "queued" || runStatus === "running";
  useEffect(() => {
    if (wasActive.current && !active) void onRefresh();
    wasActive.current = Boolean(active);
  }, [active, onRefresh]);
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => void load(), 900);
    return () => window.clearInterval(timer);
  }, [polling, load]);
  const messageCount = detail?.messages.length;
  useEffect(() => { if (active || (messageCount ?? 0) > 0) endRef.current?.scrollIntoView({ block: "end" }); }, [messageCount, active]);

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || busy || active) return;
    setBusy(true); setError(undefined); setDraft("");
    try {
      await api(`/api/conversations/${chatId}/messages`, { method: "POST", body: JSON.stringify({ content }) });
      await load(); void onRefresh();
    } catch (cause) { setDraft(content); setError(cause instanceof Error ? cause.message : "Message failed."); }
    finally { setBusy(false); }
  }

  async function approve(actionId: string, approved: boolean) {
    setBusy(true); setError(undefined);
    try {
      await api(`/api/conversations/${chatId}/approvals/${actionId}`, { method: "POST", body: JSON.stringify({ approved }) });
      await load(); void onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update approval."); }
    finally { setBusy(false); }
  }

  if (!detail) return <main className="grid h-[calc(100dvh-4rem)] place-items-center p-6 md:h-dvh">{error ? <div className="max-w-md text-center"><p className="text-destructive text-sm leading-relaxed">{error}</p><Button className="mt-4" onClick={() => void load()} variant="outline">Try again</Button></div> : <Spinner />}</main>;
  const participants = detail.conversation.botIds.map((id) => bots.find((bot) => bot.id === id)).filter((bot): bot is Bot => Boolean(bot));
  return (
    <main className="flex h-[calc(100dvh-4rem)] min-h-0 flex-col md:h-dvh">
      <header className="flex h-20 shrink-0 items-center justify-center px-4">
        <div className="flex min-w-0 items-center gap-2 border border-foreground/20 bg-foreground/10 px-3 py-2">
          <BotAvatars bots={participants} />
          <h1 className="hidden max-w-52 truncate text-[13px] font-medium md:block">{participants[0]?.name ?? detail.conversation.title}</h1>
          <select aria-label="Switch bot" className="min-w-0 max-w-52 bg-transparent text-xs outline-none md:hidden" onChange={(event) => onBot(event.target.value)} value={selectedBotId}>
            {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </select>
        </div>
      </header>

      <div aria-busy={active} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-4 sm:px-6 sm:py-6">
          <div aria-live="polite" aria-relevant="additions text" className="space-y-4">
            {detail.messages.map((message) => <MessageBubble key={message.id} message={message} />)}
          </div>

          {detail.pendingActions.map((action) => {
            const expired = action.expiresAt ? Date.parse(action.expiresAt) <= Date.now() : false;
            const waiting = busy || action.status !== "pending" || expired;
            const args = previewArgs(action.toolArgsRedacted);
            return (
              <section className="my-8 border border-border bg-muted/50 p-5" key={action.id}>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-[0.16em]">Approval required</p>
                  <RiskBadge risk={action.toolRisk} />
                </div>
                <p className="message-text mb-4 text-[13px] leading-6">{action.summary}</p>
                <dl className="mb-4 grid gap-1 text-[11px] leading-5">
                  <div className="flex gap-2"><dt className="w-20 shrink-0 text-muted-foreground">Tool</dt><dd className="min-w-0 truncate font-medium">{action.toolName ?? "Tool request"}</dd></div>
                  {action.integrationName ? <div className="flex gap-2"><dt className="w-20 shrink-0 text-muted-foreground">Connection</dt><dd className="min-w-0 truncate">{action.integrationName}</dd></div> : null}
                  {action.expiresAt ? <div className="flex gap-2"><dt className="w-20 shrink-0 text-muted-foreground">Expires</dt><dd className="min-w-0 truncate">{formatExpiry(action.expiresAt)}</dd></div> : null}
                </dl>
                {args ? <pre className="mb-4 max-h-40 overflow-auto border border-border/70 bg-background/60 p-2 text-[10px] leading-4 whitespace-pre-wrap break-all">{args}</pre> : null}
                {expired ? <p className="mb-4 text-destructive text-xs leading-5" role="alert">This approval expired and can no longer be resumed.</p> : null}
                <div className="flex gap-2">
                  <Button disabled={waiting} onClick={() => void approve(action.id, true)}>Approve</Button>
                  <Button disabled={waiting} onClick={() => void approve(action.id, false)} variant="ghost">Deny</Button>
                </div>
              </section>
            );
          })}

          {runStatus === "queued" ? <RunStatusLine label="Queued…" /> : null}
          {runStatus === "running" ? <RunStatusLine label="Bots are responding in sequence…" /> : null}
          {runStatus === "awaiting_approval" ? <RunStatusLine label="Waiting for your approval…" /> : null}
          {error ? <p className="mt-6 border-l-2 border-destructive pl-3 text-destructive text-xs" role="alert">{error}</p> : null}
          <div ref={endRef} />
        </div>
      </div>

      <div className="shrink-0 bg-background px-4 pb-4 pt-2 sm:px-6 sm:pb-6">
        <form className="mx-auto flex max-w-3xl items-center gap-1 border border-foreground/20 bg-foreground/10 p-1.5" onSubmit={send}>
          <Button aria-label="Add attachment" className="size-9" disabled size="icon-lg" title="Attachments aren't available yet" type="button" variant="ghost"><PlusIcon /></Button>
          <Textarea
            aria-label="Message the bot"
            className="h-9 max-h-40 min-h-9 min-w-0 flex-1 resize-none border-0 bg-transparent px-2 py-2 text-[13px] leading-5 focus-visible:ring-0 disabled:bg-transparent md:text-[13px]"
            disabled={busy || active}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
            placeholder={runStatus === "awaiting_approval" ? "Approve or deny the request above…" : active ? "Wait for the reply to finish…" : "Message the bot…"}
            rows={1}
            value={draft}
          />
          <Button aria-label="Voice input" className="size-9" disabled size="icon-lg" title="Voice input isn't available yet" type="button" variant="ghost"><MicrophoneIcon /></Button>
          {draft.trim().length > 0 ? (
            <Button aria-label="Send message" className="size-9" disabled={busy || active} size="icon-lg" type="submit" variant="ghost">{busy ? <Spinner /> : <ArrowUpIcon />}</Button>
          ) : (
            <Button aria-label="Voice chat" className="size-9" disabled size="icon-lg" title="Voice chat isn't available yet" type="button" variant="ghost"><WaveformIcon /></Button>
          )}
        </form>
        <p className="sr-only">Enter to send. Shift and Enter creates a new line.</p>
      </div>
    </main>
  );
}

function previewArgs(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  const text = JSON.stringify(args);
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

function formatExpiry(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function RiskBadge({ risk }: { risk: ToolRisk }) {
  const tone = risk === "destructive" ? "border-destructive text-destructive" : risk === "write" ? "border-foreground/40 text-foreground" : "border-border text-muted-foreground";
  return <span className={`shrink-0 border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] ${tone}`}>{risk}</span>;
}

function RunStatusLine({ label }: { label: string }) {  return (
    <div className="mt-8 inline-flex items-center gap-3 border border-border/70 bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground" role="status">
      <span className="flex gap-1"><i className="size-1 animate-pulse bg-current" /><i className="size-1 animate-pulse bg-current [animation-delay:150ms]" /><i className="size-1 animate-pulse bg-current [animation-delay:300ms]" /></span>
      {label}
    </div>
  );
}

function BotAvatars({ bots, large = false }: { bots: Bot[]; large?: boolean }) {
  return (
    <div aria-label={`Participants: ${bots.map((bot) => bot.name).join(", ")}`} className={`flex items-center ${large ? "justify-center" : "justify-start"}`} role="img">
      {bots.map((bot) => (
        <span
          aria-hidden="true"
          className={`${large ? "-ml-2 size-11 border-2 text-sm first:ml-0" : "-ml-1 size-5 border text-[8px] first:ml-0"} grid place-items-center border-background font-medium text-white`}
          key={bot.id}
          style={{ backgroundColor: bot.color }}
        >
          {bot.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.senderType === "user") return (
    <article className="flex justify-end">
      <div className="max-w-[90%] border border-border/70 bg-muted px-3.5 py-2.5 text-foreground sm:max-w-[80%]">
        <p className="message-text text-[13px] leading-6">{message.content}</p>
      </div>
    </article>
  );
  if (message.senderType === "system") return <p className="border-l-2 border-destructive bg-destructive/5 px-4 py-3 text-muted-foreground text-xs leading-6">{message.content}</p>;
  return (
    <article className="flex max-w-[96%] sm:max-w-[88%]">
      <div className="w-fit max-w-full border border-foreground/10 bg-foreground/5 px-3.5 py-2.5">
        <p className={`message-text text-[13px] leading-6 ${message.status === "failed" ? "text-destructive" : "text-foreground"}`}>{message.content}</p>
      </div>
    </article>
  );
}
