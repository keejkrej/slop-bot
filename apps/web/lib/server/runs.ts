import { Effect } from "effect";
import { start } from "workflow/api";
import type { RunAccepted } from "@slopbot/contracts";
import { runGroupTurn } from "@workflows/group-chat";
import { ApiError } from "./http";
import { isGatewayConfigured } from "./auth";
import { fromPromise, withStore, StoreService, type AppEffect } from "./effect";

export function startGroupRun(userId: string, conversationId: string): AppEffect<RunAccepted, StoreService> {
  return Effect.gen(function* () {
    const store = yield* StoreService;
    const conversation = yield* fromPromise(() => store.getConversation(userId, conversationId));
    if (!conversation) return yield* Effect.fail(new ApiError(404, "Conversation not found."));
    if (conversation.activeRunId || conversation.runStatus === "running") {
      return yield* Effect.fail(new ApiError(409, "This group is already responding. Wait for the round to finish."));
    }
    yield* fromPromise(() => store.setConversationRun(userId, conversationId, null, "running"));
    return yield* fromPromise(async () => {
      const run = await start(runGroupTurn, [{
        userId,
        conversationId,
        botIds: conversation.botIds,
        useGateway: isGatewayConfigured(),
      }]);
      await store.setConversationRun(userId, conversationId, run.runId, "running");
      return { runId: run.runId, status: "running" as const };
    }).pipe(
      Effect.catch((error) => Effect.gen(function* () {
        yield* fromPromise(() => store.setConversationRun(userId, conversationId, null, "failed"));
        return yield* Effect.fail(error);
      })),
    );
  });
}
