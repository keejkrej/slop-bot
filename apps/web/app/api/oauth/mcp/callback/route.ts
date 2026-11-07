import { Effect } from "effect";
import { runApp, fromPromise, withMcp, withStore } from "@/lib/server/effect";
import { ApiError } from "@/lib/server/http";

function redirect(platform: "web" | "android", status: string): Response {
  const target = platform === "android" ? `slopbot://integrations?status=${status}` : `/?view=connections&status=${status}`;
  return Response.redirect(target, 302);
}

export function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  const code = params.get("code");
  return runApp(Effect.gen(function* () {
    if (!state) return yield* Effect.fail(new ApiError(400, "Missing OAuth state."));
    if (params.get("error") || !code) {
      const pending = yield* withStore((store) => store.getOAuthState(state));
      return redirect(pending?.platform ?? "web", "denied");
    }
    const result = yield* withMcp((mcp) => mcp.completeOAuth(state, code, request));
    return redirect(result.platform, result.integration.status === "connected" ? "connected" : "incomplete");
  }).pipe(Effect.catch((error) => Effect.gen(function* () {
    console.error("MCP OAuth callback failed", error);
    if (!state) return yield* Effect.fail(error);
    const pending = yield* withStore((store) => store.getOAuthState(state));
    return redirect(pending?.platform ?? "web", "error");
  }))));
}
