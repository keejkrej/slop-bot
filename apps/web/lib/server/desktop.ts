import { timingSafeEqual } from "node:crypto";
import type { User } from "@slopbot/contracts";
import { ApiError, appUrl } from "./http";
import { requireUser } from "./auth";

export function requireDesktopUser(request: Request): User {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = process.env.DESKTOP_PAIRING_TOKEN;
  if (!expected && process.env.NODE_ENV !== "production") {
    return { id: "demo-user", name: "Local human", email: null, avatarUrl: null };
  }
  const userId = process.env.DESKTOP_USER_ID;
  if (!expected || !userId) throw new ApiError(503, "Desktop pairing is not configured.");
  const valid = token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!valid) throw new ApiError(401, "Invalid desktop pairing token.");
  return { id: userId, name: "Desktop owner", email: process.env.ALLOWED_EMAIL ?? null, avatarUrl: null };
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
