/**
 * Portable, pure high-confidence secret redaction.
 *
 * This module deliberately has no store, network, or workflow imports so the
 * tool-permission layer, run telemetry, and the MCP result boundary can share
 * one implementation. It only redacts shapes that are confidently secret; it is
 * not a universal guarantee and must not be treated as one.
 */

export const REDACTED = "[REDACTED]";

/** Connection URLs with credentials: mask the whole userinfo, keep the scheme. */
const CONNECTION_URL =
  /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/)[^\s:@/]+:[^\s@/]+@/gi;

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // PEM private keys.
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Authorization headers (Bearer/Basic) and bare bearer tokens.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi,
  // JWT compact tokens.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // KEY=value assignments for common secret names.
  /\b[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET)[A-Z0-9_]*\s*[:=]\s*["']?[^\s,;]{4,}/gi,
  /\b(?:oauth|access|refresh)[_-]?token\s*[:=]\s*["']?[A-Za-z0-9\-._~+/]{8,}/gi,
  // Session identifiers/tokens are credentials too.
  /\bsession[_-]?(?:id|token|key)\s*[:=]\s*["']?[^\s,;]{4,}/gi,
  // Provider token prefixes.
  /\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Long base64-ish opaque tokens (legacy helper behavior).
  /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_-])/g,
];

/**
 * Replace high-confidence secret shapes in free-form text. Structural text
 * around a secret is preserved so JSON payloads stay valid after redaction.
 */
export function redactSensitiveText(value: string): string {
  let text = value.replace(CONNECTION_URL, `$1${REDACTED}@`);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, REDACTED);
  }
  return text;
}
