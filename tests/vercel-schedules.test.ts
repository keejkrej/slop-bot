import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const configPath = "apps/web/vercel.json";
const routePath = "apps/web/app/api/cron/tick/route.ts";

type ScheduleEntry = {
  schedule?: unknown;
  path?: unknown;
  requestMethod?: unknown;
  function?: unknown;
  topic?: unknown;
};

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
}

function isFiveFieldCron(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field) => /^[0-9*,/-]+$/.test(field));
}

describe("Vercel schedule configuration", () => {
  it("uses the current schedules object and no legacy crons array", async () => {
    const config = await readConfig();
    expect(config).not.toHaveProperty("crons");
    expect(config.schedules).toBeTypeOf("object");
    expect(config.schedules).not.toBeNull();
    expect(Array.isArray(config.schedules)).toBe(false);
  });

  it("declares the stable proactive-tick schedule as a POST path target", async () => {
    const config = await readConfig();
    const schedules = config.schedules as Record<string, ScheduleEntry>;
    expect(schedules["proactive-tick"]).toEqual({
      schedule: "*/15 * * * *",
      path: "/api/cron/tick",
      requestMethod: "POST",
    });
  });

  it("keeps every schedule entry valid and single-target", async () => {
    const config = await readConfig();
    const schedules = config.schedules as Record<string, ScheduleEntry>;
    for (const [name, entry] of Object.entries(schedules)) {
      expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/);
      expect(isFiveFieldCron(entry.schedule)).toBe(true);

      const targets = [entry.path, entry.function, entry.topic].filter(
        (target) => target !== undefined,
      );
      expect(targets).toHaveLength(1);

      if (entry.path !== undefined) {
        expect(entry.path).toMatch(/^\//);
        expect(["GET", "POST"]).toContain(entry.requestMethod ?? "POST");
      }
    }
  });

  it("targets a route that only exports POST, with no legacy GET fallback", async () => {
    const route = await readFile(routePath, "utf8");
    expect(route).toMatch(/export\s+async\s+function\s+POST\b/);
    expect(route).not.toMatch(/export\s+(async\s+)?function\s+GET\b/);
    expect(route).not.toMatch(/export\s+const\s+GET\b/);
  });
});
