import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { HostStatsItem } from "./hostStats.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(HostStatsItem));

const sample = {
  at: "2026-10-29T12:00:00.000Z",
  cpuPercent: 12.5,
  loadAverage: [1.5, 1.25, 0.75],
  memoryUsedBytes: 6_442_450_944,
  memoryTotalBytes: 8_589_934_592,
  disk: { path: "/home/pi/.polaris", usedBytes: 20_000_000_000, totalBytes: 64_000_000_000 },
};

describe("HostStatsItem", () => {
  test("a History off the wire decodes with byte counts above 2^32 and a Windows sample", () => {
    const windows = { ...sample, cpuPercent: null, loadAverage: null, disk: null };

    const item = decode(
      `{"_tag":"History","cores":4,"intervalMs":2000,"samples":${JSON.stringify([sample, windows])}}`
    );

    expect(HostStatsItem.guards.History(item) && item.samples.map((s) => s.loadAverage)).toEqual([
      [1.5, 1.25, 0.75],
      null,
    ]);
  });

  test("rejects a CPU share above 100", () => {
    expect(() =>
      decode(`{"_tag":"Sample","sample":${JSON.stringify({ ...sample, cpuPercent: 101 })}}`)
    ).toThrow();
  });
});
