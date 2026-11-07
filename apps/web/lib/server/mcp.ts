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
import type { Integration } from "@slopbot/contracts";
import { getStore } from "@db/store";
import { appUrl, ApiError } from "./http";

export type IntegrationSecret = {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  headers?: Record<string, string>;
  deviceId?: string;
  tools?: McpToolDefinition[];
};

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
};

const READ_VERBS = /(?:^|_)(?:GET|LIST|SEARCH|FETCH|FIND|READ|QUERY|DESCRIBE|SHOW|VIEW|LOOKUP|PULL|CHECK|INFO|HISTORY)(?:_|$)/i;
const COMPOSIO_EXECUTE_TOOL = "COMPOSIO_EXECUTE_TOOL";
const COMPOSIO_MULTI_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";
const COMPOSIO_EXECUTE_TOOLS = new Set([COMPOSIO_EXECUTE_TOOL, COMPOSIO_MULTI_EXECUTE_TOOL]);

export function isReadOnlyToolName(name: string): boolean {
  return READ_VERBS.test(name) || ["COMPOSIO_MANAGE_CONNECTIONS", ...COMPOSIO_EXECUTE_TOOLS].includes(name);
}

export function assertMcpCallAllowed(tool: McpToolDefinition, args: Record<string, unknown>): void {
  if (!tool.readOnly) throw new Error("Write tools are blocked until per-call approval is enabled.");
  if (!COMPOSIO_EXECUTE_TOOLS.has(tool.name)) {
    if (tool.name === "COMPOSIO_MANAGE_CONNECTIONS") {
      const items = Array.isArray(args.toolkits) ? args.toolkits : [];
      const disallowed = items.some((item) => {
        const action = (item as { action?: string }).action ?? "add";
        return action !== "add" && action !== "list";
      });
      if (disallowed) throw new Error("Only adding and listing Composio connections is allowed.");
    }
    return;
  }
  if (tool.name === COMPOSIO_MULTI_EXECUTE_TOOL) {
    const calls = Array.isArray(args.tools) ? args.tools : [];
    if (calls.length === 0) throw new Error("Composio multi-execute needs at least one tool call.");
    for (const call of calls) {
      const slug = (call as { tool_slug?: unknown }).tool_slug;
      if (typeof slug !== "string" || !isReadOnlyToolName(slug)) {
        throw new Error("Composio can only execute read operations through this connection.");
      }
    }
    return;
  }
  const slug = args.tool_slug ?? args.toolSlug ?? args.tool_name ?? args.toolName;
  if (typeof slug !== "string" || !isReadOnlyToolName(slug)) {
    throw new Error("Composio can only execute read operations through this connection.");
  }
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
    const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
    if (addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new ApiError(400, "Private network MCP endpoints aren't allowed in production.");
    }
  }
  return url.toString();
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  if (normalized.includes(":")) {
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  const [a = 0, b = 0] = normalized.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
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
    return (await getStore().getSecret<IntegrationSecret>(userId, integrationId))?.tools ?? [];
  }
  const result = await withClient(integration, userId, "web", undefined, async (client) => {
    const response = await client.listTools(undefined, { timeout: 20_000 });
    return response.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? `Call ${tool.name} on ${integration.name}.`,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      readOnly: COMPOSIO_EXECUTE_TOOLS.has(tool.name) || tool.name === "COMPOSIO_MANAGE_CONNECTIONS" ||
        tool.annotations?.readOnlyHint === true ||
        (tool.annotations?.destructiveHint !== true && isReadOnlyToolName(tool.name)),
    }));
  });
  return result.value ?? [];
}

export async function callMcpTool(
  userId: string,
  integrationId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const integration = await getStore().getIntegration(userId, integrationId);
  if (!integration || integration.status !== "connected") throw new Error("MCP connection is not connected.");
  const tools = await listMcpTools(userId, integrationId);
  const tool = tools.find((item) => item.name === toolName);
  if (!tool) throw new Error("The MCP tool no longer exists.");
  assertMcpCallAllowed(tool, args);
  const result = await withClient(integration, userId, "web", undefined, (client) =>
    client.callTool({ name: toolName, arguments: args }, undefined, { timeout: 45_000 }),
  );
  if (!result.value) throw new Error("MCP authorization is required again.");
  const serialized = JSON.stringify(result.value);
  if (serialized.length > 60_000) return { content: serialized.slice(0, 60_000), truncated: true };
  return result.value;
}

function safeConnectionError(error: unknown): string {
  if (error instanceof Error) {
    if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(error.message)) return "Could not reach the MCP server.";
    return error.message.slice(0, 300);
  }
  return "MCP connection failed.";
}
