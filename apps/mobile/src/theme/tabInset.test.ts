import { expect, test } from "bun:test";
import { tabBottomInset } from "./tabInset.ts";

test.each([
  ["android", 48, 48],
  ["android", 24, 24],
  ["android", 0, 20],
  ["ios", 34, 30],
  ["ios", 21, 20],
  ["ios", 0, 20],
])("%s bottom inset %i positions the pill at %i", (platform, inset, expected) => {
  expect(tabBottomInset(inset, platform)).toBe(expected);
});
