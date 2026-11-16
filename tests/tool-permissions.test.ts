import { describe, expect, it } from "vitest";
import {
  createIntegrationSchema,
  pendingActionSchema,
  toPublicPendingAction,
  updateIntegrationPolicySchema,
} from "@slopbot/contracts";
import {
  DEFAULT_APPROVAL_TTL_MS,
  classifyToolRisk,
  defaultApprovalExpiresAt,
  isPendingActionExpired,
  isToolAllowedForIntegration,
  normalizeAllowedWriteTools,
  redactToolArgs,
  summarizeToolPermissions,
  toolArgsPreview,
  validateWriteToolGrants,
} from "../apps/web/lib/server/tool-permissions";

describe("tool risk classification", () => {
  it("trusts explicit annotations before name heuristics", () => {
    expect(classifyToolRisk({ name: "GITHUB_CREATE_ISSUE", readOnlyHint: true })).toBe("read");
    expect(classifyToolRisk({ name: "GITHUB_GET_REPOSITORY", destructiveHint: true })).toBe("destructive");
  });

  it("classifies read and write verbs", () => {
    expect(classifyToolRisk({ name: "GITHUB_FIND_PULL_REQUESTS" })).toBe("read");
    expect(classifyToolRisk({ name: "GMAIL_SEND_EMAIL" })).toBe("write");
    expect(classifyToolRisk({ name: "GITHUB_DELETE_REPOSITORY" })).toBe("destructive");
  });

  it("defaults unknown tools to write so they stay denied", () => {
    expect(classifyToolRisk({ name: "SOME_OPAQUE_OPERATION" })).toBe("write");
  });

  it("gives destructive verbs precedence in compound names", () => {
    expect(classifyToolRisk({ name: "GITHUB_LIST_AND_DELETE_REPO" })).toBe("destructive");
    expect(classifyToolRisk({ name: "SLACK_GET_AND_ARCHIVE" })).toBe("destructive");
    expect(classifyToolRisk({ name: "GITHUB_LIST_AND_DELETE_REPO", readOnlyHint: true })).toBe("destructive");
  });

  it("treats a read verb before a compound write as a write", () => {
    expect(classifyToolRisk({ name: "GITHUB_LIST_AND_CREATE_ISSUE" })).toBe("write");
    expect(classifyToolRisk({ name: "GITHUB_LIST_AND_CREATE_ISSUE", readOnlyHint: true })).toBe("write");
    expect(classifyToolRisk({ name: "GITHUB_LIST_AND_CREATE_ISSUE", readOnly: true })).toBe("write");
    expect(classifyToolRisk({ name: "GITHUB_LIST_AND_CREATE" })).toBe("write");
    expect(classifyToolRisk({ name: "GITHUB_GET_AND_ARCHIVE" })).toBe("destructive");
  });

  it("keeps destructive compound terms ahead of read verbs", () => {
    expect(classifyToolRisk({ name: "GITHUB_LIST_AND_DELETE" })).toBe("destructive");
    expect(classifyToolRisk({ name: "GITHUB_LIST_AND_ARCHIVE" })).toBe("destructive");
    expect(classifyToolRisk({ name: "GITHUB_LIST_AND_DELETE", readOnlyHint: true })).toBe("destructive");
    expect(classifyToolRisk({ name: "GITHUB_LIST_AND_ARCHIVE", readOnly: true })).toBe("destructive");
  });

  it("keeps genuinely pure read names as reads", () => {
    for (const name of ["GITHUB_GET", "GITHUB_LIST", "GITHUB_READ"]) {
      expect(classifyToolRisk({ name })).toBe("read");
      expect(classifyToolRisk({ name, readOnlyHint: true })).toBe("read");
      expect(classifyToolRisk({ name, readOnly: true })).toBe("read");
    }
  });

  it("keeps pure read operations safe", () => {
    for (const name of ["GITHUB_READ_FILE", "GITHUB_LIST_REPOSITORIES", "GITHUB_GET_ISSUE_COMMENT"]) {
      expect(classifyToolRisk({ name })).toBe("read");
      expect(classifyToolRisk({ name, readOnly: true })).toBe("read");
    }
  });

  it("only lets the legacy read flag confirm a true simple read", () => {
    expect(classifyToolRisk({ name: "GITHUB_CREATE_ISSUE", readOnly: true })).toBe("write");
    expect(classifyToolRisk({ name: "SOME_OPAQUE_OPERATION", readOnly: true })).toBe("write");
    expect(classifyToolRisk({ name: "GITHUB_GET_REPOSITORY", readOnly: true })).toBe("read");
  });

  it("never treats Composio executors as reads", () => {
    expect(classifyToolRisk({ name: "COMPOSIO_EXECUTE_TOOL", readOnlyHint: true })).toBe("write");
    expect(classifyToolRisk({ name: "COMPOSIO_MULTI_EXECUTE_TOOL" })).toBe("write");
    expect(classifyToolRisk({ name: "COMPOSIO_MANAGE_CONNECTIONS" })).toBe("write");
  });
});

