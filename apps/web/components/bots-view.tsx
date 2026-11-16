"use client";

import { PlusIcon, RobotIcon } from "@phosphor-icons/react";
import type { Bot, Integration } from "@slopbot/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function BotsView({ bots, integrations, onCreate }: { bots: Bot[]; integrations: Integration[]; onCreate: () => void }) {
  return (
    <main className="mx-auto max-w-5xl px-5 py-8 sm:px-8 lg:py-10">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4 pr-10">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl tracking-[-0.05em]">Bots</h1>
          <p className="mt-1.5 max-w-xl text-[13px] text-muted-foreground leading-6">Give each bot its own instructions, model, and connectors.</p>
        </div>
        <Button className="shrink-0 self-start" onClick={onCreate}><PlusIcon /> Create bot</Button>
      </header>

      {bots.length === 0 ? (
        <div className="grid min-h-64 place-items-center bg-muted/20">
          <div className="max-w-sm px-6 text-center">
            <div className="mx-auto mb-4 grid size-11 place-items-center bg-muted"><RobotIcon className="size-5" /></div>
            <p className="text-sm font-medium">No bots yet</p>
            <p className="mt-2 text-muted-foreground text-xs leading-5">A bot is a personality with its own instructions, model, and optional connectors.</p>
            <Button className="mt-5" onClick={onCreate}><PlusIcon /> Create your first bot</Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {bots.map((bot) => (
            <article className="flex flex-col bg-muted/30 p-5" key={bot.id}>
              <div className="flex items-start gap-3">
                <div className="grid size-10 shrink-0 place-items-center font-medium text-sm text-white" style={{ backgroundColor: bot.color }}>{bot.name.slice(0, 1).toUpperCase()}</div>
                <div className="min-w-0 flex-1"><h2 className="truncate text-[13px] font-medium">{bot.name}</h2><p className="mt-1 truncate text-[10px] text-muted-foreground">@{bot.handle}</p></div>
              </div>
              <p className="mt-5 line-clamp-4 min-h-20 text-muted-foreground text-xs leading-5">{bot.persona}</p>
              <div className="mt-5 flex flex-wrap gap-1.5"><Badge variant="outline">{bot.model.split("/").pop()}</Badge><Badge variant="secondary">{bot.integrationIds.length} {bot.integrationIds.length === 1 ? "connector" : "connectors"}</Badge></div>
              {bot.integrationIds.length > 0 ? <p className="mt-3 truncate pt-1 text-[10px] text-muted-foreground">{bot.integrationIds.map((id) => integrations.find((item) => item.id === id)?.name ?? "Removed connector").join(" · ")}</p> : null}
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
