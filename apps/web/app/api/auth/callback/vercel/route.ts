import { Effect } from "effect";
import { fromPromise, runApp } from "@/lib/server/effect";
import { finishVercelSignIn, sessionCookie } from "@/lib/server/vercel-auth";
import { absoluteAppUrl } from "@/lib/server/http";

export function GET(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const result = yield* fromPromise(() => finishVercelSignIn(request));
    if (result.platform === "android") {
      return Response.redirect(`slopbot://auth?token=${encodeURIComponent(result.token)}`, 302);
    }
    return new Response(null, {
      status: 302,
      headers: { location: absoluteAppUrl(request, "/"), "set-cookie": sessionCookie(result.token) },
    });
  }));
}
