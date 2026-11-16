import { Effect } from "effect";
import { authenticate, runApp, withStore } from "@/lib/server/effect";
import { exportMemoryForUser } from "@/lib/server/memory";

/** GET /api/memory/export?conversationId=...&botId=... */
export function GET(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId") ?? "";
    const botId = url.searchParams.get("botId") ?? "";
    const snapshot = yield* withStore((store) =>
      exportMemoryForUser(store, user.id, conversationId, botId),
    );
    return Response.json({
      scope: { conversationId, botId },
      files: snapshot.files,
      count: snapshot.count,
      totalChars: snapshot.totalChars,
    });
  }));
}
