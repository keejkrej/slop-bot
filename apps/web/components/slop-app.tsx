"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ChatsCircleIcon, MagnifyingGlassIcon, PlusIcon, SidebarSimpleIcon, SquaresFourIcon } from "@phosphor-icons/react";
import { lyra } from "@slopbot/design-tokens";
import type { Bootstrap, Conversation } from "@slopbot/contracts";
import { api, getBootstrap } from "@/lib/client/api";
import { AuthScreen, LogoMark } from "./auth-screen";
import { ChatView } from "./chat-view";
import { BotDialog, ConnectionDialog } from "./product-dialogs";
import { WorkspaceSettings, type SettingsTab } from "./workspace-settings";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

type DialogName = "bot" | "connection" | null;

const DEFAULT_SIDEBAR_WIDTH = 280;
const COLLAPSED_SIDEBAR_WIDTH = 72;

export function SlopApp() {
  const [data, setData] = useState<Bootstrap>();
  const [selectedBotId, setSelectedBotId] = useState<string>();
  const [dialog, setDialog] = useState<DialogName>(null);
  const [settingsOpen, setSettingsOpen] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("view") === "connections");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("view") === "connections" ? "connectors" : "general");
  const [authChecked, setAuthChecked] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [error, setError] = useState<string>();
  const resizing = useRef(false);
  const collapsed = sidebarWidth <= 180;

  const reload = useCallback(async () => {
    try {
      const next = await getBootstrap();
      if (!next) throw new Error("Could not load your workspace.");
      setData(next);
      setSelectedBotId((current) => current && next.bots.some((bot) => bot.id === current) ? current : next.bots[0]?.id);
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

  useEffect(() => {
    const sendToHost = window.__electrobunSendToHost;
    if (!data || typeof sendToHost !== "function") return;
    void fetch("/api/auth/desktop-handoff", { method: "POST" })
      .then((response) => response.ok ? response.json() : null)
      .then((handoff) => { if (handoff) sendToHost({ type: "slop-bot:session", ...handoff }); })
      .catch(() => undefined);
  }, [data?.user.id]);

  useEffect(() => {
    if (!data || !selectedBotId) return;
    if (data.conversations.some((conversation) => conversation.botIds.includes(selectedBotId))) return;
    const bot = data.bots.find((item) => item.id === selectedBotId);
    if (!bot) return;
    let cancelled = false;
    void api<{ conversation: Conversation }>("/api/conversations", { method: "POST", body: JSON.stringify({ title: bot.name, botIds: [bot.id] }) })
      .then(() => { if (!cancelled) void reload(); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not open the chat."); });
    return () => { cancelled = true; };
  }, [data, selectedBotId, reload]);

  const selectedBot = data?.bots.find((bot) => bot.id === selectedBotId);
  const selectedConversation = data?.conversations.find((conversation) => conversation.botIds.includes(selectedBotId ?? ""));

  async function signOut() {
    await fetch("/api/auth/signout", { method: "POST" });
    setData(undefined);
    setSignedOut(true);
  }

  function openSettings(tab: SettingsTab) {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }

  function createBot() {
    setSettingsOpen(false);
    setDialog("bot");
  }

  function addConnection() {
    setSettingsOpen(false);
    setDialog("connection");
  }

  if (!authChecked || signedOut) return signedOut ? <AuthScreen /> : <LoadingScreen />;
  if (!data) return <LoadingScreen error={error} retry={() => void reload()} />;

  return (
    <div className="min-h-dvh bg-background md:flex" data-ui-preset={lyra.preset} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <aside className="relative hidden shrink-0 bg-muted/20 md:fixed md:inset-y-0 md:left-0 md:flex md:w-[var(--sidebar-width)]">
        <ChatSidebar
          collapsed={collapsed}
          data={data}
          onBot={setSelectedBotId}
          onCollapse={() => setSidebarWidth(COLLAPSED_SIDEBAR_WIDTH)}
          onExpand={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          onNewBot={() => setDialog("bot")}
          onSettings={() => openSettings("general")}
          selectedBotId={selectedBotId}
        />
        <div
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemax={440}
          aria-valuemin={72}
          aria-valuenow={sidebarWidth}
          className="absolute top-0 right-0 z-20 h-full w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-border focus-visible:bg-border focus-visible:outline-none"
          onDoubleClick={() => setSidebarWidth(collapsed ? DEFAULT_SIDEBAR_WIDTH : COLLAPSED_SIDEBAR_WIDTH)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSidebarWidth(collapsed ? DEFAULT_SIDEBAR_WIDTH : COLLAPSED_SIDEBAR_WIDTH); }
            if (event.key === "ArrowLeft") { event.preventDefault(); setSidebarWidth((width) => Math.max(COLLAPSED_SIDEBAR_WIDTH, width - 16)); }
            if (event.key === "ArrowRight") { event.preventDefault(); setSidebarWidth((width) => Math.min(440, width + 16)); }
            if (event.key === "Home") { event.preventDefault(); setSidebarWidth(COLLAPSED_SIDEBAR_WIDTH); }
            if (event.key === "End") { event.preventDefault(); setSidebarWidth(440); }
          }}
          onPointerDown={(event) => { resizing.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={(event) => { if (resizing.current) setSidebarWidth(Math.min(440, Math.max(COLLAPSED_SIDEBAR_WIDTH, event.clientX))); }}
          onPointerUp={(event) => { resizing.current = false; event.currentTarget.releasePointerCapture(event.pointerId); setSidebarWidth((width) => width < 180 ? COLLAPSED_SIDEBAR_WIDTH : width); }}
          role="separator"
          tabIndex={0}
          title="Drag to resize. Double-click to collapse or expand."
        />
      </aside>

      <div className="min-w-0 flex-1 md:ml-[var(--sidebar-width)]">
        <header className="flex h-16 items-center justify-between px-4 md:hidden">
          <button className="flex items-center gap-2.5 text-[13px] font-medium tracking-[-0.04em]" onClick={() => setSelectedBotId(data.bots[0]?.id)} type="button"><LogoMark /> SLOP BOT</button>
          <div className="flex items-center gap-1">
            <Button aria-label="Open settings" onClick={() => openSettings("general")} size="icon-lg" variant="soft"><SquaresFourIcon /></Button>
            <Button aria-label="Create bot" onClick={() => setDialog("bot")} size="icon-lg" variant="soft"><PlusIcon /></Button>
          </div>
        </header>
        {error ? <div className="px-4 py-2 text-destructive text-xs" role="alert">{error}</div> : null}
        {selectedBot && selectedConversation ? (
          <ChatView bots={data.bots} chatId={selectedConversation.id} key={selectedConversation.id} onBot={setSelectedBotId} onRefresh={reload} selectedBotId={selectedBot.id} />
        ) : data.bots.length === 0 ? (
          <EmptyChat onCreate={() => setDialog("bot")} />
        ) : (
          <main className="grid min-h-[calc(100dvh-4rem)] place-items-center md:min-h-dvh"><Spinner /></main>
        )}
      </div>

      <BotDialog integrations={data.integrations} onOpenChange={(open) => setDialog(open ? "bot" : null)} open={dialog === "bot"} onCreated={async (botId) => { setSelectedBotId(botId); setDialog(null); await reload(); }} />
      <ConnectionDialog onOpenChange={(open) => setDialog(open ? "connection" : null)} open={dialog === "connection"} onCreated={async () => { setDialog(null); await reload(); openSettings("connectors"); }} />
      <WorkspaceSettings
        data={data}
        onAddConnection={addConnection}
        onCreateBot={createBot}
        onOpenChange={setSettingsOpen}
        onRefresh={reload}
        onSignOut={data.user.id !== "demo-user" ? () => void signOut() : undefined}
        onTabChange={setSettingsTab}
        open={settingsOpen}
        tab={settingsTab}
      />
    </div>
  );
}

function ChatSidebar({ data, selectedBotId, collapsed, onCollapse, onExpand, onBot, onNewBot, onSettings }: {
  data: Bootstrap;
  selectedBotId?: string;
  collapsed: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  onBot: (id: string) => void;
  onNewBot: () => void;
  onSettings: () => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const bots = data.bots.filter((bot) => `${bot.name} ${bot.handle}`.toLowerCase().includes(needle));

  if (collapsed) return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-2 py-3">
        {bots.map((bot) => {
          const active = selectedBotId === bot.id;
          return (
            <button aria-current={active ? "page" : undefined} aria-label={bot.name} className={`grid size-11 shrink-0 place-items-center text-white text-xs font-medium transition-colors ${active ? "ring-1 ring-foreground ring-offset-2 ring-offset-background" : "hover:ring-1 hover:ring-border"}`} key={bot.id} onClick={() => onBot(bot.id)} style={{ backgroundColor: bot.color }} title={bot.name} type="button">
              {bot.name.slice(0, 1).toUpperCase()}
            </button>
          );
        })}
      </div>
      <div className="flex flex-col items-center gap-1 p-2">
        <Button aria-label="Expand sidebar" onClick={onExpand} size="icon-lg" title="Expand sidebar" variant="ghost"><SidebarSimpleIcon className="rotate-180" /></Button>
        <Button aria-label="Create bot" onClick={onNewBot} size="icon-lg" variant="ghost"><PlusIcon /></Button>
        <Button aria-label="Open settings" onClick={onSettings} size="icon-lg" variant="ghost"><SquaresFourIcon /></Button>
        <button aria-label="Open account settings" className="mt-1 grid size-9 place-items-center bg-muted text-[10px] font-medium hover:bg-secondary" onClick={onSettings} type="button">{data.user.name.slice(0, 2).toUpperCase()}</button>
      </div>
    </div>
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-16 items-center justify-end gap-2 px-3">
        <Button aria-label="Collapse sidebar" onClick={onCollapse} size="icon-lg" title="Collapse sidebar" variant="ghost"><SidebarSimpleIcon /></Button>
        <Button aria-label={searchOpen ? "Close search" : "Search bots"} onClick={() => { setSearchOpen((current) => !current); if (searchOpen) setQuery(""); }} size="icon-lg" variant="soft"><MagnifyingGlassIcon /></Button>
        <Button aria-label="Create bot" onClick={onNewBot} size="icon-lg" title="Create bot" variant="soft"><PlusIcon /></Button>
      </div>

      {searchOpen ? (
        <div className="px-3 pb-3">
          <label className="relative block">
            <span className="sr-only">Search bots</span>
            <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <input autoFocus className="h-9 w-full bg-muted/40 pr-3 pl-9 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring/50" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setSearchOpen(false); setQuery(""); } }} placeholder="Search bots" type="search" value={query} />
          </label>
        </div>
      ) : null}

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {bots.map((bot) => {
          const active = selectedBotId === bot.id;
          const conversation = data.conversations.find((item) => item.botIds.includes(bot.id));
          return (
            <button
              aria-current={active ? "page" : undefined}
              className={`flex w-full items-center gap-3 px-3 py-3 text-left transition-colors ${active ? "bg-muted" : "hover:bg-muted/60"}`}
              key={bot.id}
              onClick={() => onBot(bot.id)}
              type="button"
            >
              <span className="grid size-9 shrink-0 place-items-center text-[11px] font-medium text-white" style={{ backgroundColor: bot.color }}>{bot.name.slice(0, 1).toUpperCase()}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{bot.name}</span>
                <span className="mt-1 block truncate text-[11px] text-muted-foreground">{conversation?.runStatus === "running" ? "Thinking…" : `@${bot.handle}`}</span>
              </span>
            </button>
          );
        })}
        {bots.length === 0 ? <div className="px-3 py-8 text-center"><ChatsCircleIcon className="mx-auto size-5 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">{needle ? "No bots found." : "Create your first bot."}</p>{!needle ? <Button className="mt-4" onClick={onNewBot} size="sm" variant="soft"><PlusIcon /> Create bot</Button> : null}</div> : null}
      </div>

      <div className="flex items-center gap-3 p-3">
        <div className="grid size-9 shrink-0 place-items-center bg-muted text-[10px] font-medium">{data.user.name.slice(0, 2).toUpperCase()}</div>
        <p className="min-w-0 flex-1 truncate text-xs font-medium">{data.user.name}</p>
        <Button aria-label="Open settings" onClick={onSettings} size="icon-lg" variant="soft"><SquaresFourIcon /></Button>
      </div>
    </div>
  );
}

function LoadingScreen({ error, retry }: { error?: string; retry?: () => void }) {
  return <main className="grid min-h-dvh place-items-center p-6"><div className="text-center"><LogoMark /><p className="mt-4 text-muted-foreground text-xs">{error ?? "Assembling your bots…"}</p>{error && retry ? <Button className="mt-4" onClick={retry} variant="soft">Try again</Button> : !error ? <Spinner className="mt-5" /> : null}</div></main>;
}

function EmptyChat({ onCreate }: { onCreate: () => void }) {
  return <main className="grid min-h-[calc(100dvh-4rem)] place-items-center p-6 md:min-h-dvh"><div className="max-w-sm text-center"><LogoMark /><h1 className="mt-5 text-2xl tracking-[-0.05em]">Your bot club.</h1><p className="mt-3 text-[13px] text-muted-foreground leading-6">Create your first bot to start chatting.</p><Button className="mt-6" onClick={onCreate}><PlusIcon /> Create bot</Button></div></main>;
}
