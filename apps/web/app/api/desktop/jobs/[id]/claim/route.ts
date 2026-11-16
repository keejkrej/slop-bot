import { Effect } from "effect";
import { z } from "zod";
import { requireDesktopUser } from "@/lib/server/desktop";
import { fromPromise, runApp, withStore } from "@/lib/server/effect";
import { ApiError, parseJson } from "@/lib/server/http";

const schema = z.object({ deviceId: z.string().min(8).max(100) });

/** Lease long enough for one local MCP call, short enough to recover a crash. */
const LEASE_MS = 90_000;

export function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* fromPromise(() => requireDesktopUser(request));
    const [{ id }, input] = yield* fromPromise(() => Promise.all([context.params, parseJson(request, schema)]));
    const job = yield* withStore((store) => store.claimDesktopJob({
      userId: user.id,
      jobId: id,
      deviceId: input.deviceId,
      leaseMs: LEASE_MS,
    }));
    if (!job) throw new ApiError(409, "Desktop job is already claimed or completed.");
    return Response.json({ job });
  }));
}