describe("per-integration write allowlist", () => {
  it("always allows reads and denies writes by default", () => {
    expect(isToolAllowedForIntegration({ toolName: "GITHUB_GET_REPOSITORY", risk: "read", allowedWriteTools: [] })).toBe(true);
    expect(isToolAllowedForIntegration({ toolName: "GITHUB_CREATE_ISSUE", risk: "write", allowedWriteTools: [] })).toBe(false);
  });

  it("allows only explicitly granted write tools", () => {
    expect(isToolAllowedForIntegration({ toolName: "GITHUB_CREATE_ISSUE", risk: "write", allowedWriteTools: ["GITHUB_CREATE_ISSUE"] })).toBe(true);
    expect(isToolAllowedForIntegration({ toolName: "GITHUB_DELETE_REPOSITORY", risk: "destructive", allowedWriteTools: ["GITHUB_CREATE_ISSUE"] })).toBe(false);
  });

  it("denies Composio nested executors no matter what is granted", () => {
    for (const name of ["COMPOSIO_EXECUTE_TOOL", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_MANAGE_CONNECTIONS"]) {
      expect(isToolAllowedForIntegration({ toolName: name, risk: "write", allowedWriteTools: [name] })).toBe(false);
    }
  });

  it("rejects wildcards, invalid names, and oversized allowlists", () => {
    expect(() => normalizeAllowedWriteTools(["*"])).toThrow(/plain tool names/);
    expect(() => normalizeAllowedWriteTools(["all"])).toThrow(/plain tool names/);
    expect(() => normalizeAllowedWriteTools(["bad name"])).toThrow(/plain tool names/);
    expect(() => normalizeAllowedWriteTools(Array.from({ length: 21 }, (_, index) => `TOOL_${index}`))).toThrow(/At most/);
    expect(() => normalizeAllowedWriteTools(["COMPOSIO_EXECUTE_TOOL"])).toThrow(/Composio/);
  });

  it("dedupes and validates grants against the live listing", () => {
    const known = [
      { name: "GITHUB_CREATE_ISSUE", risk: "write" as const },
      { name: "GITHUB_GET_REPOSITORY", risk: "read" as const },
    ];
    expect(validateWriteToolGrants(["GITHUB_CREATE_ISSUE", "GITHUB_CREATE_ISSUE"], known)).toEqual(["GITHUB_CREATE_ISSUE"]);
    expect(() => validateWriteToolGrants(["GITHUB_GET_REPOSITORY"], known)).toThrow(/not a grantable write tool/);
    expect(() => validateWriteToolGrants(["UNKNOWN_TOOL"], known)).toThrow(/Unknown tool/);
  });

  it("summarizes live tools without marking unlisted writes as permitted", () => {
    const summaries = summarizeToolPermissions([
      { name: "GITHUB_GET_REPOSITORY", description: "Read a repo", risk: "read" },
      { name: "GITHUB_CREATE_ISSUE", description: "Create an issue", risk: "write" },
      { name: "COMPOSIO_EXECUTE_TOOL", description: "Execute", risk: "write" },
    ], ["GITHUB_CREATE_ISSUE", "COMPOSIO_EXECUTE_TOOL"]);
    expect(summaries.find((tool) => tool.name === "GITHUB_GET_REPOSITORY")?.allowed).toBe(true);
    expect(summaries.find((tool) => tool.name === "GITHUB_CREATE_ISSUE")?.allowed).toBe(true);
    expect(summaries.find((tool) => tool.name === "COMPOSIO_EXECUTE_TOOL")?.allowed).toBe(false);
  });
});

describe("tool argument redaction", () => {
  it("redacts sensitive keys and secret-looking values", () => {
    const redacted = redactToolArgs({
      apiKey: "visible-but-keyed",
      nested: { password: "hunter2", authorization: "Bearer abc", ok: "visible" },
      token: "sk-abcdefghijklmnop",
      note: "hello",
    });
    expect(redacted.apiKey).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).authorization).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).ok).toBe("visible");
    expect(redacted.token).toBe("[REDACTED]");
    expect(redacted.note).toBe("hello");
  });

  it("redacts high-confidence secrets in nested approval arguments", () => {
    const redacted = redactToolArgs({
      note: "connect with postgres://admin:s3cret@db.internal/app",
      harmless: {
        aws: "AKIAABCDEFGHIJKLMNOP",
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
        bearer: "Bearer abcdefghijklmnop",
      },
      assignment: "password=hunter2",
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("s3cret");
    expect(serialized).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(serialized).not.toContain("abcdefghijklmnop");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts connection URLs, AWS keys, JWTs, and session secrets in field strings", () => {
    const seeds = [
      "postgres://u:secret@host/db",
      "mysql://x:y@host",
      "AKIA1234567890123456",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456",
      "Bearer abcdefghijklmnop",
      "session_id=abc123def456ghi789",
    ];
    const redacted = redactToolArgs({ note: seeds.join(" | ") });
    const serialized = JSON.stringify(redacted);
    for (const seed of seeds) {
      expect(serialized).not.toContain(seed);
    }
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("AKIA1234567890123456");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(serialized).not.toContain("abcdefghijklmnop");
    expect(serialized).not.toContain("abc123def456ghi789");
    expect(serialized).toContain("[REDACTED]");
  });

  it("leaves a normal queryless URI readable", () => {
    const uri = "https://api.github.com/repos/octocat/hello-world";
    expect(redactToolArgs({ note: uri }).note).toBe(uri);
  });

  it("bounds depth, collection sizes, and preview length", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 12; index += 1) deep = { child: deep };
    const redacted = redactToolArgs({ deep, items: Array.from({ length: 80 }, (_, index) => index) });
    expect((redacted.items as unknown[]).length).toBe(51);
    expect(toolArgsPreview({ body: "x".repeat(2_000) }).length).toBeLessThanOrEqual(400);
  });
});

