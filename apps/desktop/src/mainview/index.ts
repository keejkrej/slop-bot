import { Electroview } from "electrobun/view";
import type { AppRPC } from "../shared/rpc";

const rpc = Electroview.defineRPC<AppRPC>({
	maxRequestTime: 35_000,
	handlers: { requests: {}, messages: { stateChanged: () => undefined } },
});
const view = new Electroview({ rpc });
const webApp = document.getElementById("web-app") as HTMLElement & { src: string };

void rpc.request.getState({}).then((state) => { webApp.src = state.apiUrl; });
webApp.addEventListener("host-message", (event) => {
	const payload = (event as CustomEvent).detail as { type?: string; token?: string; apiUrl?: string };
	if (payload?.type !== "slop-bot:session" || !payload.token || !payload.apiUrl) return;
	void rpc.request.saveSettings({ apiUrl: payload.apiUrl, token: payload.token });
});
void view;
