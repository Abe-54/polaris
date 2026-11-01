import { join } from "node:path";
import { expect, test } from "bun:test";
import { parseProfile } from "./parser.ts";

import { sampled } from "./parser.testing.ts";

test("sample weights produce self and inclusive totals, merge adjacent frames and preserve hot-path table indices", () => {
  const parsed = parseProfile(JSON.stringify(sampled()), "/checkout");
  expect(parsed.hotFunctions).toEqual([
    { name: "(root)", file: null, line: null, selfMs: 0, totalMs: 10 },
    { name: "caller", file: join("src", "main.ts"), line: 10, selfMs: 1, totalMs: 6 },
    { name: "leaf", file: join("src", "leaf.ts"), line: 20, selfMs: 5, totalMs: 5 },
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
    file: join("src", "main.ts"),
    line: 10,
    selfMs: 6,
    totalMs: 6,
  });
});

for (const reversed of [false, true])
  test(`ancestry depth allows 256 frames and refuses 257 (reversed nodes: ${reversed})`, () => {
    const profile = (depth: number) => {
      const nodes = Array.from({ length: depth }, (_, id) => ({
        id,
        callFrame: { functionName: `frame${id}`, url: "", lineNumber: -1 },
        children: id + 1 < depth ? [id + 1] : [],
      }));

      return JSON.stringify({
        startTime: 0,
        endTime: 1000,
        nodes: reversed ? nodes.reverse() : nodes,
        samples: [depth - 1],
        timeDeltas: [1000],
      });
    };

    const parsed = parseProfile(profile(256), "/checkout");
    expect(parsed.hotPath.map((i) => parsed.hotFunctions[i]!.name)).toEqual(
      Array.from({ length: 256 }, (_, i) => `frame${i}`)
    );
    expect(() => parseProfile(profile(257), "/checkout")).toThrow();
  });

test("malformed sample ids, negative time, cycles, duplicate parents and out-of-window durations are refused", () => {
  const invalid = [
    { ...sampled(), samples: [123, 4, 2, 3] },
    { ...sampled(), timeDeltas: [-1, 3000, 1000, 4000] },
    { ...sampled(), timeDeltas: [2000, -3000, 1000, 4000] },
    { ...sampled(), timeDeltas: [12000, -2000, 0, 0] },
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

for (const { samples, timeDeltas } of [
  { samples: [2, 4, 3], timeDeltas: [4000, -1000, 5000] },
  { samples: [3, 4, 2], timeDeltas: [8000, -5000, 1000] },
  { samples: [4, 3, 2, 4], timeDeltas: [3000, 5000, -4000, -1000] },
])
  test(`out-of-order Node samples retain timestamps and weights (${samples.join(",")})`, () => {
    const cpu = {
      ...sampled(),
      startTime: 0,
      endTime: 10_000,
      samples,
      timeDeltas,
    };

    const parsed = parseProfile(JSON.stringify(cpu), "/checkout");

    expect(
      parsed.hotFunctions.map(({ name, selfMs, totalMs }) => ({ name, selfMs, totalMs }))
    ).toEqual([
      { name: "(root)", selfMs: 0, totalMs: 8 },
      { name: "other", selfMs: 4, totalMs: 4 },
      { name: "caller", selfMs: 1, totalMs: 4 },
      { name: "leaf", selfMs: 3, totalMs: 3 },
    ]);
    expect(parsed).toEqual(
      parseProfile(
        JSON.stringify({ ...cpu, samples: [4, 2, 3], timeDeltas: [3000, 1000, 4000] }),
        "/checkout"
      )
    );
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
