import { Effect } from "effect";
import { authenticate, runApp, withStore } from "@/lib/server/effect";
import { ApiError } from "@/lib/server/http";

export function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const { id } = yield* fromParams(context.params);
    const [conversation, messages] = yield* withStore((store) => Promise.all([
      store.getConversation(user.id, id),
      store.listMessages(user.id, id),
    ]));
    if (!conversation) return yield* Effect.fail(new ApiError(404, "Conversation not found."));
    return Response.json({ conversation, messages });
  }));
}

function fromParams(params: Promise<{ id: string }>) {
  return Effect.tryPromise({ try: () => params, catch: () => new ApiError(400, "Invalid conversation ID.") });
}
