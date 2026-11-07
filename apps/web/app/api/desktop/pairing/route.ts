import { Effect } from "effect";
import { desktopPairing } from "@/lib/server/desktop";
import { fromPromise, runApp } from "@/lib/server/effect";

export function GET(request: Request): Promise<Response> {
  return runApp(Effect.map(fromPromise(() => desktopPairing(request)), (pairing) => Response.json(pairing)));
}
