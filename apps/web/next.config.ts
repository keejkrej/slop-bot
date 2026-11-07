import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],
  transpilePackages: ["@slopbot/contracts", "@slopbot/design-tokens"],
  async headers() {
    if (process.env.NODE_ENV !== "development") return [];
    return [{
      source: "/api/:path*",
      headers: [
        { key: "access-control-allow-origin", value: "*" },
        { key: "access-control-allow-methods", value: "GET, POST, DELETE, OPTIONS" },
        { key: "access-control-allow-headers", value: "authorization, content-type" },
      ],
    }];
  },
};

export default withWorkflow(nextConfig);
