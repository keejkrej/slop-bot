import { createClient } from "@supabase/supabase-js";
import type { User } from "@slopbot/contracts";
import { ApiError } from "./http";

const DEMO_USER: User = {
  id: "demo-user",
  name: "Local human",
  email: null,
  avatarUrl: null,
};

export async function requireUser(request: Request): Promise<User> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (url && key) {
    if (!token) throw new ApiError(401, "Sign in to continue.");
    const supabase = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) throw new ApiError(401, "Your session has expired. Sign in again.");
    const allowedEmail = process.env.ALLOWED_EMAIL?.trim().toLowerCase();
    if (allowedEmail && data.user.email?.toLowerCase() !== allowedEmail) {
      throw new ApiError(403, "This Google account isn't allowed to use this personal deployment.");
    }
    if (process.env.NODE_ENV === "production" && !allowedEmail) {
      throw new ApiError(503, "ALLOWED_EMAIL is required for this single-tenant deployment.");
    }
    return {
      id: data.user.id,
      name: data.user.user_metadata.full_name ?? data.user.user_metadata.name ?? data.user.email?.split("@")[0] ?? "Member",
      email: data.user.email ?? null,
      avatarUrl: data.user.user_metadata.avatar_url ?? null,
    };
  }

  if (process.env.NODE_ENV !== "production") return DEMO_USER;
  throw new ApiError(503, "Supabase authentication is not configured.");
}

export function isGatewayConfigured(): boolean {
  return Boolean(
    process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL,
  );
}
