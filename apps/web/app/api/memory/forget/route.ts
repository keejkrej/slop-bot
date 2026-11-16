import { Effect } from "effect";
import { forgetMemorySchema } from "@slopbot/contracts";
import { authenticate, fromPromise, runApp, withStore } from "@/lib/server/effect";
import { parseJson } from "@/lib/server/http";
import { forgetMemoryForUser } from "@/lib/server/memory";

/** POST /api/memory/forget — explicit, path-scoped deletion. */
export function POST(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const input = yield* fromPromise(() => parseJson(request, forgetMemorySchema));
    const deleted = yield* withStore((store) =>
      forgetMemoryForUser(store, user.id, input.conversationId, input.botId, input.paths),
    );
    return Response.json({ deleted });
  }));
}
