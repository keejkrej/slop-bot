import { Effect } from "effect";
import { requireDesktopUser } from "@/lib/server/desktop";
import { fromPromise, runApp, withStore } from "@/lib/server/effect";

export function GET(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* fromPromise(() => requireDesktopUser(request));
    const connections = yield* withStore((store) => store.listPendingDesktopConnections(user.id));
    return Response.json({ connections });
  }));
}
