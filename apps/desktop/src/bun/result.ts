/**
 * Desktop-side adapter that bounds and redacts local MCP results before they
 * leave the machine. The server applies the same policy again, so a buggy or
 * compromised bridge cannot persist an unbounded payload.
 */
const MAX_RESULT_CHARS = 60_000;
const MAX_RESULT_DEPTH = 8;
const MAX_RESULT_ITEMS = 100;
const MAX_RESULT_KEYS = 100;
const MAX_RESULT_STRING = 4_000;
const SENSITIVE_KEY =
	/(?:api[_-]?key|secret|token|password|passwd|authorization|(?:^|[_-])auth(?:$|[_-])|cookie|credential|private[_-]?key|access[_-]?key|client[_-]?secret|session[_-]?id|refresh[_-]?token)/i;
const SECRET_TEXT = /(bearer\s+)[a-z0-9._~+/=-]+/gi;
const SECRET_ASSIGN = /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi;

export function redactDesktopText(value: string): string {
	return value.replace(SECRET_TEXT, "$1[REDACTED]").replace(SECRET_ASSIGN, "$1[REDACTED]");
}

function redactDesktopValue(value: unknown, depth: number): unknown {
	if (depth > MAX_RESULT_DEPTH) return "[Truncated: max depth]";
	if (typeof value === "string") {
		const redacted = redactDesktopText(value);
		return redacted.length > MAX_RESULT_STRING
			? `${redacted.slice(0, MAX_RESULT_STRING)}…[truncated]`
			: redacted;
	}
	if (Array.isArray(value)) {
		const items = value.slice(0, MAX_RESULT_ITEMS).map((item) => redactDesktopValue(item, depth + 1));
		if (value.length > MAX_RESULT_ITEMS) {
			items.push(`[Truncated: ${value.length - MAX_RESULT_ITEMS} more items]`);
		}
		return items;
	}
	if (!value || typeof value !== "object") return value;
	const entries = Object.entries(value as Record<string, unknown>);
	const result: Record<string, unknown> = {};
	for (const [key, child] of entries.slice(0, MAX_RESULT_KEYS)) {
		result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactDesktopValue(child, depth + 1);
	}
	if (entries.length > MAX_RESULT_KEYS) {
		result["__truncated"] = `${entries.length - MAX_RESULT_KEYS} more keys`;
	}
	return result;
}

export function boundDesktopResult(value: unknown): unknown {
	const sanitized = redactDesktopValue(value, 0);
	const serialized = JSON.stringify(sanitized);
	if (serialized === undefined || serialized.length <= MAX_RESULT_CHARS) return sanitized;
	return {
		truncated: true,
		reason: "Desktop tool result exceeded the size limit.",
		content: serialized.slice(0, MAX_RESULT_CHARS - 200),
	};
}
