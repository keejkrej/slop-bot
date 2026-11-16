import { createHash } from "node:crypto";
import { createHook, getStepMetadata, getWorkflowMetadata, sleep } from "workflow";
import { runService, withStore } from "../apps/web/lib/server/effect";
import type { IntegrationSecret } from "../apps/web/lib/server/mcp";

export type DesktopToolResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
};

/**
 * Optional identity supplied by the workflow caller. `runId` is the logical
 * persisted run id; `attempt` is the persisted workflow attempt. When omitted
 * the workflow run id and step id still give a stable per-attempt identity.
 */
export type DesktopToolExecutionContext = {
  runId?: string;
  attempt?: number;
};

type DesktopJobIdentity = {
  jobId: string;
  runId: string | null;
  stepKey: string;
  attempt: number;
};

export async function executeDesktopTool(input: {
  userId: string;
  integrationId: string;
  toolName: string;
  args: Record<string, unknown>;
  executionContext?: DesktopToolExecutionContext;
}): Promise<unknown> {
  const identity = await resolveDesktopJobIdentityStep(input);
  using resultHook = createHook<DesktopToolResult>({
    token: hookTokenForIdentity(identity.runId, identity.stepKey),
  });
  // Register the hook before the job becomes visible to the desktop bridge so a
  // fast result can never arrive before the workflow is waiting for it.
  const conflict = await resultHook.getConflict();
  if (conflict) throw new Error("Desktop tool result hook is already owned by another run.");
  const job = await createDesktopJobStep({ ...input, identity });
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

async function resolveDesktopJobIdentityStep(input: {
  userId: string;
  integrationId: string;
  toolName: string;
  args: Record<string, unknown>;
  executionContext?: DesktopToolExecutionContext;
}): Promise<DesktopJobIdentity> {
  "use step";
  const { stepId } = getStepMetadata();
  const { workflowRunId } = getWorkflowMetadata();
  const runId = input.executionContext?.runId ?? null;
  const attempt = input.executionContext?.attempt ?? 0;
  const stepKey = `${workflowRunId}:${stepId}`;
  const digest = createHash("sha256").update(`${runId ?? ""}:${stepKey}`).digest("hex").slice(0, 32);
  return { jobId: `desktop_job_${digest}`, runId, stepKey, attempt };
}

async function createDesktopJobStep(input: {
  userId: string;
  integrationId: string;
  toolName: string;
  args: Record<string, unknown>;
  identity: DesktopJobIdentity;
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
    const job = await store.createDesktopJob({
      id: input.identity.jobId,
      userId: input.userId,
      deviceId: secret.deviceId,
      integrationId: input.integrationId,
      toolName: input.toolName,
      args: input.args,
      runId: input.identity.runId,
      stepKey: input.identity.stepKey,
      attempt: input.identity.attempt,
    });
    return { id: job.id };
  }));
}

async function expireDesktopJobStep(userId: string, jobId: string, error: string): Promise<void> {
  "use step";
  return runService(withStore(async (store) => {
    await store.completeDesktopJob(userId, jobId, { ok: false, error: error.slice(0, 1_000) });
  }));
}

export function hookToken(jobId: string): string {
  return `slop-bot:desktop-tool:${jobId}`;
}

/**
 * Hook token derived from the stable workflow-step identity rather than the
 * job row id, so a retry that reuses an existing job still resumes the same
 * hook.
 */
export function hookTokenForIdentity(runId: string | null, stepKey: string): string {
  return hookToken(runId ? `run:${runId}:${stepKey}` : `step:${stepKey}`);
}

export function hookTokenForJob(job: {
  id: string;
  runId: string | null;
  stepKey: string | null;
}): string {
  return job.stepKey ? hookTokenForIdentity(job.runId, job.stepKey) : hookToken(job.id);
}
