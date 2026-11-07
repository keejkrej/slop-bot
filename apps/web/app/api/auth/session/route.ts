import { Effect } from "effect";
import { requireUser } from "@/lib/server/auth";
import { fromPromise, runApp } from "@/lib/server/effect";

export function GET(request: Request): Promise<Response> {
  return runApp(Effect.map(fromPromise(() => requireUser(request)), (user) => Response.json({ user })));
}
