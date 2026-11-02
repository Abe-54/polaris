/**
 * Test preload the watchdog adds when quarantine applies (`quarantine.ts`): wraps `bun:test`'s
 * `test`, `it` and `describe` so each test's full name can be matched against the entries.
 *
 * `POLARIS_TEST_QUARANTINE=skip` skips the quarantined tests and prints each one;
 * `only` skips every other test, for the nightly's `--quarantined` run.
 */
import * as bunTest from "bun:test";
import { Predicate } from "effect";
import {
  appliesOn,
  currentOs,
  describeEntry,
  type Entry,
  quarantineSource,
  readQuarantine,
  repoPath,
} from "./quarantine.ts";

/** The real module, copied before `mock.module` replaces its live bindings. */
const original = { ...bunTest };

const { test, describe } = original;

type Cell = string | number | bigint | boolean | symbol | object | null | undefined;

type Body = Parameters<typeof test>[1];

type Options = Parameters<typeof test>[2];

type EachTest = bunTest.Test<[Cell]>;

type EachBody = Parameters<EachTest>[1];

type Label = Parameters<typeof describe>[0];

type EachDescribe = bunTest.Describe<[Cell]>;

type Group = Parameters<EachDescribe>[1];

const mode = process.env.POLARIS_TEST_QUARANTINE === "only" ? "only" : "skip";

const os = currentOs();

const { root } = quarantineSource();

const entries = readQuarantine().filter((entry) => appliesOn(entry, os));

/** The names of the `describe` blocks being collected, outermost first. */
const stack: Array<string> = [];

const labelOf = (label: Label): string =>
  Predicate.isString(label) || Predicate.isNumber(label) ? String(label) : label.name;

const quarantinedIn = (file: string, name: string): Entry | undefined => {
  const full = [...stack, name].join(" > ");

  return entries.find((entry) => entry.file === file && entry.test === full);
};

/** Runs `run` or `skip` for the test `label` declares, per the mode; prints each quarantine skip. */
const decide = (label: string, run: () => void, skip: () => void): void => {
  const entry = quarantinedIn(repoPath(Bun.main, root), label);

  if (mode === "only") return entry ? run() : skip();

  if (!entry) return run();

  console.error(`(quarantined) skipped ${describeEntry(entry)}`);
  skip();
};

const wrapTest =
  (base: typeof test) =>
  (label: string, fn: Body, options?: Options): void =>
    decide(
      label,
      () => base(label, fn, options),
      () => test.skip(label, fn, options)
    );

const wrappedTest = Object.assign(wrapTest(test), test, {
  each:
    (table: Array<Cell>) =>
    (label: string, fn: EachBody, options?: Options): void =>
      decide(
        label,
        () => test.each(table)(label, fn, options),
        () => test.skip.each(table)(label, fn, options)
      ),
  if: (condition: boolean) => wrapTest(test.if(condition)),
  skipIf: (condition: boolean) => wrapTest(test.skipIf(condition)),
});

/** Collects `fn` under its full path: bun runs a nested `describe` after its parent's returns. */
const within = <Row extends ReadonlyArray<Cell>>(
  label: Label,
  fn: (...row: Row) => void
): ((...row: Row) => void) => {
  const path = [...stack, labelOf(label)];

  return (...row) => {
    const saved = stack.splice(0, stack.length, ...path);

    try {
      fn(...row);
    } finally {
      stack.splice(0, stack.length, ...saved);
    }
  };
};

const wrapDescribe = (base: typeof describe) => (label: Label, fn: () => void) =>
  base(label, within(label, fn));

const wrappedDescribe = Object.assign(wrapDescribe(describe), describe, {
  each: (table: Array<Cell>) => (label: Label, fn: Group) =>
    describe.each(table)(label, within(label, fn)),
  if: (condition: boolean) => wrapDescribe(describe.if(condition)),
  skipIf: (condition: boolean) => wrapDescribe(describe.skipIf(condition)),
});

if (entries.length > 0 || mode === "only")
  void bunTest.mock.module("bun:test", () => ({
    ...original,
    test: wrappedTest,
    it: wrappedTest,
    describe: wrappedDescribe,
  }));
