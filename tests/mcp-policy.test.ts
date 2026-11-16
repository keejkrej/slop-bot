import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertMcpCallAllowed,
  boundMcpResult,
  isReadOnlyToolName,
  isLocalMcpUrl,
  validateMcpUrl,
} from "../apps/web/lib/server/mcp";
import { selectBotConnections } from "../workflows/group-chat";
import { createIntegrationSchema, type Integration } from "@slopbot/contracts";

const executeTool = { name: "COMPOSIO_EXECUTE_TOOL", description: "Execute", inputSchema: {}, readOnly: true };
const multiTool = { ...executeTool, name: "COMPOSIO_MULTI_EXECUTE_TOOL" };
const manageTool = { ...executeTool, name: "COMPOSIO_MANAGE_CONNECTIONS" };

function connection(id: string): Integration {
  return { id, name: id } as Integration;
}

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

  it("recognizes local endpoints for the desktop bridge without weakening public validation", () => {
    expect(isLocalMcpUrl("http://127.0.0.1:3030/mcp")).toBe(true);
    expect(isLocalMcpUrl("http://localhost:3030/mcp")).toBe(true);
    expect(isLocalMcpUrl("https://internal-node.alexandria.so/v1/mcp")).toBe(false);
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

describe("Composio nested execution policy", () => {
  it("rejects a nested executor hidden behind a read-looking top-level slug", () => {
    expect(() => assertMcpCallAllowed(executeTool, {
      tool_slug: "COMPOSIO_EXECUTE_TOOL",
      arguments: { tool_slug: "GMAIL_SEND_EMAIL", arguments: {} },
    })).toThrow(/Nested Composio execution/);
    expect(() => assertMcpCallAllowed(executeTool, {
      tool_slug: "COMPOSIO_MULTI_EXECUTE_TOOL",
      arguments: { tools: [{ tool_slug: "GITHUB_GET_REPOSITORY" }] },
    })).toThrow(/Nested Composio execution/);
  });

  it("rejects nested connection management and writes", () => {
    expect(() => assertMcpCallAllowed(executeTool, {
      tool_slug: "GITHUB_GET_REPOSITORY",
      arguments: { tool_slug: "COMPOSIO_MANAGE_CONNECTIONS", toolkits: [{ action: "remove" }] },
    })).toThrow(/Nested Composio execution/);
    expect(() => assertMcpCallAllowed(executeTool, {
      tool_slug: "GITHUB_GET_REPOSITORY",
      arguments: { tool_slug: "GITHUB_CREATE_ISSUE" },
    })).toThrow(/read operations/);
  });

  it("rejects nested executors inside multi-execute arguments", () => {
    expect(() => assertMcpCallAllowed(multiTool, {
      tools: [{
        tool_slug: "GITHUB_GET_REPOSITORY",
        arguments: { tool_slug: "COMPOSIO_EXECUTE_TOOL", arguments: { tool_slug: "GMAIL_SEND_EMAIL" } },
      }],
    })).toThrow(/Nested Composio execution/);
  });

  it("allows multiple safe nested reads and rejects a mixed batch", () => {
    expect(() => assertMcpCallAllowed(multiTool, {
      tools: [
        { tool_slug: "GITHUB_FIND_PULL_REQUESTS", arguments: { query: "is:pr" } },
        { tool_slug: "GITHUB_GET_REPOSITORY", arguments: { owner: "acme", repo: "app" } },
      ],
    })).not.toThrow();
    expect(() => assertMcpCallAllowed(multiTool, {
      tools: [
        { tool_slug: "GITHUB_FIND_PULL_REQUESTS", arguments: {} },
        { tool_slug: "GMAIL_SEND_EMAIL", arguments: {} },
      ],
    })).toThrow(/read operations/);
  });

  it("does not treat connection management as a read operation", () => {
    expect(isReadOnlyToolName("COMPOSIO_MANAGE_CONNECTIONS")).toBe(false);
    expect(isReadOnlyToolName("COMPOSIO_EXECUTE_TOOL")).toBe(false);
    expect(isReadOnlyToolName("COMPOSIO_MULTI_EXECUTE_TOOL")).toBe(false);
  });

  it("rejects compound slugs that mix a read verb with a destructive verb", () => {
    expect(isReadOnlyToolName("GITHUB_LIST_AND_DELETE_REPO")).toBe(false);
    expect(isReadOnlyToolName("SLACK_GET_AND_ARCHIVE")).toBe(false);
    expect(() => assertMcpCallAllowed(executeTool, {
      tool_slug: "GITHUB_LIST_AND_DELETE_REPO",
    })).toThrow(/read operations/);
    expect(() => assertMcpCallAllowed(executeTool, {
      tool_slug: "SLACK_GET_AND_ARCHIVE",
    })).toThrow(/read operations/);
    expect(() => assertMcpCallAllowed(multiTool, {
      tools: [
        { tool_slug: "GITHUB_FIND_PULL_REQUESTS", arguments: {} },
        { tool_slug: "GITHUB_LIST_AND_DELETE_REPO", arguments: {} },
      ],
    })).toThrow(/read operations/);
  });

  it("bounds argument recursion depth", () => {
    let nested: Record<string, unknown> = { tool_slug: "GITHUB_GET_REPOSITORY" };
    for (let index = 0; index < 12; index += 1) nested = { child: nested };
    expect(() => assertMcpCallAllowed(executeTool, {
      tool_slug: "GITHUB_GET_REPOSITORY",
      arguments: nested,
    })).toThrow(/nested too deeply/);
  });
});

describe("MCP result bounding", () => {
  it("redacts high-confidence sensitive keys in arbitrary structure", () => {
    const result = boundMcpResult({
      apiKey: "secret",
      nested: { password: "hunter2", authorization: "Bearer x", ok: "visible" },
      list: [{ access_token: "abc" }],
    }) as Record<string, unknown>;
    expect(result.apiKey).toBe("[REDACTED]");
    expect((result.nested as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((result.nested as Record<string, unknown>).authorization).toBe("[REDACTED]");
    expect((result.nested as Record<string, unknown>).ok).toBe("visible");
    expect(((result.list as unknown[])[0] as Record<string, unknown>).access_token).toBe("[REDACTED]");
  });

  it("caps depth and collection counts while staying valid JSON", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 20; index += 1) deep = { child: deep };
    const result = boundMcpResult({ deep, items: Array.from({ length: 250 }, (_, index) => index) }) as Record<string, unknown>;
    const items = result.items as unknown[];
    expect(items).toHaveLength(101);
    expect(items[100]).toMatch(/Truncated/);
    expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();
  });

  it("returns a structured envelope instead of sliced invalid JSON", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`field_${index}`, "x ".repeat(2_000)]),
    );
    const result = boundMcpResult(wide) as Record<string, unknown>;
    expect(result.truncated).toBe(true);
    expect(typeof result.content).toBe("string");
    expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();
  });

  it("redacts secret-looking values even under harmless keys", () => {
    const result = boundMcpResult({
      data: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
      note: "sk-abcdefghijklmnop",
      ok: "visible",
    }) as Record<string, unknown>;
    expect(result.data).toBe("[REDACTED]");
    expect(result.note).toBe("[REDACTED]");
    expect(result.ok).toBe("visible");
  });

  it("redacts nested connection URLs, AWS keys, and JWTs in MCP results", () => {
    const result = boundMcpResult({
      nested: {
        dsn: "postgres://admin:s3cret@db.internal/app",
        aws: "AKIAABCDEFGHIJKLMNOP",
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
        safe: "visible",
      },
    }) as Record<string, unknown>;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("s3cret");
    expect(serialized).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect((result.nested as Record<string, unknown>).safe).toBe("visible");
    expect(serialized).toContain("[REDACTED]");
  });

  it("leaves small results intact", () => {
    expect(boundMcpResult({ ok: true, value: 3 })).toEqual({ ok: true, value: 3 });
  });
});

