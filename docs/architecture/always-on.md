# Always-on agents

This document explains how Slop Bot does proactive, unattended work without
long-lived compute, and why the current design looks the way it does. Time
computation and the scheduler tick are specified in
[scheduling.md](./scheduling.md); this document covers the surrounding model.

## Vocabulary

- **Run** — one durable unit of agent work for a conversation, stored in
  `AppStore.runs`. A run is the source of truth, not the workflow process.
- **Turn** — the model/tool loop inside a run (`runGroupTurn`).
- **Automation task** — a user-owned one-time or cron schedule bound to a bot
  and its existing conversation.
- **Occurrence** — one materialized firing of a task, keyed by a stable
  `executionId`.
- **Tick** — one bounded scheduler pass that leases due tasks and admits
  occurrences.
- **Timer** — a durable `run_timers` row that recovery can act on later.
- **Quiet reply** — a scheduled turn that ends with the exact sentinel
  `NO_REPLY` and records no visible message.

## What "always-on" means here

Always-on does not mean a resident process or VM. It means durable state plus a
timer plus a run checkpoint: the system can be asleep, restart, or lose a
worker, and still resume or expire work correctly. Compute is created only for
the duration of a turn and then stopped.

## Convergent patterns in the field

The following patterns recur across current agent platforms. They are stated as
design patterns, not vendor endorsements.

