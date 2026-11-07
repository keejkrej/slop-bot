import { Effect } from "effect";
import { z } from "zod";
import { authenticate, fromPromise, runApp, withStore } from "@/lib/server/effect";
import { ApiError, parseJson } from "@/lib/server/http";
import { startGroupRun } from "@/lib/server/runs";

const schema = z.object({ approved: z.boolean().default(true) });

export function POST(request: Request, context: { params: Promise<{ id: string; actionId: string }> }): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const { id, actionId } = yield* fromPromise(() => context.params);
    const { approved } = yield* fromPromise(() => parseJson(request, schema));
    const action = yield* withStore((store) => store.getPendingAction(user.id, actionId));
    if (!action || action.conversationId !== id || action.status !== "pending") {
      return yield* Effect.fail(new ApiError(404, "Approval not found or already completed."));
    }
    if (!approved) {
      yield* withStore(async (store) => {
        await store.setPendingActionStatus(user.id, actionId, "cancelled");
        await store.addMessage(user.id, {
          conversationId: id,
          senderType: "system",
          senderId: actionId,
          content: "Email send denied by the user.",
        });
      });
      return Response.json({ ok: true, status: "cancelled" });
    }
    const run = yield* startGroupRun(user.id, id, { resumeActionId: actionId });
    return Response.json(run, { status: 202 });
  }));
}
