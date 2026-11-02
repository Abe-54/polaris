import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEntries, currentOs, type Entry, type Os } from "./quarantine.ts";

const WATCHDOG = join(import.meta.dir, "watchdog.ts");

const here = currentOs() ?? "linux";

const elsewhere: Os = here === "linux" ? "windows" : "linux";

const FLAKY = `import { describe, expect, test } from "bun:test";
describe("outer", () => {
  describe("inner", () => {
    test("flaky", () => expect("ran flaky").toBe("passes"));
    test("steady", () => expect(1).toBe(1));
  });
  test.each([1, 2])("row %p", () => expect("ran rows").toBe("passes"));
});
`;

/** The same names as FLAKY in another file: quarantine is per file, so these still run. */
const TWIN = `import { describe, expect, test } from "bun:test";
describe("outer", () => {
  describe("inner", () => {
    test("flaky", () => expect("ran twin").toBe("passes"));
  });
});
`;

const entry = (overrides: Partial<Entry> = {}): Entry => ({
  file: "pkg/flaky.test.ts",
  test: "outer > inner > flaky",
  os: "all",
  issue: "ENG-1",
  added: "2026-11-01",
  ...overrides,
});

const HEAVY = `import { expect, test } from "bun:test";
test("heavy", () => expect("ran heavy").toBe("passes"));
`;

const repo = (entries: ReadonlyArray<Entry>, twin = false, slow = false) => {
  const root = mkdtempSync(join(tmpdir(), "quarantine-"));

  mkdirSync(join(root, "pkg"));
  writeFileSync(join(root, "pkg/flaky.test.ts"), FLAKY);

  if (twin) writeFileSync(join(root, "pkg/twin.test.ts"), TWIN);

  if (slow) writeFileSync(join(root, "pkg/heavy.slow.test.ts"), HEAVY);
  writeFileSync(join(root, "quarantine.json"), JSON.stringify({ $comment: "", entries }));

  return root;
};

const watch = async (root: string, args: ReadonlyArray<string> = []) => {
  const proc = Bun.spawn(["bun", WATCHDOG, ...args], {
    cwd: join(root, "pkg"),
    env: {
      ...process.env,
      POLARIS_TEST_QUARANTINE_FILE: join(root, "quarantine.json"),
      POLARIS_TEST_PARALLEL: "1",
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

  return { output: stdout + stderr, code };
};

describe("the required lane", () => {
  test("skips a quarantined test by file and full name, says so, and runs the rest", async () => {
    const rows = entry({ test: "outer > row %p", issue: "ENG-2" });
    const { output, code } = await watch(repo([entry(), rows], true));

    expect(output).toContain(
      "(quarantined) skipped pkg/flaky.test.ts > outer > inner > flaky (ENG-1"
    );
    expect(output).toContain("(quarantined) skipped pkg/flaky.test.ts > outer > row %p (ENG-2");
    expect(output).not.toContain('"ran flaky"');
    expect(output).not.toContain('"ran rows"');
    expect(output).toContain("(pass) outer > inner > steady");
    // The twin has the same name in another file, and still runs (and fails).
    expect(output).toContain('"ran twin"');
    expect(code).toBe(1);
  }, 30_000);

  test("passes once its only failures are quarantined", async () => {
    const rows = entry({ test: "outer > row %p" });
    const { code } = await watch(repo([entry(), rows]));

    expect(code).toBe(0);
  }, 30_000);

  test("runs an entry quarantined only on another OS", async () => {
    const { output } = await watch(repo([entry({ os: [elsewhere] })]));

    expect(output).not.toContain("(quarantined)");
    expect(output).toContain('"ran flaky"');
  }, 30_000);
});

describe("with a tier", () => {
  const heavy = entry({ file: "pkg/heavy.slow.test.ts", test: "heavy", issue: "ENG-3" });

  test.each(["--tier=fast", "--tier=slow"])(
    "%s still skips quarantined tests",
    async (tier) => {
      const rows = entry({ test: "outer > row %p" });
      const { output, code } = await watch(repo([entry(), rows, heavy], false, true), [tier]);

      expect(output).toContain("(quarantined) skipped");
      expect(output).not.toContain('"ran');
      expect(code).toBe(0);
    },
    30_000
  );

  test("--quarantined ignores --tier=fast, which would drop a quarantined slow file", async () => {
    const { output, code } = await watch(repo([heavy], false, true), [
      "--quarantined",
      "--tier=fast",
    ]);

    expect(output).toContain('"ran heavy"');
    expect(code).toBe(1);
  }, 30_000);
});

describe("--quarantined", () => {
  test("runs only the quarantined tests, in their files only", async () => {
    const { output, code } = await watch(repo([entry({ os: [here] })], true), ["--quarantined"]);

    expect(output).toContain('"ran flaky"');
    expect(output).not.toContain('"ran rows"');
    expect(output).not.toContain('"ran twin"');
    expect(output).not.toContain("(pass) outer > inner > steady");
    expect(code).toBe(1);
  }, 30_000);

  test("passes with nothing to run in a package without entries", async () => {
    const { output, code } = await watch(repo([entry({ file: "other/a.test.ts" })]), [
      "--quarantined",
    ]);

    expect(output).toContain("No quarantined test in this package on this OS.");
    expect(code).toBe(0);
  }, 30_000);
});

describe("the check", () => {
  const root = repo([]);
  const today = new Date("2026-11-02T12:00:00Z");

  test.each([
    ["no issue", entry({ issue: undefined }), "needs an issue"],
    ["an issue that isn't an ENG id", entry({ issue: "flaky" }), "needs an issue"],
    ["31 days old", entry({ added: "2026-10-02" }), "older than 30 days"],
    ["no such file", entry({ file: "pkg/gone.test.ts" }), "its file does not exist"],
    ["a malformed date", entry({ added: "Oct 2" }), "is not a YYYY-MM-DD date"],
  ])("fails an entry with %s", (_, bad, problem) => {
    const problems = checkEntries([bad], today, root);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(problem);
  });

  test("passes an entry 30 days old with an issue and a file", () => {
    expect(checkEntries([entry({ added: "2026-10-03" })], today, root)).toEqual([]);
  });
});
