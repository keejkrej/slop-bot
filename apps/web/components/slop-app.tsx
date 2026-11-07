"use client";

import { useCallback, useEffect, useState } from "react";
import { ChatsCircleIcon, PlugsConnectedIcon, PlusIcon, RobotIcon, SignOutIcon } from "@phosphor-icons/react";
import { lyra } from "@slopbot/design-tokens";
import type { Bootstrap } from "@slopbot/contracts";
import { getBootstrap } from "@/lib/client/api";
import { AuthScreen, LogoMark } from "./auth-screen";
import { BotsView } from "./bots-view";
import { ChatView } from "./chat-view";
import { ConnectionsView } from "./connections-view";
import { BotDialog, ConnectionDialog, ConversationDialog } from "./product-dialogs";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export type View = "chat" | "bots" | "connections";
type DialogName = "bot" | "conversation" | "connection" | null;

export function SlopApp() {
  const [data, setData] = useState<Bootstrap>();
  const [view, setView] = useState<View>(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("view") === "connections" ? "connections" : "chat");
  const [selectedId, setSelectedId] = useState<string>();
  const [dialog, setDialog] = useState<DialogName>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    try {
      const next = await getBootstrap();
      setData(next);
      setSelectedId((current) => current && next.conversations.some((item) => item.id === current) ? current : next.conversations[0]?.id);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load your workspace.");
    } finally {
      setAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    void fetch("/api/auth/session").then(async (response) => {
      if (response.ok) await reload();
      else { setSignedOut(true); setAuthChecked(true); }
    }).catch(() => setAuthChecked(true));
  }, [reload]);

  function navigate(next: View) {
    setView(next);
    if (next === "connections") window.history.replaceState(null, "", "/?view=connections");
    else window.history.replaceState(null, "", "/");
  }

  async function signOut() {
    await fetch("/api/auth/signout", { method: "POST" });
    setData(undefined);
    setSignedOut(true);
  }

  if (!authChecked || signedOut) return signedOut ? <AuthScreen /> : <LoadingScreen />;
  if (!data) return <LoadingScreen error={error} retry={() => void reload()} />;

  return (
    <div className="min-h-dvh bg-background lg:flex" data-ui-preset={lyra.preset}>
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-background lg:fixed lg:inset-y-0 lg:left-0 lg:flex">
        <SidebarContent
          data={data}
          selectedId={selectedId}
          view={view}
          onConversation={(id) => { setSelectedId(id); navigate("chat"); }}
          onNavigate={navigate}
          onDialog={setDialog}
          onSignOut={data.user.id !== "demo-user" ? () => void signOut() : undefined}
        />
      </aside>

      <div className="min-w-0 flex-1 lg:ml-64">
        <header className="flex h-14 items-center justify-between border-b px-4 lg:hidden">
          <button className="flex items-center gap-2 text-sm font-medium tracking-[-0.05em]" onClick={() => navigate("chat")} type="button"><LogoMark /> SLOP BOT</button>
          <Button aria-label="Create a group" onClick={() => setDialog("conversation")} size="icon-sm" variant="outline"><PlusIcon /></Button>
        </header>
        <nav aria-label="Mobile navigation" className="grid grid-cols-3 border-b lg:hidden">
          <MobileNavButton active={view === "chat"} label="Chat" onClick={() => navigate("chat")} />
          <MobileNavButton active={view === "bots"} label="Bots" onClick={() => navigate("bots")} />
          <MobileNavButton active={view === "connections"} label="Tools" onClick={() => navigate("connections")} />
        </nav>
        {error ? <div className="border-b px-4 py-2 text-destructive text-xs" role="alert">{error}</div> : null}
        {view === "chat" ? (
          selectedId ? <ChatView bots={data.bots} conversationId={selectedId} key={selectedId} onRefresh={reload} onCreateGroup={() => setDialog("conversation")} /> : <EmptyChat onCreate={() => setDialog("conversation")} />
        ) : view === "bots" ? (
          <BotsView bots={data.bots} integrations={data.integrations} onCreate={() => setDialog("bot")} />
        ) : (
          <ConnectionsView integrations={data.integrations} onAdd={() => setDialog("connection")} onRefresh={reload} />
        )}
      </div>

      <BotDialog integrations={data.integrations} onOpenChange={(open) => setDialog(open ? "bot" : null)} open={dialog === "bot"} onCreated={async () => { setDialog(null); await reload(); navigate("bots"); }} />
      <ConversationDialog bots={data.bots} onOpenChange={(open) => setDialog(open ? "conversation" : null)} open={dialog === "conversation"} onCreated={async (id) => { setDialog(null); setSelectedId(id); await reload(); navigate("chat"); }} />
      <ConnectionDialog onOpenChange={(open) => setDialog(open ? "connection" : null)} open={dialog === "connection"} onCreated={async () => { setDialog(null); await reload(); navigate("connections"); }} />
    </div>
  );
}

