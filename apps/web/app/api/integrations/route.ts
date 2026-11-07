import { Effect } from "effect";
import { Composio } from "@composio/core";
import { createIntegrationSchema } from "@slopbot/contracts";
import { authenticate, fromPromise, runApp, withMcp, withStore } from "@/lib/server/effect";
import { ApiError, parseJson } from "@/lib/server/http";
import { validateMcpUrl, type IntegrationSecret } from "@/lib/server/mcp";

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
    let name = input.name;
    let url = input.url;
    let description = input.description;
    let secret: IntegrationSecret = {};

    if (input.kind === "github") {
      name ??= "GitHub";
      url = "https://api.githubcopilot.com/mcp/";
      description ||= "Read GitHub repositories, issues, pull requests, and code with the official remote MCP server.";
    } else if (input.kind === "composio") {
      if (!process.env.COMPOSIO_API_KEY) return yield* Effect.fail(new ApiError(400, "Add COMPOSIO_API_KEY to the server environment first."));
      name ??= "Composio";
      description ||= "Composio's user-scoped hosted MCP session for connected apps and tools.";
      const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
      const session = yield* fromPromise(() => composio.create(user.id, {
        mcp: true,
        ...(input.toolkits.length > 0 ? { toolkits: input.toolkits } : {}),
      }));
      if (!session.mcp?.url) return yield* Effect.fail(new ApiError(502, "Composio did not return an MCP session URL."));
      url = session.mcp.url;
      secret = { headers: session.mcp.headers };
    }

    if (!name || !url) return yield* Effect.fail(new ApiError(400, "A name and MCP URL are required."));
    if (input.kind === "mcp") url = yield* fromPromise(() => validateMcpUrl(url!));
    const created = yield* withStore(async (store) => {
      const integration = await store.createIntegration(user.id, { kind: input.kind, name: name!, url: url!, description, status: "error" });
      await store.setSecret(user.id, integration.id, secret);
      return integration;
    });
    const result = yield* withMcp((mcp) => mcp.probe(user.id, created.id, input.platform, request));
    return Response.json(result, { status: 201 });
  }));
}
