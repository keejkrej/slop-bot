import { Effect } from "effect";
import { authenticate, fromPromise, runApp, withStore } from "@/lib/server/effect";
import { ApiError } from "@/lib/server/http";

export function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const { id } = yield* fromPromise(() => context.params);
    yield* withStore(async (store) => {
      if (!(await store.getIntegration(user.id, id))) throw new ApiError(404, "Connection not found.");
      await store.deleteIntegration(user.id, id);
    });
    return Response.json({ ok: true });
  }));
}
