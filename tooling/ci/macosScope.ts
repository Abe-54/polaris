#!/usr/bin/env bun
/**
 * Whether a PR's report-only macOS jobs run: they take runners main is queueing for, so only when
 * the PR's own files could behave differently there (ADR 0097). Main and the nightly always run them.
 * Writes `macos=true|false` to GITHUB_OUTPUT; no install needed, the Scope job has none.
 */
import { appendFileSync } from "node:fs";

/** What builds or runs the macOS jobs themselves. */
const INFRA =
  /^(\.github\/workflows\/ci\.yml$|\.github\/actions\/|bun\.lock$|package\.json$|patches\/|scripts\/build-daemon|tooling\/test\/|apps\/daemon\/scripts\/)/;

const SOURCE = /\.(ts|tsx|mts|js|mjs|sh|py|swift|json)$/;

const NOT_PRODUCT = /\.test\.|fixtures|docs\//;

export const MARKERS = "darwin|launchd|codesign|macOS|process\\.platform";

/** The changed files that call for macOS: `mentioning` is those whose text matches MARKERS. */
export const macosReasons = (
  changed: ReadonlyArray<string>,
  mentioning: ReadonlySet<string>
): ReadonlyArray<string> =>
  changed.filter(
    (file) =>
      INFRA.test(file) || (mentioning.has(file) && SOURCE.test(file) && !NOT_PRODUCT.test(file))
  );

const lines = (text: string) => text.split("\n").filter(Boolean);

const git = (...args: ReadonlyArray<string>) => Bun.spawnSync(["git", ...args]).stdout.toString();

const main = () => {
  const { EVENT, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY } = process.env;

  const reasons =
    EVENT === "pull_request"
      ? (() => {
          const changed = lines(git("diff", "--name-only", "HEAD^1", "HEAD"));
          const mentioning = lines(git("grep", "-lE", MARKERS, "--", ...changed));

          return macosReasons(changed, new Set(mentioning));
        })()
      : ["(not a pull request)"];

  const macos = reasons.length > 0;

  const said = macos
    ? `macOS jobs run, because of: ${reasons.slice(0, 10).join(", ")}`
    : "No macOS jobs: nothing this PR changes mentions macOS. A push to main runs them.";

  console.log(said);

  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `macos=${macos}\n`);

  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `${said}\n`);
};

if (import.meta.main) main();
