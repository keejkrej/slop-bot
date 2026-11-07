import { isGatewayConfigured } from "@/lib/server/auth";

export function GET(): Response {
  return Response.json({
    ok: true,
    service: "slop-bot",
    agentMode: isGatewayConfigured() ? "gateway" : "demo",
  });
}
