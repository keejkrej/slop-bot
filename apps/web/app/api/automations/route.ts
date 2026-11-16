import { Effect } from "effect";
import { createAutomationSchema } from "@slopbot/contracts";
import { authenticate, fromPromise, runApp, withStore } from "@/lib/server/effect";
import { parseJson } from "@/lib/server/http";
import { createAutomation, listAutomations } from "@/lib/server/automations";

export function GET(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const automations = yield* withStore((store) => listAutomations(store, user.id));
    return Response.json({ automations });
  }));
}

export function POST(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const input = yield* fromPromise(() => parseJson(request, createAutomationSchema));
    const automation = yield* withStore((store) => createAutomation(store, user.id, input));
    return Response.json({ automation }, { status: 201 });
  }));
}
