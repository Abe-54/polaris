import { describe, test } from "bun:test";

const windows = process.platform === "win32";

type Test = (
  label: string,
  fn: Parameters<typeof test>[1],
  options?: Parameters<typeof test>[2]
) => void;

type Describe = (label: string, fn: () => void) => void;

/**
 * `test`, skipped on Windows. `gap` names what Windows lacks for it, and the Linear issue
 * when the gap is deferred work; the skipped test's name carries it.
 */
export const posixTest =
  (gap: string): Test =>
  (label, fn, options) =>
    windows
      ? test.skip(`${label} [not on Windows: ${gap}]`, fn, options)
      : test(label, fn, options);

/** `describe`, skipped on Windows, for a group whose every test needs what `gap` names. */
export const posixDescribe =
  (gap: string): Describe =>
  (label, fn) =>
    windows ? describe.skip(`${label} [not on Windows: ${gap}]`, fn) : describe(label, fn);
