import { Effect } from "effect";
import { sendMessageSchema } from "@slopbot/contracts";
import { authenticate, fromPromise, runApp } from "@/lib/server/effect";
import { parseJson } from "@/lib/server/http";
import { startMessageRun } from "@/lib/server/runs";

export function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const { id } = yield* fromPromise(() => context.params);
    const { content } = yield* fromPromise(() => parseJson(request, sendMessageSchema));
    const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;
    const result = yield* startMessageRun(user.id, id, content, { idempotencyKey });
    return Response.json(result, { status: 202 });
  }));
}
