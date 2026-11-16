import {
  MAX_ALLOWED_WRITE_TOOLS,
  MAX_TOOL_NAME_LENGTH,
  type ToolRisk,
} from "@slopbot/contracts";
import { canonicalArgsDigest } from "./portable-hash";
import { redactSensitiveText } from "./portable-redact";

export { redactSensitiveText } from "./portable-redact";

/**
 * Pure tool-approval policy. This module deliberately has no store, network,
 * or MCP client imports so it can be reused by the API, the workflow layer,
 * and focused tests without side effects.
 */

/** Human approval horizon. New actions always receive a deadline. */
export const DEFAULT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60_000;

const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const WILDCARD_NAMES = new Set(["*", "all", "any", "everything"]);

const READ_VERBS =
  /(?:^|_)(?:GET|LIST|SEARCH|FETCH|FIND|READ|QUERY|DESCRIBE|SHOW|VIEW|LOOKUP|PULL|CHECK|INFO|HISTORY)(?:_|$)/i;
const DESTRUCTIVE_VERBS =
  /(?:^|_)(?:DELETE|REMOVE|DESTROY|DROP|PURGE|REVOKE|TRUNCATE|WIPE|UNINSTALL|DISCONNECT|CANCEL|CLOSE|ARCHIVE)(?:_|$)/i;
const WRITE_VERBS =
  /(?:^|_)(?:CREATE|UPDATE|SEND|POST|PUT|PATCH|WRITE|EDIT|ADD|INSERT|UPLOAD|SET|MOVE|RENAME|MERGE|COMMENT|REPLY|INVITE|ASSIGN|LABEL|REOPEN|PUBLISH|SCHEDULE|TRIGGER|RUN|EXECUTE|DELETE|REMOVE)(?:_|$)/i;
/**
 * Compound names join operations with `_AND_`. A read verb before the join
 * (for example `GITHUB_LIST_AND_CREATE_ISSUE`) must not hide the write that
 * follows it. This is deliberately narrower than "any name with both verbs" so
 * a pure read whose noun looks like a verb (`GITHUB_GET_ISSUE_COMMENT`) stays a
 * read.
 */
const COMPOUND_AND = /_AND_/i;

export const COMPOSIO_EXECUTE_TOOL = "COMPOSIO_EXECUTE_TOOL";
export const COMPOSIO_MULTI_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";
export const COMPOSIO_MANAGE_CONNECTIONS = "COMPOSIO_MANAGE_CONNECTIONS";
const COMPOSIO_EXECUTORS = new Set([COMPOSIO_EXECUTE_TOOL, COMPOSIO_MULTI_EXECUTE_TOOL]);

export function isSyntacticallyValidToolName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= MAX_TOOL_NAME_LENGTH &&
    TOOL_NAME_PATTERN.test(name) &&
    !WILDCARD_NAMES.has(name.toLowerCase())
  );
}

export function isComposioExecutorTool(name: string): boolean {
  return COMPOSIO_EXECUTORS.has(name);
}

export function isComposioConnectionManagementTool(name: string): boolean {
  return name === COMPOSIO_MANAGE_CONNECTIONS;
}

/**
 * Composio executors and connection management are never plain reads: they can
 * trigger arbitrary nested operations. They are also never grantable through
 * the per-integration allowlist.
 */
export function isComposioNestedExecutor(name: string): boolean {
  return isComposioExecutorTool(name) || isComposioConnectionManagementTool(name);
}

export type ToolRiskInput = {
  name: string;
  /** MCP annotation. Only an explicit `true` is trusted. */
  readOnlyHint?: boolean;
  /** MCP annotation. Only an explicit `true` is trusted. */
  destructiveHint?: boolean;
  /** Legacy normalized flag from the MCP listing. */
  readOnly?: boolean;
};

/**
 * Classify a tool from annotations first, then from its name. Unknown names
 * default to `write` so they stay denied until explicitly granted. A read verb
 * is a hint, not a security boundary.
 */
export function classifyToolRisk(input: ToolRiskInput): ToolRisk {
  const { name } = input;
  if (isComposioNestedExecutor(name)) return "write";
  if (input.destructiveHint === true) return "destructive";
  // A destructive verb in a compound name (for example
  // `GITHUB_LIST_AND_DELETE_REPO`) wins over a read-looking annotation or verb.
  if (DESTRUCTIVE_VERBS.test(name)) return "destructive";

  const hasReadVerb = READ_VERBS.test(name);
  const hasWriteVerb = WRITE_VERBS.test(name);

  // A compound name that mixes a read verb with a write verb is a write, even
  // when the read verb appears first or an untrusted read-only annotation is
  // set. Pure reads (only read verbs) are unaffected.
  if (COMPOUND_AND.test(name) && hasWriteVerb) return "write";

  if (input.readOnlyHint === true) return "read";
  // The legacy normalized flag is weaker than the MCP annotation: it may only
  // confirm a true simple read (a read verb and no write/destructive verb).
  if (input.readOnly === true && hasReadVerb && !hasWriteVerb) return "read";
  if (hasReadVerb) return "read";
  if (hasWriteVerb) return "write";
  return "write";
}

