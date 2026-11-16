import { Effect } from "effect";
import { authenticate, fromPromise, runApp, withStore } from "@/lib/server/effect";
import { runAutomationNow } from "@/lib/server/automations";
import { scheduledRunStarter } from "@/lib/server/scheduled-run-starter";

export function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const { id } = yield* fromPromise(() => context.params);
    const requestId = request.headers.get("idempotency-key")?.trim() || crypto.randomUUID();
    const result = yield* withStore((store) =>
      runAutomationNow(store, user.id, id, requestId, scheduledRunStarter),
    );
    // Busy and failed are normal outcomes the client renders; only a missing
    // task (404) or an unexpected error is a non-2xx response.
    return Response.json(result, { status: result.outcome === "started" ? 202 : 200 });
  }));
}
