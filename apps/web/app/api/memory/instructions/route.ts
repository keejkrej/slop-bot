import { Effect } from "effect";
import { updateMemoryInstructionsSchema } from "@slopbot/contracts";
import { authenticate, fromPromise, runApp, withStore } from "@/lib/server/effect";
import { parseJson } from "@/lib/server/http";
import { setUserInstructions } from "@/lib/server/memory";

/** PATCH /api/memory/instructions — replace global user instructions with CAS. */
export function PATCH(request: Request): Promise<Response> {
  return runApp(Effect.gen(function* () {
    const user = yield* authenticate(request);
    const input = yield* fromPromise(() => parseJson(request, updateMemoryInstructionsSchema));
    const file = yield* withStore((store) =>
      setUserInstructions(store, user.id, input.content, input.expectedVersion),
    );
    return Response.json({
      instructions: { content: file.content, version: file.version, updatedAt: file.updatedAt },
    });
  }));
}
