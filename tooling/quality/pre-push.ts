#!/usr/bin/env bun
/**
 * pre-push: for each pushed ref, checks formatting and lint on the changed files
 * (without writing), then through turbo typechecks the changed packages and their
 * dependents and runs the changed packages' fast-tier tests. Git passes `<local ref> <local sha> <remote ref> <remote sha>`
 * lines on stdin.
 */
import { bin, formatFailure, installed, planChecks, ROOT, runSteps, type Step } from "./checks.ts";

const ZERO = /^0+$/;

const git = (...args: ReadonlyArray<string>) => {
  const run = Bun.spawnSync(["git", ...args], { cwd: ROOT });

  return run.exitCode === 0 ? run.stdout.toString().trim() : null;
};

/** The commit a push is measured from: the remote tip, or where a new branch left main. */
const baseOf = (localSha: string, remoteSha: string) =>
  ZERO.test(remoteSha) ? git("merge-base", localSha, "origin/main") : remoteSha;

const turbo = (task: string, filter: string, ...args: ReadonlyArray<string>) => [
  bin("turbo"),
  "run",
  task,
  filter,
  "--output-logs=errors-only",
  ...(args.length > 0 ? ["--", ...args] : []),
];

const stepsFor = (base: string, head: string): ReadonlyArray<Step> => {
  const files = (git("diff", "--name-only", "--diff-filter=ACMR", `${base}..${head}`) ?? "")
    .split("\n")
    .filter(Boolean);

  const scripts: ReadonlyArray<Step> = files.some((f) => f.startsWith("scripts/"))
    ? [
        {
          label: "typecheck scripts",
          command: [process.execPath, "check", "-p", "scripts"],
        },
        // A bare "scripts" is a name filter that would also match every package's scripts/.
        { label: "test scripts", command: [process.execPath, "test", "./scripts/"] },
      ]
    : [];

  return [
    ...planChecks(files, "check"),
    {
      label: "typecheck the changed packages and their dependents",
      command: turbo("typecheck", `--filter=...[${base}...${head}]`),
    },
    // Dependents' tests and the slow tier are CI's job; a push tests the changed packages' fast tier.
    {
      label: "test the changed packages (fast tier)",
      command: turbo("test", `--filter=[${base}...${head}]`, "--tier=fast"),
    },
    ...scripts,
  ];
};

const main = async () => {
  if (!installed()) {
    console.error(
      `pre-push: dependencies aren't installed in ${ROOT}. Run bun install, then push again.`
    );

    return 1;
  }

  const refs = (await Bun.stdin.text()).split("\n").filter(Boolean);

  for (const ref of refs) {
    const [, localSha = "", , remoteSha = ""] = ref.split(" ");
    const base = ZERO.test(localSha) ? null : baseOf(localSha, remoteSha);

    if (base === null) continue;

    const failure = await runSteps(stepsFor(base, localSha));

    if (failure !== null) {
      console.error(
        `${formatFailure(failure)}\n\npre-push: fix the errors above, commit, and push again.`
      );

      return 1;
    }
  }

  return 0;
};

process.exit(await main());
