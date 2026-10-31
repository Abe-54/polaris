import { expect, test } from "bun:test";
import { parseProfile } from "./parser.ts";

import { sampled } from "./parser.testing.ts";

test("sample weights produce self and inclusive totals, merge adjacent frames and preserve hot-path table indices", () => {
  const parsed = parseProfile(JSON.stringify(sampled()), "/checkout");
  expect(parsed.hotFunctions).toEqual([
    { name: "(root)", file: null, line: null, selfMs: 0, totalMs: 10 },
    { name: "caller", file: "src/main.ts", line: 10, selfMs: 1, totalMs: 6 },
    { name: "leaf", file: "src/leaf.ts", line: 20, selfMs: 5, totalMs: 5 },
    { name: "other", file: "node:internal", line: 1, selfMs: 4, totalMs: 4 },
  ]);
  expect(parsed.hotPath).toEqual([0, 1, 2]);
  expect(parsed.nodes).toEqual([
    { parent: null, functionIndex: 0, startMs: 0, durationMs: 10 },
    { parent: 0, functionIndex: 1, startMs: 0, durationMs: 6 },
    { parent: 1, functionIndex: 2, startMs: 0, durationMs: 5 },
    { parent: 0, functionIndex: 3, startMs: 6, durationMs: 4 },
  ]);
});

test("recursive appearances of a function count inclusive samples once and count self only at the sampled leaf", () => {
  const cpu = sampled();
  cpu.nodes[3]!.callFrame = cpu.nodes[1]!.callFrame;
  const parsed = parseProfile(JSON.stringify(cpu), "/checkout");
  expect(parsed.hotFunctions.find((f) => f.name === "caller")).toEqual({
    name: "caller",
    file: "src/main.ts",
    line: 10,
    selfMs: 6,
    totalMs: 6,
  });
});

test("malformed sample ids, negative time, cycles, duplicate parents and out-of-window durations are refused", () => {
  const invalid = [
    { ...sampled(), samples: [123, 4, 2, 3] },
    { ...sampled(), timeDeltas: [-1, 3000, 1000, 4000] },
    { ...sampled(), timeDeltas: [2000] },
    { ...sampled(), endTime: 2000 },
    { ...sampled(), nodes: [...sampled().nodes, sampled().nodes[0]] },
  ];

  const cycle = sampled();
  cycle.nodes[3]!.children = [1];
  invalid.push(cycle);
  const duplicate = sampled();
  duplicate.nodes[2]!.children = [4];
  invalid.push(duplicate);

  for (const cpu of invalid) expect(() => parseProfile(JSON.stringify(cpu), "/checkout")).toThrow();
});

test("the hot path aggregates nonadjacent samples of the same stack instead of picking the longest contiguous frame", () => {
  const cpu = { ...sampled(), samples: [4, 3, 4], timeDeltas: [3000, 4000, 3000] };
  const parsed = parseProfile(JSON.stringify(cpu), "/checkout");
  expect(parsed.hotPath.map((i) => parsed.hotFunctions[i]!.name)).toEqual([
    "(root)",
    "caller",
    "leaf",
  ]);
});

test("parsed profile locations and labels redact credential-bearing URLs before reaching tools", () => {
  const cpu = sampled();
  cpu.nodes[3]!.callFrame.url = "https://user:private@host/script.js?token=private";
  cpu.nodes[3]!.callFrame.functionName = "Bearer abc-private";
  const output = JSON.stringify(parseProfile(JSON.stringify(cpu), "/checkout"));
  expect(output).not.toContain("private");
  expect(output).toContain("[redacted]");
});

test("Bun runtime pseudo-files remain unresolved instead of becoming clickable project locations", () => {
  const cpu = sampled();
  cpu.nodes[3]!.callFrame.url = "bun:main";
  const parsed = parseProfile(JSON.stringify(cpu), "/checkout");
  expect(parsed.hotFunctions.find((f) => f.name === "leaf")).toMatchObject({
    file: null,
    line: null,
    selfMs: 5,
  });
});
