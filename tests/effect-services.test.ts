import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { StoreService, normalizeError, withStore } from "../apps/web/lib/server/effect";
import { FileStore } from "../db/file-store";
import { ApiError } from "../apps/web/lib/server/http";

describe("Effect application services", () => {
  it("uses the provided storage service", async () => {
    const store = new FileStore("/tmp/does-not-read-for-this-test.json");
    const result = await Effect.runPromise(withStore((current) => current.getUser("demo-user")).pipe(Effect.provideService(StoreService, store)));
    expect(result.id).toBe("demo-user");
  });

  it("normalizes expected API errors without losing their status", () => {
    expect(normalizeError(new ApiError(409, "Busy")).status).toBe(409);
    expect(normalizeError(new Error("Failed")).status).toBe(500);
  });
});
