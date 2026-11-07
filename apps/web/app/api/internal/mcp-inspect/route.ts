import { Effect } from "effect";
import { z } from "zod";
import { ApiError } from "@/lib/server/http";
import { fromPromise, runApp, withMcp } from "@/lib/server/effect";
import { isReadOnlyToolName } from "@/lib/server/mcp";

const schema = z.object({
  integrationId: z.string(),
  toolName: z.string().optional(),
  toolSlug: z.string().optional(),
});

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.MCP_INSPECT_TOKEN;
  if (!expected) return Response.json({ error: "Inspection is not configured." }, { status: 503 });
  if (request.headers.get("x-mcp-inspect-token") !== expected) {
    return Response.json({ error: "Not found.", configured: true, provided: Boolean(request.headers.get("x-mcp-inspect-token")) }, { status: 404 });
  }
  return runApp(Effect.gen(function* () {
    const input = yield* fromPromise(() => request.json().then((body) => schema.parse(body)));
    const integrationId = input.integrationId;
    const tools = yield* withMcp((mcp) => mcp.list(process.env.DESKTOP_USER_ID!, integrationId));
    if (!input.toolName) return Response.json({ tools });
    if (input.toolSlug && !isReadOnlyToolName(input.toolSlug)) {
      return yield* Effect.fail(new ApiError(400, "Only a read operation may be inspected."));
    }
    const args = input.toolName === "COMPOSIO_MULTI_EXECUTE_TOOL"
      ? {
          tools: [{ tool_slug: input.toolSlug, arguments: { query: "author:keejkrej is:merged merged:2026-11-07" } }],
          sync_response_to_workbench: false,
        }
      : {
          ...(input.toolSlug ? { tool_slug: input.toolSlug } : {}),
          query: "author:keejkrej is:merged merged:2026-11-07",
        };
    const result = yield* withMcp((mcp) => mcp.call(process.env.DESKTOP_USER_ID!, integrationId, input.toolName!, args));
    return Response.json({ result });
  }));
}
