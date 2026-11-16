import { Effect } from "effect";
import { authenticate, runApp, withStore } from "@/lib/server/effect";
import { listTraceEvents } from "@/lib/server/run-telemetry";

/**
 * Own-user run detail. Returns only the run projection and typed, sanitized
 * trace events. Model messages, tool bodies, and other users' context are
 * never exposed.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await context.params;
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const run = yield* withStore((store) => store.runs.getRun(user.id, runId));
    if (!run) return Response.json({ error: "Run not found." }, { status: 404 });
    const traces = yield* withStore((store) => listTraceEvents(store, user.id, runId));
    return Response.json({
      run: {
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
      },
      traces,
    });
  }));
}
