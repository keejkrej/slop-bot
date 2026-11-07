import { createHash, randomBytes, randomUUID } from "node:crypto";
import { decodeJwt, jwtVerify, SignJWT } from "jose";
import type { User } from "@slopbot/contracts";
import { ApiError, appUrl } from "./http";

const SESSION_COOKIE = "slop_session";
const SESSION_ISSUER = "slop-bot";
const SESSION_AUDIENCE = "slop-bot-user";

type VercelProfile = {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  picture?: string;
};

type TokenResponse = {
  access_token: string;
  id_token: string;
};

function secret(): Uint8Array {
  const value = process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET;
  if (value) return new TextEncoder().encode(value);
  if (process.env.NODE_ENV !== "production") return new TextEncoder().encode("slop-bot-local-development-secret");
  throw new ApiError(503, "BETTER_AUTH_SECRET is not configured.");
}

function clientId(): string {
  const value = process.env.VERCEL_APP_CLIENT_ID ?? process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID;
  if (!value) throw new ApiError(503, "Vercel sign-in is not configured.");
  return value;
}

function clientSecret(): string {
  const value = process.env.VERCEL_APP_CLIENT_SECRET;
  if (!value) throw new ApiError(503, "Vercel sign-in secret is not configured.");
  return value;
}

function assertOwner(profile: VercelProfile): void {
  const allowed = process.env.ALLOWED_USER_ID;
  if (process.env.NODE_ENV === "production" && !allowed) throw new ApiError(503, "ALLOWED_USER_ID is required.");
  if (allowed && profile.sub !== allowed) throw new ApiError(403, "This Vercel account isn't allowed to use this personal deployment.");
}

export async function startVercelSignIn(request: Request, platform: "web" | "android"): Promise<string> {
  const verifier = randomBytes(48).toString("base64url");
  const nonce = randomUUID();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = await new SignJWT({ verifier, nonce, platform })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SESSION_ISSUER)
    .setAudience("slop-bot-oauth-state")
    .setExpirationTime("10m")
    .sign(secret());
  const callback = `${appUrl(request)}/api/auth/callback/vercel`;
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: callback,
    response_type: "code",
    scope: "openid email profile offline_access",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://vercel.com/oauth/authorize?${params}`;
}

export async function finishVercelSignIn(request: Request): Promise<{ user: User; token: string; platform: "web" | "android" }> {
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) throw new ApiError(400, "The Vercel sign-in callback is incomplete.");
  const { payload } = await jwtVerify(state, secret(), { issuer: SESSION_ISSUER, audience: "slop-bot-oauth-state" });
  if (typeof payload.verifier !== "string" || typeof payload.nonce !== "string") throw new ApiError(400, "Invalid sign-in state.");
  const platform = payload.platform === "android" ? "android" : "web";
  const tokenResponse = await fetch("https://api.vercel.com/login/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      code_verifier: payload.verifier,
      redirect_uri: `${appUrl(request)}/api/auth/callback/vercel`,
    }),
  });
  if (!tokenResponse.ok) throw new ApiError(401, "Vercel could not exchange the sign-in code.");
  const tokens = await tokenResponse.json() as TokenResponse;
  if (decodeJwt(tokens.id_token).nonce !== payload.nonce) throw new ApiError(401, "Vercel sign-in nonce mismatch.");
  const profileResponse = await fetch("https://api.vercel.com/login/oauth/userinfo", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileResponse.ok) throw new ApiError(401, "Could not read your Vercel profile.");
  const profile = await profileResponse.json() as VercelProfile;
  assertOwner(profile);
  const user: User = {
    id: profile.sub,
    name: profile.name ?? profile.preferred_username ?? profile.email?.split("@")[0] ?? "Vercel user",
    email: profile.email ?? null,
    avatarUrl: profile.picture ?? null,
  };
  return { user, token: await createSessionToken(user), platform };
}

export async function createSessionToken(user: User): Promise<string> {
  return new SignJWT({ email: user.email, name: user.name, avatarUrl: user.avatarUrl })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setExpirationTime("30d")
    .sign(secret());
}

export async function userFromSessionToken(token: string): Promise<User> {
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: SESSION_ISSUER, audience: SESSION_AUDIENCE });
    if (!payload.sub) throw new Error("Missing subject");
    const profile = { sub: payload.sub } satisfies VercelProfile;
    assertOwner(profile);
    return {
      id: payload.sub,
      name: typeof payload.name === "string" ? payload.name : "Vercel user",
      email: typeof payload.email === "string" ? payload.email : null,
      avatarUrl: typeof payload.avatarUrl === "string" ? payload.avatarUrl : null,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status !== 401) throw error;
    throw new ApiError(401, "Your session has expired. Sign in again.");
  }
}

export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;
}

export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function tokenFromRequest(request: Request): string | null {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;
  const cookies = request.headers.get("cookie") ?? "";
  for (const item of cookies.split(";")) {
    const [name, ...value] = item.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=") || null;
  }
  return null;
}
