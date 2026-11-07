import { Effect } from "effect";
import { z } from "zod";
import { authenticate, fromPromise, runApp, withMcp } from "@/lib/server/effect";
import { parseJson } from "@/lib/server/http";

const schema = z.object({ platform: z.enum(["web", "android"]).default("web") });

export function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const [{ id }, { platform }] = yield* fromPromise(() => Promise.all([context.params, parseJson(request, schema)]));
    const result = yield* withMcp((mcp) => mcp.probe(user.id, id, platform, request));
    return Response.json(result);
  }));
}
