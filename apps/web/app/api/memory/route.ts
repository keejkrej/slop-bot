import { Effect } from "effect";
import { authenticate, runApp, withStore } from "@/lib/server/effect";
import { listMemoryDirectoryForUser } from "@/lib/server/memory";

/**
 * GET /api/memory?conversationId=...&botId=...
 *
 * With a scope, returns that conversation's directory plus global
 * instructions. Without a scope, returns global instructions and the user's
 * permitted conversation scopes.
 */
export function GET(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId") ?? undefined;
    const botId = url.searchParams.get("botId") ?? undefined;
    const memory = yield* withStore((store) =>
      listMemoryDirectoryForUser(store, user.id, conversationId, botId),
    );
    return Response.json(memory);
  }));
}
