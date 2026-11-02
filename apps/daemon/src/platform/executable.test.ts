import { afterEach, describe, expect, test } from "bun:test";
import { basename, delimiter, join } from "node:path";
import { hostProgram, plantAll, ranOf } from "../git/planted.testing.ts";
import {
  ExecutableNotFound,
  executableOf,
  findExecutable,
  pathOf,
  windowsSearch,
} from "./executable.ts";
import { newTempDir, removeTempDir } from "./tempDir.testing.ts";

const dirs: Array<string> = [];

const temp = (prefix: string) => {
  const dir = newTempDir(prefix, { short: true });
  dirs.push(dir);

  return dir;
};

const home = process.cwd();

/** The test's own env with no PATH under any casing (Windows keeps `Path`). */
const withoutPath = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));

afterEach(() => {
  process.chdir(home);

  for (const dir of dirs.splice(0)) removeTempDir(dir);
});

describe("a program the Daemon starts in a repository", () => {
  test("is the Host's on PATH, never one planted in the cwd, also with `.` and empty PATH entries", async () => {
    const repo = temp("exe-repo-");
    const bin = temp("exe-bin-");
    const planted = plantAll(repo, "zzpolaris");
    hostProgram(bin, "zzpolaris", "host-program");
    // Windows looks in the cwd first anyway; POSIX would only through `.`, resolved against the cwd.
    const env = { ...withoutPath(), PATH: ["", ".", bin].join(delimiter) };

    const proc = Bun.spawn([executableOf("zzpolaris", env)], {
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect((await new Response(proc.stdout).text()).trim()).toBe("host-program");
    expect(await proc.exited).toBe(0);
    expect(ranOf(planted)).toEqual([]);
  }, 30_000);

  test("a `.` PATH entry is the Daemon's cwd, given as an absolute path", () => {
    const daemonCwd = temp("exe-cwd-");
    const program = hostProgram(daemonCwd, "zzpolaris", "x");
    process.chdir(daemonCwd);

    expect(findExecutable("zzpolaris", { PATH: "." })?.toLowerCase()).toBe(
      join(process.cwd(), basename(program)).toLowerCase()
    );
  });

  test("a relative path is the Daemon's cwd's, an absolute one stays as given", () => {
    const daemonCwd = temp("exe-cwd-");
    process.chdir(daemonCwd);

    expect(findExecutable(join("bin", "codex"), { PATH: "" })).toBe(
      join(process.cwd(), "bin", "codex")
    );
    expect(executableOf("/opt/codex/bin/codex", { PATH: "" })).toBe("/opt/codex/bin/codex");
  });

  test("a program on no PATH directory is an error naming it, never its bare name", () => {
    const empty = temp("exe-empty-");

    expect(findExecutable("zzpolaris-missing", { PATH: empty })).toBeNull();
    expect(() => executableOf("zzpolaris-missing", { PATH: empty })).toThrow(
      new ExecutableNotFound({ program: "zzpolaris-missing" })
    );
    expect(new ExecutableNotFound({ program: "git" }).message).toBe(
      "git is not installed, or not on the Daemon's PATH"
    );
  });
});

describe("windowsSearch: Windows' lookup without its cwd step", () => {
  const files = (...paths: Array<string>) => {
    const set = new Set(paths.map((p) => p.toLowerCase()));

    return { isFile: (path: string) => set.has(path.toLowerCase()) };
  };

  test("each PATH directory in order, then each PATHEXT extension in PATHEXT's order", () => {
    const io = files("C:\\b\\git.cmd", "C:\\b\\git.exe", "C:\\c\\git.exe");

    expect(windowsSearch("git", "C:\\a;C:\\b;C:\\c", ".EXE;.CMD", io)).toBe("C:\\b\\git.exe");
    expect(windowsSearch("git", "C:\\a;C:\\b;C:\\c", ".CMD;.EXE", io)).toBe("C:\\b\\git.cmd");
  });

  test("only what Bun.spawn can start: PATHEXT's .JS or .PS1 is never found", () => {
    const io = files("C:\\a\\tool.js", "C:\\a\\tool.ps1", "C:\\b\\tool.bat");

    expect(windowsSearch("tool", "C:\\a;C:\\b", ".JS;.PS1;.BAT", io)).toBe("C:\\b\\tool.bat");
    expect(windowsSearch("tool", "C:\\a", ".JS;.PS1", io)).toBeNull();
  });

  test("no PATHEXT is .COM, .EXE, .BAT, .CMD; a name with one of those is looked up as given", () => {
    const io = files("C:\\a\\x.bat", "C:\\a\\x.exe.exe", "C:\\a\\x.exe");

    expect(windowsSearch("x", "C:\\a", undefined, io)).toBe("C:\\a\\x.exe");
    expect(windowsSearch("x.exe", "C:\\a", ".EXE", io)).toBe("C:\\a\\x.exe");
  });

  test("empty entries are no directory; an entry's quotes are stripped", () => {
    const io = files("C:\\Program Files\\Git\\cmd\\git.exe", "git.exe", "\\git.exe");

    expect(windowsSearch("git", ';;"C:\\Program Files\\Git\\cmd"', ".EXE", io)).toBe(
      "C:\\Program Files\\Git\\cmd\\git.exe"
    );
    expect(windowsSearch("git", ";", ".EXE", io)).toBeNull();
  });
});

test("Windows' PATH is found under any case of its name, as a child would get it", () => {
  expect(pathOf({ Path: "C:\\Git\\cmd" }, "win32")).toBe("C:\\Git\\cmd");
  expect(pathOf({ Path: "C:\\Git\\cmd" }, "linux")).toBe("");
  expect(pathOf({ PATH: "/usr/bin" }, "linux")).toBe("/usr/bin");
});
