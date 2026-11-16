/**
 * Portable SHA-256 helpers.
 *
 * Workflow functions cannot import Node built-ins such as `node:crypto`, so
 * hashing that runs inside a workflow must use a runtime-neutral implementation.
 * `@noble/hashes` is a small, dependency-free, audited-by-community library that
 * works in Node and browsers alike. These helpers are used for stable identity
 * and content-dedup digests, not as a security boundary.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const encoder = new TextEncoder();

/** Lowercase hex SHA-256 digest of the UTF-8 encoding of `text`. */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(encoder.encode(text)));
}

const MAX_CANONICAL_DEPTH = 32;

/**
 * Deterministic JSON for the JSON value types only. Object keys are sorted
 * recursively so two semantically equal argument objects produce the same
 * bytes regardless of insertion order. Unsupported values (undefined,
 * functions, symbols, bigint, non-finite numbers, cycles) are rejected rather
 * than silently coerced.
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, 0, new Set<object>());
}

function serializeCanonical(value: unknown, depth: number, seen: Set<object>): string {
  if (depth > MAX_CANONICAL_DEPTH) throw new Error("Value is nested too deeply.");
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("Unsupported non-finite number.");
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (seen.has(value)) throw new Error("Unsupported cyclic value.");
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          const items: string[] = [];
          for (let index = 0; index < value.length; index += 1) {
            items.push(serializeCanonical(value[index], depth + 1, seen));
          }
          return `[${items.join(",")}]`;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new Error("Unsupported non-plain object.");
        }
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        const entries = keys.map(
          (key) => `${JSON.stringify(key)}:${serializeCanonical(record[key], depth + 1, seen)}`,
        );
        return `{${entries.join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new Error(`Unsupported value type: ${typeof value}.`);
  }
}

/** Stable SHA-256 digest of the canonical JSON representation of `value`. */
export function canonicalArgsDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