- **Durable inbox + timer + run checkpoint.** Work is persisted before it runs;
  a timer or queue wakes it; each run checkpoints so a crash resumes rather than
  restarts. See Anthropic's
  [building always-on agents](https://claude.com/resources/articles/building-always-on-agents)
  and Vercel Workflow
  [idempotency](https://workflow-sdk.dev/docs/foundations/idempotency).
- **Small core profile, lazily retrieved archive.** A compact, always-loaded
  memory core is separated from a larger archive fetched on demand. See the
  Anthropic
  [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool),
  OpenClaw [memory](https://docs.openclaw.ai/concepts/memory), Letta
  [MemFS](https://docs.letta.com/concepts/memfs), and Google ADK
  [memory](https://adk.dev/sessions/memory/).
- **Code-enforced permissions.** Policy is enforced in code at the tool
  boundary, not only in the prompt. See OpenClaw
  [permission modes](https://docs.openclaw.ai/tools/permission-modes).
- **Approvals plus idempotency.** Consequential writes pause for explicit
  approval and resume durably; retries reuse a stable key. See the OpenAI Agents
  SDK [human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)
  and Vercel Workflow
  [idempotency](https://workflow-sdk.dev/docs/foundations/idempotency).
- **Small in-app outbox with quiet defaults.** Proactive results land in an
  in-app activity surface and stay silent unless there is something to say. See
  Letta [schedules](https://docs.letta.com/configuration/schedules) and Google
  ADK [ambient agents](https://adk.dev/runtime/ambient-agents/).
- **Bounded subagents, only later.** Delegation is added after the single-agent
  path is durable and observable. See OpenClaw
  [subagents](https://docs.openclaw.ai/subagents).
- **Trajectory evals.** Quality is measured on full run trajectories, not just
  final text. See Google ADK [evaluate](https://adk.dev/evaluate/).

## Slop Bot design decisions

These are recovered from the current source, not aspirational.

- **Retained `WorkflowAgent`.** Model and tool work still runs in
  `WorkflowAgent` inside `runGroupTurn` with explicit step, token, and tool
  limits. Proactive work reuses the same turn path as interactive chat.
- **`AppStore.runs` is core.** `RunStore` (`claimRun`, `transitionRun`,
  `appendEvent`, timers) is the durable record. The workflow process is
  replaceable; the run row is not.
- **Fenced, per-conversation exclusive run.** `claimRun` returns `busy` when the
  conversation already has an active run, and `transitionRun` is guarded by
  `expectedStatus` plus a monotonic `fence`. A stale writer cannot overwrite a
  newer state.
- **Conversation projection only.** A conversation stores `activeRunId` and a
  projected `runStatus`; it is not a second state machine. The projection is
  derived from run status via `conversationProjectionFor`.
- **Durable timers and recovery.** Admission writes `run_timers` rows: a
  `start_handoff` deadline (60s), a `lease_recovery` deadline (5m), and an
  `approval_timeout` (7d). `runSchedulerTick` invokes `recoverRuns` by default,
  so each tick consumes due timers and applies a bounded lease safety net. See
  [run-recovery.md](./run-recovery.md).
- **Atomic terminal completion.** `RunStore.completeWithMessage` writes the bot
  outbox message and the terminal `succeeded` run state in one transaction, so a
  crash cannot leave a message without a completed run or vice versa.
- **Attempt-scoped start tokens.** `startToken(runId, attempt)` keeps duplicate
  starts of one attempt from creating a second owner, while an approval resume
  (attempt 1) gets a fresh token. The default start hook retains the token for
  7 days.
- **Database tasks and occurrence admission.** `automation_tasks` and
  `automation_occurrences` are durable rows. An occurrence is materialized
  before dispatch with a unique `executionId`, so a redelivered tick reuses the
  existing occurrence instead of starting a second run.
- **Existing single conversation.** A bot has exactly one conversation
  (`MAX_CHAT_BOTS = 1`). Automations resolve that conversation rather than
  creating new ones, so proactive output lands where the user already talks to
  the bot.
- **Memory is not the system of record.** Durable file memory lives in the
  store alongside runs; it never replaces run state or messages.
- **Bounded sandbox.** `computerRun` creates a non-persistent sandbox with a
  short timeout, `deny-all` network policy, and a `finally` stop. No VM outlives
  a turn.
- **Desktop jobs are claimed and delivered separately.** The bridge claims a
  job with a short lease before executing it. Execution and hook delivery are
  tracked separately, so a completed job can retry delivery without re-running
  the local tool, and an already-delivered result is acknowledged without
  resuming the hook again. Results are bounded and redacted on both sides.
- **User-managed Automations and in-app activity.** Users create, pause, and
  run tasks in the app; results and run history appear in the in-app activity
  view. There are no external delivery channels.

## Observability and replay evals

- **Trace events share the run log.** `run-telemetry.ts` writes typed,
  sanitized envelopes through `RunStore.appendEvent` with a natural
  `run + span/tool-call` dedupe key. Categories are `run`, `model`, `tool`, and
  `approval`; phases are `start` and `end`.
- **Allowlist, not transcripts.** A trace event may carry a model name, tool
  name, nonsecret integration id, tool-call id, duration, bounded status/error
  taxonomy, and input/output token usage from the actual generation result.
  Raw prompts, chain-of-thought, model messages, MCP request/result bodies,
  tool inputs/outputs, and credentials are never stored. Unknown or malformed
  stored rows fail closed when read.
- **Own-user run detail.** `GET /api/activity/[runId]` authenticates the user,
  verifies run ownership, and returns only the run projection plus sanitized
  traces. The Activity view expands a run to show lifecycle, token, and latency
  metadata; historical runs without traces still render.
- **No exporter by default.** The installed `WorkflowAgent` telemetry is only
  enabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is explicitly configured, and
  input/output recording stays off. The default path stores backend usage and
  tool events only.
- **Replay evals use the public executor.** `agent-turn.ts` exposes
  `executeAgentTurn(request, factory)`; production uses the normal
  `WorkflowAgent` factory. Six recorded fixtures replay real result shapes
  through the same decision logic and store transitions: scheduled duplicate
  and empty reports, memory-delete approval pause and resume, unselected MCP
  blocking, and sanitized tool exceptions. This is an executor +
  store-transition harness, not a full workflow-runtime E2E test.

## Why one protected database tick

Milestone 1 uses a single protected tick (`POST /api/cron/tick`, guarded by
`CRON_SECRET`, plus `pnpm tick` locally) instead of a managed schedule/queue
product. This keeps local Next.js development and the single-process `FileStore`
simple: one code path, one auth check, no extra infrastructure to run or
simulate. `@vercel/schedules` and `@vercel/queues` are intentionally not part of
milestone 1.

The tick is a dispatcher seam. `runSchedulerTick` takes an injected
`startScheduledRun` and an optional `recoverRuns` override (defaulting to the
real recovery pass), so a later milestone can add dynamic schedules or a managed
trigger without changing the admission logic. See
[scheduling.md](./scheduling.md) for the time policy.

## Remaining boundaries

- **`FileStore` is single-process.** It keeps state in memory with a write
  chain; it is for local development, not multi-instance deployment.
- **No exactly-once external side effects.** Idempotency keys reduce duplicate
  sends but cannot make an external provider exactly-once.
- **Finite write grants, not general write-MCP.** MCP tools are read-only by
  default. A connection may grant a finite list of write tools, and each
  granted write still requires a signed, expiring approval that is rechecked at
  execution time. There is no blanket write toggle. See
  [tool-permissions.md](./tool-permissions.md).
- **Proactive results are quiet by default.** A scheduled turn that has nothing
  to say returns the exact `NO_REPLY` sentinel and records no message.
- **No proactive email, push, dreaming, or heartbeats.** There is no outbound
  notification channel for unattended results and no background reflection loop.
  A scheduled run may update `reported.md`; an identical repeat is suppressed
  rather than re-emitted.
- **No long-lived VMs.** Compute is per-turn and stopped in `finally`.
- **Public Vercel Schedules is a beta.** If a managed schedule is adopted later,
  its documented limits apply; see
  [Vercel Schedules limits](https://vercel.com/docs/schedules/limits) and
  [handling runs](https://vercel.com/docs/schedules/handle-runs).
