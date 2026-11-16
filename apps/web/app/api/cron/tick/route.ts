import { getStore } from "@db/store";
import { runSchedulerTick } from "@/lib/server/automations";
import { authorizeCronRequest } from "@/lib/server/cron-auth";
import { scheduledRunStarter } from "@/lib/server/scheduled-run-starter";

export async function POST(request: Request): Promise<Response> {
  const auth = authorizeCronRequest(request);
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  let limit: number | undefined;
  try {
    const body = (await request.json()) as { limit?: unknown } | null;
    if (body && typeof body.limit === "number") limit = body.limit;
  } catch {
    // An empty body is valid; the service applies a bounded default.
  }

  try {
    const result = await runSchedulerTick({
      store: getStore(),
      startScheduledRun: scheduledRunStarter,
      limit,
    });
    return Response.json(result);
  } catch (error) {
    console.error(error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Scheduler tick failed." },
      { status: 500 },
    );
  }
}
