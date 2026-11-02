import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { executableOf } from "../platform/executable.ts";
import { isRunning } from "../platform/processes.ts";
import { childProcesses } from "../platform/windowsNative.ts";
import { git, gitText, runGit } from "./git.ts";
import { finishingGit } from "./interrupt.ts";
import { makeRepo, tempDir, write } from "./testing.ts";

const windows = process.platform === "win32";

/** The git processes this test process started that are still running. */
const gitChildren = (): ReadonlyArray<number> => {
  if (windows)
    return childProcesses(process.pid)
      .filter((child) => /^git(\.exe)?$/i.test(child.exe))
      .map((child) => child.pid);

  const ps = Bun.spawnSync([executableOf("ps"), "-axo", "pid=,ppid=,comm="], { stderr: "ignore" });

  return new TextDecoder()
    .decode(ps.stdout)
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([, ppid, comm]) => Number(ppid) === process.pid && /(^|\/)git$/.test(comm ?? ""))
    .map(([pid]) => Number(pid));
};

/** A shell script git runs; it records its own pid (the Windows one under Git's sh), then waits. */
const slowScript = (dir: string, name: string, body: string) => {
  const marker = join(dir, `${name}.pid`).replaceAll("\\", "/");
  write(
    dir,
    `${name}.sh`,
    `#!/bin/sh\n{ cat /proc/$$/winpid 2>/dev/null || echo $$; } > "${marker}.tmp"\n` +
      `mv "${marker}.tmp" "${marker}"\n${body}\n`
  );

  return {
    script: join(dir, `${name}.sh`).replaceAll("\\", "/"),
    pidFile: join(dir, `${name}.pid`),
  };
};

const until = async (check: () => boolean, ms: number) => {
  const end = Date.now() + ms;

  while (!check() && Date.now() < end) await Bun.sleep(20);

  return check();
};

describe("an interrupted git call", () => {
  test("a read is killed with what it started, and none of it outlives the Effect", async () => {
    const repo = await makeRepo({ "a.txt": "a\n" });
    write(repo, "a.txt", "b\n");
    const { script, pidFile } = slowScript(tempDir(), "diff", "sleep 30");

    const read = git(repo, ["diff"], {
      config: "host",
      env: { GIT_EXTERNAL_DIFF: `sh "${script}"` },
    });

    const fiber = Effect.runFork(read);

    expect(await until(() => existsSync(pidFile), 10_000)).toBe(true);
    const hook = Number(readFileSync(pidFile, "utf8").trim());
    expect(gitChildren().length).toBeGreaterThan(0);

    await Effect.runPromise(Fiber.interrupt(fiber));

    // git is reaped before the Effect ends; its hook, killed with it, may take a moment more.
    expect(gitChildren()).toEqual([]);
    expect(await until(() => !isRunning(hook), 2_000)).toBe(true);
  }, 20_000);

  describe("a ref transaction", () => {
    const transaction = async (hookBody: string) => {
      const repo = await makeRepo({ "a.txt": "a\n" });
      const head = await gitText(repo, ["rev-parse", "HEAD"]);
      const hooks = tempDir();
      const { script, pidFile } = slowScript(hooks, "slow", hookBody);
      // The hook runs in the prepared state: every ref is locked, none is written yet.
      write(
        hooks,
        "reference-transaction",
        `#!/bin/sh\n[ "$1" = prepared ] || exit 0\nsh "${script}"\n`
      );
      chmodSync(join(hooks, "reference-transaction"), 0o755);
      await gitText(repo, ["config", "core.hooksPath", hooks.replaceAll("\\", "/")]);
      const refs = ["refs/polaris/test/a", "refs/polaris/test/b"];
      const stdin = refs.map((ref) => `create ${ref} ${head}\n`).join("");

      return { repo, refs, stdin, started: () => existsSync(pidFile) };
    };

    const written = async (repo: string, refs: ReadonlyArray<string>) => {
      const listed = await gitText(repo, ["for-each-ref", "--format=%(refname)", "refs/polaris/"]);

      return refs.map((ref) => listed.split("\n").includes(ref));
    };

    const locks = (repo: string) =>
      readdirSync(join(repo, ".git"), { recursive: true, encoding: "utf8" }).filter((path) =>
        path.endsWith(".lock")
      );

    test("finishes when it can, before the Effect ends", async () => {
      const { repo, refs, stdin, started } = await transaction("sleep 1");

      const fiber = Effect.runFork(
        finishingGit({
          try: () => runGit(repo, ["update-ref", "--stdin"], { config: "host", stdin }),
          catch: String,
        })
      );

      expect(await until(started, 10_000)).toBe(true);
      await Effect.runPromise(Fiber.interrupt(fiber));

      expect(await written(repo, refs)).toEqual([true, true]);
      expect(locks(repo)).toEqual([]);
      expect(gitChildren()).toEqual([]);
    }, 20_000);

    // taskkill can only force a kill, which leaves git's lock files behind (ENG-363).
    test.skipIf(windows)(
      "past its deadline is killed and writes nothing",
      async () => {
        const { repo, refs, stdin, started } = await transaction("sleep 30");

        const fiber = Effect.runFork(
          finishingGit(
            {
              try: () => runGit(repo, ["update-ref", "--stdin"], { config: "host", stdin }),
              catch: String,
            },
            200
          )
        );

        expect(await until(started, 10_000)).toBe(true);
        await Effect.runPromise(Fiber.interrupt(fiber));

        expect(gitChildren()).toEqual([]);
        expect(await written(repo, refs)).toEqual([false, false]);
        expect(locks(repo)).toEqual([]);
      },
      20_000
    );
  });
});
