import { expect, test } from "bun:test";
import { durationVerdict } from "./usual.ts";

test.each([
  [112, 9, 5, "SLOW"],
  [5, 90, 5, "FAST"],
  [112, 9, 4, null],
  [5, 90, 4, null],
  [27, 9, 5, null],
  [27.001, 9, 5, "SLOW"],
  [20, 1, 5, null],
  [20.001, 1, 5, "SLOW"],
  [30, 90, 5, null],
  [29.999, 90, 5, "FAST"],
  [1, 20, 5, null],
  [1, 20.001, 5, "FAST"],
  [0, 0, 5, null],
  [21, 0, 5, "SLOW"],
  [9, 9, 50, null],
] as const)("%s ms against %s ms with %s samples: %s", (ms, usualMs, samples, verdict) => {
  expect(durationVerdict(ms, { usualMs, samples })).toBe(verdict);
});

test("an old Daemon or an unseen name supplies no verdict", () => {
  expect(durationVerdict(1000, undefined)).toBeNull();
});
