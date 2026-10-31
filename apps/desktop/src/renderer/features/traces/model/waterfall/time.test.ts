import { describe, expect, test } from "bun:test";
import { clockLabel, durationLabel, rulerTicks, shortHex } from "./time.ts";

describe("durationLabel", () => {
  test("stays within six characters for the 40px lane across every magnitude", () => {
    const cases = [0, 0.4, 2.14, 38, 999.4, 999.6, 3100, 9940, 12_300, 599_400, 3_600_000];
    const labels = cases.map(durationLabel);

    expect(labels).toEqual([
      "0 ms",
      "<1 ms",
      "2.1 ms",
      "38 ms",
      "999 ms",
      "1.0 s",
      "3.1 s",
      "9.9 s",
      "12 s",
      "599 s",
      "60 min",
    ]);
    expect(labels.every((l) => l.length <= 6)).toBe(true);
  });
});

describe("rulerTicks", () => {
  test("Paper T1's 840 ms trace gets 0 to 800 ms every 200", () => {
    expect(rulerTicks(0, 840).map((t) => t.label)).toEqual([
      "0",
      "200 ms",
      "400 ms",
      "600 ms",
      "800 ms",
    ]);
  });

  test("past a second ticks read in seconds, and a zoomed window starts on a round tick", () => {
    expect(rulerTicks(0, 3100).map((t) => t.label)).toEqual(["0", "1 s", "2 s", "3 s"]);
    expect(rulerTicks(57, 61).map((t) => t.at)).toEqual([57, 58, 59, 60, 61]);
    expect(rulerTicks(57.3, 58.1).map((t) => t.label)).toEqual([
      "57.4 ms",
      "57.6 ms",
      "57.8 ms",
      "58 ms",
    ]);
  });
});

test("clockLabel keeps the millisecond of exact nanoseconds in local time", () => {
  const local = new Date(2026, 9, 31, 14, 2, 11, 204);
  const ns = BigInt(local.getTime()) * 1_000_000n + 999_999n;

  expect(clockLabel(ns)).toBe("14:02:11.204");
});

test("shortHex keeps four characters at each end", () => {
  expect(shortHex("4f1c0e5b7d2a46c1b3e8d90f61a59a2e")).toBe("4f1c…9a2e");
});
