"use client";

import type { ActivityTrace } from "@/lib/client/api";

function formatDuration(ms?: number): string | null {
  if (ms === undefined) return null;
  if (ms < 1_000) return `${ms} ms`;
  return `${(ms / 1_000).toFixed(1)} s`;
}

function formatUsage(usage?: ActivityTrace["usage"]): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`${usage.inputTokens} in`);
  if (usage.outputTokens !== undefined) parts.push(`${usage.outputTokens} out`);
  if (usage.totalTokens !== undefined) parts.push(`${usage.totalTokens} total`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Renders only the typed, sanitized trace envelope. It never receives model
 * messages, tool inputs, or tool outputs.
 */
export function TraceView({ traces }: { traces: ActivityTrace[] }) {
  if (traces.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        No trace data for this run. Older runs may predate tracing.
      </p>
    );
  }

  return (
    <ol aria-label="Run trace" className="grid gap-1.5">
      {traces.map((trace) => {
        const duration = formatDuration(trace.durationMs);
        const usage = formatUsage(trace.usage);
        return (
          <li
            className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px]"
            key={`${trace.seq}-${trace.type}`}
          >
            <span className="font-mono text-[10px] text-muted-foreground">{trace.type}</span>
            {trace.toolName ? <span className="font-medium">{trace.toolName}</span> : null}
            {trace.model ? <span className="text-muted-foreground">{trace.model}</span> : null}
            {trace.status ? (
              <span className={trace.status === "error" ? "text-destructive" : "text-muted-foreground"}>
                {trace.status}
              </span>
            ) : null}
            {trace.outcome ? <span className="text-muted-foreground">{trace.outcome}</span> : null}
            {duration ? <span className="text-muted-foreground">{duration}</span> : null}
            {usage ? <span className="text-muted-foreground">{usage}</span> : null}
            {trace.error ? (
              <span className="text-destructive">
                {trace.error.kind}: {trace.error.message}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
