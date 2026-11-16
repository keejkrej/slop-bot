import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Integration, ToolRisk } from "@slopbot/contracts";
import { getStore } from "@db/store";
import { appUrl, ApiError } from "./http";
import { classifyToolRisk, redactSensitiveText } from "./tool-permissions";

export type IntegrationSecret = {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  headers?: Record<string, string>;
  deviceId?: string;
  pending?: boolean;
  tools?: McpToolDefinition[];
};

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  /** Structured policy hint. Optional for legacy callers/tests. */
  risk?: ToolRisk;
};

const COMPOSIO_EXECUTE_TOOL = "COMPOSIO_EXECUTE_TOOL";
const COMPOSIO_MULTI_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";
const COMPOSIO_MANAGE_CONNECTIONS = "COMPOSIO_MANAGE_CONNECTIONS";
const COMPOSIO_EXECUTE_TOOLS = new Set([COMPOSIO_EXECUTE_TOOL, COMPOSIO_MULTI_EXECUTE_TOOL]);
const SLUG_KEYS = ["tool_slug", "toolSlug", "tool_name", "toolName"] as const;
const MAX_NESTED_DEPTH = 5;
const MAX_ARGUMENT_DEPTH = 8;

/**
 * A read verb in the tool name is a hint, not a security boundary. Composio
 * executors and connection management are never treated as plain reads because
 * they can trigger arbitrary nested operations.
 */
export function isReadOnlyToolName(name: string): boolean {
  if (COMPOSIO_EXECUTE_TOOLS.has(name) || name === COMPOSIO_MANAGE_CONNECTIONS) return false;
  // Compound names such as `GITHUB_LIST_AND_DELETE_REPO` contain a read verb
  // but are destructive; classifyToolRisk gives destructive verbs precedence.
  return classifyToolRisk({ name }) === "read";
}

function slugOf(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of SLUG_KEYS) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function assertNestedSlug(slug: unknown, depth: number): void {
  if (depth > MAX_NESTED_DEPTH) throw new Error("Composio execution is nested too deeply.");
  if (typeof slug !== "string" || !slug) {
    throw new Error("Composio can only execute read operations through this connection.");
  }
  if (COMPOSIO_EXECUTE_TOOLS.has(slug) || slug === COMPOSIO_MANAGE_CONNECTIONS) {
    throw new Error("Nested Composio execution is not allowed.");
  }
  // Classify the nested slug itself. A compound name that contains a
  // destructive verb is never a read, even if it also contains a read verb.
  if (classifyToolRisk({ name: slug }) !== "read") {
    throw new Error("Composio can only execute read operations through this connection.");
  }
}

/**
 * Walk arbitrary nested arguments and reject any embedded tool slug that would
 * execute another Composio operation. Depth is bounded so a hostile payload
 * cannot exhaust the stack.
 */
function assertNoNestedExecution(value: unknown, depth: number): void {
  if (depth > MAX_ARGUMENT_DEPTH) throw new Error("Composio arguments are nested too deeply.");
  if (Array.isArray(value)) {
    for (const item of value) assertNoNestedExecution(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of SLUG_KEYS) {
    if (record[key] !== undefined) assertNestedSlug(record[key], depth + 1);
  }
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") assertNoNestedExecution(child, depth + 1);
  }
}

function assertManageConnectionsAllowed(args: Record<string, unknown>): void {
  const items = Array.isArray(args.toolkits) ? args.toolkits : [];
  const disallowed = items.some((item) => {
    const action = (item as { action?: string }).action ?? "add";
    return action !== "add" && action !== "list";
  });
  if (disallowed) throw new Error("Only adding and listing Composio connections is allowed.");
}

export function assertMcpArgumentsSafe(tool: McpToolDefinition, args: Record<string, unknown>): void {
  if (COMPOSIO_EXECUTE_TOOLS.has(tool.name)) {
    if (tool.name === COMPOSIO_MULTI_EXECUTE_TOOL) {
      const calls = Array.isArray(args.tools) ? args.tools : [];
      if (calls.length === 0) throw new Error("Composio multi-execute needs at least one tool call.");
      for (const call of calls) assertNestedSlug(slugOf(call), 0);
    } else {
      assertNestedSlug(slugOf(args), 0);
    }
    assertNoNestedExecution(args, 0);
    return;
  }
  if (tool.name === COMPOSIO_MANAGE_CONNECTIONS) {
    assertManageConnectionsAllowed(args);
  }
}

