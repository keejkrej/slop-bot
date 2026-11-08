import { Effect } from "effect";
import { resumeHook } from "workflow/api";
import { z } from "zod";
import { requireDesktopUser } from "@/lib/server/desktop";
import { fromPromise, runApp, withStore } from "@/lib/server/effect";
import { ApiError, parseJson } from "@/lib/server/http";
import { hookToken } from "@workflows/desktop-tools";

const resultSchema = z.object({
  deviceId: z.string().min(8).max(100),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().max(1_000).optional(),
});

export function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* fromPromise(() => requireDesktopUser(request));
    const [{ id }, input] = yield* fromPromise(() => Promise.all([context.params, parseJson(request, resultSchema)]));
    yield* withStore(async (store) => {
      const job = await store.getDesktopJob(user.id, id);
      if (!job || job.deviceId !== input.deviceId) throw new ApiError(404, "Desktop job not found.");
      if (!(await store.completeDesktopJob(user.id, id, input))) throw new ApiError(409, "Desktop job was already completed.");
    });
    yield* fromPromise(() => resumeHook(hookToken(id), { ok: input.ok, output: input.output, error: input.error }));
    return Response.json({ ok: true });
  }));
}