describe("MCP URL SSRF validation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects IPv4-mapped IPv6 loopback, link-local, and metadata literals", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const url of [
      "https://[::ffff:127.0.0.1]/mcp",
      "https://[::ffff:169.254.169.254]/mcp",
      "https://[::ffff:7f00:1]/mcp",
      "https://[::]/mcp",
      "https://[::1]/mcp",
      "https://[fe80::1]/mcp",
      "https://[fd00::1]/mcp",
    ]) {
      await expect(validateMcpUrl(url)).rejects.toThrow(/Private network|Local and metadata/);
    }
  });

  it("still allows a public IPv4-mapped IPv6 literal", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(validateMcpUrl("https://[::ffff:8.8.8.8]/mcp")).resolves.toContain("/mcp");
  });
});

describe("per-bot integration selection", () => {
  it("returns no connections when the bot has no integration ids", () => {
    expect(selectBotConnections([], [connection("a"), connection("b")])).toEqual([]);
  });

  it("returns only the connections assigned to the bot", () => {
    const selected = selectBotConnections(["b"], [connection("a"), connection("b"), connection("c")]);
    expect(selected.map((item) => item.id)).toEqual(["b"]);
  });

  it("ignores ids that do not belong to the user's connections", () => {
    expect(selectBotConnections(["missing"], [connection("a")])).toEqual([]);
  });
});
