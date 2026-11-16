import type { DesktopStore } from "./store";
import { callLocalTool, discoverTools } from "./mcp";
import { boundDesktopResult, redactDesktopText } from "./result";
import type { LocalServer } from "../shared/rpc";

type DesktopConfig = Awaited<ReturnType<DesktopStore["read"]>>;
type BridgeResult = { ok: boolean; output?: unknown; error?: string };

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
			for (const job of jobs) void this.claimAndExecute(job, config);
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

	private async claimAndExecute(job: BridgeJob, config: DesktopConfig): Promise<void> {
		try {
			const response = await this.request(`/api/desktop/jobs/${job.id}/claim`, { deviceId: config.deviceId }, config);
			// Another bridge instance owns this job, or it already finished.
			if (!response.ok) return;
			const { job: claimed } = await response.json() as { job?: BridgeJob };
			await this.execute(claimed ?? job, config);
		} catch (error) {
			this.onStatus?.("error", error instanceof Error ? error.message : "Could not claim desktop job.");
		}
	}

	private async execute(job: BridgeJob, config: DesktopConfig): Promise<void> {
		const server = config.servers.find((item) => item.integrationId === job.integrationId);
		let result: BridgeResult;
		try {
			if (!server) throw new Error("The local MCP server is no longer configured.");
			const tool = server.tools.find((item) => item.name === job.toolName);
			if (!tool?.readOnly) throw new Error("Only read-only local tools can be called.");
			result = { ok: true, output: boundDesktopResult(await callLocalTool(server.url, job.toolName, job.args)) };
		} catch (error) {
			result = {
				ok: false,
				error: redactDesktopText(error instanceof Error ? error.message : "Local tool failed.").slice(0, 1_000),
			};
		}
		await this.deliver(job.id, config, result);
	}

	private async deliver(jobId: string, config: DesktopConfig, result: BridgeResult): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				const response = await this.request(`/api/desktop/jobs/${jobId}`, { deviceId: config.deviceId, ...result }, config);
				// A 200 is terminal: either delivered, or the server recorded a
				// terminal delivery failure (expired job / no live hook).
				if (response.ok) return;
				// 404/409 mean the job is gone or owned elsewhere; retrying cannot help.
				if (response.status === 404 || response.status === 409) return;
				if (response.status >= 400 && response.status < 500) return;
			} catch (error) {
				this.onStatus?.("error", error instanceof Error ? error.message : "Could not return tool result.");
			}
			await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
		}
		this.onStatus?.("error", "Could not deliver the desktop tool result.");
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
