/**
 * Test tiers. A file named `*.slow.test.ts` (or `.tsx`) is slow-tier: a real Daemon process,
 * real network or SSH, heavy real git, model-based or property runs, Quint, or over 2 s.
 * Every other test file is fast-tier and has a 2 s budget. pre-push runs fast; CI runs all.
 */

export type Tier = "fast" | "slow" | "all";

const TIER_FLAG = /^--tier=(.*)$/;

const TIERS: ReadonlyArray<Tier> = ["fast", "slow", "all"];

const isTier = (value: string): value is Tier => TIERS.some((tier) => tier === value);

/** A slow-tier file's name, as bun reports it in `--timings`. */
export const SLOW_FILE = /\.slow\.test\.[cm]?[jt]sx?$/;

/** The fast-tier budget per file. */
export const FILE_BUDGET_MS = 2000;

export interface TieredArgs {
  readonly tier: Tier;
  /** The args without `--tier`. */
  readonly rest: ReadonlyArray<string>;
}

/** Takes `--tier=…` out of the args; `all` when absent. */
export const parseTier = (args: ReadonlyArray<string>): TieredArgs => {
  let tier: Tier = "all";
  const rest: Array<string> = [];

  for (const arg of args) {
    const value = TIER_FLAG.exec(arg)?.[1];

    if (value === undefined) {
      rest.push(arg);
      continue;
    }

    if (!isTier(value)) throw new Error(`--tier must be fast, slow or all: "${value}"`);
    tier = value;
  }

  return { tier, rest };
};

const ignore = (pattern: string) => `--path-ignore-patterns=${pattern}`;

/**
 * Ignores every test file whose name before `.test.` doesn't end in `.slow`, one character
 * at a time, since bun's globs have no negated groups.
 */
const NOT_SLOW = [
  "**/*[!w].test.*",
  "**/*[!o]w.test.*",
  "**/*[!l]ow.test.*",
  "**/*[!s]low.test.*",
  "**/*[!.]slow.test.*",
  "**/w.test.*",
  "**/ow.test.*",
  "**/low.test.*",
  "**/slow.test.*",
];

/** The `bun test` flags that keep a run to its tier, alongside any path filters given. */
export const tierFlags = (tier: Tier): ReadonlyArray<string> => {
  if (tier === "fast") return [ignore("**/*.slow.test.*")];

  if (tier === "slow") return NOT_SLOW.map(ignore);

  return [];
};

/** Fast-tier files over the budget, the slowest first, from a `--timings` file's durations. */
export const overBudget = (
  files: Readonly<Record<string, number>>
): ReadonlyArray<readonly [string, number]> =>
  Object.entries(files)
    .filter(([file, ms]) => !SLOW_FILE.test(file) && ms > FILE_BUDGET_MS)
    .toSorted(([, a], [, b]) => b - a);
