import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../engine/testing.ts";
import { removeTempDir } from "../../git/testing.ts";
import { executableOf } from "./executable.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

/** A `/proc` entry: its binary, its arguments and its children. */
const entry = (
  proc: string,
  pid: number,
  exe: string,
  argv: ReadonlyArray<string>,
  children: ReadonlyArray<number> = []
) => {
  const dir = join(proc, String(pid));
  mkdirSync(join(dir, "task", String(pid)), { recursive: true });
  symlinkSync(exe, join(dir, "exe"));
  writeFileSync(join(dir, "cmdline"), `${argv.join("\0")}\0`);
  writeFileSync(join(dir, "task", String(pid), "children"), children.map((c) => `${c} `).join(""));
};

const fakeProc = () => {
  const proc = tempDir();
  cleanup.push(proc);

  return proc;
};

const NATIVE = "/home/lucas/.codex/packages/standalone/releases/0.164.0/bin/codex";

describe("the app-server's binary", () => {
  test("is the recorded process's own when Codex runs natively", () => {
    const proc = fakeProc();
    entry(proc, 40, NATIVE, ["codex", "app-server", "--listen", "unix:///s"]);

    expect(executableOf(40, proc)).toBe(NATIVE);
  });

  test("is the native child an npm launcher starts, not node", () => {
    const proc = fakeProc();
    const vendored = "/home/lucas/.npm-global/lib/node_modules/@openai/codex/vendor/codex";
    entry(
      proc,
      40,
      "/usr/bin/node",
      ["node", "/home/lucas/.npm-global/bin/codex", "app-server"],
      [41, 42]
    );
    entry(proc, 41, "/usr/bin/cat", ["cat"]);
    entry(proc, 42, vendored, [vendored, "app-server", "--listen", "unix:///s"]);

    expect(executableOf(40, proc)).toBe(vendored);
  });

  test("is unknown when the process is gone", () => {
    expect(executableOf(40, fakeProc())).toBeNull();
  });
});
