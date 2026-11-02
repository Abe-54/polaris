import { describe, expect, test } from "bun:test";
import { compare, compareMetric, gatingKinds } from "./compare.ts";
import { summarize } from "./stats.ts";
import {
  type AggregatedMetric,
  type BenchResult,
  type Environment,
  type Metric,
  type MetricKind,
  parseBenchResult,
} from "./types.ts";

const agg = (m: Metric): AggregatedMetric => ({
  ...m,
  runs: [m.value],
  min: m.value,
  max: m.value,
});

const metric = (kind: MetricKind, value: number, better: "lower" | "higher" = "lower") =>
  agg({ value, unit: "", kind, better });

const result = (
  metrics: Record<string, AggregatedMetric>,
  slug = "m",
  env: Partial<Environment> = {}
): BenchResult => ({
  schema: 1,
  env: {
    machine: "m",
    machineSlug: slug,
    cpu: "c",
    cores: 1,
    memoryGiB: 1,
    os: "o",
    arch: "a",
    bun: "1",
    gitSha: "x",
    gitDirty: false,
    daemon: "source",
    daemonBinary: null,
    transport: "bridge",
    sampler: "ps",
    date: "",
    ...env,
  },
  options: { quick: true, runs: 1, profile: false, scenarios: ["s"] },
  scenarios: { s: { metrics, notes: [], durationMs: 1 } },
});

describe("summarize", () => {
  test("median, nearest-rank percentiles", () => {
    const s = summarize([5, 1, 4, 2, 3]);
    expect(s.median).toBe(3);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.p95).toBe(5);
    expect(summarize([1, 2, 3, 4]).median).toBe(2.5);
    expect(Number.isNaN(summarize([]).median)).toBe(true);
  });
});

describe("compareMetric", () => {
  test("memory is held to 10% or 5 MiB, whichever is larger", () => {
    expect(compareMetric(metric("memory", 100), metric("memory", 109)).status).toBe("ok");
    expect(compareMetric(metric("memory", 100), metric("memory", 111)).status).toBe("regressed");
    expect(compareMetric(metric("memory", 10), metric("memory", 14)).status).toBe("ok");
    expect(compareMetric(metric("memory", 100), metric("memory", 80)).status).toBe("improved");
  });

  test("throughput regresses when it drops", () => {
    expect(
      compareMetric(metric("throughput", 100, "higher"), metric("throughput", 65, "higher")).status
    ).toBe("regressed");
    expect(
      compareMetric(metric("throughput", 100, "higher"), metric("throughput", 200, "higher")).status
    ).toBe("improved");
  });

  test("a metric's own tolerance wins", () => {
    const base = agg({
      value: 0.1,
      unit: "%",
      kind: "cpu",
      better: "lower",
      tolerance: { relative: 1, absolute: 0.5 },
    });

    expect(compareMetric(base, { ...base, value: 0.5 }).status).toBe("ok");
    expect(compareMetric(base, { ...base, value: 0.7 }).status).toBe("regressed");
  });
});

describe("parseBenchResult", () => {
  test("older artifacts without background load still decode", () => {
    const saved = result({ mem: metric("memory", 100) });
    const decoded = parseBenchResult(JSON.stringify(saved));

    expect(decoded).toEqual(saved);
    expect(decoded.env).not.toHaveProperty("backgroundCores");
  });

  test.each([0, 1.5, 6.8, 10.2])("retains saved background load of %s cores", (backgroundCores) => {
    const saved = result({ mem: metric("memory", 100) });

    const decoded = parseBenchResult(
      JSON.stringify({ ...saved, env: { ...saved.env, backgroundCores } })
    );

    expect(decoded.env.backgroundCores).toBe(backgroundCores);
  });
});

