# Durable run recovery

`recoverRuns` in `apps/web/lib/server/run-recovery.ts` is the recovery pass for
durable runs. It is independent of automation task state and only touches run
state, timers, and pending approvals.

```ts
const result = await recoverRuns({ store, now, limit });
```

`startRun` is an optional injection point. The default reuses `admitClaim` from
`runs.ts` with the same stable `startToken(run.id, attempt)`, so a retried
handoff adopts the existing logical run instead of creating a second one. An
approval resume (attempt 1) gets a fresh token instead of adopting the finished
attempt-0 workflow.

Admission writes the timers this pass consumes: `start_handoff` at 60 seconds,
`lease_recovery` at the 5-minute lease, and `approval_timeout` at 7 days. The
initial `start_handoff` timer is written atomically with the run claim (message,
scheduled, and approval-resume), so a crash before admission still leaves a
recoverable due timer. The default start hook retains its token for 7 days so a
late duplicate cannot start a second workflow after the first ends.

## What it does

1. **Claims due timers** with `store.runs.claimDueTimers({ now, limit })`.
   `claimDueTimers` already cancels timers whose run is terminal, so completed
   runs never produce recovery events.
2. **Handles each claimed timer in isolation.** One failing timer increments
   `errors` and never aborts the rest of the batch. A failed timer is returned
   to `pending` with a bounded retry delay (30 seconds) so a later tick retries
   it instead of leaving it claimed forever; a timer whose run is already
   terminal is cancelled instead of being resurrected.
3. **Runs a bounded safety net** with `store.runs.listRecoverableRuns({ now,
   limit })`. The query only returns active runs whose `leaseExpiresAt` is
   already due, so an idle tick never scans or fires.

### Timer kinds

| Kind | Action |
| --- | --- |
| `approval_timeout` | If the run is `awaiting_approval`, transition it to `expired`, expire the matching `pending`/`resuming` action, clear the lease, and append an `expired` event. |
| `lease_recovery` | If the run is `queued`/`running` and its lease is genuinely past, first ask the installed Workflow SDK for the run's status. A live (`pending`/`running`) workflow refreshes the lease and the recovery timer instead of expiring. A terminal or absent workflow transitions the run to `expired`, clears the lease, and appends an `expired` event. If the status lookup is unreachable, the run is left running with a short lease backoff and a retry timer. If the lease is still in the future, the timer is consumed and the run is left alone. |
| `start_handoff` | If the run is `queued` with no `workflowRunId`, retry admission through the injected `startRun` seam. If it already has a `workflowRunId` and is not an approval resume, reconcile it to `running` with that owner instead of starting a second workflow. An approval-resumed run keeps its stale `workflowRunId` from the suspended workflow, so it is re-admitted with the resuming action instead of being reconciled. |

Every transition uses the current `getRun` status and fence as the expected
values, so a concurrent writer wins and recovery records `skipped` rather than
overwriting newer state. Terminal transitions also cancel the run's other
timers through the atomic `timers` patch.

### Safety net

The safety net is a backstop for active runs whose lease is due but that have no
usable timer row (for example, runs created before timers were written, or a
timer that was lost). It applies the same live-workflow check as
`lease_recovery`: a live workflow is renewed, a terminal/absent one is expired.
It does not loop, so it cannot recurse.

## Store seam

`RunStore` gained two additive methods:

```ts
listRecoverableRuns(input: { now: string; limit?: number }): Promise<Run[]>;
releaseRunTimer(input: { timerId: string; now?: string; retryAfterMs?: number }): Promise<void>;
```

`listRecoverableRuns` is a cross-user, bounded scan of active runs with
`leaseExpiresAt <= now`, ordered by lease expiry. `FileStore` filters in memory;
`PostgresStore` uses `status in ACTIVE_RUN_STATUSES and lease_expires_at is not
null and lease_expires_at <= now` with a `limit`.

`releaseRunTimer` returns a claimed timer to `pending` with a bounded retry
delay after a handler failure, or cancels it when its run is already terminal.

## Boundaries

- Admission writes the timers; recovery consumes them and may return a failed
  timer to `pending` with a bounded backoff. The initial `start_handoff` timer is
  committed with the run claim, so a run that never reached admission is still
  visible to recovery.
- `approval_timeout` recovery requires its timer row. An `awaiting_approval` run
  has no lease timestamp, so the safety net cannot infer an approval deadline.
- Recovery is at-least-once. It does not claim exactly-once delivery; the
  status/fence CAS and dedupe keys make repeated passes safe.

## Cron integration

The shared cron tick calls recovery alongside the automation tick.
`runSchedulerTick` defaults its `recoverRuns` seam to the real pass, so
`POST /api/cron/tick` and `pnpm tick` both run it after the task pass:

```ts
const result = await runSchedulerTick({ store, startScheduledRun, limit });
// result.recovery holds the RecoverRunsResult counters
```

`recoverRuns` returns counts (`timersClaimed`, `approvalExpired`,
`leaseExpired`, `leaseRenewed`, `leaseRenewalErrors`, `handoffRetried`,
`handoffReconciled`, `safetyNetExpired`, `skipped`, `errors`) that are merged
into the tick response as `recovery`. A recovery failure is reported as
`recoveryError` and never blocks the automation pass.
