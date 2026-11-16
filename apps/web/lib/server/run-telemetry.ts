/**
 * Typed, sanitized run telemetry.
 *
 * Trace events are stored through the existing `RunStore.appendEvent` seam so
 * they share the run's durable event log and natural dedupe. The envelope is an
 * allowlist: only bounded, non-secret lifecycle metadata is persisted. Raw
 * model transcripts, chain-of-thought, MCP request/result bodies, tool inputs
 * and outputs, and credentials never enter a trace event.
 */

import type { RunEvent } from "@slopbot/contracts";
import type { AppStore } from "@db/types";
import { redactSensitiveText } from "./portable-redact";

export const TRACE_EVENT_PREFIX = "trace.";

export type TraceCategory = "run" | "model" | "tool" | "approval";
export type TracePhase = "start" | "end";
export type TraceStatus = "ok" | "error" | "blocked" | "pending" | "skipped";
export type TraceOutcome = "reply" | "silent" | "suppressed" | "approval" | "failed";
export type TraceErrorKind =
  | "tool_error"
  | "permission_denied"
  | "timeout"
  | "model_error"
  | "internal";

export type TraceUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type TraceError = {
  kind: TraceErrorKind;
  message: string;
};

/** The only fields a trace event may carry. Everything else is dropped. */
export type TraceEventData = {
  category: TraceCategory;
  phase: TracePhase;
  status?: TraceStatus;
  outcome?: TraceOutcome;
  toolName?: string;
  /** Nonsecret integration reference (the store id), never a URL or token. */
  integrationId?: string;
  toolCallId?: string;
  model?: string;
  durationMs?: number;
  usage?: TraceUsage;
  error?: TraceError;
  approvalId?: string;
  stepNumber?: number;
  attempt?: number;
};

export type TraceEventRecord = TraceEventData & {
  seq: number;
  type: string;
  at: string;
};

const MAX_STRING = 200;
const MAX_TOOL_NAME = 80;
const MAX_ID = 120;
const MAX_MODEL = 120;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_DEPTH = 4;
const MAX_ITEMS = 20;
const MAX_KEYS = 20;

const CATEGORIES = new Set<TraceCategory>(["run", "model", "tool", "approval"]);
const PHASES = new Set<TracePhase>(["start", "end"]);
const STATUSES = new Set<TraceStatus>(["ok", "error", "blocked", "pending", "skipped"]);
const OUTCOMES = new Set<TraceOutcome>(["reply", "silent", "suppressed", "approval", "failed"]);
const ERROR_KINDS = new Set<TraceErrorKind>([
  "tool_error",
  "permission_denied",
  "timeout",
  "model_error",
  "internal",
]);

/**
 * Keys that must never be copied into a trace payload. This is deliberately
 * broad: a custom nested payload fails closed rather than leaking a prompt,
 * tool body, or credential.
 */
const SENSITIVE_KEY =
  /(?:api[_-]?key|secret|token|password|passwd|authorization|(?:^|[_-])auth(?:$|[_-])|cookie|credential|private[_-]?key|access[_-]?key|client[_-]?secret|session[_-]?id|refresh[_-]?token|prompt|messages|content|body|args|input|output|result)/i;

/** Redact high-confidence secret shapes and bound the result. */
export function redactTraceText(value: string): string {
  return redactSensitiveText(value).slice(0, MAX_STRING);
}

/**
 * Bounded, fail-closed sanitizer for arbitrary custom metadata. Sensitive keys
 * are redacted, depth/collection sizes are capped, and unsupported values are
 * replaced rather than serialized.
 */
export function sanitizeTraceData(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[Truncated: max depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactTraceText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString().slice(0, MAX_STRING);
  if (typeof value === "function" || typeof value === "symbol") return "[Unsupported]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => sanitizeTraceData(item, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`[Truncated: ${value.length - MAX_ITEMS} more items]`);
    return items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [key, child] of entries.slice(0, MAX_KEYS)) {
      result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeTraceData(child, depth + 1);
    }
    if (entries.length > MAX_KEYS) result.__truncated = `${entries.length - MAX_KEYS} more keys`;
    return result;
  }
  return "[Unsupported]";
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = redactTraceText(value).trim();
  return text ? text.slice(0, max) : undefined;
}

function boundedNumber(value: unknown, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.floor(value), max);
}

