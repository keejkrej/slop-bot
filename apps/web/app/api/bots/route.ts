import { Effect } from "effect";
import { createBotSchema } from "@slopbot/contracts";
import { authenticate, fromPromise, runApp, withStore } from "@/lib/server/effect";
import { ApiError, parseJson } from "@/lib/server/http";

export function GET(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const bots = yield* withStore((store) => store.listBots(user.id));
    return Response.json({ bots });
  }));
}

export function POST(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const input = yield* fromPromise(() => parseJson(request, createBotSchema));
    const { bot, conversation } = yield* withStore(async (store) => {
      for (const integrationId of new Set(input.integrationIds)) {
        if (!(await store.getIntegration(user.id, integrationId))) throw new ApiError(400, "A selected connection no longer exists.");
      }
      const bot = await store.createBot(user.id, { ...input, integrationIds: [...new Set(input.integrationIds)] });
      const conversation = await store.createConversation(user.id, { title: bot.name, botIds: [bot.id] });
      return { bot, conversation };
    });
    return Response.json({ bot, conversation }, { status: 201 });
  }));
}
