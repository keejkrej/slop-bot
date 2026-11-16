import { describe, expect, it } from "vitest";
import {
  canonicalArgsDigest,
  canonicalJson,
  sha256Hex,
} from "../apps/web/lib/server/portable-hash";
import { hashMemoryText } from "../apps/web/lib/server/memory-files";
import { approvalIdempotencyKey } from "../workflows/group-chat";

describe("portable sha256", () => {
  it("matches the NIST vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the NIST vector for the empty string", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("canonical JSON argument digests", () => {
  it("sorts object keys recursively so key order does not change the digest", () => {
    const first = canonicalArgsDigest({ b: 2, a: { d: 4, c: 3 } });
    const second = canonicalArgsDigest({ a: { c: 3, d: 4 }, b: 2 });
    expect(first).toBe(second);
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("changes when a value changes and preserves array order", () => {
    expect(canonicalArgsDigest({ title: "Bug" })).not.toBe(canonicalArgsDigest({ title: "Other" }));
    expect(canonicalArgsDigest({ labels: ["a", "b"] })).not.toBe(canonicalArgsDigest({ labels: ["b", "a"] }));
  });

  it("rejects unsupported values instead of coercing them", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow(/Unsupported/);
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/Unsupported/);
    expect(() => canonicalJson({ value: 1n })).toThrow(/Unsupported/);
    expect(() => canonicalJson({ value: new Date() })).toThrow(/Unsupported/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);
  });
});

describe("hashMemoryText", () => {
  it("returns a full 64-char lowercase hex digest", () => {
    expect(hashMemoryText("All quiet.")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is stable for equal content and distinct for different content", () => {
    expect(hashMemoryText("same")).toBe(hashMemoryText("same"));
    expect(hashMemoryText("same")).not.toBe(hashMemoryText("different"));
  });
});

describe("approvalIdempotencyKey", () => {
  it("keeps the approval: prefix and 32-char digest shape", () => {
    expect(approvalIdempotencyKey("run_1", "call_1", "appr_1")).toMatch(/^approval:[a-f0-9]{32}$/);
  });

  it("is stable for the same run and tool call and distinct otherwise", () => {
    const first = approvalIdempotencyKey("run_1", "call_1", "appr_1");
    const second = approvalIdempotencyKey("run_1", "call_1", "appr_1");
    const other = approvalIdempotencyKey("run_1", "call_2", "appr_1");
    expect(first).toBe(second);
    expect(first).not.toBe(other);
  });

  it("derives the digest from the first 32 hex chars of sha256(runId:identity)", () => {
    expect(approvalIdempotencyKey("run_1", "call_1", "appr_1")).toBe(
      `approval:${sha256Hex("run_1:call_1").slice(0, 32)}`,
    );
  });
});
