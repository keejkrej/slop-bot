import type { DesktopStore } from "./store";
import { callLocalTool, discoverTools } from "./mcp";
import type { LocalServer } from "../shared/rpc";

export type BridgeJob = {
	id: string;
	integrationId: string;
	toolName: string;
	args: Record<string, unknown>;
};

export class DesktopBridge {
	private timer?: ReturnType<typeof setInterval>;
	private running = false;
	private pendingAttempts = new Map<string, number>();
	onStatus?: (status: "offline" | "online" | "error", message?: string) => void;

	constructor(private readonly store: DesktopStore) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.poll(), 2_000);
		void this.sync();
	}

	async sync(): Promise<void> {
		const config = await this.store.read();
		if (!config.token) { this.onStatus?.("offline", "Add your pairing token to sync local tools."); return; }
		try {
			const response = await this.request("/api/desktop/register", {
				deviceId: config.deviceId,
				servers: config.servers.map((server) => ({
					localId: server.localId,
					integrationId: server.integrationId,
					name: server.name,
					url: server.url,
					tools: server.tools,
				})),
			}, config);
			const result = await response.json() as { registrations?: Array<{ localId: string; integrationId: string }>; error?: string };
			if (!response.ok) throw new Error(result.error ?? `Registration failed (${response.status}).`);
			const registrations = result.registrations ?? [];
			const servers = config.servers.map((server) => ({
				...server,
				integrationId: registrations.find((item) => item.localId === server.localId)?.integrationId ?? server.integrationId,
			}));
			await this.store.update({ servers });
			this.onStatus?.("online", `${servers.length} local ${servers.length === 1 ? "server" : "servers"} synced.`);
		} catch (error) {
			this.onStatus?.("error", error instanceof Error ? error.message : "Could not sync desktop tools.");
		}
	}

	async unregister(integrationId: string): Promise<void> {
		const config = await this.store.read();
		if (!config.token) return;
		await this.request("/api/desktop/unregister", { deviceId: config.deviceId, integrationId }, config);
	}

	private async poll(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			const config = await this.store.read();
			if (!config.token) return;
			const response = await this.request(`/api/desktop/jobs?deviceId=${encodeURIComponent(config.deviceId)}`, undefined, config);
			if (!response.ok) throw new Error(`Bridge polling failed (${response.status}).`);
			const { jobs = [] } = await response.json() as { jobs?: BridgeJob[] };
			for (const job of jobs) void this.execute(job);
			await this.claimPending(config);
			this.onStatus?.("online");
		} catch (error) {
			this.onStatus?.("error", error instanceof Error ? error.message : "Bridge polling failed.");
		} finally {
			this.running = false;
		}
	}

	private async claimPending(config: Awaited<ReturnType<DesktopStore["read"]>>): Promise<void> {
		const response = await this.request("/api/desktop/pending", undefined, config);
		if (!response.ok) return;
		const { connections = [] } = await response.json() as { connections?: Array<{ id: string; name: string; url: string }> };
		for (const connection of connections) {
			const lastAttempt = this.pendingAttempts.get(connection.id) ?? 0;
			if (Date.now() - lastAttempt < 30_000) continue;
			this.pendingAttempts.set(connection.id, Date.now());
			try {
				const tools = await discoverTools(connection.url);
				const localId = crypto.randomUUID();
				const server: LocalServer = { localId, integrationId: connection.id, name: connection.name, url: connection.url, tools, status: "connected" };
				const claim = await this.request("/api/desktop/claim", { integrationId: connection.id, deviceId: config.deviceId, localId, tools }, config);
				if (!claim.ok) throw new Error(`Could not claim local connection (${claim.status}).`);
				await this.store.update({ servers: [...config.servers, server] });
				this.pendingAttempts.delete(connection.id);
			} catch (error) {
				await this.request("/api/desktop/claim", {
					integrationId: connection.id,
					deviceId: config.deviceId,
					localId: crypto.randomUUID(),
					tools: [],
					error: error instanceof Error ? error.message.slice(0, 500) : "Local MCP discovery failed.",
				}, config).catch(() => undefined);
			}
		}
		if (connections.length > 0) await this.sync();
	}

	private async execute(job: BridgeJob): Promise<void> {
		const config = await this.store.read();
		const server = config.servers.find((item) => item.integrationId === job.integrationId);
		let result: { ok: boolean; output?: unknown; error?: string };
		try {
			if (!server) throw new Error("The local MCP server is no longer configured.");
			const tool = server.tools.find((item) => item.name === job.toolName);
			if (!tool?.readOnly) throw new Error("Only read-only local tools can be called.");
			result = { ok: true, output: await callLocalTool(server.url, job.toolName, job.args) };
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : "Local tool failed." };
		}
		await this.request(`/api/desktop/jobs/${job.id}`, { deviceId: config.deviceId, ...result }, config).catch((error) => {
			this.onStatus?.("error", error instanceof Error ? error.message : "Could not return tool result.");
		});
	}

	private request(path: string, body: unknown, config: { apiUrl: string; token: string }): Promise<Response> {
		return fetch(`${config.apiUrl.replace(/\/$/, "")}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				authorization: `Bearer ${config.token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(70_000),
		});
	}
}
