import { describe, expect, it } from "vitest";
import {
  computeNextDue,
  ONE_TIME_CATCH_UP_MS,
  ScheduleInputError,
} from "../apps/web/lib/server/schedule-time";

const at = (iso: string) => new Date(iso);

describe("computeNextDue: recurring cron", () => {
  it("converts a five-field cron in an IANA timezone to a UTC nextDueAt", () => {
    const result = computeNextDue(
      { kind: "cron", expression: "0 9 * * *", timezone: "America/New_York" },
      at("2026-01-15T00:00:00Z"),
      { since: at("2026-01-15T00:00:00Z") },
    );
    expect(result).toEqual({ status: "scheduled", nextDueAt: "2026-01-15T14:00:00.000Z" });
  });

  it("coalesces missed occurrences to the latest one, never a burst", () => {
    const result = computeNextDue(
      { kind: "cron", expression: "0 * * * *", timezone: "UTC" },
      at("2026-01-15T05:30:00Z"),
    );
    expect(result).toEqual({ status: "scheduled", nextDueAt: "2026-01-15T05:00:00.000Z" });
  });

  it("does not re-dispatch an occurrence at or before the since bound", () => {
    const result = computeNextDue(
      { kind: "cron", expression: "0 * * * *", timezone: "UTC" },
      at("2026-01-15T05:30:00Z"),
      { since: at("2026-01-15T05:00:00Z") },
    );
    expect(result).toEqual({ status: "scheduled", nextDueAt: "2026-01-15T06:00:00.000Z" });
  });

  it("treats an occurrence exactly at now as due", () => {
    const result = computeNextDue(
      { kind: "cron", expression: "0 * * * *", timezone: "UTC" },
      at("2026-01-15T05:00:00Z"),
    );
    expect(result).toEqual({ status: "scheduled", nextDueAt: "2026-01-15T05:00:00.000Z" });
  });

  it("treats an occurrence in the current second as due even with milliseconds", () => {
    const result = computeNextDue(
      { kind: "cron", expression: "0 * * * *", timezone: "UTC" },
      at("2026-01-15T05:00:00.999Z"),
    );
    expect(result).toEqual({ status: "scheduled", nextDueAt: "2026-01-15T05:00:00.000Z" });
  });

  it("runs a fixed-time job once at the first occurrence of a DST fall-back hour", () => {
    // 2026-11-01 01:30 America/New_York occurs twice; croner's fixed-time policy picks the earlier (EDT, UTC-4).
    const result = computeNextDue(
      { kind: "cron", expression: "30 1 * * *", timezone: "America/New_York" },
      at("2026-11-01T00:00:00Z"),
      { since: at("2026-11-01T00:00:00Z") },
    );
    expect(result).toEqual({ status: "scheduled", nextDueAt: "2026-11-01T05:30:00.000Z" });
  });

  it("runs a fixed-time job at the first valid time after a DST spring-forward gap", () => {
    // 2026-03-08 02:30 America/New_York does not exist; croner's fixed-time policy runs at 03:00 EDT (UTC-4).
    const result = computeNextDue(
      { kind: "cron", expression: "30 2 * * *", timezone: "America/New_York" },
      at("2026-03-08T00:00:00Z"),
      { since: at("2026-03-08T00:00:00Z") },
    );
    expect(result).toEqual({ status: "scheduled", nextDueAt: "2026-03-08T07:00:00.000Z" });
  });

  it("rejects invalid cron expressions", () => {
    expect(() =>
      computeNextDue(
        { kind: "cron", expression: "not a cron", timezone: "UTC" },
        at("2026-01-15T00:00:00Z"),
      ),
    ).toThrow(ScheduleInputError);
  });

  it("rejects six-field cron expressions", () => {
    expect(() =>
      computeNextDue(
        { kind: "cron", expression: "0 0 9 * * *", timezone: "UTC" },
        at("2026-01-15T00:00:00Z"),
      ),
    ).toThrow(ScheduleInputError);
  });

  it("rejects invalid IANA timezones", () => {
    expect(() =>
      computeNextDue(
        { kind: "cron", expression: "0 9 * * *", timezone: "Mars/Olympus" },
        at("2026-01-15T00:00:00Z"),
      ),
    ).toThrow(ScheduleInputError);
  });
});

