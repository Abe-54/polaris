import { describe, expect, test } from "bun:test";
import { noiseReport } from "./noise.ts";
import type { AggregatedMetric, BenchResult } from "./types.ts";

const memory = (runs: Array<number>): AggregatedMetric => ({
  value: runs[Math.floor(runs.length / 2)]!,
  runs,
  min: Math.min(...runs),
  max: Math.max(...runs),
  unit: "MiB",
  kind: "memory",
  better: "lower",
});

const result = (cpu: string, runs: Array<number>): BenchResult => ({
  schema: 1,
  env: {
    machine: "m",
    machineSlug: `linux-${cpu}`,
    cpu,
    cores: 4,
    memoryGiB: 16,
    os: "Ubuntu 24.04 (Linux 6.17)",
    arch: "x64",
    bun: "1",
    gitSha: "x",
    gitDirty: false,
    daemon: "source",
    daemonBinary: null,
    transport: "bridge",
    sampler: "proc",
    date: "",
  },
  options: { quick: true, runs: runs.length, profile: false, scenarios: ["s"] },
  scenarios: { s: { metrics: { rss: memory(runs) }, notes: [], durationMs: 1 } },
});

describe("noiseReport", () => {
  const base = result("a | b", [100]);
  const gates = new Set(["memory"]);
  // One run of three on b spikes past 10% / 5 MiB; its median doesn't.
  const results = [result("a", [100, 101, 102]), result("b", [99, 100, 130])];

  test("judges the gated medians: a spike in one run of three fails nothing", () => {
    const report = noiseReport(base, results, gates, true);

    expect(report.failures).toEqual([]);
    expect(report.rows.map((r) => [r.cpu, r.values])).toEqual([
      ["a", [101]],
      ["b", [100]],
    ]);
  });

  test("--per-run shows the single-run spread and the spike's use of the tolerance", () => {
    const b = noiseReport(base, results, gates, true, true).rows.find((r) => r.cpu === "b")!;

    expect(b.values).toEqual([99, 100, 130]);
    expect(b.spread).toBeCloseTo(0.31);
    expect(b.worstUse).toBeCloseTo(3);
  });

  test("a CPU model the baseline doesn't cover is not gated", () => {
    const report = noiseReport(base, [result("c", [150])], gates, true);

    expect(report).toMatchObject({ failures: [], gated: 0 });
  });
});
