import { timingSafeEqual } from "node:crypto";

export type CronAuthResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

type CronEnv = {
  CRON_SECRET?: string;
  NODE_ENV?: string;
};

function providedSecret(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (authorization) return authorization.replace(/^Bearer\s+/i, "").trim();
  return request.headers.get("x-cron-secret")?.trim() ?? "";
}

/**
 * Authorize a scheduler tick. When CRON_SECRET is configured the request must
 * present it. When it is unset, production fails closed and local development
 * is allowed so `pnpm tick` and manual ticks work without configuration.
 */
export function authorizeCronRequest(
  request: Request,
  env: CronEnv = process.env,
): CronAuthResult {
  const secret = env.CRON_SECRET?.trim();
  if (!secret) {
    if (env.NODE_ENV === "production") {
      return { ok: false, status: 500, message: "CRON_SECRET is not configured." };
    }
    return { ok: true };
  }

  const provided = providedSecret(request);
  if (!provided) return { ok: false, status: 401, message: "Missing cron secret." };

  const expected = Buffer.from(secret);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, status: 401, message: "Invalid cron secret." };
  }
  return { ok: true };
}
