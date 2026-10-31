import { expect, test } from "bun:test";
import { ReplyStats } from "@polaris/protocol";
import { replyStatsLine } from "./replyStats.ts";

const line = (outputTokens: number, latencyMs: number | null, durationMs: number | null) =>
  replyStatsLine(new ReplyStats({ outputTokens, latencyMs, durationMs }));

test.each([
  [842, 1_200, 13_365, "1.2s · 842 tokens · 63 tok/s"],
  [12_345, 420, 100_000, "420ms · 12,345 tokens · 123 tok/s"],
  [1, 14_000, null, "14s · 1 token"],
  [90, null, 1_500, "90 tokens · 60 tok/s"],
  [90, null, 0, "90 tokens"],
])("%d tokens, %p ms latency, %p ms generating reads %p", (tokens, latency, duration, expected) => {
  expect(line(tokens, latency, duration)).toBe(expected);
});