export function isReadRisk(risk: ToolRisk): boolean {
  return risk === "read";
}

export function isWriteRisk(risk: ToolRisk): boolean {
  return risk === "write" || risk === "destructive";
}

/**
 * Validate and normalize an explicit finite allowlist. Blanket selectors and
 * Composio executors are rejected; duplicates are collapsed.
 */
export function normalizeAllowedWriteTools(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error("allowedWriteTools must be an array of tool names.");
  if (input.length > MAX_ALLOWED_WRITE_TOOLS) {
    throw new Error(`At most ${MAX_ALLOWED_WRITE_TOOLS} write tools can be allowed.`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of input) {
    if (!isSyntacticallyValidToolName(value)) {
      throw new Error("Use plain tool names; wildcards and free-form selectors are not allowed.");
    }
    if (isComposioNestedExecutor(value)) {
      throw new Error("Composio executors cannot be granted through a connection allowlist.");
    }
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export type ToolPermissionInput = {
  toolName: string;
  risk: ToolRisk;
  allowedWriteTools: readonly string[];
};

/**
 * Read tools are always available. Write and destructive tools require an
 * explicit per-tool grant on the selected connection. Composio executors are
 * denied regardless of grants.
 */
export function isToolAllowedForIntegration(input: ToolPermissionInput): boolean {
  const { toolName, risk, allowedWriteTools } = input;
  if (!isSyntacticallyValidToolName(toolName)) return false;
  if (isComposioNestedExecutor(toolName)) return false;
  if (isReadRisk(risk)) return true;
  return allowedWriteTools.includes(toolName);
}

export function assertToolAllowedForIntegration(input: ToolPermissionInput): void {
  if (!isToolAllowedForIntegration(input)) {
    throw new Error("This tool is not permitted on the selected connection.");
  }
}

export type ToolPolicyDecision =
  | { kind: "allow"; risk: "read" }
  | { kind: "approval_required"; risk: "write" | "destructive" }
  | { kind: "deny"; reason: "invalid_name" | "nested_composio" | "not_granted" };

/**
 * Decide whether a tool may run, needs approval, or is denied. The decision is
 * based on the current tool risk and the current connection allowlist, never on
 * model instructions. Composio executors are never grantable, even when their
 * name appears in the allowlist.
 */
export function decideToolPolicy(input: ToolPermissionInput): ToolPolicyDecision {
  const { toolName, risk, allowedWriteTools } = input;
  if (!isSyntacticallyValidToolName(toolName)) return { kind: "deny", reason: "invalid_name" };
  if (isComposioNestedExecutor(toolName)) return { kind: "deny", reason: "nested_composio" };
  if (risk === "read") return { kind: "allow", risk: "read" };
  if (allowedWriteTools.includes(toolName)) return { kind: "approval_required", risk };
  return { kind: "deny", reason: "not_granted" };
}

export function toolNeedsApproval(input: ToolPermissionInput): boolean {
  return decideToolPolicy(input).kind === "approval_required";
}

export type KnownTool = { name: string; risk: ToolRisk };

export type ToolSummary = {
  name: string;
  description: string;
  risk: ToolRisk;
  allowed: boolean;
};

/** Sanitized summaries for the connection permission UI. */
export function summarizeToolPermissions(
  tools: readonly { name: string; description: string; risk: ToolRisk }[],
  allowedWriteTools: readonly string[],
): ToolSummary[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description.slice(0, 300),
    risk: tool.risk,
    allowed: isToolAllowedForIntegration({
      toolName: tool.name,
      risk: tool.risk,
      allowedWriteTools,
    }),
  }));
}

/**
 * Validate a PATCH allowlist against the live tool listing. Only known,
 * write-class, non-Composio tools can be granted.
 */
export function validateWriteToolGrants(
  requested: unknown,
  knownTools: readonly KnownTool[],
): string[] {
  const normalized = normalizeAllowedWriteTools(requested);
  const known = new Map(knownTools.map((tool) => [tool.name, tool.risk]));
  for (const name of normalized) {
    const risk = known.get(name);
    if (!risk) throw new Error(`Unknown tool: ${name}.`);
    if (isComposioNestedExecutor(name) || !isWriteRisk(risk)) {
      throw new Error(`${name} is not a grantable write tool.`);
    }
  }
  return normalized;
}

