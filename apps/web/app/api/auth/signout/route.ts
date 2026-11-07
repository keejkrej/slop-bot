import { clearSessionCookie } from "@/lib/server/vercel-auth";

export function POST(): Response {
  return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
}