describe("computeNextDue: one-time local timestamps", () => {
  it("schedules a future one-time local timestamp as UTC", () => {
    const result = computeNextDue(
      { kind: "once", localTime: "2026-12-25T09:00:00", timezone: "America/New_York" },
      at("2026-12-01T00:00:00Z"),
    );
    expect(result).toEqual({ status: "scheduled", nextDueAt: "2026-12-25T14:00:00.000Z" });
  });

  it("converts a one-time local timestamp in a non-hour-offset timezone", () => {
    const result = computeNextDue(
      { kind: "once", localTime: "2026-01-15T09:00:00", timezone: "Asia/Kathmandu" },
      at("2026-01-01T00:00:00Z"),
    );
    expect(result).toEqual({ status: "scheduled", nextDueAt: "2026-01-15T03:15:00.000Z" });
  });

  it("dispatches a late one-time task inside the 24h catch-up window", () => {
    const result = computeNextDue(
      { kind: "once", localTime: "2026-01-10T09:00:00", timezone: "America/New_York" },
      at("2026-01-11T13:00:00Z"), // 23h late
    );
    expect(result).toEqual({ status: "scheduled", nextDueAt: "2026-01-10T14:00:00.000Z" });
  });

  it("ignores since for one-time tasks and still applies the 24h window", () => {
    const result = computeNextDue(
      { kind: "once", localTime: "2026-01-10T09:00:00", timezone: "America/New_York" },
      at("2026-01-11T13:00:00Z"),
      { since: at("2026-01-11T13:00:00Z") },
    );
    expect(result).toEqual({ status: "scheduled", nextDueAt: "2026-01-10T14:00:00.000Z" });
  });

  it("dispatches exactly at the 24h catch-up boundary", () => {
    const result = computeNextDue(
      { kind: "once", localTime: "2026-01-10T09:00:00", timezone: "America/New_York" },
      new Date(at("2026-01-10T14:00:00Z").getTime() + ONE_TIME_CATCH_UP_MS),
    );
    expect(result).toEqual({ status: "scheduled", nextDueAt: "2026-01-10T14:00:00.000Z" });
  });

  it("marks a one-time task missed after the 24h catch-up window", () => {
    const result = computeNextDue(
      { kind: "once", localTime: "2026-01-10T09:00:00", timezone: "America/New_York" },
      new Date(at("2026-01-10T14:00:00Z").getTime() + ONE_TIME_CATCH_UP_MS + 1),
    );
    expect(result).toEqual({ status: "missed" });
  });

  it("resolves a one-time local time in a DST gap to the first valid time after the gap", () => {
    const result = computeNextDue(
      { kind: "once", localTime: "2026-03-08T02:30:00", timezone: "America/New_York" },
      at("2026-03-01T00:00:00Z"),
    );
    expect(result).toEqual({ status: "scheduled", nextDueAt: "2026-03-08T07:00:00.000Z" });
  });

  it("resolves an ambiguous one-time local time to the earlier occurrence", () => {
    const result = computeNextDue(
      { kind: "once", localTime: "2026-11-01T01:30:00", timezone: "America/New_York" },
      at("2026-10-01T00:00:00Z"),
    );
    expect(result).toEqual({ status: "scheduled", nextDueAt: "2026-11-01T05:30:00.000Z" });
  });

  it("rejects a local timestamp with an explicit offset", () => {
    expect(() =>
      computeNextDue(
        { kind: "once", localTime: "2026-12-25T09:00:00Z", timezone: "America/New_York" },
        at("2026-12-01T00:00:00Z"),
      ),
    ).toThrow(ScheduleInputError);
  });
});
