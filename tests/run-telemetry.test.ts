import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore } from "../db/file-store";
import {
  appendTraceEvent,
  buildTraceEvent,
  classifyTraceError,
  listTraceEvents,
  sanitizeTraceData,
  sanitizeTraceEvent,
  traceDedupeKey,
  traceToolEnd,
  traceToolStart,
  usageFromResult,
} from "../apps/web/lib/server/run-telemetry";

let directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

async function makeStore() {
  const directory = await mkdtemp(join(tmpdir(), "slop-telemetry-"));
  directories.push(directory);
  return new FileStore(join(directory, "store.json"));
}

async function makeRun(store: FileStore) {
  const bot = await store.createBot("demo-user", {
    name: "Trace Bot",
    handle: `trace_${Math.random().toString(36).slice(2, 8)}`,
    persona: "A bot used to test run telemetry.",
    model: "test/model",
    integrationIds: [],
  });
  const conversation = await store.createConversation("demo-user", {
    title: "Trace",
    botIds: [bot.id],
  });
  const claim = await store.runs.claimRun({
    kind: "message",
    userId: "demo-user",
    conversationId: conversation.id,
    message: { senderType: "user", senderId: "demo-user", content: "Hello" },
  });
  if (claim.outcome !== "claimed") throw new Error("Could not claim run");
  return { bot, conversation, run: claim.run };
}

