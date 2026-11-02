/**
 * The fast-tier budget report: after a run, the fast files over 2 s, read from bun's
 * `--timings` file. It warns and never fails the run (docs/adr/0096-tests-split-into-a-fast-and-a-slow-tier.md).
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Schema } from "effect";
import { FILE_BUDGET_MS, overBudget } from "./tier.ts";

const Timings = Schema.Struct({
  version: Schema.Literal(1),
  files: Schema.Record(Schema.String, Schema.Number),
});

const decodeTimings = Schema.decodeUnknownSync(Schema.fromJsonString(Timings));

const TIMINGS_FLAG = /^--(?:timings|update-timings)(?:=|$)/;

const ROOT = join(import.meta.dir, "../..");

export interface RunTimings {
  /** The `bun test` flags that write the timings file. */
  readonly flags: ReadonlyArray<string>;
  /** Reads the file and removes it; null when there is none. */
  readonly read: () => string | null;
}

/** A timings file for the run, unless the caller already manages its own. */
export const timingsFor = (args: ReadonlyArray<string>): RunTimings => {
  if (args.some((arg) => TIMINGS_FLAG.test(arg))) return { flags: [], read: () => null };

  const dir = mkdtempSync(join(tmpdir(), "polaris-timings-"));
  const file = join(dir, "timings.json");

  return {
    flags: [`--timings=${file}`, "--update-timings"],
    read: () => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return null;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The report's lines, or none when every fast file kept to the budget. */
export const budgetReport = (
  timings: string,
  cwd: string
): { readonly text: string; readonly markdown: string } | null => {
  const over = overBudget(decodeTimings(timings).files);

  if (over.length === 0) return null;

  const rows = over.map(([file, ms]) => [relative(ROOT, join(cwd, file)), seconds(ms)] as const);
  const head = `${over.length} fast-tier test file(s) over the ${seconds(FILE_BUDGET_MS)} budget; speed them up or rename them *.slow.test.ts:`;

  return {
    text: [head, ...rows.map(([file, time]) => `  ${time.padStart(7)}  ${file}`)].join("\n"),
    markdown: [
      `### ${head}`,
      "",
      "| File | Time |",
      "| --- | ---: |",
      ...rows.map(([file, time]) => `| \`${file}\` | ${time} |`),
      "",
    ].join("\n"),
  };
};

/** Prints the report, and adds it to the GitHub job summary under Actions. */
export const reportBudget = (
  timings: string | null,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>
) => {
  const report = timings === null ? null : budgetReport(timings, cwd);

  if (report === null) return;

  console.error(`\n${report.text}`);

  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${report.markdown}\n`);
};
