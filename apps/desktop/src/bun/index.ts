import { BrowserView, BrowserWindow } from "electrobun/main";
import type { AppRPC, DesktopState, LocalServer } from "../shared/rpc";
import { DesktopStore } from "./store";
import { DesktopBridge } from "./bridge";
import { discoverTools, validateLocalMcpUrl } from "./mcp";

const store = new DesktopStore();
const bridge = new DesktopBridge(store);

async function state(): Promise<DesktopState> {
	const config = await store.read();
	return {
		apiUrl: config.apiUrl,
		hasToken: Boolean(config.token),
		deviceId: config.deviceId,
		servers: config.servers,
		bridgeStatus: bridgeStatus,
		bridgeMessage,
	};
}

let bridgeStatus: DesktopState["bridgeStatus"] = "offline";
let bridgeMessage: string | undefined;

const rpc = BrowserView.defineRPC<AppRPC>({
	maxRequestTime: 30_000,
	handlers: {
		requests: {
			getState: () => state(),
			saveSettings: async ({ apiUrl, token }) => {
				const endpoint = new URL(apiUrl);
				if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("Use an HTTP(S) API URL.");
				const current = await store.read();
				await store.update({ apiUrl: endpoint.toString().replace(/\/$/, ""), token: token || current.token });
				await bridge.sync();
				return state();
			},
			addServer: async ({ name, url }) => {
				validateLocalMcpUrl(url);
				const tools = await discoverTools(url);
				const server: LocalServer = {
					localId: crypto.randomUUID(), name: name.trim(), url, tools, status: "connected",
				};
				const current = await store.read();
				await store.update({ servers: [...current.servers, server] });
				await bridge.sync();
				return state();
			},
			removeServer: async ({ localId }) => {
				const current = await store.read();
				const removed = current.servers.find((server) => server.localId === localId);
				if (removed?.integrationId) await bridge.unregister(removed.integrationId);
				await store.update({ servers: current.servers.filter((server) => server.localId !== localId) });
				await bridge.sync();
				return state();
			},
			syncServers: async () => { await bridge.sync(); return state(); },
			openWebApp: async () => {
				const config = await store.read();
				new BrowserWindow({
					title: "Slop Bot",
					url: config.apiUrl,
					renderer: "native",
					sandbox: true,
					frame: { width: 1280, height: 860 },
				});
				return { ok: true };
			},
		},
		messages: {},
	},
});

bridge.onStatus = (status, message) => {
	bridgeStatus = status;
	bridgeMessage = message;
	void state().then((next) => rpc.send.stateChanged(next));
};

const mainWindow = new BrowserWindow({
	title: "Slop Bot Desktop",
	url: "views://mainview/index.html",
	renderer: "native",
	rpc,
	frame: { width: 920, height: 720 },
});

bridge.start();
void mainWindow;