function SidebarContent({ data, view, selectedId, onNavigate, onConversation, onDialog, onSignOut }: {
  data: Bootstrap; view: View; selectedId?: string; onNavigate: (view: View) => void;
  onConversation: (id: string) => void; onDialog: (dialog: DialogName) => void; onSignOut?: () => void;
}) {
  return <>
    <div className="flex h-16 items-center gap-3 border-b px-5"><LogoMark /><span className="font-medium text-sm tracking-[-0.06em]">SLOP BOT</span><span className="ml-auto text-[9px] text-muted-foreground">BETA</span></div>
    <div className="p-3"><Button className="w-full justify-start" onClick={() => onDialog("conversation")} variant="outline"><PlusIcon /> New group chat</Button></div>
    <nav className="space-y-1 px-3" aria-label="Main navigation">
      <NavButton active={view === "chat"} icon={<ChatsCircleIcon />} label="Conversations" onClick={() => onNavigate("chat")} />
      <NavButton active={view === "bots"} icon={<RobotIcon />} label="Your bots" count={data.bots.length} onClick={() => onNavigate("bots")} />
      <NavButton active={view === "connections"} icon={<PlugsConnectedIcon />} label="Connections" count={data.integrations.length} onClick={() => onNavigate("connections")} />
    </nav>
    <div className="mt-7 flex items-center justify-between px-5 pb-2 text-[10px] text-muted-foreground uppercase tracking-widest"><span>Recent rooms</span><span>{data.conversations.length}</span></div>
    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 pb-4">
      {data.conversations.map((conversation) => <button className={`mb-1 w-full border-l-2 px-3 py-2 text-left text-xs transition-colors ${view === "chat" && selectedId === conversation.id ? "border-foreground bg-muted text-foreground" : "border-transparent text-muted-foreground hover:bg-muted/60"}`} key={conversation.id} onClick={() => onConversation(conversation.id)} type="button"><span className="block truncate">{conversation.title}</span><span className="mt-1 block text-[10px] opacity-60">{conversation.botIds.length} {conversation.botIds.length === 1 ? "bot" : "bots"} · {conversation.runStatus === "running" ? "thinking…" : "ready"}</span></button>)}
      {data.conversations.length === 0 ? <p className="px-2 py-4 text-muted-foreground text-xs">No rooms yet. Make one with your favorite bots.</p> : null}
    </div>
    <div className="border-t p-4"><div className="flex items-center gap-3"><div className="grid size-7 place-items-center bg-foreground text-background text-[10px]">{data.user.name.slice(0, 2).toUpperCase()}</div><div className="min-w-0 flex-1"><p className="truncate text-xs">{data.user.name}</p><p className="mt-0.5 text-[9px] text-muted-foreground uppercase">{data.agentMode === "gateway" ? "AI Gateway" : "Demo mode"}</p></div>{onSignOut ? <Button aria-label="Sign out" onClick={onSignOut} size="icon-sm" variant="ghost"><SignOutIcon /></Button> : null}</div></div>
  </>;
}

function NavButton({ active, icon, label, count, onClick }: { active: boolean; icon: React.ReactNode; label: string; count?: number; onClick: () => void }) {
  return <button className={`flex h-9 w-full items-center gap-3 px-3 text-left text-xs ${active ? "border border-border bg-muted text-foreground" : "border border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"}`} onClick={onClick} type="button">{icon}<span>{label}</span>{count !== undefined ? <span className="ml-auto opacity-60">{count}</span> : null}</button>;
}

function MobileNavButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button className={`h-11 text-xs ${active ? "bg-muted text-foreground" : "text-muted-foreground"}`} onClick={onClick} type="button">{label}</button>;
}

function LoadingScreen({ error, retry }: { error?: string; retry?: () => void }) {
  return <main className="grid min-h-dvh place-items-center p-6"><div className="text-center"><LogoMark /><p className="mt-4 text-muted-foreground text-xs">{error ?? "Assembling your bots…"}</p>{error && retry ? <Button className="mt-4" onClick={retry} variant="outline">Try again</Button> : !error ? <Spinner className="mt-5" /> : null}</div></main>;
}

function EmptyChat({ onCreate }: { onCreate: () => void }) {
  return <main className="grid min-h-[calc(100dvh-7rem)] place-items-center p-6"><div className="max-w-sm text-center"><ChatsCircleIcon className="mx-auto mb-5 size-8" /><h1 className="text-2xl tracking-[-0.06em]">Start a bot room.</h1><p className="mt-3 mb-6 text-muted-foreground text-xs leading-relaxed">Pick one bot for a focused chat or up to four for a bounded group discussion.</p><Button onClick={onCreate} variant="outline"><PlusIcon /> Create group</Button></div></main>;
}
