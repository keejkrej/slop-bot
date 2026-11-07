import { Effect } from "effect";
import { createConversationSchema } from "@slopbot/contracts";
import { authenticate, fromPromise, runApp, withStore } from "@/lib/server/effect";
import { ApiError, parseJson } from "@/lib/server/http";

export function GET(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const conversations = yield* withStore((store) => store.listConversations(user.id));
    return Response.json({ conversations });
  }));
}

export function POST(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const input = yield* fromPromise(() => parseJson(request, createConversationSchema));
    const conversation = yield* withStore(async (store) => {
      const botIds = [...new Set(input.botIds)];
      const ownedBots = await Promise.all(botIds.map((id) => store.getBot(user.id, id)));
      if (ownedBots.some((bot) => !bot)) throw new ApiError(400, "Every participant must be one of your bots.");
      return store.createConversation(user.id, { ...input, botIds });
    });
    return Response.json({ conversation }, { status: 201 });
  }));
}
