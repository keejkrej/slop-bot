import type { RPCSchema } from "electrobun/view";

export type LocalTool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	readOnly: boolean;
};

export type LocalServer = {
	localId: string;
	integrationId?: string;
	name: string;
	url: string;
	tools: LocalTool[];
	status: "connected" | "error";
	error?: string;
};

export type DesktopState = {
	apiUrl: string;
	hasToken: boolean;
	deviceId: string;
	servers: LocalServer[];
	bridgeStatus: "offline" | "online" | "error";
	bridgeMessage?: string;
};

export type AppRPC = {
	bun: RPCSchema<{
		requests: {
			getState: { params: Record<string, never>; response: DesktopState };
			saveSettings: { params: { apiUrl: string; token: string }; response: DesktopState };
			addServer: { params: { name: string; url: string }; response: DesktopState };
			removeServer: { params: { localId: string }; response: DesktopState };
			syncServers: { params: Record<string, never>; response: DesktopState };
			openWebApp: { params: Record<string, never>; response: { ok: boolean } };
		};
		messages: Record<string, never>;
	}>;
	webview: RPCSchema<{
		requests: Record<string, never>;
		messages: { stateChanged: DesktopState };
	}>;
};
