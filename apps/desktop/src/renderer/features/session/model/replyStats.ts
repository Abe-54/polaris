import type { ReplyStats } from "@polaris/protocol";
import { formatElapsed, plural } from "./format.ts";

/** "420ms", "1.2s", "12s". */
const formatLatency = (ms: number): string => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;

  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : formatElapsed(ms);
};

/**
 * The advanced view's line under a reply (ENG-678): "1.2s · 842 tokens · 63 tok/s". A part
 * the Harness didn't report is left out; tokens per second needs a generation time.
 */
export const replyStatsLine = (stats: ReplyStats): string => {
  const { outputTokens, latencyMs, durationMs } = stats;
  const rate = durationMs !== null && durationMs > 0 ? outputTokens / (durationMs / 1000) : null;

  return [
    latencyMs === null ? null : formatLatency(latencyMs),
    plural(outputTokens, "token"),
    rate === null ? null : `${Math.round(rate).toLocaleString("en-US")} tok/s`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
};
