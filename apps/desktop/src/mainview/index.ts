import { Electroview } from "electrobun/view";
import type { AppRPC, DesktopState } from "../shared/rpc";

let currentState: DesktopState | undefined;
const rpc = Electroview.defineRPC<AppRPC>({
	maxRequestTime: 35_000,
	handlers: {
		requests: {},
		messages: { stateChanged: (next) => { currentState = next; render(next); } },
	},
});
const view = new Electroview({ rpc });

const byId = <T extends HTMLElement>(id: string): T => {
	const element = document.getElementById(id);
	if (!element) throw new Error(`Missing element ${id}`);
	return element as T;
};

function render(state: DesktopState): void {
	byId<HTMLInputElement>("api-url").value = state.apiUrl;
	byId("paired-badge").textContent = state.hasToken ? "PAIRED" : "NOT PAIRED";
	byId("status-text").textContent = state.bridgeStatus.toUpperCase();
	byId("status-dot").className = state.bridgeStatus;
	byId("server-count").textContent = `${state.servers.length} · ${state.servers.reduce((sum, server) => sum + server.tools.length, 0)} TOOLS`;
	byId("message").textContent = state.bridgeMessage ?? "";
	byId("servers").innerHTML = state.servers.length === 0 ? '<div class="empty">No local MCP servers yet.</div>' : "";
	state.servers.forEach((server) => {
		const row = document.createElement("div"); row.className = "server";
		const info = document.createElement("div"); info.className = "server-info";
		const name = document.createElement("div"); name.textContent = server.name;
		const url = document.createElement("div"); url.className = "server-url"; url.textContent = server.url;
		info.append(name, url);
		const count = document.createElement("span"); count.className = "server-tools"; count.textContent = `${server.tools.length} TOOLS`;
		const remove = document.createElement("button"); remove.className = "remove"; remove.textContent = "×"; remove.ariaLabel = `Remove ${server.name}`;
		remove.addEventListener("click", () => { void rpc.request.removeServer({ localId: server.localId }).then(render); });
		row.append(info, count, remove); byId("servers").append(row);
	});
}

byId("open-web").addEventListener("click", () => { void rpc.request.openWebApp({}); });
byId("save-settings").addEventListener("click", async () => {
	byId("message").textContent = "Saving…";
	try {
		const next = await rpc.request.saveSettings({ apiUrl: byId<HTMLInputElement>("api-url").value, token: byId<HTMLInputElement>("token").value });
		byId<HTMLInputElement>("token").value = ""; currentState = next; render(next);
	} catch (error) { byId("message").textContent = error instanceof Error ? error.message : "Could not save settings."; }
});
byId("add-server").addEventListener("submit", async (event) => {
	event.preventDefault(); byId("message").textContent = "Discovering MCP tools…";
	try {
		const next = await rpc.request.addServer({ name: byId<HTMLInputElement>("server-name").value, url: byId<HTMLInputElement>("server-url").value });
		byId<HTMLInputElement>("server-name").value = ""; byId<HTMLInputElement>("server-url").value = ""; currentState = next; render(next);
	} catch (error) { byId("message").textContent = error instanceof Error ? error.message : "Could not connect."; }
});

void rpc.request.getState({}).then((state) => { currentState = state; render(state); });
void view; void currentState;
