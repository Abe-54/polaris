import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WATCHDOG = join(import.meta.dir, "watchdog.ts");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

/** Whether `pid` exits within 2 s: a killed process lingers until it is reaped. */
const gone = async (pid: number) => {
  for (let tries = 0; tries < 40 && alive(pid); tries++) await Bun.sleep(50);

  return !alive(pid);
};

const suite = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "watchdog-"));

  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);

  return dir;
};

const watch = async (
  dir: string,
  stallSeconds = 1,
  githubActions = false,
  args: ReadonlyArray<string> = [],
  parallel = "1"
) => {
  const proc = Bun.spawn(["bun", WATCHDOG, ...args], {
    cwd: dir,
    env: {
      ...process.env,
      POLARIS_TEST_STALL_S: String(stallSeconds),
      GITHUB_ACTIONS: githubActions ? "true" : "",
      POLARIS_TEST_PARALLEL: parallel,
      CLAUDECODE: "",
      AI_AGENT: "",
      CLAUDE_CODE_ENTRYPOINT: "",
      CURSOR_AGENT: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { code, output: stdout + stderr };
};

const PASSES = `import { test } from "bun:test";\ntest("adds", () => {});\n`;

describe("the test watchdog", () => {
  test.each([
    ["locally", false],
    ["under GitHub Actions", true],
  ])(
    "a hung test %s fails the run and names its file and the last result before it",
    async (_, githubActions) => {
      const dir = suite({
        "a.test.ts": PASSES,
        "b.test.ts": `import { test } from "bun:test";\ntest("first", () => {});\ntest("hangs", () => new Promise(() => {}), 60_000);\n`,
      });

      const { code, output } = await watch(dir, 1, githubActions);

      expect(code).toBe(1);
      expect(output).toContain("bun test stalled: no output for 1s, in b.test.ts");
      expect(output).toContain("last result: (pass) first");
    },
    20_000
  );

  test.each([
    ["locally", false],
    ["under GitHub Actions", true],
  ])(
    "in a parallel run %s, a hung file is named, files that finished meanwhile are not, and its worker is killed",
    async (_, githubActions) => {
      const dir = suite({
        "hangs.test.ts": `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("first", () => writeFileSync("worker.pid", String(process.pid)));\ntest("hangs", () => new Promise(() => {}), 60_000);\n`,
        "slow.test.ts": `import { test } from "bun:test";\nfor (const n of [1, 2, 3]) test(\`slow \${n}\`, () => Bun.sleep(300));\n`,
      });

      const { code, output } = await watch(dir, 2, githubActions, ["--parallel=2"]);

      expect(code).toBe(1);
      expect(output).toContain("bun test stalled: no output for 2s, in hangs.test.ts");
      expect(output).toContain("last result: (pass) first");
      expect(output).toContain("(pass) slow 3");
      expect(output).not.toContain("slow.test.ts\n  last result");
      expect(output).not.toContain("polaris-test");
      expect(await gone(Number(readFileSync(join(dir, "worker.pid"), "utf8")))).toBe(true);
    },
    20_000
  );

  test.each([
    ["passing", PASSES, 0],
    [
      "failing",
      `import { expect, test } from "bun:test";\ntest("no", () => expect(1).toBe(2));\n`,
      1,
    ],
  ])(
    "a %s run that finishes keeps bun's exit code and no stall report",
    async (_, body, exit) => {
      const { code, output } = await watch(suite({ "a.test.ts": body }), 30);

      expect(code).toBe(exit);
      expect(output).not.toContain("stalled");
    },
    20_000
  );

  /** Each file waits for the other's flag, so the run passes only when both run at once. */
  const rendezvous = (mine: string, theirs: string) =>
    `import { test } from "bun:test";\nimport { existsSync, writeFileSync } from "node:fs";\ntest("meets", async () => {\n  writeFileSync("${mine}", "");\n  while (!existsSync("${theirs}")) await Bun.sleep(20);\n}, 4_000);\n`;

  test.each([
    ["runs files in parallel", "2", 0],
    ["runs files one at a time when set to 1", "1", 1],
  ])(
    "with no scheduling flags, POLARIS_TEST_PARALLEL %s",
    async (_, parallel, exit) => {
      const dir = suite({
        "a.test.ts": rendezvous("a.flag", "b.flag"),
        "b.test.ts": rendezvous("b.flag", "a.flag"),
      });

      const { code } = await watch(dir, 30, false, [], parallel);

      expect(code).toBe(exit);
    },
    20_000
  );
});