export function assertMcpCallAllowed(tool: McpToolDefinition, args: Record<string, unknown>): void {
  if (!tool.readOnly) throw new Error("Write tools are blocked until per-call approval is enabled.");
  assertMcpArgumentsSafe(tool, args);
}

export function isLocalMcpUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "localhost.localdomain" || isPrivateAddress(hostname);
  } catch { return false; }
}

export async function validateMcpUrl(value: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, "Enter a valid MCP endpoint URL.");
  }
  if (url.username || url.password || url.hash) throw new ApiError(400, "Credentials and fragments aren't allowed in the MCP URL.");
  const local = process.env.NODE_ENV !== "production";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new ApiError(400, "MCP endpoints must use HTTPS.");
  }
  if (!local) {
    const hostname = url.hostname.toLowerCase();
    if (["localhost", "localhost.localdomain", "metadata.google.internal"].includes(hostname)) {
      throw new ApiError(400, "Local and metadata addresses aren't allowed.");
    }
    const host = stripIpv6Brackets(hostname);
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new ApiError(400, "Private network MCP endpoints aren't allowed in production.");
    }
  }
  return url.toString();
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isPrivateIpv4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Expand an IPv6 literal into eight 16-bit groups. Embedded IPv4 tails are
 * converted to two hex groups first. Returns null for malformed input.
 */
function expandIpv6(address: string): number[] | null {
  let value = address;
  const embeddedIpv4 = value.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (embeddedIpv4) {
    const parts = embeddedIpv4.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    const high = ((parts[0]! << 8) | parts[1]!).toString(16);
    const low = ((parts[2]! << 8) | parts[3]!).toString(16);
    value = `${value.slice(0, -embeddedIpv4.length)}${high}:${low}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const numbers = groups.map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : Number.NaN));
  if (numbers.some((number) => !Number.isInteger(number) || number < 0 || number > 0xffff)) return null;
  return numbers;
}

function isPrivateAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address.toLowerCase().split("%")[0] ?? "");
  if (!normalized.includes(":")) return isPrivateIpv4(normalized);
  const groups = expandIpv6(normalized);
  if (!groups) return true;
  // IPv4-mapped IPv6 (`::ffff:127.0.0.1`, `::ffff:7f00:1`) must be judged by
  // the embedded IPv4 address, not by the IPv6 prefix.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const ipv4 = `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
    return isPrivateIpv4(ipv4);
  }
  // Unspecified (`::`) and loopback (`::1`).
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  // Unique-local fc00::/7 and link-local fe80::/10.
  if ((groups[0]! & 0xfe00) === 0xfc00) return true;
  if ((groups[0]! & 0xffc0) === 0xfe80) return true;
  return false;
}

class StoredOAuthProvider implements OAuthClientProvider {
  authorizationUrl: string | null = null;
  private pendingState: string | null = null;

  constructor(
    private readonly userId: string,
    private readonly integrationId: string,
    private readonly platform: "web" | "android",
    private readonly request?: Request,
  ) {}

