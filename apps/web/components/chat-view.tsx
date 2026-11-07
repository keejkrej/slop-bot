"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpIcon, PlusIcon, UsersThreeIcon } from "@phosphor-icons/react";
import type { Bot, ChatMessage, ConversationDetail } from "@slopbot/contracts";
import { api, getConversation } from "@/lib/client/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

export function ChatView({ conversationId, bots, onRefresh, onCreateGroup }: { conversationId: string; bots: Bot[]; onRefresh: () => Promise<void>; onCreateGroup: () => void }) {
  const [detail, setDetail] = useState<ConversationDetail>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const endRef = useRef<HTMLDivElement>(null);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    try { setDetail(await getConversation(conversationId)); setError(undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load conversation."); }
  }, [conversationId]);

  useEffect(() => { void load(); }, [load]);
  const running = detail?.conversation.runStatus === "running";
  useEffect(() => {
    if (wasRunning.current && !running) void onRefresh();
    wasRunning.current = Boolean(running);
  }, [running, onRefresh]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(), 900);
    return () => window.clearInterval(timer);
  }, [running, load]);
  const messageCount = detail?.messages.length;
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messageCount, running]);

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || busy || running) return;
    setBusy(true); setError(undefined); setDraft("");
    try {
      await api(`/api/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ content }) });
      await load(); void onRefresh();
    } catch (cause) { setDraft(content); setError(cause instanceof Error ? cause.message : "Message failed."); }
    finally { setBusy(false); }
  }

  async function botRound() {
    setBusy(true); setError(undefined);
    try { await api(`/api/conversations/${conversationId}/round`, { method: "POST" }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start round."); }
    finally { setBusy(false); }
  }

  async function approve(actionId: string, approved: boolean) {
    setBusy(true); setError(undefined);
    try {
      await api(`/api/conversations/${conversationId}/approvals/${actionId}`, { method: "POST", body: JSON.stringify({ approved }) });
      await load(); void onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update approval."); }
    finally { setBusy(false); }
  }

  if (!detail) return <main className="grid h-[calc(100dvh-7rem)] place-items-center"><Spinner /></main>;
  const participants = detail.conversation.botIds.map((id) => bots.find((bot) => bot.id === id)).filter((bot): bot is Bot => Boolean(bot));

  return <main className="flex h-[calc(100dvh-7rem)] min-h-0 flex-col lg:h-dvh">
    <header className="flex h-16 items-center gap-3 border-b px-4 sm:px-6">
      <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h1 className="truncate text-sm font-medium">{detail.conversation.title}</h1><Badge variant={running ? "default" : "secondary"}>{running ? "THINKING" : "READY"}</Badge></div><div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground"><span>{participants.map((bot) => `@${bot.handle}`).join(" · ")}</span></div></div>
      <Button className="hidden sm:inline-flex" disabled={busy || running} onClick={() => void botRound()} size="sm" variant="outline"><UsersThreeIcon /> Bot round</Button>
      <Button aria-label="New group" onClick={onCreateGroup} size="icon-sm" variant="ghost"><PlusIcon /></Button>
    </header>

    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
        {detail.messages.length === 0 ? <div className="py-16 text-center"><div className="mb-5 flex justify-center">{participants.map((bot) => <div className="-ml-1.5 grid size-10 place-items-center border-2 border-background text-sm text-white first:ml-0" key={bot.id} style={{ backgroundColor: bot.color }}>{bot.name[0]}</div>)}</div><h2 className="text-xl tracking-[-0.05em]">The floor is yours.</h2><p className="mx-auto mt-3 max-w-sm text-muted-foreground text-xs leading-relaxed">Ask a question, or start a bot round and let each participant respond once in order.</p><Button className="mt-6" disabled={busy} onClick={() => void botRound()} variant="outline"><UsersThreeIcon /> Start bot round</Button></div> : null}
        <div className="space-y-7">{detail.messages.map((message) => <MessageBubble bots={bots} key={message.id} message={message} />)}</div>
        {detail.pendingActions.map((action) => <section className="my-7 border border-border bg-muted p-4" key={action.id}><p className="mb-2 text-[10px] text-muted-foreground uppercase tracking-widest">Approval required</p><p className="message-text mb-4 text-xs leading-6">{action.summary}</p><div className="flex gap-2"><Button disabled={busy} onClick={() => void approve(action.id, true)} size="sm" variant="default">Approve send</Button><Button disabled={busy} onClick={() => void approve(action.id, false)} size="sm" variant="ghost">Deny</Button></div></section>)}
        {running ? <div className="mt-7 flex items-center gap-3 text-muted-foreground text-xs"><span className="flex gap-1"><i className="size-1 animate-pulse bg-current" /><i className="size-1 animate-pulse bg-current [animation-delay:150ms]" /><i className="size-1 animate-pulse bg-current [animation-delay:300ms]" /></span>Bots are responding in sequence…</div> : null}
        {error ? <p className="mt-6 border-l-2 border-destructive pl-3 text-destructive text-xs" role="alert">{error}</p> : null}
        <div ref={endRef} />
      </div>
    </div>

    <div className="border-t bg-background p-3 sm:p-5"><form className="mx-auto flex max-w-3xl items-end gap-2" onSubmit={send}><Textarea aria-label="Message the group" className="max-h-36 min-h-11 flex-1 resize-none py-3" disabled={busy || running} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={running ? "Wait for this round to finish…" : "Message the group…"} rows={1} value={draft} /><Button aria-label="Send message" className="size-11" disabled={!draft.trim() || busy || running} size="icon" type="submit">{busy ? <Spinner /> : <ArrowUpIcon />}</Button></form><p className="mx-auto mt-2 max-w-3xl text-[9px] text-muted-foreground">ENTER TO SEND · SHIFT+ENTER FOR A NEW LINE · MAX 4 BOTS PER ROUND</p></div>
  </main>;
}

function MessageBubble({ message, bots }: { message: ChatMessage; bots: Bot[] }) {
  if (message.senderType === "user") return <article className="flex justify-end"><div className="max-w-[88%] border border-border bg-muted px-4 py-3 text-foreground sm:max-w-[80%]"><p className="message-text text-xs leading-relaxed">{message.content}</p><p className="mt-2 text-right text-[9px] text-muted-foreground">YOU</p></div></article>;
  if (message.senderType === "system") return <p className="border-l-2 border-destructive pl-3 text-muted-foreground text-xs">{message.content}</p>;
  const bot = bots.find((item) => item.id === message.senderId);
  return <article className="flex max-w-[94%] items-start gap-3 sm:max-w-[85%]"><div className="mt-0.5 grid size-8 shrink-0 place-items-center text-white text-xs" style={{ backgroundColor: bot?.color ?? "#737373" }}>{bot?.name.slice(0, 1) ?? "?"}</div><div className="min-w-0"><div className="mb-1.5 flex items-center gap-2"><span className="font-medium text-xs">{bot?.name ?? "Removed bot"}</span><span className="text-[9px] text-muted-foreground">@{bot?.handle ?? "unknown"}</span></div><p className={`message-text text-xs leading-6 ${message.status === "failed" ? "text-destructive" : "text-foreground"}`}>{message.content}</p></div></article>;
}
