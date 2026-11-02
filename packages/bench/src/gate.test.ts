import { describe, expect, test } from "bun:test";
import { gate } from "./gate.ts";
import type { AggregatedMetric, BenchResult, MetricKind } from "./types.ts";

const metric = (kind: MetricKind, value: number): AggregatedMetric => ({
  value,
  runs: [value],
  min: value,
  max: value,
  unit: kind === "memory" ? "MiB" : "ms",
  kind,
  better: "lower",
});

const result = (cpu: string, rss: number, ms = 10): BenchResult => ({
  schema: 1,
  env: {
    machine: "Virtual Machine",
    machineSlug: cpu.includes(" | ") ? "linux-x64-4c-mixed" : `vm-${cpu}-4c`,
    cpu,
    cores: 4,
    memoryGiB: 16,
    os: "Ubuntu 24.04.3 LTS (Linux 6.17.0-1022-azure)",
    arch: "x64",
    bun: "1.4.4",
    gitSha: "x",
    gitDirty: false,
    daemon: "source",
    daemonBinary: null,
    transport: "bridge",
    sampler: "linux-proc",
    date: "",
  },
  options: { quick: true, runs: 1, profile: false, scenarios: ["s"] },
  scenarios: {
    s: {
      metrics: { rss: metric("memory", rss), hello: metric("time", ms) },
      notes: [],
      durationMs: 1,
    },
  },
});

describe("gate", () => {
  const baseline = result("epyc-7763 | epyc-9v45", 100);
  const gates = new Set(["memory", "time"]);

  const failing = (shards: Array<BenchResult>) =>
    gate(baseline, shards, gates, true).comparison.regressions.map((r) => r.metric);

  test("gates the median of the shards: one spike passes, a regression in two fails", () => {
    expect(
      failing([result("epyc-7763", 100), result("epyc-9v45", 101), result("epyc-7763", 160)])
    ).toEqual([]);
    expect(
      failing([result("epyc-7763", 100), result("epyc-9v45", 130), result("epyc-7763", 131)])
    ).toEqual(["rss"]);
  });

  test("timings never gate between two merged results, though both are named ...-mixed", () => {
    expect(failing([result("epyc-7763", 100, 90), result("epyc-9v45", 100, 90)])).toEqual([]);
  });

  test("a shard on a CPU model the baseline lacks is left out while two others remain", () => {
    const outcome = gate(
      baseline,
      [result("xeon-6973p", 100), result("epyc-7763", 130), result("epyc-9v45", 131)],
      gates,
      true
    );

    expect(outcome.dropped).toEqual(["xeon-6973p"]);
    expect(outcome.comparison.regressions.map((r) => r.metric)).toEqual(["rss"]);
  });

  test("with fewer than two shards on covered models, nothing gates and it says why", () => {
    const outcome = gate(
      baseline,
      [result("xeon-6973p", 200), result("xeon-8370c", 200), result("epyc-7763", 200)],
      gates,
      true
    );

    expect(outcome.comparison.regressions).toEqual([]);
    expect(outcome.ungated).toContain("xeon-6973p");
  });

  test("a scenario that failed in any shard is reported", () => {
    const broken = result("epyc-9v45", 100);
    broken.scenarios.s = { ...broken.scenarios.s!, error: "boom" };

    const outcome = gate(baseline, [result("epyc-7763", 100), broken], gates, true);

    expect(outcome.failedScenarios).toEqual(["s (shard 2)"]);
  });
});
