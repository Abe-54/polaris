#!/usr/bin/env bun
/**
 * CLI over checks.ts.
 *
 *   bun tooling/quality/run.ts [--check] <files…>
 *   bun tooling/quality/run.ts [--check] --range <base>..<head>   files changed in a commit range
 *   bun tooling/quality/run.ts [--check] --dirty                  uncommitted and untracked files
 *   bun tooling/quality/run.ts --staged                           the pre-commit hook
 *
 * Without `--check` it applies oxlint's safe fixes (`oxlint --fix`), then formats.
 * `--staged` formats fully staged files and restages them; a partially staged file
 * is only checked, so its unstaged hunks never sneak into the commit.
 */
import { formatFailure, installed, type Mode, planChecks, ROOT, runSteps } from "./checks.ts";

const git = (...args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const run = Bun.spawnSync(["git", ...args], { cwd: ROOT });

  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);

  return run.stdout.toString().split("\n").filter(Boolean);
};

const changed = (...args: ReadonlyArray<string>) =>
  git("diff", "--name-only", "--diff-filter=ACMR", ...args);

const fail = (message: string) => {
  console.error(message);

  return 1;
};

/** Pre-commit: fix what can be restaged safely, check the rest. */
const staged = async () => {
  const files = changed("--cached");
  const unstaged = new Set(changed());
  const whole = files.filter((f) => !unstaged.has(f));
  const partial = files.filter((f) => unstaged.has(f));

  const failure =
    (await runSteps(planChecks(whole, "format"))) ?? (await runSteps(planChecks(partial, "check")));

  if (whole.length > 0) git("add", "--", ...whole);

  if (failure === null) return 0;

  return fail(
    `${formatFailure(failure)}\n\npre-commit: fix the errors above and commit again. Partially staged files are checked, not formatted: run bun run format, then stage them.`
  );
};

const filesFor = (args: ReadonlyArray<string>) => {
  const rangeAt = args.indexOf("--range");
  const range = rangeAt === -1 ? undefined : args[rangeAt + 1];

  if (range !== undefined) return changed(range);

  if (args.includes("--dirty")) {
    return [...changed("HEAD"), ...git("ls-files", "--others", "--exclude-standard")];
  }

  return args.filter((a) => !a.startsWith("--"));
};

const main = async () => {
  const args = process.argv.slice(2);

  if (!installed()) {
    return fail(`Dependencies aren't installed in ${ROOT}. Run bun install there first.`);
  }

  if (args.includes("--staged")) return staged();

  const mode: Mode = args.includes("--check") ? "check" : "fix";
  const failure = await runSteps(planChecks(filesFor(args), mode));

  return failure === null ? 0 : fail(formatFailure(failure));
};

process.exit(await main());
