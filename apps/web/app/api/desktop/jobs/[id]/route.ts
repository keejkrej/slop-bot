import { Effect } from "effect";
import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { z } from "zod";
import { requireDesktopUser } from "@/lib/server/desktop";
import { recordDesktopJobResult } from "@/lib/server/desktop-jobs";
import { fromPromise, runApp, withStore } from "@/lib/server/effect";
import { parseJson } from "@/lib/server/http";

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
    const outcome = yield* withStore((store) => recordDesktopJobResult({
      store,
      userId: user.id,
      jobId: id,
      result: input,
      resume: (token, payload) => resumeHook(token, payload),
      isHookMissing: (error) => HookNotFoundError.is(error),
    }));
    return Response.json(outcome.body, { status: outcome.status });
  }));
}
