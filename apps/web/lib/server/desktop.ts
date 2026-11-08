import { timingSafeEqual } from "node:crypto";
import type { User } from "@slopbot/contracts";
import { ApiError, appUrl } from "./http";
import { requireUser } from "./auth";
import { userFromSessionToken } from "./vercel-auth";

export async function requireDesktopUser(request: Request): Promise<User> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = process.env.DESKTOP_PAIRING_TOKEN;
  const userId = process.env.DESKTOP_USER_ID;
  if (expected && userId && token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    return { id: userId, name: "Desktop owner", email: null, avatarUrl: null };
  }
  if (process.env.NODE_ENV !== "production") {
    return { id: "demo-user", name: "Local human", email: null, avatarUrl: null };
  }
  if (token) return userFromSessionToken(token);
  if (!userId) throw new ApiError(503, "Desktop pairing is not configured.");
  throw new ApiError(401, "Sign in through the desktop app or provide a pairing token.");
}

export async function desktopPairing(request: Request): Promise<{ apiUrl: string; token: string }> {
  await requireUser(request);
  if (process.env.NODE_ENV !== "production" && !process.env.DESKTOP_PAIRING_TOKEN) {
    return { apiUrl: appUrl(request), token: "local-development" };
  }
  const token = process.env.DESKTOP_PAIRING_TOKEN;
  if (!token) throw new ApiError(503, "Desktop pairing is not configured.");
  return { apiUrl: appUrl(request), token };
}
