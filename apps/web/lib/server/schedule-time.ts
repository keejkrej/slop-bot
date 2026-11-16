import { Cron } from "croner";

/**
 * A proactive task schedule. Both variants carry an IANA timezone so that
 * local wall-clock times are resolved deterministically.
 */
export type ScheduleInput =
  | {
      kind: "once";
      /** ISO 8601 local timestamp without an offset, e.g. "2026-12-25T09:00:00". */
      localTime: string;
      timezone: string;
    }
  | {
      kind: "cron";
      /** Standard five-field cron expression (minute hour day-of-month month day-of-week). */
      expression: string;
      timezone: string;
    };

export type NextDue =
  | { status: "scheduled"; nextDueAt: string }
  | { status: "missed" };

export interface ComputeNextDueOptions {
  /**
   * Exclusive lower bound for recurring-task catch-up. Occurrences at or before
   * this instant are treated as already handled. Omit it to consider every
   * occurrence up to `now`.
   */
  since?: Date;
}

/** A one-time task may still be dispatched this long after its local time. */
export const ONE_TIME_CATCH_UP_MS = 24 * 60 * 60 * 1000;

export class ScheduleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleInputError";
  }
}

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new ScheduleInputError(`Invalid IANA timezone: ${timezone}`);
  }
}

function scheduled(date: Date): NextDue {
  return { status: "scheduled", nextDueAt: date.toISOString() };
}

/**
 * Resolve a local wall-clock timestamp in an IANA timezone to a UTC instant.
 *
 * Croner's fixed-time DST policy is used: an ambiguous local time resolves to
 * the earlier occurrence, and a local time inside a spring-forward gap resolves
 * to the first valid time after the gap. The timestamp is expressed as a
 * one-off seven-field cron so the resolution does not depend on the host
 * machine's timezone.
 */
function resolveLocalTime(localTime: string, timezone: string): Date {
  const match = LOCAL_TIME.exec(localTime);
  if (!match) {
    throw new ScheduleInputError(
      `One-time localTime must be an ISO 8601 local timestamp without an offset: ${localTime}`,
    );
  }
  const [, year, month, day, hour, minute, second = "0"] = match;
  const expression = `${Number(second)} ${Number(minute)} ${Number(hour)} ${Number(day)} ${Number(month)} * ${Number(year)}`;

  let cron: Cron;
  try {
    cron = new Cron(expression, { timezone, paused: true, mode: "7-part" });
  } catch {
    throw new ScheduleInputError(`Invalid one-time local timestamp: ${localTime}`);
  }

  const before = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)) - 2 * 86_400_000);
  const resolved = cron.nextRun(before);
  if (!resolved) {
    throw new ScheduleInputError(`Invalid one-time local timestamp: ${localTime}`);
  }
  return resolved;
}

/**
 * Compute the next due instant for a schedule at a caller-supplied `now`.
 *
 * Recurring tasks coalesce: if several occurrences were missed, only the latest
 * one is returned, so a tick creates at most one occurrence. One-time tasks are
 * returned while they are at most 24 hours late and are otherwise `missed`.
 */
export function computeNextDue(
  input: ScheduleInput,
  now: Date,
  options: ComputeNextDueOptions = {},
): NextDue {
  if (Number.isNaN(now.getTime())) {
    throw new ScheduleInputError("now must be a valid Date");
  }
  assertTimezone(input.timezone);

  if (input.kind === "once") {
    const instant = resolveLocalTime(input.localTime, input.timezone);
    const lateBy = now.getTime() - instant.getTime();
    if (lateBy < 0) return scheduled(instant);
    if (lateBy <= ONE_TIME_CATCH_UP_MS) return scheduled(instant);
    return { status: "missed" };
  }

  const fields = input.expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ScheduleInputError("Cron expression must have exactly five fields");
  }

  let cron: Cron;
  try {
    cron = new Cron(input.expression, { timezone: input.timezone, paused: true });
  } catch {
    throw new ScheduleInputError(`Invalid cron expression: ${input.expression}`);
  }

  // Croner's previousRuns is exclusive. Occurrences are whole seconds, so use
  // 1ms after the start of the current second: this includes an occurrence
  // exactly at `now` without pulling in the next second.
  const currentSecond = Math.floor(now.getTime() / 1000) * 1000;
  const latest = cron.previousRuns(1, new Date(currentSecond + 1))[0];
  if (latest && (!options.since || latest.getTime() > options.since.getTime())) {
    return scheduled(latest);
  }

  const next = cron.nextRun(now);
  if (!next) {
    throw new ScheduleInputError(`Cron expression has no future occurrence: ${input.expression}`);
  }
  return scheduled(next);
}
