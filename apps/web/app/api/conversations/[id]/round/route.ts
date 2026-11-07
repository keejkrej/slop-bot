import { Effect } from "effect";
import { authenticate, fromPromise, runApp } from "@/lib/server/effect";
import { startGroupRun } from "@/lib/server/runs";

export function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const { id } = yield* fromPromise(() => context.params);
    const run = yield* startGroupRun(user.id, id);
    return Response.json(run, { status: 202 });
  }));
}
