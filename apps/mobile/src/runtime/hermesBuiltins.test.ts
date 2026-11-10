import { expect, test } from "bun:test";

test("app tests run without the builtins the app's Hermes lacks", () => {
  // The bug ENG-591 names: `toSorted` passed on Bun and threw on every launch.
  expect(() => [2, 1].toSorted((a, b) => a - b)).toThrow(TypeError);
  expect([2, 1].toReversed()).toEqual([1, 2]);
});
