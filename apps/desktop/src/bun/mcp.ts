import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LocalServer, LocalTool } from "../shared/rpc";

export function validateLocalMcpUrl(value: string): URL {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use an HTTP Streamable MCP endpoint.");
	if (url.username || url.password) throw new Error("Put credentials in the MCP server's local configuration, not its URL.");
	return url;
}

async function connect(url: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
	const client = new Client({ name: "slop-bot-desktop", version: "0.1.0" });
	const transport = new StreamableHTTPClientTransport(validateLocalMcpUrl(url));
	await client.connect(transport, { timeout: 15_000 });
	return { client, transport };
}

export async function discoverTools(url: string): Promise<LocalTool[]> {
	const { client } = await connect(url);
	try {
		const response = await client.listTools(undefined, { timeout: 15_000 });
		return response.tools.map((tool) => ({
			name: tool.name,
			description: tool.description ?? `Call ${tool.name}`,
			inputSchema: tool.inputSchema as Record<string, unknown>,
			readOnly: tool.annotations?.readOnlyHint === true,
		}));
	} finally {
		await client.close();
	}
}

export async function callLocalTool(url: string, name: string, args: Record<string, unknown>): Promise<unknown> {
	const { client } = await connect(url);
	try {
		const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
		return JSON.parse(JSON.stringify(result));
	} finally {
		await client.close();
	}
}

export function serverWithError(server: LocalServer, error: unknown): LocalServer {
	return { ...server, status: "error", error: error instanceof Error ? error.message.slice(0, 300) : "Connection failed" };
}
