import { Effect } from "effect";
import { z } from "zod";
import { requireDesktopUser } from "@/lib/server/desktop";
import { fromSync, runApp, withStore } from "@/lib/server/effect";

const querySchema = z.object({ deviceId: z.string().min(8).max(100) });

export function GET(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* fromSync(() => requireDesktopUser(request));
    const { deviceId } = yield* fromSync(() => querySchema.parse(Object.fromEntries(new URL(request.url).searchParams)));
    const jobs = yield* withStore((store) => store.listPendingDesktopJobs(user.id, deviceId));
    return Response.json({ jobs });
  }));
}
