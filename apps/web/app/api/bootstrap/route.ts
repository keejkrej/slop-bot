import { Effect } from "effect";
import { isGatewayConfigured } from "@/lib/server/auth";
import { authenticate, runApp, withStore } from "@/lib/server/effect";

export function GET(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const [bots, conversations, integrations, botPreviews, unreadCounts] = yield* withStore((store) => Promise.all([
      store.listBots(user.id),
      store.listConversations(user.id),
      store.listIntegrations(user.id),
      store.listBotPreviews(user.id),
      store.readState.getUnreadCounts(user.id),
    ]));
    return Response.json({ user, bots, conversations, integrations, botPreviews, unreadCounts, agentMode: isGatewayConfigured() ? "gateway" : "demo" });
  }));
}
