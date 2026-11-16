import { Effect } from "effect";
import { authenticate, fromPromise, runApp } from "@/lib/server/effect";
import { startScheduledRun } from "@/lib/server/runs";

const ROUND_PROMPT =
  "The human opened this chat. Introduce yourself briefly and invite them to share what they need help with.";

export function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const { id } = yield* fromPromise(() => context.params);
    const result = yield* startScheduledRun(user.id, id, {
      automationId: "round",
      occurrenceAt: new Date().toISOString(),
      prompt: ROUND_PROMPT,
    });
    return Response.json(result, { status: 202 });
  }));
}
