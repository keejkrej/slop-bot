import { Effect } from "effect";
import { markReadSchema } from "@slopbot/contracts";
import { authenticate, fromPromise, runApp, withStore } from "@/lib/server/effect";
import { ApiError, parseJson } from "@/lib/server/http";

export function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const { id } = yield* fromPromise(() => context.params);
    const body = yield* fromPromise(() => parseJson(request, markReadSchema));
    const state = yield* withStore((store) => store.readState.markRead(user.id, id, body.messageId ?? null)).pipe(
      Effect.catchIf(
        (error) => error.message === "Message not found.",
        () => Effect.fail(new ApiError(404, "Message not found.")),
      ),
    );
    if (!state) return yield* Effect.fail(new ApiError(404, "Conversation not found."));
    return Response.json(state);
  }));
}
