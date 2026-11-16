import { Effect } from "effect";
import {
  updateIntegrationPolicySchema,
  type IntegrationToolSummary,
} from "@slopbot/contracts";
import { authenticate, fromPromise, runApp, withMcp, withStore } from "@/lib/server/effect";
import { ApiError, parseJson } from "@/lib/server/http";
import type { McpToolDefinition } from "@/lib/server/mcp";
import {
  classifyToolRisk,
  summarizeToolPermissions,
  validateWriteToolGrants,
} from "@/lib/server/tool-permissions";

type Listing = { tools: McpToolDefinition[]; available: boolean };

function riskOf(tool: McpToolDefinition) {
  return tool.risk ?? classifyToolRisk({ name: tool.name, readOnly: tool.readOnly });
}

function summarize(tools: McpToolDefinition[], allowedWriteTools: string[]): IntegrationToolSummary[] {
  return summarizeToolPermissions(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      risk: riskOf(tool),
    })),
    allowedWriteTools,
  );
}

export function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const { id } = yield* fromPromise(() => context.params);
    const integration = yield* withStore((store) => store.getIntegration(user.id, id));
    if (!integration) return yield* Effect.fail(new ApiError(404, "Connection not found."));

    const listing: Listing = integration.status === "connected"
      ? yield* withMcp(async (mcp) => {
          try {
            return { tools: await mcp.list(user.id, id), available: true };
          } catch {
            return { tools: [], available: false };
          }
        })
      : { tools: [], available: false };

    return Response.json({
      integrationId: id,
      tools: summarize(listing.tools, integration.allowedWriteTools),
      listingAvailable: listing.available,
    });
  }));
}

export function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const [{ id }, input] = yield* fromPromise(() => Promise.all([
      context.params,
      parseJson(request, updateIntegrationPolicySchema),
    ]));
    const integration = yield* withStore((store) => store.getIntegration(user.id, id));
    if (!integration) return yield* Effect.fail(new ApiError(404, "Connection not found."));
    if (integration.status !== "connected") {
      return yield* Effect.fail(new ApiError(409, "Connect this provider before configuring permissions."));
    }

    const listing: Listing = yield* withMcp(async (mcp) => {
      try {
        return { tools: await mcp.list(user.id, id), available: true };
      } catch {
        return { tools: [], available: false };
      }
    });
    if (!listing.available) {
      return yield* Effect.fail(new ApiError(409, "Could not read the provider's tool list. Try again."));
    }

    let allowedWriteTools: string[];
    try {
      allowedWriteTools = validateWriteToolGrants(
        input.allowedWriteTools,
        listing.tools.map((tool) => ({ name: tool.name, risk: riskOf(tool) })),
      );
    } catch (error) {
      return yield* Effect.fail(new ApiError(400, error instanceof Error ? error.message : "Invalid tool allowlist."));
    }

    yield* withStore((store) => store.updateIntegration(user.id, id, { allowedWriteTools }));
    return Response.json({
      integrationId: id,
      tools: summarize(listing.tools, allowedWriteTools),
      listingAvailable: true,
    });
  }));
}
