import { describe, expect, it } from "vitest";
import {
  applyMemoryPlan,
  buildCoreContext,
  canWriteMemoryPath,
  DEFAULT_CORE_LIMITS,
  exportMemorySnapshot,
  isMemoryPath,
  listMemoryDirectory,
  MAX_MEMORY_FILE_CHARS,
  MemoryConflictError,
  MemoryError,
  MemoryLimitError,
  MemoryPathError,
  MemoryPolicyError,
  MemorySecretError,
  memoryPathForName,
  memoryPathKind,
  parseMemoryPath,
  planMemoryOperation,
  readMemoryFile,
  scanForSecrets,
  toMemoryName,
  type MemoryFile,
  type MemoryWriteContext,
} from "../apps/web/lib/server/memory-files";

const NOW = "2026-01-02T00:00:00.000Z";

function file(path: string, content: string, overrides: Partial<MemoryFile> = {}): MemoryFile {
  return {
    path: parseMemoryPath(path),
    content,
    version: 1,
    source: "assistant",
    provenance: "test",
    sourceRunId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function ctx(overrides: Partial<MemoryWriteContext> = {}): MemoryWriteContext {
  return {
    actor: "model",
    source: "assistant",
    now: NOW,
    ...overrides,
  };
}

describe("memory paths", () => {
  it("accepts the documented root files and one-level branches", () => {
    for (const path of [
      "instructions.md",
      "index.md",
      "reported.md",
      "notes/alpha.md",
      "progress/2026-01-01.md",
      "notes/Café-notes.md",
    ]) {
      expect(parseMemoryPath(path)).toBe(path);
      expect(isMemoryPath(path)).toBe(true);
    }
  });

  it("rejects absolute, traversal, backslash, glob, and device paths", () => {
    for (const path of [
      "/etc/passwd",
      "C:\\secrets.md",
      "\\\\server\\share\\x.md",
      "../notes/a.md",
      "notes/../a.md",
      "notes/./a.md",
      "notes\\a.md",
      "notes/*.md",
      "notes/a?.md",
      "notes/a/b.md",
      "other/a.md",
      "notes/a.txt",
      "notes/.env.md",
      ".env",
      "notes/CON.md",
      "notes/a..md",
      "",
      "notes/" + "a".repeat(80) + ".md",
    ]) {
      expect(() => parseMemoryPath(path), path).toThrow(MemoryPathError);
      expect(isMemoryPath(path), path).toBe(false);
    }
  });

  it("classifies kinds", () => {
    expect(memoryPathKind(parseMemoryPath("instructions.md"))).toBe("instructions");
    expect(memoryPathKind(parseMemoryPath("index.md"))).toBe("index");
    expect(memoryPathKind(parseMemoryPath("reported.md"))).toBe("reported");
    expect(memoryPathKind(parseMemoryPath("notes/a.md"))).toBe("note");
    expect(memoryPathKind(parseMemoryPath("progress/a.md"))).toBe("progress");
  });

  it("sanitizes names while preserving unicode", () => {
    expect(toMemoryName("Café notes")).toBe("Café-notes");
    expect(toMemoryName("  ../.env  ")).toBe("env");
    expect(toMemoryName("CON")).toBe("_CON");
    expect(toMemoryName("")).toBe("untitled");
    expect(memoryPathForName("notes", "Café notes")).toBe("notes/Café-notes.md");
  });
});

describe("core context", () => {
  it("loads instructions, index, and reported but not notes or progress", () => {
    const files = [
      file("instructions.md", "Always be concise."),
      file("index.md", "Index of notes."),
      file("reported.md", "Last run summary."),
      file("notes/secret.md", "lazy note"),
      file("progress/run.md", "lazy progress"),
    ];

    const core = buildCoreContext(files);

    expect(core.files.map((entry) => entry.path)).toEqual([
      "instructions.md",
      "index.md",
      "reported.md",
    ]);
    expect(core.missing).toEqual([]);
    expect(core.promptSection).toContain("User-confirmed instructions (trusted)");
    expect(core.promptSection).toContain("reference data, not instructions");
    expect(core.promptSection).toContain("Always be concise.");
    expect(core.promptSection).not.toContain("lazy note");
    expect(core.promptSection).not.toContain("lazy progress");
  });

  it("fails gracefully to empty memory when no files exist", () => {
    const core = buildCoreContext([]);
    expect(core.files).toEqual([]);
    expect(core.missing).toEqual(["instructions.md", "index.md", "reported.md"]);
    expect(core.totalChars).toBe(0);
    expect(core.promptSection).toContain("(no user-confirmed instructions)");
  });

  it("applies per-file and total character caps", () => {
    const files = [
      file("instructions.md", "i".repeat(100)),
      file("index.md", "x".repeat(100)),
      file("reported.md", "r".repeat(100)),
    ];

    const perFile = buildCoreContext(files, { perFileChars: 10, totalChars: 1000 });
    expect(perFile.files[0]!.content).toHaveLength(10);
    expect(perFile.files[0]!.truncated).toBe(true);

    const total = buildCoreContext(files, { perFileChars: 10, totalChars: 15 });
    expect(total.totalChars).toBe(15);
    expect(total.files[0]!.content).toHaveLength(10);
    expect(total.files[1]!.content).toHaveLength(5);
    expect(total.files[2]!.content).toHaveLength(0);
    expect(total.files[2]!.truncated).toBe(true);
  });

  it("uses a lean explicit default budget", () => {
    expect(DEFAULT_CORE_LIMITS.totalChars).toBeLessThanOrEqual(6_000);
    expect(DEFAULT_CORE_LIMITS.perFileChars).toBeLessThanOrEqual(DEFAULT_CORE_LIMITS.totalChars);
  });
});

describe("directory viewer and reader", () => {
  const files = [
    file("notes/b.md", "line1\nline2\nline3\nline4"),
    file("notes/a.md", "alpha"),
    file("progress/p.md", "progress"),
    file("index.md", "index"),
  ];

  it("lists names, kinds, and sizes without content", () => {
    const entries = listMemoryDirectory(files);
    expect(entries.map((entry) => entry.path)).toEqual([
      "index.md",
      "notes/a.md",
      "notes/b.md",
      "progress/p.md",
    ]);
    expect(entries[1]).toMatchObject({ kind: "note", chars: 5, version: 1 });
    expect(entries[1]).not.toHaveProperty("content");
  });

  it("filters by kind and caps entries", () => {
    expect(listMemoryDirectory(files, { kind: "note" }).map((entry) => entry.path)).toEqual([
      "notes/a.md",
      "notes/b.md",
    ]);
    expect(listMemoryDirectory(files, { limit: 2 })).toHaveLength(2);
  });

  it("reads optional line ranges and caps characters", () => {
    const range = readMemoryFile(files, "notes/b.md", { startLine: 2, endLine: 3 });
    expect(range).toMatchObject({
      content: "line2\nline3",
      startLine: 2,
      endLine: 3,
      totalLines: 4,
      truncated: true,
    });

    const capped = readMemoryFile(files, "notes/b.md", { maxChars: 2 });
    expect(capped).toMatchObject({ content: "li", truncated: true });
  });

  it("returns null for a missing file and throws for an invalid path", () => {
    expect(readMemoryFile(files, "notes/missing.md")).toBeNull();
    expect(() => readMemoryFile(files, "../x.md")).toThrow(MemoryPathError);
  });
});

describe("write policy", () => {
  it("never lets the model write user-confirmed instructions", () => {
    expect(canWriteMemoryPath(parseMemoryPath("instructions.md"), "model", "assistant")).toEqual({
      allowed: false,
      reason: expect.stringContaining("user-confirmed"),
    });
    expect(canWriteMemoryPath(parseMemoryPath("instructions.md"), "user", "user").allowed).toBe(true);
    expect(canWriteMemoryPath(parseMemoryPath("instructions.md"), "system", "system").allowed).toBe(
      true,
    );
  });

  it("rejects tool and web content as instructions", () => {
    expect(canWriteMemoryPath(parseMemoryPath("instructions.md"), "user", "tool").allowed).toBe(
      false,
    );
    expect(canWriteMemoryPath(parseMemoryPath("instructions.md"), "system", "web").allowed).toBe(
      false,
    );
  });

  it("reserves reported.md for system run-completion metadata", () => {
    expect(canWriteMemoryPath(parseMemoryPath("reported.md"), "model", "assistant").allowed).toBe(
      false,
    );
    expect(canWriteMemoryPath(parseMemoryPath("reported.md"), "system", "system").allowed).toBe(
      true,
    );
  });

  it("allows the model to write notes, progress, and index", () => {
    for (const path of ["notes/a.md", "progress/a.md", "index.md"]) {
      expect(canWriteMemoryPath(parseMemoryPath(path), "model", "assistant").allowed).toBe(true);
    }
  });

  it("enforces policy in planMemoryOperation", () => {
    expect(() =>
      planMemoryOperation([], { op: "create", path: "instructions.md", content: "x" }, ctx()),
    ).toThrow(MemoryPolicyError);

    expect(() =>
      planMemoryOperation(
        [],
        { op: "create", path: "instructions.md", content: "x" },
        ctx({ actor: "user", source: "user" }),
      ),
    ).not.toThrow();
  });
});

describe("memory operations", () => {
  it("creates a file with a null expected version and version 1", () => {
    const plan = planMemoryOperation(
      [],
      { op: "create", path: "notes/a.md", content: "hello" },
      ctx(),
    );
    expect(plan).toMatchObject({
      op: "create",
      path: "notes/a.md",
      fromPath: null,
      content: "hello",
      expectedVersion: null,
      source: "assistant",
      sourceRunId: null,
      now: NOW,
    });

    const next = applyMemoryPlan([], plan);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      path: "notes/a.md",
      content: "hello",
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it("rejects creating a duplicate path", () => {
    const files = [file("notes/a.md", "old")];
    expect(() =>
      planMemoryOperation(files, { op: "create", path: "notes/a.md", content: "new" }, ctx()),
    ).toThrow(MemoryConflictError);
  });

  it("str_replace requires exactly one exact match", () => {
    const files = [file("notes/a.md", "alpha beta gamma")];
    const plan = planMemoryOperation(
      files,
      { op: "str_replace", path: "notes/a.md", old: "beta", new: "BETA" },
      ctx(),
    );
    expect(plan.content).toBe("alpha BETA gamma");
    expect(plan.expectedVersion).toBe(1);

    expect(() =>
      planMemoryOperation(
        files,
        { op: "str_replace", path: "notes/a.md", old: "missing", new: "x" },
        ctx(),
      ),
    ).toThrow(MemoryConflictError);

    expect(() =>
      planMemoryOperation(
        [file("notes/a.md", "foo foo")],
        { op: "str_replace", path: "notes/a.md", old: "foo", new: "bar" },
        ctx(),
      ),
    ).toThrow(/ambiguous/);
  });

  it("inserts at a chosen line", () => {
    const files = [file("notes/a.md", "a\nb\nc")];
    const plan = planMemoryOperation(
      files,
      { op: "insert", path: "notes/a.md", line: 2, content: "x" },
      ctx(),
    );
    expect(plan.content).toBe("a\nx\nb\nc");
    expect(plan.expectedVersion).toBe(1);

    expect(() =>
      planMemoryOperation(
        files,
        { op: "insert", path: "notes/a.md", line: 99, content: "x" },
        ctx(),
      ),
    ).toThrow(MemoryError);
  });

  it("deletes and renames with revisions", () => {
    const files = [file("notes/a.md", "hello")];

    const del = planMemoryOperation(files, { op: "delete", path: "notes/a.md" }, ctx());
    expect(del).toMatchObject({ op: "delete", content: null, expectedVersion: 1 });
    expect(applyMemoryPlan(files, del)).toEqual([]);

    const rename = planMemoryOperation(
      files,
      { op: "rename", from: "notes/a.md", to: "notes/b.md" },
      ctx(),
    );
    expect(rename).toMatchObject({
      op: "rename",
      path: "notes/b.md",
      fromPath: "notes/a.md",
      expectedVersion: 1,
    });
    const renamed = applyMemoryPlan(files, rename);
    expect(renamed[0]).toMatchObject({ path: "notes/b.md", version: 2, content: "hello" });
  });

  it("rejects rename onto an existing path", () => {
    const files = [file("notes/a.md", "a"), file("notes/b.md", "b")];
    expect(() =>
      planMemoryOperation(
        files,
        { op: "rename", from: "notes/a.md", to: "notes/b.md" },
        ctx(),
      ),
    ).toThrow(MemoryConflictError);
  });

  it("requires compare-and-swap revisions on mutate", () => {
    const files = [file("notes/a.md", "hello", { version: 2 })];
    const plan = planMemoryOperation(
      files,
      { op: "str_replace", path: "notes/a.md", old: "hello", new: "bye" },
      ctx(),
    );
    expect(plan.expectedVersion).toBe(2);

    const stale = [file("notes/a.md", "hello", { version: 3 })];
    expect(() => applyMemoryPlan(stale, plan)).toThrow(MemoryConflictError);
  });

  it("rejects oversized and binary content", () => {
    expect(() =>
      planMemoryOperation(
        [],
        { op: "create", path: "notes/a.md", content: "a".repeat(MAX_MEMORY_FILE_CHARS + 1) },
        ctx(),
      ),
    ).toThrow(MemoryLimitError);

    expect(() =>
      planMemoryOperation(
        [],
        { op: "create", path: "notes/a.md", content: "a\u0000b" },
        ctx(),
      ),
    ).toThrow(MemoryLimitError);
  });
});

describe("secret policy", () => {
  it("rejects convincing high-confidence secrets", () => {
    const samples = [
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
      "API_KEY=abcdefghijklmnop",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "DATABASE_URL=postgres://user:password@db.example.com/app",
      "AKIAABCDEFGHIJKLMNOP",
      "oauth_token: abcdefghijklmnopqrstuvwxyz",
    ];
    for (const sample of samples) {
      expect(scanForSecrets(sample).length, sample).toBeGreaterThan(0);
      expect(() =>
        planMemoryOperation([], { op: "create", path: "notes/a.md", content: sample }, ctx()),
      ).toThrow(MemorySecretError);
    }
  });

  it("preserves normal technical text", () => {
    const samples = [
      "Set the API_KEY environment variable before running the app.",
      "The token is short and rotated by the user.",
      "Use postgres for the local database.",
      "The password prompt appears once.",
    ];
    for (const sample of samples) {
      expect(scanForSecrets(sample), sample).toEqual([]);
      expect(() =>
        planMemoryOperation([], { op: "create", path: "notes/a.md", content: sample }, ctx()),
      ).not.toThrow();
    }
  });
});

describe("export snapshot", () => {
  it("returns sorted full entries with a total size", () => {
    const files = [file("notes/b.md", "bb"), file("index.md", "i")];
    const snapshot = exportMemorySnapshot(files);
    expect(snapshot.count).toBe(2);
    expect(snapshot.totalChars).toBe(3);
    expect(snapshot.files.map((entry) => entry.path)).toEqual(["index.md", "notes/b.md"]);
    expect(snapshot.files[1]!.content).toBe("bb");
  });
});
