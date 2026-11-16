import { Effect } from "effect";
import { authenticate, runApp, withStore } from "@/lib/server/effect";
import { getMemoryFileForUser } from "@/lib/server/memory";

/** GET /api/memory/file?conversationId=...&botId=...&path=... */
export function GET(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId") ?? "";
    const botId = url.searchParams.get("botId") ?? "";
    const path = url.searchParams.get("path") ?? "";
    const file = yield* withStore((store) =>
      getMemoryFileForUser(store, user.id, conversationId, botId, path),
    );
    return Response.json({ file });
  }));
}
