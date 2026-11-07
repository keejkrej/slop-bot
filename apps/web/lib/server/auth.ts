import type { User } from "@slopbot/contracts";
import { ApiError } from "./http";
import { tokenFromRequest, userFromSessionToken } from "./vercel-auth";

const DEMO_USER: User = {
  id: "demo-user",
  name: "Local human",
  email: null,
  avatarUrl: null,
};

export async function requireUser(request: Request): Promise<User> {
  const token = tokenFromRequest(request);
  if (token) return userFromSessionToken(token);
  if (process.env.NODE_ENV !== "production") return DEMO_USER;
  throw new ApiError(401, "Sign in with your Vercel account to continue.");
}

export function isGatewayConfigured(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL);
}
