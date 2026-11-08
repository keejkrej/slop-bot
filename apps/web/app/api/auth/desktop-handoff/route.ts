import { Effect } from "effect";
import { createSessionToken } from "@/lib/server/vercel-auth";
import { authenticate, fromPromise, runApp } from "@/lib/server/effect";
import { appUrl } from "@/lib/server/http";

export function POST(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const token = yield* fromPromise(() => createSessionToken(user));
    return Response.json({ token, apiUrl: appUrl(request) });
  }));
}
