"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowSquareOutIcon, ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import type { Bot, Conversation, RunStatus, RunTrigger } from "@slopbot/contracts";
import { getActivity, type ActivityRun } from "@/lib/client/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Awaiting approval",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
};

function triggerLabel(trigger: RunTrigger): string {
  if (trigger.kind === "scheduled") return "Scheduled";
  if (trigger.kind === "approval") return "Approval";
  return "Message";
}

function statusVariant(status: RunStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "failed" || status === "expired") return "destructive";
  if (status === "succeeded") return "default";
  if (status === "queued" || status === "running" || status === "awaiting_approval") return "outline";
  return "secondary";
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function ActivityView({ bots, conversations, onBot }: {
  bots: Bot[];
  conversations: Conversation[];
  onBot: (botId: string) => void;
}) {
  const [runs, setRuns] = useState<ActivityRun[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getActivity();
      setRuns(result.runs);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load activity.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <main className="mx-auto max-w-4xl px-5 py-8 sm:px-8 lg:py-10">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4 pr-10">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl tracking-[-0.05em]">Activity</h1>
          <p className="mt-1.5 max-w-xl text-[13px] text-muted-foreground leading-6">Recent bot runs across your workspace.</p>
        </div>
        <Button disabled={loading} onClick={() => void load()} size="sm" variant="ghost">Refresh</Button>
      </header>

      {error ? <p className="mb-5 border-l-2 border-destructive bg-destructive/10 px-4 py-3 text-destructive text-xs leading-5" role="alert">{error}</p> : null}

      {loading ? (
        <div className="grid min-h-40 place-items-center bg-muted/20"><Spinner /></div>
      ) : runs && runs.length > 0 ? (
        <div className="grid gap-2">
          {runs.map((run) => {
            const bot = bots.find((item) => item.id === run.botId);
            const conversation = conversations.find((item) => item.id === run.conversationId);
            const quiet = run.status === "succeeded" && run.trigger.kind === "scheduled" && run.outputMessageId === null;
            return (
              <article className="bg-muted/30 p-4" key={run.id}>
                <div className="flex flex-wrap items-start gap-3">
                  <div className="grid size-9 shrink-0 place-items-center text-[11px] font-medium text-white" style={{ backgroundColor: bot?.color ?? "#6b7280" }}>
                    {(bot?.name ?? "?").slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-[13px] font-medium">{bot?.name ?? "Removed bot"}</h2>
                      <Badge variant={statusVariant(run.status)}>{STATUS_LABEL[run.status]}</Badge>
                      <span className="text-[10px] text-muted-foreground uppercase tracking-[0.08em]">{triggerLabel(run.trigger)}</span>
                    </div>
                    <p className="mt-1 truncate text-[10px] text-muted-foreground">{conversation?.title ?? "Conversation unavailable"} · {formatTimestamp(run.createdAt)}</p>
                  </div>
                  {bot ? (
                    <Button className="shrink-0" onClick={() => onBot(bot.id)} size="sm" variant="ghost">
                      Open chat <ArrowSquareOutIcon />
                    </Button>
                  ) : null}
                </div>

                {quiet ? <p className="mt-3 text-[10px] text-muted-foreground">Quiet run — no message was posted.</p> : null}
                {run.error ? <p className="mt-3 line-clamp-3 text-destructive text-xs leading-5" role="alert">{run.error}</p> : null}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="grid min-h-64 place-items-center bg-muted/20">
          <div className="max-w-sm px-6 text-center">
            <div className="mx-auto mb-4 grid size-11 place-items-center bg-muted"><ClockCounterClockwiseIcon className="size-5" /></div>
            <p className="text-sm font-medium">No activity yet</p>
            <p className="mt-2 text-muted-foreground text-xs leading-5">Runs appear here after you message a bot or an automation fires.</p>
          </div>
        </div>
      )}
    </main>
  );
}
