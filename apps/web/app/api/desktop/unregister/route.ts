import { Effect } from "effect";
import { z } from "zod";
import { requireDesktopUser } from "@/lib/server/desktop";
import { fromPromise, fromSync, runApp, withStore } from "@/lib/server/effect";
import { ApiError, parseJson } from "@/lib/server/http";
import type { IntegrationSecret } from "@/lib/server/mcp";

const schema = z.object({ deviceId: z.string().min(8).max(100), integrationId: z.string() });

export function POST(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* fromSync(() => requireDesktopUser(request));
    const input = yield* fromPromise(() => parseJson(request, schema));
    yield* withStore(async (store) => {
      const integration = await store.getIntegration(user.id, input.integrationId);
      const secret = await store.getSecret<IntegrationSecret>(user.id, input.integrationId);
      if (!integration || integration.kind !== "desktop" || secret?.deviceId !== input.deviceId) {
        throw new ApiError(404, "Desktop connection not found.");
      }
      await store.deleteIntegration(user.id, integration.id);
    });
    return Response.json({ ok: true });
  }));
}
