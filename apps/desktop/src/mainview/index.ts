import { Electroview } from "electrobun/view";
import type { AppRPC } from "../shared/rpc";

const rpc = Electroview.defineRPC<AppRPC>({
	maxRequestTime: 35_000,
	handlers: { requests: {}, messages: { stateChanged: () => undefined } },
});
const view = new Electroview({ rpc });
const webApp = document.getElementById("web-app") as HTMLElement & { src: string };

void rpc.request.getState({}).then((state) => { webApp.src = state.apiUrl; });
void view;