function sanitizeUsage(value: unknown): TraceUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const usage: TraceUsage = {};
  const input = boundedNumber(record.inputTokens, Number.MAX_SAFE_INTEGER);
  const output = boundedNumber(record.outputTokens, Number.MAX_SAFE_INTEGER);
  const total = boundedNumber(record.totalTokens, Number.MAX_SAFE_INTEGER);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (total !== undefined) usage.totalTokens = total;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function sanitizeError(value: unknown): TraceError | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const kind =
    typeof record.kind === "string" && ERROR_KINDS.has(record.kind as TraceErrorKind)
      ? (record.kind as TraceErrorKind)
      : "internal";
  const message = boundedString(record.message, MAX_STRING) ?? "Trace error.";
  return { kind, message };
}

/**
 * Validate and sanitize one trace envelope. Unknown fields are ignored and an
 * invalid category/phase fails closed (returns null).
 */
export function sanitizeTraceEvent(value: unknown): TraceEventData | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const category =
    typeof record.category === "string" && CATEGORIES.has(record.category as TraceCategory)
      ? (record.category as TraceCategory)
      : null;
  const phase =
    typeof record.phase === "string" && PHASES.has(record.phase as TracePhase)
      ? (record.phase as TracePhase)
      : null;
  if (!category || !phase) return null;

  const data: TraceEventData = { category, phase };
  const status =
    typeof record.status === "string" && STATUSES.has(record.status as TraceStatus)
      ? (record.status as TraceStatus)
      : undefined;
  if (status) data.status = status;
  const outcome =
    typeof record.outcome === "string" && OUTCOMES.has(record.outcome as TraceOutcome)
      ? (record.outcome as TraceOutcome)
      : undefined;
  if (outcome) data.outcome = outcome;
  const toolName = boundedString(record.toolName, MAX_TOOL_NAME);
  if (toolName) data.toolName = toolName;
  const integrationId = boundedString(record.integrationId, MAX_ID);
  if (integrationId) data.integrationId = integrationId;
  const toolCallId = boundedString(record.toolCallId, MAX_ID);
  if (toolCallId) data.toolCallId = toolCallId;
  const model = boundedString(record.model, MAX_MODEL);
  if (model) data.model = model;
  const durationMs = boundedNumber(record.durationMs, MAX_DURATION_MS);
  if (durationMs !== undefined) data.durationMs = durationMs;
  const usage = sanitizeUsage(record.usage);
  if (usage) data.usage = usage;
  const error = sanitizeError(record.error);
  if (error) data.error = error;
  const approvalId = boundedString(record.approvalId, MAX_ID);
  if (approvalId) data.approvalId = approvalId;
  const stepNumber = boundedNumber(record.stepNumber, Number.MAX_SAFE_INTEGER);
  if (stepNumber !== undefined) data.stepNumber = stepNumber;
  const attempt = boundedNumber(record.attempt, Number.MAX_SAFE_INTEGER);
  if (attempt !== undefined) data.attempt = attempt;
  return data;
}

export function traceEventType(category: TraceCategory, phase: TracePhase): string {
  return `${TRACE_EVENT_PREFIX}${category}.${phase}`;
}

export function isTraceEventType(type: string): boolean {
  return type.startsWith(TRACE_EVENT_PREFIX);
}

/**
 * Natural dedupe key per run + span/tool-call. The store scopes events by run,
 * so the identity only needs the span identity.
 */
export function traceDedupeKey(data: TraceEventData): string {
  const identity =
    data.category === "tool"
      ? data.toolCallId ?? data.toolName ?? "unknown"
      : data.category === "approval"
        ? data.approvalId ?? "unknown"
        : data.category === "model"
          ? String(data.stepNumber ?? 0)
          : String(data.attempt ?? 0);
  return `trace:${data.category}:${data.phase}:${identity}`;
}

export function buildTraceEvent(
  input: unknown,
): { type: string; data: TraceEventData } | null {
  const data = sanitizeTraceEvent(input);
  if (!data) return null;
  return { type: traceEventType(data.category, data.phase), data };
}

/** Append one sanitized trace event through the existing run event seam. */
export async function appendTraceEvent(
  store: AppStore,
  input: { userId: string; runId: string; event: unknown },
): Promise<RunEvent | null> {
  const built = buildTraceEvent(input.event);
  if (!built) return null;
  return store.runs.appendEvent({
    userId: input.userId,
    runId: input.runId,
    type: built.type,
    data: built.data,
    dedupeKey: traceDedupeKey(built.data),
  });
}

