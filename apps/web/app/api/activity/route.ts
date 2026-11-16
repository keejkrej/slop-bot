import { Effect } from "effect";
import { authenticate, runApp, withStore } from "@/lib/server/effect";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function parseLimit(value: string | null): number {
  if (value === null) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

export function GET(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const limit = parseLimit(new URL(request.url).searchParams.get("limit"));
    const runs = yield* withStore((store) => store.runs.listRuns({ userId: user.id, limit }));
    return Response.json({
      runs: runs.map((run) => ({
        id: run.id,
        conversationId: run.conversationId,
        botId: run.botId,
        status: run.status,
        trigger: run.trigger,
        outputMessageId: run.outputMessageId,
        workflowRunId: run.workflowRunId,
        error: run.error,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      })),
    });
  }));
}
