import { Context, Effect, Layer } from "effect";
import type { User } from "@slopbot/contracts";
import { ZodError } from "zod";
import { getStore } from "@db/store";
import type { AppStore } from "@db/types";
import { requireUser } from "./auth";
import { ApiError, errorResponse } from "./http";
import {
  callMcpTool,
  completeMcpOAuth,
  listMcpTools,
  probeIntegration,
  type OAuthCompletion,
} from "./mcp";
import type { McpToolDefinition } from "./mcp";
import type { Integration } from "@slopbot/contracts";

export class StoreService extends Context.Service<StoreService, AppStore>()("SlopBot/Store") {}

export class AuthService extends Context.Service<AuthService, {
  user(request: Request): Promise<User>;
}>()("SlopBot/Auth") {}

export type McpServiceShape = {
  probe(userId: string, integrationId: string, platform?: "web" | "android", request?: Request): Promise<{ integration: Integration; authorizationUrl: string | null }>;
  list(userId: string, integrationId: string): Promise<McpToolDefinition[]>;
  call(userId: string, integrationId: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
  completeOAuth(state: string, code: string, request: Request): Promise<OAuthCompletion>;
};

export class McpService extends Context.Service<McpService, McpServiceShape>()("SlopBot/Mcp") {}

export const AppLive = Layer.mergeAll(
  Layer.succeed(StoreService, getStore()),
  Layer.succeed(AuthService, { user: requireUser }),
  Layer.succeed(McpService, {
    probe: probeIntegration,
    list: listMcpTools,
    call: callMcpTool,
    completeOAuth: completeMcpOAuth,
  }),
);

export type AppServices = StoreService | AuthService | McpService;
export type AppEffect<A, R = AppServices> = Effect.Effect<A, ApiError, R>;

export function normalizeError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  if (cause instanceof ZodError) return new ApiError(400, cause.issues[0]?.message ?? "Invalid request.");
  if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505") {
    return new ApiError(409, "That handle is already in use.");
  }
  return new ApiError(500, cause instanceof Error ? cause.message : "Unexpected server error.");
}

export function fromPromise<A>(evaluate: () => Promise<A>): AppEffect<A, never> {
  return Effect.tryPromise({ try: evaluate, catch: normalizeError });
}

export function fromSync<A>(evaluate: () => A): AppEffect<A, never> {
  return Effect.try({ try: evaluate, catch: normalizeError });
}

export function withStore<A>(use: (store: AppStore) => Promise<A>): AppEffect<A, StoreService> {
  return Effect.gen(function* () {
    const store = yield* StoreService;
    return yield* fromPromise(() => use(store));
  });
}

export function authenticate(request: Request): AppEffect<User, AuthService> {
  return Effect.gen(function* () {
    const auth = yield* AuthService;
    return yield* fromPromise(() => auth.user(request));
  });
}

export function withMcp<A>(use: (mcp: McpServiceShape) => Promise<A>): AppEffect<A, McpService> {
  return Effect.gen(function* () {
    const mcp = yield* McpService;
    return yield* fromPromise(() => use(mcp));
  });
}

export function runService<A>(effect: Effect.Effect<A, ApiError, AppServices>): Promise<A> {
  return Effect.runPromise(Effect.provide(effect, AppLive));
}

export function runApp(effect: Effect.Effect<Response, ApiError, AppServices>): Promise<Response> {
  return runService(effect.pipe(Effect.catch((error) => Effect.succeed(errorResponse(error)))));
}