describe("run telemetry envelope", () => {
  it("drops unknown fields and redacts secrets in the error message", () => {
    const event = sanitizeTraceEvent({
      category: "tool",
      phase: "end",
      status: "error",
      toolName: "mcp_abc_search",
      toolCallId: "call_1",
      input: { query: "private prompt" },
      output: { body: "raw tool result" },
      messages: [{ role: "user", content: "secret" }],
      error: {
        kind: "tool_error",
        message: "Authorization: Bearer sk-live-1234567890abcdef",
      },
    });

    expect(event).not.toBeNull();
    expect(event).not.toHaveProperty("input");
    expect(event).not.toHaveProperty("output");
    expect(event).not.toHaveProperty("messages");
    expect(event?.error?.message).not.toContain("sk-live");
    expect(event?.error?.message).not.toContain("Bearer");
    expect(event?.error?.message).toContain("[REDACTED]");
  });

  it("fails closed for an invalid category or phase", () => {
    expect(sanitizeTraceEvent({ category: "tool" })).toBeNull();
    expect(sanitizeTraceEvent({ category: "unknown", phase: "start" })).toBeNull();
    expect(sanitizeTraceEvent("not an object")).toBeNull();
  });

  it("redacts nested custom payloads and bounds depth", () => {
    const sanitized = sanitizeTraceData({
      apiKey: "sk-live-1234567890abcdef",
      nested: {
        token: "abc",
        password: "hunter2",
        safe: "visible",
        deeper: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" },
      },
      list: [{ secret: "x" }, { safe: "y" }],
      deep: { a: { b: { c: { d: { e: "too deep" } } } } },
    }) as Record<string, unknown>;

    expect(sanitized.apiKey).toBe("[REDACTED]");
    const nested = sanitized.nested as Record<string, unknown>;
    expect(nested.token).toBe("[REDACTED]");
    expect(nested.password).toBe("[REDACTED]");
    expect(nested.safe).toBe("visible");
    const list = sanitized.list as Array<Record<string, unknown>>;
    expect(list[0]?.secret).toBe("[REDACTED]");
    expect(list[1]?.safe).toBe("y");
    expect(JSON.stringify(sanitized)).toContain("[Truncated: max depth]");
  });

  it("redacts high-confidence secrets in nested trace payloads", () => {
    const sanitized = sanitizeTraceData({
      nested: {
        dsn: "mysql://root:s3cret@db.internal/app",
        aws: "AKIAABCDEFGHIJKLMNOP",
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
        safe: "visible",
      },
    }) as Record<string, unknown>;
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("s3cret");
    expect(serialized).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect((sanitized.nested as Record<string, unknown>).safe).toBe("visible");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts connection URLs, AWS keys, JWTs, and session secrets in trace payloads", () => {
    const seeds = [
      "postgres://u:secret@host/db",
      "mysql://x:y@host",
      "AKIA1234567890123456",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456",
      "Bearer abcdefghijklmnop",
      "session_id=abc123def456ghi789",
    ];
    const sanitized = sanitizeTraceData({ note: seeds.join(" | ") }) as Record<string, unknown>;
    const serialized = JSON.stringify(sanitized);
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

  it("leaves a normal queryless URI readable in trace payloads", () => {
    const uri = "https://api.github.com/repos/octocat/hello-world";
    expect(sanitizeTraceData({ note: uri })).toEqual({ note: uri });
  });

  it("builds a typed event and a natural dedupe key", () => {
    const built = buildTraceEvent(traceToolStart({ toolName: "web_search", toolCallId: "call_1" }));
    expect(built?.type).toBe("trace.tool.start");
    expect(built?.data.toolName).toBe("web_search");
    expect(traceDedupeKey(built!.data)).toBe("trace:tool:start:call_1");
  });

  it("reads usage only from the actual result and never invents it", () => {
    expect(
      usageFromResult({ totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    ).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(usageFromResult({ totalUsage: {} })).toBeUndefined();
    expect(usageFromResult({})).toBeUndefined();
    expect(usageFromResult({ totalUsage: { inputTokens: -1 } })).toBeUndefined();
  });

  it("classifies errors into a bounded taxonomy", () => {
    expect(classifyTraceError(new Error("This connection is not enabled for this bot.")).kind).toBe(
      "permission_denied",
    );
    expect(classifyTraceError(new Error("Desktop tool timed out.")).kind).toBe("timeout");
    expect(classifyTraceError(new Error("model provider failed")).kind).toBe("model_error");
    expect(classifyTraceError(new Error("boom")).kind).toBe("tool_error");
    expect(classifyTraceError(undefined).kind).toBe("internal");
  });
});

describe("run telemetry storage", () => {
  it("stores only the allowlisted envelope and dedupes per tool call", async () => {
    const store = await makeStore();
    const { run } = await makeRun(store);

    const malicious = {
      category: "tool",
      phase: "end",
      status: "error",
      toolName: "mcp_abc_search",
      toolCallId: "call_1",
      input: { query: "private prompt" },
      output: { body: "raw tool result" },
      error: { kind: "tool_error", message: "Bearer sk-live-1234567890abcdef" },
    };

    const first = await appendTraceEvent(store, {
      userId: "demo-user",
      runId: run.id,
      event: malicious,
    });
    const second = await appendTraceEvent(store, {
      userId: "demo-user",
      runId: run.id,
      event: malicious,
    });

    expect(first).not.toBeNull();
    expect(second?.id).toBe(first?.id);
    const events = await store.runs.listEvents("demo-user", run.id);
    expect(events).toHaveLength(1);
    const data = events[0]?.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("input");
    expect(data).not.toHaveProperty("output");
    expect(JSON.stringify(data)).not.toContain("sk-live");
    expect(JSON.stringify(data)).not.toContain("private prompt");
    expect(JSON.stringify(data)).not.toContain("raw tool result");
  });

  it("lists only trace events and skips malformed stored rows", async () => {
    const store = await makeStore();
    const { run } = await makeRun(store);

    await store.runs.appendEvent({
      userId: "demo-user",
      runId: run.id,
      type: "succeeded",
      data: { ok: true },
    });
    await store.runs.appendEvent({
      userId: "demo-user",
      runId: run.id,
      type: "trace.tool.end",
      data: { category: "tool" },
    });
    await appendTraceEvent(store, {
      userId: "demo-user",
      runId: run.id,
      event: traceToolEnd({
        toolName: "web_search",
        toolCallId: "call_1",
        durationMs: 12,
        success: true,
      }),
    });

    const traces = await listTraceEvents(store, "demo-user", run.id);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.type).toBe("trace.tool.end");
    expect(traces[0]?.toolName).toBe("web_search");
    expect(traces[0]?.durationMs).toBe(12);
  });

  it("does not expose another user's trace events", async () => {
    const store = await makeStore();
    const { run } = await makeRun(store);
    await appendTraceEvent(store, {
      userId: "demo-user",
      runId: run.id,
      event: traceToolStart({ toolName: "web_search", toolCallId: "call_1" }),
    });

    expect(await listTraceEvents(store, "other-user", run.id)).toEqual([]);
  });
});