  get redirectUrl(): string {
    return `${appUrl(this.request)}/api/oauth/mcp/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Slop Bot",
      client_uri: appUrl(this.request),
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  private async read(): Promise<IntegrationSecret> {
    return (await getStore().getSecret<IntegrationSecret>(this.userId, this.integrationId)) ?? {};
  }

  private async write(patch: Partial<IntegrationSecret>): Promise<void> {
    const current = await this.read();
    await getStore().setSecret(this.userId, this.integrationId, { ...current, ...patch });
  }

  async state(): Promise<string> {
    this.pendingState = randomUUID();
    return this.pendingState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.read()).clientInformation;
  }

  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> {
    await this.write({ clientInformation: value });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.read()).tokens;
  }

  async saveTokens(value: OAuthTokens): Promise<void> {
    await this.write({ tokens: value });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this.authorizationUrl = url.toString();
    const state = this.pendingState ?? url.searchParams.get("state");
    if (!state) throw new Error("The MCP authorization server did not receive an OAuth state.");
    const timestamp = new Date();
    await getStore().putOAuthState({
      state,
      integrationId: this.integrationId,
      userId: this.userId,
      platform: this.platform,
      createdAt: timestamp.toISOString(),
      expiresAt: new Date(timestamp.getTime() + 10 * 60_000).toISOString(),
    });
  }

  async saveCodeVerifier(value: string): Promise<void> {
    await this.write({ codeVerifier: value });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.read()).codeVerifier;
    if (!verifier) throw new Error("OAuth PKCE verifier is missing. Restart the connection.");
    return verifier;
  }

  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    await this.write({ discoveryState: value });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.read()).discoveryState;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const current = await this.read();
    if (scope === "all") {
      await getStore().setSecret(this.userId, this.integrationId, { headers: current.headers });
      return;
    }
    const key = ({ client: "clientInformation", tokens: "tokens", verifier: "codeVerifier", discovery: "discoveryState" } as const)[scope];
    delete current[key];
    await getStore().setSecret(this.userId, this.integrationId, current);
  }
}

function makeTransport(
  integration: Integration,
  provider: StoredOAuthProvider,
  secret: IntegrationSecret | null,
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(integration.url), {
    authProvider: provider,
    requestInit: { headers: secret?.headers },
  });
}

async function withClient<T>(
  integration: Integration,
  userId: string,
  platform: "web" | "android",
  request: Request | undefined,
  operation: (client: Client) => Promise<T>,
): Promise<{ value?: T; authorizationUrl: string | null }> {
  const provider = new StoredOAuthProvider(userId, integration.id, platform, request);
  const secret = await getStore().getSecret<IntegrationSecret>(userId, integration.id);
  const client = new Client({ name: "slop-bot", version: "0.1.0" });
  const transport = makeTransport(integration, provider, secret);
  try {
    await client.connect(transport, { timeout: 20_000 });
    return { value: await operation(client), authorizationUrl: null };
  } catch (error) {
    if (error instanceof UnauthorizedError || (error instanceof Error && error.name === "UnauthorizedError")) {
      return { authorizationUrl: provider.authorizationUrl };
    }
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function probeIntegration(
  userId: string,
  integrationId: string,
  platform: "web" | "android" = "web",
  request?: Request,
): Promise<{ integration: Integration; authorizationUrl: string | null }> {
  const store = getStore();
  const existing = await store.getIntegration(userId, integrationId);
  if (!existing) throw new ApiError(404, "Connection not found.");
  if (existing.kind === "desktop") return { integration: existing, authorizationUrl: null };
  try {
    const result = await withClient(existing, userId, platform, request, async (client) => {
      const response = await client.listTools(undefined, { timeout: 20_000 });
      return response.tools.length;
    });
    if (result.authorizationUrl || result.value === undefined) {
      await store.updateIntegration(userId, integrationId, {
        status: "authorization_required",
        lastError: result.authorizationUrl ? null : "Authorization is required, but the server provided no sign-in URL.",
      });
    } else {
      await store.updateIntegration(userId, integrationId, {
        status: "connected",
        toolCount: result.value,
        lastError: null,
      });
    }
    const integration = await store.getIntegration(userId, integrationId);
    if (!integration) throw new ApiError(404, "Connection not found.");
    return { integration, authorizationUrl: result.authorizationUrl };
  } catch (error) {
    const message = safeConnectionError(error);
    await store.updateIntegration(userId, integrationId, { status: "error", lastError: message });
    const integration = await store.getIntegration(userId, integrationId);
    if (!integration) throw new ApiError(404, "Connection not found.");
    return { integration, authorizationUrl: null };
  }
}

export async function completeMcpOAuth(state: string, code: string, request: Request): Promise<OAuthCompletion> {
  const pending = await getStore().getOAuthState(state);
  if (!pending) throw new ApiError(400, "This sign-in link is invalid or expired. Start the connection again.");
  const integration = await getStore().getIntegration(pending.userId, pending.integrationId);
  if (!integration) throw new ApiError(404, "Connection not found.");
  const provider = new StoredOAuthProvider(pending.userId, pending.integrationId, pending.platform, request);
  const secret = await getStore().getSecret<IntegrationSecret>(pending.userId, pending.integrationId);
  const transport = makeTransport(integration, provider, secret);
  await transport.finishAuth(code);
  await getStore().deleteOAuthState(state);
  const result = await probeIntegration(pending.userId, pending.integrationId, pending.platform, request);
  return { ...result, platform: pending.platform };
}

export type OAuthCompletion = {
  integration: Integration;
  authorizationUrl: string | null;
  platform: "web" | "android";
};

export async function listMcpTools(userId: string, integrationId: string): Promise<McpToolDefinition[]> {
  const integration = await getStore().getIntegration(userId, integrationId);
  if (!integration || integration.status !== "connected") return [];
  if (integration.kind === "desktop") {
    const tools = (await getStore().getSecret<IntegrationSecret>(userId, integrationId))?.tools ?? [];
    return tools.map((tool) => ({
      ...tool,
      risk: tool.risk ?? classifyToolRisk({ name: tool.name, readOnly: tool.readOnly }),
    }));
  }
  const result = await withClient(integration, userId, "web", undefined, async (client) => {
    const response = await client.listTools(undefined, { timeout: 20_000 });
    return response.tools.map((tool) => {
      const risk = classifyToolRisk({
        name: tool.name,
        readOnlyHint: tool.annotations?.readOnlyHint,
        destructiveHint: tool.annotations?.destructiveHint,
      });
      return {
        name: tool.name,
        description: tool.description ?? `Call ${tool.name} on ${integration.name}.`,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        readOnly: risk === "read",
        risk,
      };
    });
  });
  return result.value ?? [];
}

const MAX_RESULT_CHARS = 60_000;
const MAX_RESULT_DEPTH = 8;
const MAX_RESULT_ITEMS = 100;
const MAX_RESULT_KEYS = 100;
const MAX_RESULT_STRING = 4_000;
const SENSITIVE_KEY = /(?:api[_-]?key|secret|token|password|passwd|authorization|(?:^|[_-])auth(?:$|[_-])|cookie|credential|private[_-]?key|access[_-]?key|client[_-]?secret|session[_-]?id|refresh[_-]?token)/i;

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_RESULT_DEPTH) return "[Truncated: max depth]";
  if (typeof value === "string") {
    const redacted = redactSensitiveText(value);
    if (redacted !== value) return redacted;
    return value.length > MAX_RESULT_STRING ? `${value.slice(0, MAX_RESULT_STRING)}…[truncated]` : value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_RESULT_ITEMS).map((item) => redactValue(item, depth + 1));
    if (value.length > MAX_RESULT_ITEMS) items.push(`[Truncated: ${value.length - MAX_RESULT_ITEMS} more items]`);
    return items;
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>);
  const result: Record<string, unknown> = {};
  for (const [key, child] of entries.slice(0, MAX_RESULT_KEYS)) {
    result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(child, depth + 1);
  }
  if (entries.length > MAX_RESULT_KEYS) {
    result.__truncated = `${entries.length - MAX_RESULT_KEYS} more keys`;
  }
  return result;
}

/**
 * Bound an untrusted MCP result without producing invalid JSON. Sensitive keys
 * are redacted, depth and collection sizes are capped, and an oversized result
 * becomes a structured envelope instead of a sliced JSON string.
 */
export function boundMcpResult(value: unknown): unknown {
  const sanitized = redactValue(value, 0);
  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= MAX_RESULT_CHARS) return sanitized;
  return {
    truncated: true,
    reason: "MCP result exceeded the size limit.",
    content: serialized.slice(0, MAX_RESULT_CHARS - 200),
  };
}

/**
 * The MCP spec allows opaque `_meta` on `tools/call` params. We attach the
 * persisted server action key there as a best-effort hint. Provider support is
 * unknown and this is NOT an exactly-once guarantee; the server-side ledger is
 * the only dedupe we rely on.
 */
export const IDEMPOTENCY_META_KEY = "slopbot/idempotencyKey";

export function buildCallToolParams(
  toolName: string,
  args: Record<string, unknown>,
  idempotencyKey?: string | null,
): { name: string; arguments: Record<string, unknown>; _meta?: Record<string, unknown> } {
  if (!idempotencyKey) return { name: toolName, arguments: args };
  return {
    name: toolName,
    arguments: args,
    _meta: { [IDEMPOTENCY_META_KEY]: idempotencyKey },
  };
}

export type McpToolInvocation = {
  integration: Integration;
  userId: string;
  toolName: string;
  args: Record<string, unknown>;
  idempotencyKey?: string | null;
};

export async function invokeMcpTool(input: McpToolInvocation): Promise<unknown> {
  const result = await withClient(input.integration, input.userId, "web", undefined, (client) =>
    client.callTool(
      buildCallToolParams(input.toolName, input.args, input.idempotencyKey),
      undefined,
      { timeout: 45_000 },
    ),
  );
  if (!result.value) throw new Error("MCP authorization is required again.");
  return result.value;
}

function safeConnectionError(error: unknown): string {
  if (error instanceof Error) {
    if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(error.message)) return "Could not reach the MCP server.";
    return error.message.slice(0, 300);
  }
  return "MCP connection failed.";
}
