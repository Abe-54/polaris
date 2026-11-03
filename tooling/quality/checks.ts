/**
 * The file-level quality checks behind the git hooks: oxfmt formatting, then the
 * oxlint ratchet. Same rules as `bun run lint` in CI, scoped to the given files.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lint/oxlint.ts";

export { ROOT };

export type Mode = "fix" | "check";

export interface Step {
  readonly label: string;
  readonly command: ReadonlyArray<string>;
}

export interface Failure {
  readonly step: Step;
  readonly output: string;
}

export const bin = (name: string) =>
  join(ROOT, "node_modules/.bin", process.platform === "win32" ? `${name}.exe` : name);

/** Whether this checkout has its dependencies installed; hooks refuse to run without them. */
export const installed = () => existsSync(bin("oxfmt")) && existsSync(bin("oxlint"));

/**
 * oxfmt formats (or checks) the files, then the ratchet lints them. Deleted files are
 * skipped; oxfmt applies oxfmt.config.mts's ignorePatterns to explicit paths too.
 */
export const planChecks = (files: ReadonlyArray<string>, mode: Mode): ReadonlyArray<Step> => {
  const present = [...new Set(files)].filter((f) => existsSync(join(ROOT, f)));

  if (present.length === 0) return [];

  const check = mode === "check" ? ["--check"] : [];

  return [
    {
      label: mode === "fix" ? "oxfmt" : "oxfmt --check",
      command: [bin("oxfmt"), ...check, "--no-error-on-unmatched-pattern", ...present],
    },
    {
      label: "oxlint ratchet",
      command: [process.execPath, join(ROOT, "tooling/lint/ratchet.ts"), ...present],
    },
  ];
};

const runStep = async (step: Step): Promise<Failure | null> => {
  const child = Bun.spawn([...step.command], {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return code === 0 ? null : { step, output: `${stdout}${stderr}`.trim() };
};

/** Runs the steps in order and stops at the first failure. */
export const runSteps = async (steps: ReadonlyArray<Step>): Promise<Failure | null> => {
  for (const step of steps) {
    const failure = await runStep(step);

    if (failure !== null) return failure;
  }

  return null;
};

export const formatFailure = ({ step, output }: Failure) => `✖ ${step.label}\n${output}`;
