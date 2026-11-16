import { Effect } from "effect";
import { z } from "zod";
import { authenticate, fromPromise, runApp } from "@/lib/server/effect";
import { parseJson } from "@/lib/server/http";
import { startApprovalRun } from "@/lib/server/runs";

const schema = z.object({ approved: z.boolean().default(true) });

export function POST(request: Request, context: { params: Promise<{ id: string; actionId: string }> }): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const { id, actionId } = yield* fromPromise(() => context.params);
    const { approved } = yield* fromPromise(() => parseJson(request, schema));
    const idempotencyKey = request.headers.get("idempotency-key") ?? `approval:${actionId}:${approved ? "approve" : "deny"}`;
    const result = yield* startApprovalRun(user.id, id, actionId, approved ? "approve" : "deny", { idempotencyKey });
    return Response.json(result, { status: result.status === "cancelled" ? 200 : 202 });
  }));
}
