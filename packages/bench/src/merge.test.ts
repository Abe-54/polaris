import { expect, test } from "bun:test";
import { gatingKinds } from "./compare.ts";
import { mergeResults } from "./merge.ts";
import type { AggregatedMetric, BenchResult } from "./types.ts";

const rss = (value: number): AggregatedMetric => ({
  value,
  unit: "MiB",
  kind: "memory",
  better: "lower",
  runs: [value],
  min: value,
  max: value,
});

const runner = (cpu: string, values: Record<string, number>, cores = 4): BenchResult => ({
  schema: 1,
  env: {
    machine: "Virtual Machine",
    machineSlug: `virtual-machine-${cpu}-${cores}c`,
    cpu,
    cores,
    memoryGiB: 16,
    os: "Ubuntu 24.04.3 LTS (Linux 6.11.0-1018-azure)",
    arch: "x64",
    bun: "1.3.13",
    gitSha: "x",
    gitDirty: false,
    daemon: "source",
    daemonBinary: null,
    transport: "bridge",
    sampler: "linux-proc",
    date: "",
  },
  options: { quick: true, runs: 1, profile: false, scenarios: ["sessions"] },
  scenarios: {
    sessions: {
      metrics: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, rss(v)])),
      notes: [],
      durationMs: 1,
    },
  },
});

test("a merged baseline holds each metric's median and gates memory on the CPUs it covers", () => {
  const merged = mergeResults([
    runner("epyc-7763", { rss_before_mib: 113, peak: 170 }),
    runner("epyc-9v74", { rss_before_mib: 111 }),
    runner("epyc-9v45", { rss_before_mib: 120, peak: 174 }),
  ]);

  expect(merged.scenarios.sessions?.metrics.rss_before_mib?.value).toBe(113);
  expect(merged.scenarios.sessions?.metrics.peak?.value).toBe(172);
  const gates = new Set(["memory", "time"]);

  expect(gatingKinds(merged, runner("epyc-9v74", {}), gates, true)).toEqual(new Set(["memory"]));
  expect(gatingKinds(merged, runner("xeon", {}), gates, true).size).toBe(0);
});

test("results from different core counts are refused", () => {
  expect(() => mergeResults([runner("epyc-7763", {}, 2), runner("epyc-7763", {}, 4)])).toThrow(
    "linux-x64-2c"
  );
});
