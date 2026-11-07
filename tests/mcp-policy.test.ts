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

  it("allows single-tool Composio execution only for reads", () => {
    expect(() => assertMcpCallAllowed(executeTool, { tool_slug: "GITHUB_FIND_PULL_REQUESTS" })).not.toThrow();
    expect(() => assertMcpCallAllowed(executeTool, { tool_slug: "GITHUB_CREATE_ISSUE" })).toThrow(/read operations/);
    expect(() => assertMcpCallAllowed(executeTool, { arguments: {} })).toThrow(/read operations/);
  });

  it("allows multi-execute only when every nested operation is a read", () => {
    const multi = { ...executeTool, name: "COMPOSIO_MULTI_EXECUTE_TOOL" };
    const readCall = { tool_slug: "GITHUB_MCP_SEARCH_PULL_REQUESTS", arguments: { query: "is:pr" } };
    const writeCall = { tool_slug: "GITHUB_CREATE_ISSUE", arguments: {} };
    expect(() => assertMcpCallAllowed(multi, { tools: [readCall] })).not.toThrow();
    expect(() => assertMcpCallAllowed(multi, { tools: [writeCall] })).toThrow(/read operations/);
    expect(() => assertMcpCallAllowed(multi, { tools: [] })).toThrow(/at least one/);
  });

  it("permits auth links and account listing but blocks removal", () => {
    const manage = { ...executeTool, name: "COMPOSIO_MANAGE_CONNECTIONS" };
    expect(() => assertMcpCallAllowed(manage, { toolkits: [{ name: "github_mcp", action: "add" }] })).not.toThrow();
    expect(() => assertMcpCallAllowed(manage, { toolkits: [{ name: "github_mcp", action: "list" }] })).not.toThrow();
    expect(() => assertMcpCallAllowed(manage, { toolkits: [{ name: "github_mcp", action: "remove" }] })).toThrow(/adding and listing/);
  });

  it("blocks non-read tools and dedicated creation presets", () => {
    expect(() => assertMcpCallAllowed({ ...executeTool, readOnly: false }, { tool_slug: "GITHUB_FIND_PULL_REQUESTS" })).toThrow(/Write tools/);
    expect(() => createIntegrationSchema.parse({ kind: "github", url: "https://api.githubcopilot.com/mcp/" })).toThrow();
    expect(() => createIntegrationSchema.parse({ kind: "composio", url: "https://backend.composio.dev/mcp" })).toThrow();
  });

  it("supports custom MCP connections with optional encrypted headers", () => {
    const input = createIntegrationSchema.parse({
      kind: "mcp",
      name: "Composio",
      url: "https://backend.composio.dev/mcp",
      headerName: "x-api-key",
      headerValue: "secret",
    });
    expect(input.headerName).toBe("x-api-key");
  });
});
