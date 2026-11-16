/**
 * Test-visible agent execution seam.
 *
 * `runGroupTurn` uses `workflowAgentFactory` (the normal `WorkflowAgent`
 * defaults). Replay/evals can call `executeAgentTurn` with a recorded
 * `AgentFactory` that returns a real `WorkflowAgentGenerateResult` shape, so
 * the decision and store-transition logic is exercised without a live model.
 */

import { WorkflowAgent } from "@ai-sdk/workflow";
import type {
  TelemetryOptions,
  WorkflowAgentOnToolExecutionEndCallback,
  WorkflowAgentOnToolExecutionStartCallback,
} from "@ai-sdk/workflow";
import { isStepCount, type ModelMessage, type ToolSet } from "ai";

export type ApprovalContentPart = {
  type: string;
  approvalId?: string;
  isAutomatic?: boolean;
  toolCall?: { toolName?: string; toolCallId?: string; input?: unknown };
};

export type AgentTurnRequest = {
  id: string;
  model: string;
  instructions: string;
  tools: ToolSet;
  messages: ModelMessage[];
  maxSteps: number;
  maxOutputTokens: number;
  toolApprovalSecretEnv?: string;
  telemetry?: TelemetryOptions;
  onToolExecutionStart?: WorkflowAgentOnToolExecutionStartCallback<ToolSet>;
  onToolExecutionEnd?: WorkflowAgentOnToolExecutionEndCallback<ToolSet>;
};

/** The subset of `WorkflowAgentGenerateResult` the turn logic consumes. */
export type AgentTurnResult = {
  text: string;
  content: ReadonlyArray<ApprovalContentPart>;
  responseMessages: ModelMessage[];
  totalUsage?: unknown;
  usage?: unknown;
  steps?: unknown[];
};

export type AgentFactory = (request: AgentTurnRequest) => Promise<AgentTurnResult>;

/** Run one agent turn through the supplied factory. */
export async function executeAgentTurn(
  request: AgentTurnRequest,
  factory: AgentFactory,
): Promise<AgentTurnResult> {
  return factory(request);
}

/** The production factory: normal `WorkflowAgent` defaults. */
export const workflowAgentFactory: AgentFactory = async (request) => {
  const agent = new WorkflowAgent({
    id: request.id,
    model: request.model,
    instructions: request.instructions,
    tools: request.tools,
    experimental_toolApprovalSecret: request.toolApprovalSecretEnv
      ? { environmentVariable: request.toolApprovalSecretEnv }
      : undefined,
    toolCallConcurrency: 1,
    telemetry: request.telemetry,
    onToolExecutionStart: request.onToolExecutionStart,
    onToolExecutionEnd: request.onToolExecutionEnd,
  });
  const result = await agent.generate({
    messages: request.messages,
    stopWhen: isStepCount(request.maxSteps),
    maxOutputTokens: request.maxOutputTokens,
  });
  return {
    text: result.text,
    content: result.content as ReadonlyArray<ApprovalContentPart>,
    responseMessages: result.responseMessages as ModelMessage[],
    totalUsage: result.totalUsage,
    usage: result.usage,
    steps: result.steps,
  };
};
