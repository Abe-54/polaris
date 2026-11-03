import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installed, planChecks, ROOT, runSteps } from "./checks.ts";

const CRAMPED = `export const f = (a: number) => {
  const b = a + 1;
  if (b > 2) return b;
  return a;
};
`;

const SPACED = `export const f = (a: number) => {
  const b = a + 1;

  if (b > 2) return b;

  return a;
};
`;

// The file must sit in the repo so the repo's oxlint configs and plugins apply to it.
const run = (args: ReadonlyArray<string>) => {
  const relative = `tooling/quality/fix-fixture-${process.pid}-${Date.now()}.ts`;
  const file = join(ROOT, relative);

  writeFileSync(file, CRAMPED);

  try {
    const result = Bun.spawnSync(
      [process.execPath, join(ROOT, "tooling/quality/run.ts"), ...args, relative],
      { cwd: ROOT }
    );

    return { code: result.exitCode, text: readFileSync(file, "utf8") };
  } finally {
    rmSync(file, { force: true });
  }
};

test("fix mode applies oxlint's autofixes (require-readable-spacing), then passes the ratchet", () => {
  expect(run([])).toEqual({ code: 0, text: SPACED });
}, 30000);

test("--check leaves the file alone and fails on the same violation", () => {
  expect(run(["--check"])).toEqual({ code: 1, text: CRAMPED });
}, 30000);

test("pre-commit format mode finds the installed formatter and formats on this platform", async () => {
  const relative = `tooling/quality/format-fixture-${process.pid}.ts`;
  const file = join(ROOT, relative);

  writeFileSync(file, "export const value=1;\n");

  try {
    expect(installed()).toBe(true);
    expect(await runSteps(planChecks([relative], "format"))).toBeNull();
    expect(readFileSync(file, "utf8")).toBe("export const value = 1;\n");
    expect(await runSteps(planChecks([relative], "check"))).toBeNull();
  } finally {
    rmSync(file, { force: true });
  }
}, 30000);
