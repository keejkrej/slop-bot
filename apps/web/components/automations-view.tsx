"use client";

import { useCallback, useEffect, useState } from "react";
import {
  LightningIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import type { AutomationSchedule, AutomationTask, Bot } from "@slopbot/contracts";
import { api, getAutomations } from "@/lib/client/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

type ScheduleKind = "once" | "cron";

const STATUS_LABEL: Record<AutomationTask["status"], string> = {
  active: "Active",
  paused: "Paused",
  completed: "Completed",
  missed: "Missed",
  failed: "Failed",
};

function scheduleLabel(schedule: AutomationSchedule): string {
  return schedule.kind === "once"
    ? `Once · ${schedule.localTime.replace("T", " ")} (${schedule.timezone})`
    : `Cron · ${schedule.expression} (${schedule.timezone})`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function AutomationsView({ bots, onRefresh }: { bots: Bot[]; onRefresh?: () => Promise<void> }) {
  const [tasks, setTasks] = useState<AutomationTask[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [confirmId, setConfirmId] = useState<string>();

  const [title, setTitle] = useState("");
  const [botId, setBotId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("once");
  const [localTime, setLocalTime] = useState("");
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getAutomations();
      setTasks(result.automations);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load automations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved) setTimezone(resolved);
  }, []);

  useEffect(() => {
    setBotId((current) => (current && bots.some((bot) => bot.id === current) ? current : bots[0]?.id ?? ""));
  }, [bots]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const trimmedTitle = title.trim();
    const trimmedInstructions = instructions.trim();
    if (!trimmedTitle || !trimmedInstructions || !botId) {
      setFormError("Add a title, a bot, and instructions.");
      return;
    }
    if (kind === "once" && !localTime) {
      setFormError("Choose a date and time for the one-time run.");
      return;
    }
    if (kind === "cron" && !cron.trim()) {
      setFormError("Enter a five-field cron expression.");
      return;
    }

    setSubmitting(true);
    setFormError(undefined);
    setNotice(undefined);
    try {
      const schedule: AutomationSchedule = kind === "once"
        ? { kind: "once", localTime, timezone }
        : { kind: "cron", expression: cron.trim(), timezone };
      await api("/api/automations", {
        method: "POST",
        body: JSON.stringify({ title: trimmedTitle, botId, instructions: trimmedInstructions, schedule }),
      });
      setTitle("");
      setInstructions("");
      setLocalTime("");
      setCron("");
      await load();
      setNotice("Automation created.");
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not create the automation.");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleStatus(task: AutomationTask) {
    setBusyId(task.id);
    setError(undefined);
    setNotice(undefined);
    try {
      await api(`/api/automations/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: task.status === "active" ? "paused" : "active" }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the automation.");
    } finally {
      setBusyId(undefined);
    }
  }

  async function runNow(task: AutomationTask) {
    setBusyId(task.id);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await api<{ outcome: "started" | "duplicate" | "busy" | "failed" }>(
        `/api/automations/${task.id}/run`,
        { method: "POST", headers: { "idempotency-key": crypto.randomUUID() } },
      );
      setNotice(result.outcome === "started"
        ? "Run started."
        : result.outcome === "duplicate"
          ? "That run was already started."
          : result.outcome === "failed"
            ? "The run failed to start."
            : "The bot is busy. Try again shortly.");
      await load();
      await onRefresh?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the automation.");
    } finally {
      setBusyId(undefined);
    }
  }

  async function remove(task: AutomationTask) {
    setBusyId(task.id);
    setError(undefined);
    setNotice(undefined);
    try {
      await api(`/api/automations/${task.id}`, { method: "DELETE" });
      setConfirmId(undefined);
      await load();
      setNotice("Automation deleted.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the automation.");
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-5 py-8 sm:px-8 lg:py-10">
      <header className="mb-7 pr-10">
        <h1 className="text-2xl tracking-[-0.05em]">Automations</h1>
        <p className="mt-1.5 max-w-xl text-[13px] text-muted-foreground leading-6">Schedule a bot to run on its own. Runs post into the bot&apos;s conversation.</p>
      </header>

      {notice ? <p className="mb-5 border-l-2 border-foreground bg-muted px-4 py-3 text-xs leading-5" role="status">{notice}</p> : null}
      {error ? <p className="mb-5 border-l-2 border-destructive bg-destructive/10 px-4 py-3 text-destructive text-xs leading-5" role="alert">{error}</p> : null}

      <section className="mb-8 bg-muted/30 p-5">
        <h2 className="text-[10px] font-medium text-muted-foreground uppercase tracking-[0.16em]">New automation</h2>
        {bots.length === 0 ? (
          <p className="mt-4 text-muted-foreground text-xs leading-5">Create a bot first, then schedule it here.</p>
        ) : (
          <form className="mt-4 grid gap-4" onSubmit={create}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field htmlFor="automation-title" label="Title">
                <Input id="automation-title" maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="Morning brief" required value={title} />
              </Field>
              <Field htmlFor="automation-bot" label="Bot">
                <select
                  className="h-8 w-full border border-input bg-transparent px-2.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
                  id="automation-bot"
                  onChange={(event) => setBotId(event.target.value)}
                  required
                  value={botId}
                >
                  {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                </select>
              </Field>
            </div>

            <Field htmlFor="automation-instructions" label="Instructions">
              <Textarea
                id="automation-instructions"
                maxLength={12_000}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="What should the bot do when this runs?"
                required
                rows={3}
                value={instructions}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field htmlFor="automation-kind" label="Schedule">
                <select
                  className="h-8 w-full border border-input bg-transparent px-2.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
                  id="automation-kind"
                  onChange={(event) => setKind(event.target.value as ScheduleKind)}
                  value={kind}
                >
                  <option value="once">Once</option>
                  <option value="cron">Recurring</option>
                </select>
              </Field>
              <Field htmlFor="automation-timezone" label="Timezone">
                <Input id="automation-timezone" onChange={(event) => setTimezone(event.target.value)} required value={timezone} />
              </Field>
            </div>

            {kind === "once" ? (
              <Field htmlFor="automation-local-time" hint="Uses your local wall time in the timezone above." label="Date and time">
                <Input id="automation-local-time" onChange={(event) => setLocalTime(event.target.value)} required type="datetime-local" value={localTime} />
              </Field>
            ) : (
              <Field htmlFor="automation-cron" hint="Five fields: minute hour day-of-month month day-of-week." label="Cron expression">
                <Input id="automation-cron" onChange={(event) => setCron(event.target.value)} placeholder="0 9 * * 1-5" required value={cron} />
              </Field>
            )}

            {formError ? <p className="text-destructive text-xs leading-5" role="alert">{formError}</p> : null}

            <div className="flex items-center gap-3">
              <Button disabled={submitting} type="submit">
                {submitting ? <Spinner /> : <PlusIcon />} Create automation
              </Button>
              <span className="text-[10px] text-muted-foreground">Runs are created by the scheduler, not by a model.</span>
            </div>
          </form>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-[10px] font-medium text-muted-foreground uppercase tracking-[0.16em]">Your automations</h2>
        {loading ? (
          <div className="grid min-h-40 place-items-center bg-muted/20"><Spinner /></div>
        ) : tasks && tasks.length > 0 ? (
          <div className="grid gap-3">
            {tasks.map((task) => {
              const bot = bots.find((item) => item.id === task.botId);
              const busy = busyId === task.id;
              return (
                <article className="bg-muted/30 p-5" key={task.id}>
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="grid size-9 shrink-0 place-items-center bg-muted"><LightningIcon className="size-4" /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-[13px] font-medium">{task.title}</h3>
                        <Badge variant={task.status === "failed" || task.status === "missed" ? "destructive" : task.status === "active" ? "default" : "secondary"}>{STATUS_LABEL[task.status]}</Badge>
                      </div>
                      <p className="mt-1 text-[10px] text-muted-foreground">{bot?.name ?? "Removed bot"} · {scheduleLabel(task.schedule)}</p>
                    </div>
                  </div>

                  <p className="mt-4 line-clamp-3 text-muted-foreground text-xs leading-5">{task.instructions}</p>

                  <dl className="mt-4 grid gap-2 text-[10px] text-muted-foreground sm:grid-cols-2">
                    <div><dt className="uppercase tracking-[0.08em]">Next run</dt><dd className="mt-0.5 text-foreground">{formatTimestamp(task.nextDueAt)}</dd></div>
                    <div><dt className="uppercase tracking-[0.08em]">Last run</dt><dd className="mt-0.5 text-foreground">{formatTimestamp(task.lastOccurredAt)}</dd></div>
                  </dl>

                  {task.lastError ? <p className="mt-3 text-destructive text-xs leading-5" role="alert">{task.lastError}</p> : null}

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button disabled={busy} onClick={() => void runNow(task)} size="sm" variant="soft">
                      {busy ? <Spinner /> : <PlayIcon />} Run now
                    </Button>
                    {task.status === "active" || task.status === "paused" ? (
                      <Button disabled={busy} onClick={() => void toggleStatus(task)} size="sm" variant="ghost">
                        {task.status === "active" ? <PauseIcon /> : <PlayIcon />} {task.status === "active" ? "Pause" : "Resume"}
                      </Button>
                    ) : null}
                    {confirmId === task.id ? (
                      <div className="ml-auto flex items-center gap-1">
                        <Button onClick={() => setConfirmId(undefined)} size="sm" variant="ghost">Cancel</Button>
                        <Button disabled={busy} onClick={() => void remove(task)} size="sm" variant="destructive">Delete</Button>
                      </div>
                    ) : (
                      <Button aria-label={`Delete ${task.title}`} className="ml-auto" onClick={() => setConfirmId(task.id)} size="icon-sm" variant="ghost"><TrashIcon /></Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="grid min-h-40 place-items-center bg-muted/20">
            <div className="max-w-sm px-6 text-center">
              <div className="mx-auto mb-4 grid size-11 place-items-center bg-muted"><LightningIcon className="size-5" /></div>
              <p className="text-sm font-medium">No automations yet</p>
              <p className="mt-2 text-muted-foreground text-xs leading-5">Create one above to let a bot run on a schedule.</p>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-[0.12em]" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? <p className="text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