describe("compare", () => {
  test("only gating kinds count; informational metrics never do; mismatched machines warn", () => {
    const base = result({
      mem: metric("memory", 100),
      lat: metric("latency", 10),
      gone: metric("time", 1),
    });

    const current = result(
      {
        mem: metric("memory", 150),
        lat: metric("latency", 100),
        info: agg({ value: 1, unit: "", kind: "memory", better: "lower", info: true }),
      },
      "other",
      { cores: 2 }
    );

    const c = compare(base, current, new Set(["memory"]));
    expect(c.regressions.map((r) => r.metric)).toEqual(["mem"]);
    expect(c.rows.find((r) => r.metric === "lat")?.status).toBe("regressed");
    expect(c.rows.find((r) => r.metric === "info")?.status).toBe("new");
    expect(c.rows.find((r) => r.metric === "gone")?.status).toBe("missing");
    expect(c.warnings.some((w) => w.includes("not comparable"))).toBe(true);
  });

  test("a gate named scenario.metric gates that metric alone, whatever its kind", () => {
    const base = result({ modules: metric("count", 500), wakeups: metric("count", 40) });
    const current = result({ modules: metric("count", 700), wakeups: metric("count", 80) });

    const c = compare(base, current, new Set(["s.modules"]));
    expect(c.regressions.map((r) => r.metric)).toEqual(["modules"]);
  });

  test("-scenario.metric drops one metric from its kind's gate and still reports it", () => {
    const base = result({ rss: metric("memory", 100), peak: metric("memory", 166) });
    const current = result({ rss: metric("memory", 150), peak: metric("memory", 330) });

    const c = compare(base, current, new Set(["memory", "-s.peak"]));
    expect(c.regressions.map((r) => r.metric)).toEqual(["rss"]);
    expect(c.rows.find((r) => r.metric === "peak")?.status).toBe("regressed");
  });

  test("a Developer Mode run warns against an older baseline, which ran it off", () => {
    const old = result({ mem: metric("memory", 100) });
    const off = result({ mem: metric("memory", 100) }, "m", { developerMode: "off" });
    const on = result({ mem: metric("memory", 100) }, "m", { developerMode: "on" });

    expect(compare(old, off, new Set(["memory"])).warnings).toEqual([]);
    expect(compare(old, on, new Set(["memory"])).warnings).toEqual([
      "baseline ran with Developer Mode off, this run on",
    ]);
  });

  test("a run on a busy machine warns, whichever side it is", () => {
    const quiet = result({ mem: metric("memory", 100) });
    const busy: BenchResult = { ...quiet, env: { ...quiet.env, backgroundCores: 4.2 } };

    expect(compare(quiet, quiet, new Set(["memory"])).warnings).toEqual([]);
    expect(compare(quiet, busy, new Set(["memory"])).warnings).toEqual([
      "this run started with 4.2 cores busy with other work: throughput and CPU are not comparable",
    ]);
    expect(compare(busy, quiet, new Set(["memory"])).warnings[0]).toStartWith(
      "baseline started with 4.2"
    );
  });

  test.each([6.8, 10.2])(
    "decoded busy artifacts warn on either side at %s cores",
    (backgroundCores) => {
      const saved = result({ mem: metric("memory", 100) });
      const quiet = parseBenchResult(JSON.stringify(saved));

      const busy = parseBenchResult(
        JSON.stringify({ ...saved, env: { ...saved.env, backgroundCores } })
      );

      expect(compare(quiet, quiet, new Set(["memory"])).warnings).toEqual([]);
      expect(compare(quiet, busy, new Set(["memory"])).warnings).toEqual([
        `this run started with ${backgroundCores} cores busy with other work: throughput and CPU are not comparable`,
      ]);
      expect(compare(busy, quiet, new Set(["memory"])).warnings).toEqual([
        `baseline started with ${backgroundCores} cores busy with other work: throughput and CPU are not comparable`,
      ]);
    }
  );
});

describe("gatingKinds", () => {
  const requested = new Set<MetricKind>(["memory", "count", "latency", "throughput"]);

  const runner = (cpu: string, cores = 4) =>
    result({}, `ubuntu-${cpu}-${cores}c`, {
      cpu,
      cores,
      arch: "x64",
      os: "Ubuntu 24.04.3 LTS (Linux 6.11.0-1018-azure)",
    });

  test("gates as asked on the baseline's machine", () => {
    expect(gatingKinds(runner("epyc-7763"), runner("epyc-7763"), requested, true)).toEqual(
      requested
    );
  });

  const mixed = (...cpus: Array<string>) => {
    const base = runner(cpus.join(" | "));

    return { ...base, env: { ...base.env, machineSlug: "linux-x64-4c-mixed" } };
  };

  test("on a CPU model a mixed baseline covers, memory and counts gate, timings don't", () => {
    const base = mixed("epyc-7763", "epyc-9v74");

    expect(gatingKinds(base, runner("epyc-9v74"), requested, true)).toEqual(
      new Set(["memory", "count"])
    );
    expect(
      compare(base, runner("epyc-9v74"), new Set()).warnings.some((w) =>
        w.includes("memory and counts compare")
      )
    ).toBe(true);
  });

  test("a CPU model the baseline doesn't cover gates nothing with --gate-same-machine", () => {
    for (const base of [runner("epyc-7763"), mixed("epyc-7763", "epyc-9v74")]) {
      expect(gatingKinds(base, runner("xeon-6973p"), requested, true).size).toBe(0);
      expect(
        compare(base, runner("xeon-6973p"), new Set()).warnings.some((w) =>
          w.includes("gates nothing")
        )
      ).toBe(true);
    }
  });

  test("another core count, OS or arch gates nothing with --gate-same-machine; without it, all", () => {
    const base = runner("epyc-7763", 2);

    for (const other of [
      runner("epyc-7763", 4),
      { ...base, env: { ...base.env, machineSlug: "graviton", arch: "arm64" } },
      { ...base, env: { ...base.env, machineSlug: "mac", os: "macOS 27.0 (Darwin 27.0.0)" } },
    ]) {
      expect(gatingKinds(base, other, requested, true).size).toBe(0);
      expect(gatingKinds(base, other, requested, false)).toEqual(requested);
    }
  });
});
