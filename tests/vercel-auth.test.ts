import { afterEach, describe, expect, it } from "vitest";
import { createSessionToken, startVercelSignIn, userFromSessionToken } from "../apps/web/lib/server/vercel-auth";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });

describe("single-tenant Vercel sessions", () => {
  it("signs and verifies the approved user's session", async () => {
    process.env.BETTER_AUTH_SECRET = "test-secret-with-enough-entropy-for-tests";
    process.env.ALLOWED_USER_ID = "vercel-user-1";
    const user = { id: "vercel-user-1", name: "Owner", email: "owner@example.com", avatarUrl: null };
    const token = await createSessionToken(user);
    await expect(userFromSessionToken(token)).resolves.toEqual(user);
    process.env.ALLOWED_USER_ID = "another-user";
    await expect(userFromSessionToken(token)).rejects.toThrow();
  });

  it("creates an OIDC URL with PKCE, state, nonce, and the app callback", async () => {
    process.env.BETTER_AUTH_SECRET = "test-secret-with-enough-entropy-for-tests";
    process.env.VERCEL_APP_CLIENT_ID = "cl_test";
    const target = new URL(await startVercelSignIn(new Request("http://localhost:3000/api/auth/vercel"), "android"));
    expect(target.origin).toBe("https://vercel.com");
    expect(target.pathname).toBe("/oauth/authorize");
    expect(target.searchParams.get("client_id")).toBe("cl_test");
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.get("code_challenge")).toBeTruthy();
    expect(target.searchParams.get("state")).toBeTruthy();
    expect(target.searchParams.get("nonce")).toBeTruthy();
    expect(target.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback/vercel");
  });
});
