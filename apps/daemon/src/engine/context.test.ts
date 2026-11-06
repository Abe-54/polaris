import { ContextCategory, ContextUsage, McpServerUsage, MemoryFile } from "@polaris/protocol";
import { describe, expect, test } from "bun:test";
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import { contextChanged, contextUsageOf } from "./context.ts";

const usage = (usedTokens: number, windowTokens: number | null) =>
  new ContextUsage({ usedTokens, windowTokens });

describe("contextChanged", () => {
  test.each<[string, ContextUsage | null, ContextUsage, boolean]>([
    ["the first report", null, usage(10, null), true],
    ["a new window", usage(10, null), usage(10, 200_000), true],
    [
      "a move under one percent of the window",
      usage(50_000, 200_000),
      usage(51_999, 200_000),
      false,
    ],
    ["a move of one percent of the window", usage(50_000, 200_000), usage(52_000, 200_000), true],
    ["a compaction (a big drop)", usage(180_000, 200_000), usage(30_000, 200_000), true],
    ["without a window, under a thousand tokens", usage(5000, null), usage(5999, null), false],
    ["without a window, a thousand tokens", usage(5000, null), usage(6000, null), true],
  ])("%s: recorded is the last column", (_, last, next, recorded) => {
    expect(contextChanged(last, next)).toBe(recorded);
  });
});

describe("contextUsageOf", () => {
  const breakdown = {
    categories: [new ContextCategory({ name: "Messages", kind: "used", tokens: 30_000 })],
    memoryFiles: [new MemoryFile({ path: "/repo/CLAUDE.md", source: "Project", tokens: 900 })],
    countedTokens: 40_000,
    autoCompact: true,
  } as const;

  test("a total-only report keeps the last breakdown, dated by what it was counted at", () => {
    const counted = contextUsageOf(
      HarnessEvent.ContextUsed({ usedTokens: 40_000, windowTokens: 200_000, breakdown }),
      null
    );

    const later = contextUsageOf(
      HarnessEvent.ContextUsed({ usedTokens: 52_000, windowTokens: 200_000 }),
      counted
    );

    expect(later).toMatchObject({
      usedTokens: 52_000,
      categoriesTotal: 40_000,
      autoCompact: true,
      categories: breakdown.categories,
      memoryFiles: breakdown.memoryFiles,
    });
  });

  test("the finer breakdown is kept between counts and replaced by the next", () => {
    const servers = [
      new McpServerUsage({
        name: "linear",
        tools: 76,
        loadedTools: 4,
        tokens: 3100,
        deferredTokens: 46_000,
      }),
    ];

    const counted = contextUsageOf(
      HarnessEvent.ContextUsed({
        usedTokens: 40_000,
        windowTokens: 200_000,
        breakdown: { ...breakdown, mcpServers: servers, autoCompactAt: 167_000 },
      }),
      null
    );

    const later = contextUsageOf(
      HarnessEvent.ContextUsed({ usedTokens: 52_000, windowTokens: 200_000 }),
      counted
    );

    expect(later.mcpServers).toEqual(servers);
    expect(later.autoCompactAt).toBe(167_000);

    const recount = contextUsageOf(
      HarnessEvent.ContextUsed({ usedTokens: 60_000, windowTokens: 200_000, breakdown }),
      later
    );

    expect([recount.mcpServers, recount.autoCompactAt]).toEqual([[], null]);
  });

  test("a fresh count is recorded even when the total barely moved", () => {
    const counted = contextUsageOf(
      HarnessEvent.ContextUsed({ usedTokens: 40_000, windowTokens: 200_000, breakdown }),
      null
    );

    const recount = contextUsageOf(
      HarnessEvent.ContextUsed({
        usedTokens: 40_100,
        windowTokens: 200_000,
        breakdown: { ...breakdown, countedTokens: 40_100 },
      }),
      counted
    );

    expect(contextChanged(counted, recount)).toBe(true);
  });
});
