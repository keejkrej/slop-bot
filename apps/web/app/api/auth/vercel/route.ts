import { Effect } from "effect";
import { fromPromise, runApp } from "@/lib/server/effect";
import { startVercelSignIn } from "@/lib/server/vercel-auth";

export function GET(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const platform = new URL(request.url).searchParams.get("platform") === "android" ? "android" : "web";
    const authorizationUrl = yield* fromPromise(() => startVercelSignIn(request, platform));
    return platform === "android" ? Response.json({ authorizationUrl }) : Response.redirect(authorizationUrl, 302);
  }));
}
