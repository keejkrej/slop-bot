import { describe, expect, it } from "vitest";
import { assertMcpCallAllowed, isReadOnlyToolName } from "../apps/web/lib/server/mcp";
import { createIntegrationSchema } from "@slopbot/contracts";

const executeTool = { name: "COMPOSIO_EXECUTE_TOOL", description: "Execute", inputSchema: {}, readOnly: true };

describe("MCP read-only execution policy", () => {
  it("recognizes read operations without relying on annotations", () => {
    expect(isReadOnlyToolName("GITHUB_FIND_PULL_REQUESTS")).toBe(true);
    expect(isReadOnlyToolName("GITHUB_GET_REPOSITORY")).toBe(true);
    expect(isReadOnlyToolName("GITHUB_CREATE_ISSUE")).toBe(false);
    expect(isReadOnlyToolName("GMAIL_SEND_EMAIL")).toBe(false);
  });

  it("allows Composio execution only when the underlying operation is a read", () => {
    expect(() => assertMcpCallAllowed(executeTool, { tool_slug: "GITHUB_FIND_PULL_REQUESTS" })).not.toThrow();
    expect(() => assertMcpCallAllowed(executeTool, { tool_slug: "GITHUB_CREATE_ISSUE" })).toThrow(/read operations/);
    expect(() => assertMcpCallAllowed(executeTool, { arguments: {} })).toThrow(/read operations/);
  });

  it("blocks a non-read tool even if its name is nested inside a read operation", () => {
    expect(() => assertMcpCallAllowed({ ...executeTool, readOnly: false }, { tool_slug: "GITHUB_FIND_PULL_REQUESTS" })).toThrow(/Write tools/);
  });

  it("uses one custom MCP creation flow with optional headers", () => {
    const input = createIntegrationSchema.parse({ kind: "mcp", name: "Composio", url: "https://backend.composio.dev/mcp", headerName: "x-api-key", headerValue: "secret" });
    expect(input.headerName).toBe("x-api-key");
    expect(() => createIntegrationSchema.parse({ kind: "github", url: "https://api.githubcopilot.com/mcp/" })).toThrow();
    expect(() => createIntegrationSchema.parse({ kind: "composio", url: "https://backend.composio.dev/mcp" })).toThrow();
  });
});
