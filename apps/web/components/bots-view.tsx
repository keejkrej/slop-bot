"use client";

import { PlusIcon, RobotIcon } from "@phosphor-icons/react";
import type { Bot, Integration } from "@slopbot/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function BotsView({ bots, integrations, onCreate }: { bots: Bot[]; integrations: Integration[]; onCreate: () => void }) {
  return (
    <main className="mx-auto max-w-6xl p-5 py-8 sm:p-8 lg:py-12">
      <PageHeader eyebrow="CASTING ROOM" title="Your bots." description="Distinct instructions, models, and tools. Put them together and watch the ideas collide." action={<Button onClick={onCreate} variant="outline"><PlusIcon /> Create bot</Button>} />
      {bots.length === 0 ? <div className="grid min-h-72 place-items-center border border-dashed"><div className="text-center"><RobotIcon className="mx-auto mb-4 size-7 text-muted-foreground" /><p className="text-sm">No custom personalities yet.</p><Button className="mt-5" onClick={onCreate} variant="outline">Create your first bot</Button></div></div> : (
        <div className="grid gap-px overflow-hidden border bg-border sm:grid-cols-2 xl:grid-cols-3">
          {bots.map((bot) => <Card className="border-0 ring-0" key={bot.id}>
            <CardHeader className="flex flex-row items-start gap-3">
              <div className="grid size-9 shrink-0 place-items-center font-medium text-sm text-white" style={{ backgroundColor: bot.color }}>{bot.name.slice(0, 1).toUpperCase()}</div>
              <div className="min-w-0"><CardTitle className="truncate">{bot.name}</CardTitle><CardDescription>@{bot.handle}</CardDescription></div>
            </CardHeader>
            <CardContent>
              <p className="line-clamp-4 min-h-20 text-muted-foreground text-xs leading-relaxed">{bot.persona}</p>
              <div className="mt-5 flex flex-wrap gap-1.5"><Badge variant="outline">{bot.model.split("/").pop()}</Badge><Badge variant="secondary">{bot.integrationIds.length} {bot.integrationIds.length === 1 ? "tool link" : "tool links"}</Badge></div>
              {bot.integrationIds.length > 0 ? <p className="mt-3 truncate text-[10px] text-muted-foreground">{bot.integrationIds.map((id) => integrations.find((item) => item.id === id)?.name ?? "Removed connection").join(" · ")}</p> : null}
            </CardContent>
          </Card>)}
        </div>
      )}
    </main>
  );
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action: React.ReactNode }) {
  return <header className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between"><div><p className="mb-3 text-[10px] text-muted-foreground uppercase tracking-[0.2em]">{eyebrow}</p><h1 className="text-3xl tracking-[-0.07em] sm:text-4xl">{title}</h1><p className="mt-3 max-w-xl text-muted-foreground text-xs leading-relaxed">{description}</p></div><div className="shrink-0">{action}</div></header>;
}
