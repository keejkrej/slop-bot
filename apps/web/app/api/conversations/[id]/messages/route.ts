import { Effect } from "effect";
import { sendMessageSchema } from "@slopbot/contracts";
import { authenticate, fromPromise, runApp, withStore } from "@/lib/server/effect";
import { ApiError, parseJson } from "@/lib/server/http";
import { startGroupRun } from "@/lib/server/runs";

export function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const { id } = yield* fromPromise(() => context.params);
    const { content } = yield* fromPromise(() => parseJson(request, sendMessageSchema));
    const message = yield* withStore(async (store) => {
      const conversation = await store.getConversation(user.id, id);
      if (!conversation) throw new ApiError(404, "Conversation not found.");
      if (conversation.activeRunId || conversation.runStatus === "running") throw new ApiError(409, "This group is already responding.");
      return store.addMessage(user.id, { conversationId: id, senderType: "user", senderId: user.id, content });
    });
    const run = yield* startGroupRun(user.id, id);
    return Response.json({ ...run, message }, { status: 202 });
  }));
}
