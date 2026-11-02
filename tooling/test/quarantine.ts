#!/usr/bin/env bun
/**
 * The test quarantine: `quarantine.json` names flaky tests the required lane skips, each with
 * its issue and the day it was added. The nightly runs them with `--quarantined`.
 *
 *   bun tooling/test/quarantine.ts --check   fail on an entry without an issue, too old, or stale
 *
 * See "Quarantining a flaky test" in `tooling/test/quarantine.md`.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { Schema } from "effect";

export const ROOT = join(import.meta.dir, "../..");

export const QUARANTINE_FILE = join(import.meta.dir, "quarantine.json");

/** An entry older than this fails the check: about one release. */
export const MAX_AGE_DAYS = 30;

export const Os = Schema.Literals(["windows", "macos", "linux"]);

export type Os = typeof Os.Type;

export const Entry = Schema.Struct({
  /** Repo-relative, with forward slashes. */
  file: Schema.String,
  /** The full name as bun prints it: the `describe` names and the test's, joined by " > ". */
  test: Schema.String,
  os: Schema.Union([Schema.Literal("all"), Schema.Array(Os)]),
  issue: Schema.optional(Schema.String),
  /** ISO date, YYYY-MM-DD. */
  added: Schema.String,
});

export type Entry = typeof Entry.Type;

export const QuarantineFile = Schema.Struct({
  $comment: Schema.String,
  entries: Schema.Array(Entry),
});

const decodeFile = Schema.decodeUnknownSync(Schema.fromJsonString(QuarantineFile));

/** Where the entries are and the root their files are relative to; tests point it elsewhere. */
export const quarantineSource = (env = process.env) => {
  const file = env.POLARIS_TEST_QUARANTINE_FILE;

  return file ? { file, root: realpathSync(dirname(file)) } : { file: QUARANTINE_FILE, root: ROOT };
};

export const readQuarantine = (path = quarantineSource().file): ReadonlyArray<Entry> =>
  existsSync(path) ? decodeFile(readFileSync(path, "utf8")).entries : [];

const PLATFORMS: Partial<Record<NodeJS.Platform, Os>> = {
  win32: "windows",
  darwin: "macos",
  linux: "linux",
};

export const currentOs = (platform: NodeJS.Platform = process.platform): Os | undefined =>
  PLATFORMS[platform];

export const appliesOn = (entry: Entry, os: Os | undefined): boolean =>
  entry.os === "all" || (os !== undefined && entry.os.includes(os));

/** `path` relative to the repo root, with forward slashes, as entries name files. */
export const repoPath = (path: string, root = ROOT): string =>
  relative(root, path).split(sep).join("/");

export const describeEntry = (entry: Entry): string =>
  `${entry.file} > ${entry.test} (${entry.issue ?? "no issue"}, since ${entry.added})`;

/** How the watchdog runs a package's tests under the quarantine. */
export interface QuarantinePlan {
  /** The args for `bun test`: `--quarantined` removed, and in that mode the files appended. */
  readonly args: ReadonlyArray<string>;
  /** The preload's mode, or none when no entry touches this package. */
  readonly mode: "skip" | "only" | undefined;
  /** Lines to print before the run, so no skip is silent. */
  readonly notice: ReadonlyArray<string>;
  /** `--quarantined` in a package with no quarantined test here: nothing to run. */
  readonly empty: boolean;
}

/** The tier filter (`tier.ts`) applies to explicit paths too, so `--quarantined` runs every tier. */
const TIER = /^--tier(?:=|$)/;

export const quarantinePlan = (
  given: ReadonlyArray<string>,
  cwd: string,
  entries: ReadonlyArray<Entry>,
  os: Os | undefined,
  root = quarantineSource().root
): QuarantinePlan => {
  const only = given.includes("--quarantined");
  const rest = given.filter((arg) => arg !== "--quarantined" && !(only && TIER.test(arg)));
  const prefix = repoPath(cwd, root);
  const under = prefix === "" ? "" : `${prefix}/`;
  const here = entries.filter((entry) => appliesOn(entry, os) && entry.file.startsWith(under));
  const lines = here.map((entry) => `  ${describeEntry(entry)}`);

  if (only) {
    const files = [...new Set(here.map((entry) => `./${entry.file.slice(under.length)}`))];

    const notice =
      here.length > 0 ? [`Running only the quarantined tests on ${os}:`, ...lines] : [];

    return { args: [...rest, ...files], mode: "only", notice, empty: here.length === 0 };
  }

  if (here.length === 0) return { args: rest, mode: undefined, notice: [], empty: false };

  return {
    args: rest,
    mode: "skip",
    notice: [`Quarantined on ${os}, skipped (tooling/test/quarantine.json):`, ...lines],
    empty: false,
  };
};

const ISSUE = /^ENG-\d+$/;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 86_400_000;

const entryProblems = (entry: Entry, today: Date, root: string): ReadonlyArray<string> => {
  const problems: Array<string> = [];

  if (!entry.issue || !ISSUE.test(entry.issue)) problems.push("needs an issue, e.g. ENG-123");
  const added = DATE.test(entry.added) ? Date.parse(`${entry.added}T00:00:00Z`) : Number.NaN;

  if (Number.isNaN(added)) problems.push(`added "${entry.added}" is not a YYYY-MM-DD date`);
  else if (Math.floor((today.getTime() - added) / DAY_MS) > MAX_AGE_DAYS)
    problems.push(`older than ${MAX_AGE_DAYS} days: fix the test or delete it`);

  if (!existsSync(join(root, entry.file))) problems.push("its file does not exist");

  if (entry.os !== "all" && entry.os.length === 0) problems.push('os is empty; use "all"');

  return problems.map((problem) => `${describeEntry(entry)}: ${problem}`);
};

/** What is wrong with the entries, one line per problem; empty when they pass. */
export const checkEntries = (
  entries: ReadonlyArray<Entry>,
  today: Date,
  root = ROOT
): ReadonlyArray<string> => entries.flatMap((entry) => entryProblems(entry, today, root));

const main = (args: ReadonlyArray<string>): number => {
  if (!args.includes("--check")) {
    console.error("usage: bun tooling/test/quarantine.ts --check");

    return 2;
  }

  const problems = checkEntries(readQuarantine(), new Date());

  if (problems.length === 0) return 0;
  console.error(`Quarantine: ${problems.length} problem(s) in tooling/test/quarantine.json\n`);
  console.error(problems.map((line) => `  ${line}`).join("\n"));

  return 1;
};

if (import.meta.main) process.exit(main(process.argv.slice(2)));
