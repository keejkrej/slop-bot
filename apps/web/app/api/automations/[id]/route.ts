import { Effect } from "effect";
import { updateAutomationSchema } from "@slopbot/contracts";
import { authenticate, fromPromise, runApp, withStore } from "@/lib/server/effect";
import { parseJson } from "@/lib/server/http";
import {
  deleteAutomation,
  getAutomation,
  updateAutomation,
} from "@/lib/server/automations";

export function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const { id } = yield* fromPromise(() => context.params);
    const automation = yield* withStore((store) => getAutomation(store, user.id, id));
    return Response.json({ automation });
  }));
}

export function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const { id } = yield* fromPromise(() => context.params);
    const input = yield* fromPromise(() => parseJson(request, updateAutomationSchema));
    const automation = yield* withStore((store) => updateAutomation(store, user.id, id, input));
    return Response.json({ automation });
  }));
}

export function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const { id } = yield* fromPromise(() => context.params);
    yield* withStore((store) => deleteAutomation(store, user.id, id));
    return Response.json({ ok: true });
  }));
}
