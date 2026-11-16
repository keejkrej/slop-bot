"use client";

import { useState } from "react";
import { BrainIcon, ClockCounterClockwiseIcon, LightningIcon, PlugsConnectedIcon, RobotIcon, SlidersHorizontalIcon } from "@phosphor-icons/react";
import type { Bootstrap } from "@slopbot/contracts";
import { ActivityView } from "./activity-view";
import { AutomationsView } from "./automations-view";
import { BotsView } from "./bots-view";
import { ConnectionsView } from "./connections-view";
import { MemoryView } from "./memory-view";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export type SettingsTab = "general" | "bots" | "connectors" | "automations" | "memory" | "activity";

export function WorkspaceSettings({ open, onOpenChange, data, tab, onTabChange, onCreateBot, onAddConnection, onRefresh, onSignOut, onBot }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: Bootstrap;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onCreateBot: () => void;
  onAddConnection: () => void;
  onRefresh: () => Promise<void>;
  onSignOut?: () => void;
  onBot?: (botId: string) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="grid h-[85dvh] max-h-[85dvh] w-[calc(100%-1rem)] max-w-5xl grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:grid-cols-[12rem_minmax(0,1fr)] sm:grid-rows-1 sm:max-w-5xl">
        <aside className="flex items-center gap-1 overflow-x-auto bg-muted/20 p-3 sm:flex-col sm:items-stretch sm:p-4" aria-label="Settings navigation">
          <DialogTitle className="sr-only">Workspace settings</DialogTitle>
          <SettingsTabButton active={tab === "general"} icon={<SlidersHorizontalIcon />} label="General" onClick={() => onTabChange("general")} />
          <SettingsTabButton active={tab === "bots"} icon={<RobotIcon />} label="Bots" onClick={() => onTabChange("bots")} />
          <SettingsTabButton active={tab === "connectors"} icon={<PlugsConnectedIcon />} label="Connectors" onClick={() => onTabChange("connectors")} />
          <SettingsTabButton active={tab === "automations"} icon={<LightningIcon />} label="Automations" onClick={() => onTabChange("automations")} />
          <SettingsTabButton active={tab === "memory"} icon={<BrainIcon />} label="Memory" onClick={() => onTabChange("memory")} />
          <SettingsTabButton active={tab === "activity"} icon={<ClockCounterClockwiseIcon />} label="Activity" onClick={() => onTabChange("activity")} />
        </aside>
        <section className="scrollbar-thin min-h-0 overflow-y-auto">
          {tab === "general" ? <GeneralSettings data={data} onSignOut={onSignOut} /> : tab === "bots" ? (
            <BotsView bots={data.bots} integrations={data.integrations} onCreate={onCreateBot} />
          ) : tab === "connectors" ? (
            <ConnectionsView integrations={data.integrations} onAdd={onAddConnection} onRefresh={onRefresh} />
          ) : tab === "automations" ? (
            <AutomationsView bots={data.bots} onRefresh={onRefresh} />
          ) : tab === "memory" ? (
            <MemoryView bots={data.bots} conversations={data.conversations} />
          ) : (
            <ActivityView bots={data.bots} conversations={data.conversations} onBot={onBot ?? (() => undefined)} />
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}

function SettingsTabButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button aria-current={active ? "page" : undefined} className={`flex h-9 shrink-0 items-center gap-2 px-3 text-left text-xs transition-colors ${active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`} onClick={onClick} type="button"><span className="[&_svg]:size-4">{icon}</span>{label}</button>;
}

function GeneralSettings({ data, onSignOut }: { data: Bootstrap; onSignOut?: () => void }) {
  return (
    <div className="mx-auto max-w-3xl p-6 sm:p-8">
      <header><h1 className="text-2xl tracking-[-0.05em]">General</h1></header>
      <section className="mt-8">
        <h2 className="mb-3 text-[10px] font-medium text-muted-foreground uppercase tracking-[0.16em]">Account</h2>
        <div className="flex flex-wrap items-center gap-4 bg-muted/30 p-5">
          <div className="grid size-11 shrink-0 place-items-center bg-muted text-sm font-medium">{data.user.name.slice(0, 2).toUpperCase()}</div>
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{data.user.name}</p><p className="mt-1 truncate text-xs text-muted-foreground">{data.user.email ?? "Local account"}</p></div>
          {onSignOut ? <Button onClick={onSignOut} variant="outline">Sign out</Button> : null}
        </div>
      </section>
      <section className="mt-8">
        <h2 className="mb-3 text-[10px] font-medium text-muted-foreground uppercase tracking-[0.16em]">Workspace</h2>
        <div className="bg-muted/30">
          <div className="flex items-center justify-between px-5 py-4"><span className="text-sm">AI mode</span><span className="text-xs text-muted-foreground">{data.agentMode === "gateway" ? "AI Gateway" : "Demo responses"}</span></div>
          <div className="flex items-center justify-between px-5 py-4"><span className="text-sm">Appearance</span><span className="text-xs text-muted-foreground">Dark</span></div>
        </div>
      </section>
    </div>
  );
}