describe("approval expiry", () => {
  it("treats null legacy deadlines as not expired", () => {
    expect(isPendingActionExpired({ expiresAt: null })).toBe(false);
  });

  it("expires at or after the deadline and fails closed on invalid dates", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(isPendingActionExpired({ expiresAt: "2026-01-01T00:00:00.000Z" }, now)).toBe(true);
    expect(isPendingActionExpired({ expiresAt: "2026-01-02T00:00:00.000Z" }, now)).toBe(false);
    expect(isPendingActionExpired({ expiresAt: "not-a-date" }, now)).toBe(true);
  });

  it("assigns a bounded default deadline", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(defaultApprovalExpiresAt(now)).toBe(new Date(now.getTime() + DEFAULT_APPROVAL_TTL_MS).toISOString());
  });
});

describe("approval and integration contracts", () => {
  it("parses a public approval DTO without model messages or raw args", () => {
    const dto = toPublicPendingAction({
      id: "approval_1",
      botId: "bot_1",
      kind: "tool_approval",
      summary: "Create an issue",
      status: "pending",
      toolName: "GITHUB_CREATE_ISSUE",
      toolArgsRedacted: { title: "Bug" },
      toolRisk: "write",
      expiresAt: "2026-01-02T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(dto.toolRisk).toBe("write");
    expect(dto.toolArgsRedacted).toEqual({ title: "Bug" });
    expect("modelMessages" in dto).toBe(false);
    expect(pendingActionSchema.parse(dto).toolName).toBe("GITHUB_CREATE_ISSUE");
  });

  it("defaults legacy approval risk to read", () => {
    const dto = toPublicPendingAction({
      id: "approval_legacy",
      botId: "bot_1",
      kind: "tool_approval",
      summary: "Legacy",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(dto.toolRisk).toBe("read");
    expect(dto.toolName).toBeNull();
    expect(dto.expiresAt).toBeNull();
  });

  it("accepts integration policy input and defaults new integrations to no writes", () => {
    expect(updateIntegrationPolicySchema.parse({ allowedWriteTools: ["GITHUB_CREATE_ISSUE"] }).allowedWriteTools).toEqual(["GITHUB_CREATE_ISSUE"]);
    expect(() => updateIntegrationPolicySchema.parse({ allowedWriteTools: ["*"] })).toThrow();
    expect(createIntegrationSchema.parse({ kind: "mcp" }).allowedWriteTools).toEqual([]);
  });
});
