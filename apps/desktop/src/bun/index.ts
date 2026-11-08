import Electrobun, { BrowserWindow } from "electrobun/main";
import { DesktopStore } from "./store";
import { DesktopBridge } from "./bridge";

const store = new DesktopStore();
const bridge = new DesktopBridge(store);
const config = await store.read();

const mainWindow = new BrowserWindow({
	title: "Slop Bot",
	url: config.apiUrl,
	renderer: "native",
	sandbox: true,
	frame: { width: 1280, height: 860 },
});

bridge.onStatus = (status, message) => {
	if (status === "error") console.error(`Desktop bridge: ${message ?? "unknown error"}`);
};

Electrobun.events.on("host-message", (event) => {
	try {
		const raw = (event.data as { detail: string }).detail;
		const payload = JSON.parse(raw) as { type?: string; token?: string; apiUrl?: string };
		if (payload.type !== "slop-bot:session" || !payload.token || !payload.apiUrl) return;
		void store.update({ apiUrl: payload.apiUrl, token: payload.token }).then(() => bridge.sync());
	} catch {
		// Ignore malformed host messages without exposing credentials in logs.
	}
});

bridge.start();
void mainWindow;
