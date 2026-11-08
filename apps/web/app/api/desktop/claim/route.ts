import { Effect } from "effect";
import { z } from "zod";
import { requireDesktopUser } from "@/lib/server/desktop";
import { fromPromise, runApp, withStore } from "@/lib/server/effect";
import { ApiError, parseJson } from "@/lib/server/http";
import type { IntegrationSecret, McpToolDefinition } from "@/lib/server/mcp";

const schema = z.object({
  integrationId: z.string(),
  deviceId: z.string().min(8).max(100),
  localId: z.string().min(8).max(100),
  tools: z.array(z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(8_000),
    inputSchema: z.record(z.string(), z.unknown()),
    readOnly: z.boolean(),
  })).max(200).default([]),
  error: z.string().max(500).optional(),
});

export function POST(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* fromPromise(() => requireDesktopUser(request));
    const input = yield* fromPromise(() => parseJson(request, schema));
    const integration = yield* withStore(async (store) => {
      const current = await store.getIntegration(user.id, input.integrationId);
      if (!current || current.kind !== "desktop") throw new ApiError(404, "Desktop connection not found.");
      const secret = await store.getSecret<IntegrationSecret>(user.id, current.id);
      if (!secret?.pending) throw new ApiError(409, "Desktop connection was already claimed.");
      const tools: McpToolDefinition[] = input.tools;
      await store.setSecret(user.id, current.id, { ...secret, pending: Boolean(input.error), deviceId: input.deviceId, tools });
      await store.updateIntegration(user.id, current.id, {
        status: input.error ? "authorization_required" : "connected",
        toolCount: tools.length,
        lastError: input.error ?? null,
      });
      return current;
    });
    return Response.json({ integration });
  }));
}
