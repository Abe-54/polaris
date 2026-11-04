#!/usr/bin/env bun
/**
 * pre-push: for each pushed ref, checks formatting and lint on the changed files
 * (without writing), then through turbo typechecks the changed packages and their
 * dependents and runs the changed packages' fast-tier tests. Git passes `<local ref> <local sha> <remote ref> <remote sha>`
 * lines on stdin.
 */
import { Schema } from "effect";
import { bin, formatFailure, installed, planChecks, ROOT, runSteps, type Step } from "./checks.ts";
import { type Affected, planWindowsTests, windowsLists } from "./windows.ts";

const ZERO = /^0+$/;

const git = (...args: ReadonlyArray<string>) => {
  const run = Bun.spawnSync(["git", ...args], { cwd: ROOT });

  return run.exitCode === 0 ? run.stdout.toString().trim() : null;
};

/** The commit a push is measured from: the remote tip, or where a new branch left main. */
const baseOf = (localSha: string, remoteSha: string) =>
  ZERO.test(remoteSha) ? git("merge-base", localSha, "origin/main") : remoteSha;

const turbo = (task: string, filters: ReadonlyArray<string>, ...args: ReadonlyArray<string>) => [
  bin("turbo"),
  "run",
  task,
  ...filters,
  "--output-logs=errors-only",
  ...(args.length > 0 ? ["--", ...args] : []),
];

const DryRun = Schema.Struct({
  tasks: Schema.Array(Schema.Struct({ package: Schema.String, directory: Schema.String })),
});

/** The packages `turbo run test <filter>` would test. */
const affected = (filter: string): ReadonlyArray<Affected> => {
  const dry = Bun.spawnSync([bin("turbo"), "run", "test", filter, "--dry=json"], { cwd: ROOT });
  const { tasks } = Schema.decodeUnknownSync(Schema.fromJsonString(DryRun))(dry.stdout.toString());

  return tasks.map((task) => ({
    name: task.package,
    directory: task.directory.replaceAll("\\", "/"),
  }));
};

/** On Windows the POSIX-only packages are CI's, and their Windows-safe files run instead. */
const windowsTestSteps = (filter: string): ReadonlyArray<Step> => {
  const { posixOnly, windowsFiles } = windowsLists(ROOT);
  const plan = planWindowsTests(affected(filter), posixOnly, windowsFiles);

  if (plan.skipped.length > 0)
    console.error(
      `pre-push: on Windows, CI tests ${plan.skipped.join(", ")} on Linux and macOS (tooling/ci/windows-skipped-packages.txt).`
    );

  const packages: Step = {
    label: "test the changed packages (fast tier)",
    command: turbo(
      "test",
      plan.packages.map((name) => `--filter=${name}`),
      "--tier=fast"
    ),
  };

  const files: Step = {
    label: "test their Windows-safe files (fast tier)",
    command: [process.execPath, "tooling/test/watchdog.ts", "--tier=fast", ...plan.files],
  };

  return [
    ...(plan.packages.length > 0 ? [packages] : []),
    ...(plan.files.length > 0 ? [files] : []),
  ];
};

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
      command: turbo("typecheck", [`--filter=...[${base}...${head}]`]),
    },
    // Dependents' tests and the slow tier are CI's job; a push tests the changed packages' fast tier.
    ...(process.platform === "win32"
      ? windowsTestSteps(`--filter=[${base}...${head}]`)
      : [
          {
            label: "test the changed packages (fast tier)",
            command: turbo("test", [`--filter=[${base}...${head}]`], "--tier=fast"),
          },
        ]),
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
