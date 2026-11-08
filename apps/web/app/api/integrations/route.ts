import { Effect } from "effect";
import { createIntegrationSchema } from "@slopbot/contracts";
import { authenticate, fromPromise, runApp, withMcp, withStore } from "@/lib/server/effect";
import { ApiError, parseJson } from "@/lib/server/http";
import { validateMcpUrl, isLocalMcpUrl, type IntegrationSecret } from "@/lib/server/mcp";

export function GET(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const integrations = yield* withStore((store) => store.listIntegrations(user.id));
    return Response.json({ integrations });
  }));
}

export function POST(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const input = yield* fromPromise(() => parseJson(request, createIntegrationSchema));
    if (!input.name || !input.url) return yield* Effect.fail(new ApiError(400, "A name and MCP URL are required."));
    if (Boolean(input.headerName) !== Boolean(input.headerValue)) {
      return yield* Effect.fail(new ApiError(400, "Provide both a header name and value, or leave both empty."));
    }
    const local = isLocalMcpUrl(input.url);
    const url = local ? input.url : yield* fromPromise(() => validateMcpUrl(input.url!));
    const secret: IntegrationSecret = input.headerName && input.headerValue
      ? { headers: { [input.headerName]: input.headerValue } }
      : {};
    const created = yield* withStore(async (store) => {
      const integration = await store.createIntegration(user.id, {
        kind: local ? "desktop" : "mcp",
        name: input.name!,
        url,
        description: input.description,
        status: local ? "authorization_required" : "error",
        lastError: local ? "Waiting for Slop Bot Desktop on this computer." : null,
      });
      await store.setSecret(user.id, integration.id, { ...secret, ...(local ? { pending: true, tools: [] } : {}) });
      return integration;
    });
    if (local) return Response.json({ integration: created, authorizationUrl: null }, { status: 202 });
    const result = yield* withMcp((mcp) => mcp.probe(user.id, created.id, input.platform, request));
    return Response.json(result, { status: 201 });
  }));
}