/**
 * Read only trace events for one run, re-sanitizing stored data so a malformed
 * or legacy row fails closed instead of reaching the API/UI.
 */
export async function listTraceEvents(
  store: AppStore,
  userId: string,
  runId: string,
): Promise<TraceEventRecord[]> {
  const events = await store.runs.listEvents(userId, runId);
  const traces: TraceEventRecord[] = [];
  for (const event of events) {
    if (!isTraceEventType(event.type)) continue;
    const data = sanitizeTraceEvent(event.data);
    if (!data) continue;
    traces.push({ ...data, seq: event.seq, type: event.type, at: event.createdAt });
  }
  return traces;
}

/**
 * Read usage from the actual generation result. Unknown values stay unknown;
 * nothing is invented.
 */
export function usageFromResult(result: {
  totalUsage?: unknown;
  usage?: unknown;
}): TraceUsage | undefined {
  return sanitizeUsage(result.totalUsage) ?? sanitizeUsage(result.usage);
}

/** Bounded error taxonomy plus a redacted, bounded message. */
const PERMISSION_ERROR_CODES = new Set([
  "permission_denied",
  "permission_revoked",
  "approval_missing",
  "approval_mismatch",
  "approval_expired",
]);

export function classifyTraceError(error: unknown): TraceError {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const lower = message.toLowerCase();
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  let kind: TraceErrorKind = "tool_error";
  if (
    (typeof code === "string" && PERMISSION_ERROR_CODES.has(code)) ||
    /not enabled|not allowed|not permitted|permission|forbidden|unauthorized|approval|blocked/.test(lower)
  ) {
    kind = "permission_denied";
  } else if (/timeout|timed out/.test(lower)) {
    kind = "timeout";
  } else if (/model|provider|gateway/.test(lower)) {
    kind = "model_error";
  } else if (!message) {
    kind = "internal";
  }
  return { kind, message: redactTraceText(message || "Tool execution failed.") };
}

export function traceRunStart(input: {
  model?: string;
  attempt?: number;
}): TraceEventData {
  return {
    category: "run",
    phase: "start",
    status: "ok",
    model: input.model,
    attempt: input.attempt,
  };
}

export function traceRunEnd(input: {
  status: TraceStatus;
  outcome?: TraceOutcome;
  error?: unknown;
  attempt?: number;
}): TraceEventData {
  return {
    category: "run",
    phase: "end",
    status: input.status,
    outcome: input.outcome,
    error: input.error ? classifyTraceError(input.error) : undefined,
    attempt: input.attempt,
  };
}

export function traceModelEnd(input: {
  model?: string;
  durationMs?: number;
  usage?: TraceUsage;
  status?: TraceStatus;
  error?: unknown;
  stepNumber?: number;
}): TraceEventData {
  return {
    category: "model",
    phase: "end",
    status: input.status ?? "ok",
    model: input.model,
    durationMs: input.durationMs,
    usage: input.usage,
    error: input.error ? classifyTraceError(input.error) : undefined,
    stepNumber: input.stepNumber,
  };
}

export function traceToolStart(input: {
  toolName: string;
  toolCallId?: string;
  integrationId?: string;
  stepNumber?: number;
}): TraceEventData {
  return {
    category: "tool",
    phase: "start",
    status: "ok",
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    integrationId: input.integrationId,
    stepNumber: input.stepNumber,
  };
}

export function traceToolEnd(input: {
  toolName: string;
  toolCallId?: string;
  integrationId?: string;
  stepNumber?: number;
  durationMs?: number;
  success: boolean;
  error?: unknown;
}): TraceEventData {
  return {
    category: "tool",
    phase: "end",
    status: input.success ? "ok" : "error",
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    integrationId: input.integrationId,
    stepNumber: input.stepNumber,
    durationMs: input.durationMs,
    error: input.success ? undefined : classifyTraceError(input.error),
  };
}

export function traceApprovalStart(input: {
  approvalId: string;
  toolName?: string;
}): TraceEventData {
  return {
    category: "approval",
    phase: "start",
    status: "pending",
    approvalId: input.approvalId,
    toolName: input.toolName,
  };
}

export function traceApprovalEnd(input: {
  approvalId: string;
  status: TraceStatus;
  error?: unknown;
}): TraceEventData {
  return {
    category: "approval",
    phase: "end",
    status: input.status,
    approvalId: input.approvalId,
    error: input.error ? classifyTraceError(input.error) : undefined,
  };
}
