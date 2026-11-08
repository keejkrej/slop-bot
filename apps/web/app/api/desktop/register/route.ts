import { Effect } from "effect";
import { z } from "zod";
import { requireDesktopUser } from "@/lib/server/desktop";
import { fromPromise, runApp, withStore } from "@/lib/server/effect";
import { ApiError, parseJson } from "@/lib/server/http";
import type { IntegrationSecret, McpToolDefinition } from "@/lib/server/mcp";

const toolSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(8_000),
  inputSchema: z.record(z.string(), z.unknown()),
  readOnly: z.boolean(),
});
const schema = z.object({
  deviceId: z.string().min(8).max(100),
  servers: z.array(z.object({
    localId: z.string().min(8).max(100),
    integrationId: z.string().optional(),
    name: z.string().min(2).max(60),
    url: z.string().max(2_048),
    tools: z.array(toolSchema).max(200),
  })).max(20),
});

export function POST(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* fromPromise(() => requireDesktopUser(request));
    const input = yield* fromPromise(() => parseJson(request, schema));
    const registrations = yield* withStore(async (store) => {
      const result = [];
      for (const server of input.servers) {
        const endpoint = new URL(server.url);
        if (!["http:", "https:"].includes(endpoint.protocol)) throw new ApiError(400, "Desktop MCP URLs must use HTTP or HTTPS.");
        const tools: McpToolDefinition[] = server.tools;
        const existing = server.integrationId ? await store.getIntegration(user.id, server.integrationId) : null;
        if (existing && existing.kind !== "desktop") throw new ApiError(409, "A cloud connection cannot become a desktop connection.");
        if (existing) {
          const previous = await store.getSecret<IntegrationSecret>(user.id, existing.id);
          if (previous?.deviceId !== input.deviceId) throw new ApiError(409, "This desktop connection belongs to another device.");
        }
        const integration = existing ?? await store.createIntegration(user.id, {
          kind: "desktop",
          name: server.name,
          url: `desktop://${input.deviceId}/${server.localId}`,
          description: `Local MCP on this computer: ${server.name}. Tool calls travel through the authenticated desktop bridge.`,
          status: "connected",
        });
        await store.setSecret(user.id, integration.id, { deviceId: input.deviceId, tools } satisfies IntegrationSecret);
        await store.updateIntegration(user.id, integration.id, { status: "connected", toolCount: tools.length, lastError: null });
        result.push({ localId: server.localId, integrationId: integration.id });
      }
      return result;
    });
    return Response.json({ registrations });
  }));
}
