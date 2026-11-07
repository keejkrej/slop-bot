import { afterEach, describe, expect, it } from "vitest";
import { absoluteAppUrl } from "../apps/web/lib/server/http";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });

describe("OAuth redirects", () => {
  it("uses an absolute application URL for web callbacks", () => {
    process.env.APP_URL = "https://slop-bot.vercel.app";
    expect(absoluteAppUrl(new Request("https://slop-bot.vercel.app/api/oauth/mcp/callback"), "/?view=connections&status=connected"))
      .toBe("https://slop-bot.vercel.app/?view=connections&status=connected");
  });

  it("preserves native app callback schemes", () => {
    expect(absoluteAppUrl(new Request("http://localhost:3000"), "slopbot://integrations?status=connected"))
      .toBe("slopbot://integrations?status=connected");
  });
});
