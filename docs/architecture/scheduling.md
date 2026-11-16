# Scheduling time policy

This document describes how proactive task times are computed and how the
scheduler stores and dispatches them. General run design lives elsewhere.

The pure calculation lives in `apps/web/lib/server/schedule-time.ts` and is
covered by `tests/schedule-time.test.ts`. It takes an explicit `now` and never
reads the wall clock, so results are deterministic.

## Inputs

A schedule is one of:

- **One-time**: an ISO 8601 local timestamp without an offset, e.g.
  `2026-12-25T09:00:00`, plus an IANA timezone.
- **Recurring**: a standard five-field cron expression
  (`minute hour day-of-month month day-of-week`) plus an IANA timezone.

Both forms resolve local wall-clock time in the supplied timezone. The output is
always a UTC ISO 8601 string (`nextDueAt`) or `missed`.

## Recurring tasks

- At most one occurrence is produced per tick. If several occurrences were
  missed, only the latest missed occurrence is returned; earlier ones are
  coalesced away. There is never a burst.
- An occurrence exactly at `now` counts as due.
- `since` is an exclusive lower bound for catch-up. Occurrences at or before
  `since` are treated as already handled. Pass the task's creation time on the
  first computation so a new task starts at its next future occurrence. After
  dispatching a catch-up occurrence, pass `since = now` so older missed
  occurrences are not replayed on later ticks; this collapses all missed
  occurrences into the single latest one. Omit `since` only when you
  intentionally want to consider all history.
- If no occurrence is due, the next future occurrence is returned.

## One-time tasks

- A future local timestamp is returned as its UTC instant.
- A late task is still returned while it is at most 24 hours late (inclusive).
  This is the catch-up window.
- A task more than 24 hours late is `missed`.
- `since` does not apply to one-time tasks; the 24-hour window is the only
  catch-up rule.

## DST policy

Croner 11.0.1 is the timezone-aware parser. Its fixed-time DST policy applies to
both recurring fixed-time expressions and one-time timestamps:

- **Ambiguous local time** (fall back, the clock repeats an hour): the earlier
  occurrence is used, and the task runs once.
- **Nonexistent local time** (spring forward, the clock skips an hour): the
  first valid time after the gap is used, on the same local day.

One-time timestamps are resolved through a one-off seven-field cron internally
so the result does not depend on the host machine's timezone. Recurring
expressions with wildcards, steps, ranges, or lists are interval jobs under
Croner's rules and may run on both passes through a repeated hour; the
coalescing rule above still limits a tick to one occurrence.

## Errors

Invalid cron expressions (including anything that is not exactly five fields),
invalid IANA timezones, malformed one-time timestamps, and timestamps with an
explicit offset raise `ScheduleInputError`.

## Storage

Automation tasks and their occurrences are durable rows in the same store as
runs (`automation_tasks` and `automation_occurrences` in Postgres, nested
`automations` in `FileStore`). A task stores the owning user, bot, resolved
conversation, title, standalone instructions, schedule, status, `nextDueAt`,
`lastOccurredAt`, `lastError`, bounded `attempts`, and a short tick lease
(`claimedAt`). The database layer never imports `schedule-time`; the service
passes computed `nextDueAt` and occurrence ids across the seam.

An occurrence is materialized before dispatch with a stable `executionId`:

- scheduled: `auto:<taskId>:<occurrenceAt>`
- manual run-now: `manual:<taskId>:<requestId>`

`executionId` is unique, so a redelivered tick or request reuses the existing
occurrence and never starts a second agent run. Occurrence status is one of
`queued`, `running`, `awaiting_approval`, `succeeded`, `failed`, or `missed`.

## Scheduler tick

`runSchedulerTick({ now, limit })` in
`apps/web/lib/server/automations.ts` is the single entry point. It:

1. Reconciles open occurrences against their run's current status.
2. Retries durably reserved occurrences that never got a run (busy conversation,
   manual Run Now) oldest first, independently of `nextDueAt`. This runs before
   the due-task pass so an old queued occurrence is dispatched before a newer
   recurrence is computed.
3. Leases due active tasks in one batch. Postgres uses `FOR UPDATE SKIP LOCKED`
   and `FileStore` uses its copy-on-write commit, so parallel ticks never claim
   the same task twice. A crashed tick's lease expires after five minutes.
4. Processes each task independently; one failure never blocks the rest.
5. Runs durable run recovery (`recoverRuns`) after the task pass, consuming due
   run timers and applying a bounded lease safety net. A recovery failure is
   reported separately and never blocks the task pass.

For each task the service recomputes the due occurrence from the stored
`nextDueAt` pointer, so a late tick coalesces to the latest missed occurrence.
It then admits the occurrence through the shared scheduled-run path. On
success it advances a recurring task with `since = now` (not the occurrence
time), which guarantees the next pointer is in the future and prevents a burst.
A one-time task becomes `completed`; a one-time task more than 24 hours late
becomes `missed` with no run.

A durably reserved occurrence wins over recurrence coalescing: while any
occurrence for the task is `queued`, `running`, or `awaiting_approval`, the task
pass waits instead of starting a newer occurrence or marking the old one missed.
Automatic retries never run a paused task; an explicit manual Run Now may still
drain while paused. Manual retries never advance `nextDueAt`.

If the conversation is busy, the occurrence stays `queued` and `nextDueAt` is
left unchanged, so a later tick retries it. No terminal message is recorded and
no timer is advanced. Repeated failures increment `attempts`; after five the
task becomes `failed`.

Every task write bumps a monotonic `revision`. A tick that claimed an occurrence
advances the task only when the revision still matches, so a pause, resume,
schedule, or title edit made mid-tick is never overwritten. The occurrence/run
linkage is still recorded and the conflict is counted as `revisionConflicts`.

The HTTP entry point is `POST /api/cron/tick`, protected by `CRON_SECRET` with a
constant-time comparison. It fails closed in production when the secret is
unset and allows local ticks otherwise. `pnpm tick` runs the same service
without HTTP auth.

## Host schedule registration

Production registration is a static Vercel Schedule in `apps/web/vercel.json`,
using the current `schedules` object (not the legacy `crons` array). The entry
is named `proactive-tick` and targets the path `/api/cron/tick` with
`requestMethod: "POST"` every 15 minutes. Path targets default to `POST`, and
the route exports only `POST`; there is no legacy `GET` fallback.

`tests/vercel-schedules.test.ts` checks the repository configuration shape and
the route's exported method. It does not prove that Vercel registered or invoked
the schedule: registration happens on deploy, and invocation is a host-side
event. Verify both against the deployed project with
`vercel schedules list --project slop-bot --scope keejkrej-teams` and the
schedule's execution history.
