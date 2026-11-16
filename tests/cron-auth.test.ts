import { describe, expect, it } from "vitest";
import { authorizeCronRequest } from "../apps/web/lib/server/cron-auth";

function request(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/cron/tick", { method: "POST", headers });
}

describe("cron authorization", () => {
  it("rejects a missing or wrong secret when CRON_SECRET is configured", () => {
    const env = { CRON_SECRET: "super-secret", NODE_ENV: "production" };
    expect(authorizeCronRequest(request(), env)).toMatchObject({ ok: false, status: 401 });
    expect(
      authorizeCronRequest(request({ authorization: "Bearer wrong" }), env),
    ).toMatchObject({ ok: false, status: 401 });
  });

  it("accepts the configured secret as a bearer token or header", () => {
    const env = { CRON_SECRET: "super-secret", NODE_ENV: "production" };
    expect(authorizeCronRequest(request({ authorization: "Bearer super-secret" }), env)).toEqual({
      ok: true,
    });
    expect(authorizeCronRequest(request({ "x-cron-secret": "super-secret" }), env)).toEqual({
      ok: true,
    });
  });

  it("fails closed in production when CRON_SECRET is unset", () => {
    expect(authorizeCronRequest(request(), { NODE_ENV: "production" })).toMatchObject({
      ok: false,
      status: 500,
    });
  });

  it("allows local ticks when CRON_SECRET is unset", () => {
    expect(authorizeCronRequest(request(), { NODE_ENV: "development" })).toEqual({ ok: true });
  });
});
