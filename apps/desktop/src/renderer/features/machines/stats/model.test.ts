import { describe, expect, test } from "bun:test";
import { HostDiskUsage, HostStatsItem, HostStatsSample, Timestamp } from "@polaris/protocol";
import {
  cpuFigure,
  cpuVital,
  diskVital,
  foldStats,
  type HostStats,
  loadVital,
  memoryVital,
  sparkBars,
  vitalsFooter,
} from "./model.ts";

const GIB = 1024 ** 3;

const sample = (
  cpu: number | null,
  at = "2026-10-30T12:00:00.000Z",
  loadAverage: readonly [number, number, number] | null = [4.12, 3.8, 3.5]
) =>
  HostStatsSample.make({
    at: Timestamp.make(at),
    cpuPercent: cpu,
    loadAverage,
    memoryUsedBytes: Math.round(41.2 * GIB),
    memoryTotalBytes: 128 * GIB,
    disk: HostDiskUsage.make({
      path: "/Users/lucas/.polaris",
      usedBytes: 1.2e12,
      totalBytes: 2e12,
    }),
  });

const history = (samples: ReadonlyArray<HostStatsSample>) =>
  HostStatsItem.cases.History.make({ cores: 24, intervalMs: 2000, samples });

const stats = (samples: ReadonlyArray<HostStatsSample>): HostStats =>
  foldStats(null, history(samples)) ?? { cores: 0, intervalMs: 0, samples: [] };

describe("the stats ring", () => {
  test("keeps the newest 60 samples as more arrive", () => {
    let state = stats(Array.from({ length: 60 }, (_, i) => sample(i)));

    for (const cpu of [91, 92])
      state = foldStats(state, HostStatsItem.cases.Sample.make({ sample: sample(cpu) })) ?? state;

    expect(state.samples).toHaveLength(60);
    expect(state.samples[0]?.cpuPercent).toBe(2);
    expect(state.samples.at(-1)?.cpuPercent).toBe(92);
  });

  test("a history that crossed IPC (structured-cloned, its samples plain objects) fills the ring", () => {
    const cloned = structuredClone(history([sample(1), sample(2)]));
    const next = structuredClone(HostStatsItem.cases.Sample.make({ sample: sample(3) }));

    expect(foldStats(foldStats(null, cloned), next)?.samples.map((s) => s.cpuPercent)).toEqual([
      1, 2, 3,
    ]);
  });

  test("a sample before the history is ignored, and a new history replaces the ring", () => {
    expect(foldStats(null, HostStatsItem.cases.Sample.make({ sample: sample(5) }))).toBeNull();
    expect(foldStats(stats([sample(1), sample(2)]), history([sample(9)]))?.samples).toHaveLength(1);
  });
});

describe("sparkline bars", () => {
  test("right-aligns the samples, leaves gaps empty and shows any reading as at least one cell", () => {
    expect(sparkBars([0.2, null, 100], 5, 12)).toEqual([null, null, 2, null, 12]);
  });

  test("keeps only the newest columns when there are more samples than columns", () => {
    expect(sparkBars([100, 50, 0.1], 2, 4)).toEqual([2, 2]);
  });
});

describe("vitals", () => {
  test("every figure reads a dash before the first sample", () => {
    expect(
      [cpuVital(null, 0), loadVital(null), memoryVital(null), diskVital(null)].map((v) => v.figure)
    ).toEqual(["—", "—", "—", "—"]);
    expect(cpuFigure(null)).toBe("—");
  });

  test("CPU names its peak and how long ago it was", () => {
    const at = Date.parse("2026-10-30T12:00:00.000Z");

    const vital = cpuVital(
      stats([sample(81, "2026-10-30T12:00:00.000Z"), sample(38, "2026-10-30T12:02:00.000Z")]),
      at + 2 * 60_000
    );

    expect(vital.figure).toBe("38");
    expect(vital.caption).toBe("Peak 81% · 2m ago");
  });

  test("load, memory and disk read as the mockup does", () => {
    const s = stats([sample(38)]);

    expect(loadVital(s)).toMatchObject({
      figure: "4.12",
      unit: "/ 24 cores",
      caption: "1 min · 3.80 over 5 min",
    });
    expect(memoryVital(s)).toMatchObject({
      figure: "41.2",
      unit: "/ 128 GB",
      caption: "32% used",
      cells: 13,
    });
    expect(diskVital(s)).toMatchObject({
      figure: "1.2",
      unit: "/ 2 TB",
      caption: "800 GB free",
      cells: 24,
    });
  });

  test("a host without load averages says so rather than showing zero", () => {
    const s = stats([sample(10, undefined, null)]);

    expect(loadVital(s)).toMatchObject({ figure: "—", caption: "Windows has no load average" });
  });

  test("the footer names the window the charts cover and the daemon's uptime", () => {
    const s = stats(Array.from({ length: 60 }, () => sample(10)));

    expect(vitalsFooter(s, (3 * 24 + 4) * 3_600_000)).toBe("LAST 2 MIN · 60 SAMPLES · UP 3D 4H");
  });
});
