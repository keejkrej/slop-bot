import { createHook, sleep } from "workflow";
import { runService, withStore } from "../apps/web/lib/server/effect";
import type { IntegrationSecret } from "../apps/web/lib/server/mcp";

export type DesktopToolResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
};

export async function executeDesktopTool(input: {
  userId: string;
  integrationId: string;
  toolName: string;
  args: Record<string, unknown>;
}): Promise<unknown> {
  const job = await createDesktopJobStep(input);
  using resultHook = createHook<DesktopToolResult>({ token: hookToken(job.id) });
  const result = await Promise.race([
    resultHook,
    sleep("2m").then(() => ({ ok: false, error: "Desktop tool timed out. Open Slop Bot Desktop and try again." })),
  ]);
  if (!result.ok) {
    await expireDesktopJobStep(input.userId, job.id, result.error ?? "Desktop tool failed.");
    throw new Error(result.error ?? "Desktop tool failed.");
  }
  return "output" in result ? (result.output ?? null) : null;
}

async function createDesktopJobStep(input: {
  userId: string;
  integrationId: string;
  toolName: string;
  args: Record<string, unknown>;
}): Promise<{ id: string }> {
  "use step";
  return runService(withStore(async (store) => {
    const [integration, secret] = await Promise.all([
      store.getIntegration(input.userId, input.integrationId),
      store.getSecret<IntegrationSecret>(input.userId, input.integrationId),
    ]);
    if (!integration || integration.kind !== "desktop" || !secret?.deviceId) {
      throw new Error("Desktop connection is unavailable.");
    }
    const tool = secret.tools?.find((item) => item.name === input.toolName);
    if (!tool?.readOnly) throw new Error("Only read-only desktop MCP tools are allowed.");
    return store.createDesktopJob({ ...input, deviceId: secret.deviceId });
  }));
}

async function expireDesktopJobStep(userId: string, jobId: string, error: string): Promise<void> {
  "use step";
  return runService(withStore(async (store) => {
    await store.completeDesktopJob(userId, jobId, { ok: false, error });
  }));
}

export function hookToken(jobId: string): string {
  return `slop-bot:desktop-tool:${jobId}`;
}