const MAX_REDACT_DEPTH = 6;
const MAX_REDACT_ITEMS = 50;
const MAX_REDACT_KEYS = 50;
const MAX_REDACT_STRING = 500;
const MAX_PREVIEW_CHARS = 400;

const SENSITIVE_KEY =
  /(?:api[_-]?key|secret|token|password|passwd|authorization|(?:^|[_-])auth(?:$|[_-])|cookie|credential|private[_-]?key|access[_-]?key|client[_-]?secret|session[_-]?id|refresh[_-]?token)/i;

/**
 * Key- and value-aware redaction. Values use the shared portable text helper so
 * approval previews and untrusted MCP results agree on what looks secret.
 */
function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_REDACT_DEPTH) return "[Truncated: max depth]";
  if (typeof value === "string") {
    const redacted = redactSensitiveText(value);
    if (redacted !== value) return redacted;
    return value.length > MAX_REDACT_STRING
      ? `${value.slice(0, MAX_REDACT_STRING)}…[truncated]`
      : value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_REDACT_ITEMS).map((item) => redactValue(item, depth + 1));
    if (value.length > MAX_REDACT_ITEMS) {
      items.push(`[Truncated: ${value.length - MAX_REDACT_ITEMS} more items]`);
    }
    return items;
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>);
  const result: Record<string, unknown> = {};
  for (const [key, child] of entries.slice(0, MAX_REDACT_KEYS)) {
    result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(child, depth + 1);
  }
  if (entries.length > MAX_REDACT_KEYS) {
    result.__truncated = `${entries.length - MAX_REDACT_KEYS} more keys`;
  }
  return result;
}

/**
 * Value- and key-aware redaction with hard bounds. The result is always a
 * plain object suitable for persistence and public DTOs.
 */
export function redactToolArgs(args: unknown): Record<string, unknown> {
  const redacted = redactValue(args, 0);
  if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
    return redacted as Record<string, unknown>;
  }
  return { value: redacted };
}

/** Compact, bounded preview for the approval card. */
export function toolArgsPreview(args: unknown, maxChars = MAX_PREVIEW_CHARS): string {
  const serialized = JSON.stringify(redactToolArgs(args));
  if (serialized.length <= maxChars) return serialized;
  return `${serialized.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Legacy rows may have a null deadline; new rows always receive one. */
export function isPendingActionExpired(
  action: { expiresAt: string | null },
  now: Date = new Date(),
): boolean {
  if (!action.expiresAt) return false;
  const deadline = Date.parse(action.expiresAt);
  if (Number.isNaN(deadline)) return true;
  return deadline <= now.getTime();
}

export function defaultApprovalExpiresAt(
  now: Date = new Date(),
  ttlMs: number = DEFAULT_APPROVAL_TTL_MS,
): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}

export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/**
 * Idempotency keys are opaque server-generated credentials. They are bounded
 * and validated before they are persisted or forwarded to a provider.
 */
export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value);
}

export function normalizeIdempotencyKey(value: unknown): string | null {
  return isValidIdempotencyKey(value) ? value : null;
}

export type ToolApprovalMetadataInput = {
  tool: { name: string; risk: ToolRisk };
  integration: { id: string; name: string };
  args: unknown;
  idempotencyKey?: string | null;
  now?: Date;
  ttlMs?: number;
};

export type ToolApprovalMetadata = {
  toolName: string;
  toolArgsRedacted: Record<string, unknown>;
  toolRisk: ToolRisk;
  integrationId: string;
  integrationName: string;
  summary: string;
  idempotencyKey: string | null;
  expiresAt: string;
  /** Canonical digest of the exact approved arguments. Never the raw payload. */
  argsDigest: string | null;
};

const MAX_SUMMARY_CHARS = 300;
const MAX_INTEGRATION_NAME_CHARS = 120;

/**
 * Build the sanitized metadata persisted with a tool approval. Arguments are
 * redacted and bounded; the summary is a short preview, never the raw payload.
 */
export function buildToolApprovalMetadata(input: ToolApprovalMetadataInput): ToolApprovalMetadata {
  const integrationName = input.integration.name.slice(0, MAX_INTEGRATION_NAME_CHARS);
  const preview = toolArgsPreview(input.args, 200);
  return {
    toolName: input.tool.name,
    toolArgsRedacted: redactToolArgs(input.args),
    toolRisk: input.tool.risk,
    integrationId: input.integration.id,
    integrationName,
    summary: `${input.tool.name} on ${integrationName}: ${preview}`.slice(0, MAX_SUMMARY_CHARS),
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    expiresAt: defaultApprovalExpiresAt(input.now, input.ttlMs),
    argsDigest: canonicalArgsDigest(input.args),
  };
}
