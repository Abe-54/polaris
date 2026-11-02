import { afterEach, describe, expect, test } from "bun:test";
import { FileError, NotFound, TerminalId } from "@polaris/protocol";
import { Effect, Exit, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { cpus } from "node:os";
import { delimiter, join } from "node:path";
import { hostProgram, plantAll, ranOf } from "../git/planted.testing.ts";
import { removeDir, tempDir } from "../git/testing.ts";
import { loginShell, type ShellSources, windowsShell } from "./shell.ts";
import { Scrollback, TerminalItem, Terminals, TerminalsLive } from "./Terminals.ts";

const RUN_TIMEOUT_MS = 3000;

/** These run `/bin/sh` and `stty`; Windows has its own below. */
const posix = test.skipIf(process.platform === "win32");

/** ConPTY and taskkill exist only on Windows. */
const windowsOnly = test.skipIf(process.platform !== "win32");

const fastExits = join(import.meta.dir, "fixtures", "fast-exits.ts");

const encode = (text: string) => new TextEncoder().encode(text);

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

let runtime: ManagedRuntime.ManagedRuntime<Terminals, never>;

const cleanup: Array<string> = [];

afterEach(async () => {
  await runtime?.dispose();

  for (const dir of cleanup.splice(0)) removeDir(dir);
});

const setup = () => {
  runtime = ManagedRuntime.make(Layer.fresh(TerminalsLive));
  const dir = tempDir("polaris-term-");
  cleanup.push(dir);

  /** Fails in RUN_TIMEOUT_MS instead of hanging the file (bun's test timeout can't fire if a call blocks the thread). */
  const run = <A, E>(f: (t: Terminals["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromise(
      Effect.gen(function* () {
        return yield* f(yield* Terminals);
      }).pipe(
        Effect.timeoutOrElse({
          duration: RUN_TIMEOUT_MS,
          orElse: () => Effect.die(new Error(`a Terminals call took over ${RUN_TIMEOUT_MS} ms`)),
        })
      )
    );

  /** Attaches and collects items into an array until the stream ends or is stopped. */
  const attach = (id: TerminalId) => {
    const items: Array<TerminalItem> = [];

    const fiber = runtime.runFork(
      Effect.gen(function* () {
        const terminals = yield* Terminals;
        yield* terminals
          .attach(id)
          .pipe(Stream.runForEach((item) => Effect.sync(() => items.push(item))));
      })
    );

    const text = () =>
      items
        .map((i) =>
          TerminalItem.match(i, { Output: (o) => decode(o.data), Exit: (e) => `<exit ${e.code}>` })
        )
        .join("");

    const waitFor = async (needle: string | RegExp, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        const current = text();

        if (needle instanceof RegExp ? needle.test(current) : current.includes(needle)) return;
        await Bun.sleep(20);
      }

      throw new Error(`timed out waiting for ${needle}; got ${JSON.stringify(text())}`);
    };

    return { items, fiber, text, waitFor, stop: () => runtime.runPromise(Fiber.interrupt(fiber)) };
  };

  return { dir, run, attach };
};

describe("Scrollback", () => {
  test("keeps the most recent bytes up to capacity", () => {
    const ring = new Scrollback(8);
    ring.push(encode("abc"));
    ring.push(encode("defg"));
    expect(decode(ring.snapshot())).toBe("abcdefg");
    ring.push(encode("hij"));
    expect(decode(ring.snapshot())).toBe("cdefghij");
    ring.push(encode("0123456789"));
    expect(decode(ring.snapshot())).toBe("23456789");
    expect(ring.byteLength).toBe(8);
  });
});

describe("Terminals", () => {
  posix("echo round-trip, resize, and Exit with the process's code", async () => {
    const { dir, run, attach } = setup();
    const id = await run((t) => t.open({ cwd: dir, cols: 80, rows: 24, argv: ["/bin/sh"] }));
    const a = attach(id);
    await run((t) => t.input(id, encode("echo round-$((40+2))-trip; pwd\n")));
    await a.waitFor("round-42-trip");
    await a.waitFor(dir);

    await run((t) => t.resize(id, 100, 40));
    await run((t) => t.input(id, encode("stty size\n")));
    await a.waitFor("40 100");

    await run((t) => t.input(id, encode("exit 3\n")));
    await a.waitFor("<exit 3>");
    const exit = await runtime.runPromise(Fiber.await(a.fiber));
    expect(Exit.isSuccess(exit)).toBe(true);
    const list = await run((t) => t.list);
    expect(list.find((i) => i.id === id)?.exit).toEqual({ code: 3 });
  });

  test("a bare command is the Host's on PATH, never one planted in the terminal's cwd", async () => {
    const { dir, run, attach } = setup();
    const bin = tempDir("polaris-term-bin-");
    cleanup.push(bin);
    const planted = plantAll(dir, "zzpolaris");
    hostProgram(bin, "zzpolaris", "host-program");
    // Windows keeps `Path`; POSIX would look in the cwd through the `.` and empty entries.
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    const saved = process.env[key];
    process.env[key] = [".", "", bin, saved ?? ""].join(delimiter);

    try {
      const id = await run((t) => t.open({ cwd: dir, cols: 80, rows: 24, argv: ["zzpolaris"] }));
      const a = attach(id);
      await a.waitFor("host-program", 15_000);
      await a.waitFor("<exit 0>", 15_000);
    } finally {
      process.env[key] = saved;
    }

    expect(ranOf(planted)).toEqual([]);
  }, 30_000);

  posix("late attachers get the scrollback replayed; many can attach at once", async () => {
    const { dir, run, attach } = setup();
    const id = await run((t) => t.open({ cwd: dir, cols: 80, rows: 24, argv: ["/bin/sh"] }));
    const first = attach(id);
    await run((t) => t.input(id, encode("echo before-late\n")));
    await first.waitFor(/before-late\r?\n/);

    // The first Client goes away; the terminal keeps running.
    await first.stop();
    const late = attach(id);
    await late.waitFor("before-late");
    const second = attach(id);
    await second.waitFor("before-late");
    await run((t) => t.input(id, encode("echo after-late\n")));
    await late.waitFor("after-late");
    await second.waitFor("after-late");
    await late.stop();
    await second.stop();
  });

  posix("attaching after exit replays the output and the Exit", async () => {
    const { dir, run, attach } = setup();

    const id = await run((t) =>
      t.open({ cwd: dir, cols: 80, rows: 24, argv: ["/bin/sh", "-c", "echo done-now; exit 0"] })
    );

    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
      const info = (await run((t) => t.list)).find((i) => i.id === id);

      if (info?.exit) break;
      await Bun.sleep(20);
    }

    const a = attach(id);
    await a.waitFor("done-now");
    await a.waitFor("<exit 0>");
  });

  posix("close ends attachers and forgets the terminal", async () => {
    const { dir, run, attach } = setup();
    const id = await run((t) => t.open({ cwd: dir, cols: 80, rows: 24, argv: ["/bin/cat"] }));
    const a = attach(id);
    await run((t) => t.input(id, encode("ping\n")));
    await a.waitFor("ping");
    await run((t) => t.close(id));
    await a.waitFor("<exit null>");
    const error = await run((t) => Effect.flip(t.input(id, encode("x"))));
    expect(error).toBeInstanceOf(NotFound);
    expect(error).toMatchObject({ what: "terminal" });
  });

  test("a missing cwd is a FileError; an unknown id is NotFound", async () => {
    const { run } = setup();

    const error = await run((t) =>
      Effect.flip(t.open({ cwd: "/definitely/missing", cols: 80, rows: 24, argv: null }))
    );

    expect(error).toBeInstanceOf(FileError);
    expect(error).toMatchObject({ code: "ENOENT" });
    const missing = await run((t) => Effect.flip(t.resize(TerminalId.make("nope"), 1, 1)));
    expect(missing._tag).toBe("NotFound");
  });

  // Under load the command could exit before Bun watched it, and Bun.spawn then hung (ADR 0052).
  test.skipIf(process.platform !== "darwin")(
    "commands that exit at once can't freeze the Daemon on a loaded macOS Host",
    async () => {
      const dir = tempDir("polaris-term-");
      cleanup.push(dir);

      // Busy loops that end themselves (alarm) even if this test is killed.
      const load = Array.from({ length: cpus().length * 2 }, () =>
        Bun.spawn(["perl", "-e", "alarm 40; 1 while 1"], { stdout: "ignore", stderr: "ignore" })
      );

      try {
        const child = Bun.spawn(["bun", fastExits, "200", dir], { stdout: "pipe", stderr: "pipe" });
        const deadline = setTimeout(() => child.kill("SIGKILL"), 25_000);
        const [out, err] = await Promise.all([child.stdout.text(), child.stderr.text()]);
        await child.exited;
        clearTimeout(deadline);
        expect({ out: out.trim(), err }).toEqual({ out: "done 200", err: "" });
      } finally {
        for (const p of load) p.kill("SIGKILL");
      }
    },
    40_000
  );

  posix("the default is the user's login shell", () => {
    expect(loginShell().startsWith("/")).toBe(true);
  });

  const unreadable = () => {
    throw new Error("unreadable");
  };

  const passwd = () => "root:x:0:0::/root:/bin/bash\nada:x:501:20::/home/ada:/usr/bin/fish\n";

  test.each<[string, ShellSources, string]>([
    [
      "the user record",
      { userShell: () => "/bin/zsh", passwd, uid: 501, envShell: "/bin/ksh" },
      "/bin/zsh",
    ],
    [
      "passwd when the user record says unknown",
      { userShell: () => "unknown", passwd, uid: 501, envShell: "/bin/ksh" },
      "/usr/bin/fish",
    ],
    [
      "SHELL when passwd has no row for the uid",
      { userShell: () => null, passwd, uid: 1000, envShell: "/opt/bin/nu" },
      "/opt/bin/nu",
    ],
    [
      "SHELL when neither record can be read",
      { userShell: unreadable, passwd: unreadable, uid: 501, envShell: "/opt/bin/nu" },
      "/opt/bin/nu",
    ],
    [
      "/bin/sh when nothing names a shell",
      { userShell: unreadable, passwd: unreadable, uid: 501, envShell: "" },
      "/bin/sh",
    ],
  ])("the login shell comes from %s", (_, sources, expected) => {
    expect(loginShell(sources)).toBe(expected);
  });

  const onPath =
    (...names: ReadonlyArray<string>) =>
    (name: string) =>
      names.includes(name) ? `C:\\bin\\${name}.exe` : null;

  test.each<[string, (name: string) => string | null, string | undefined, Array<string>]>([
    [
      "PowerShell 7 first",
      onPath("pwsh", "powershell", "cmd"),
      "C:\\cmd.exe",
      ["C:\\bin\\pwsh.exe", "-NoLogo"],
    ],
    [
      "Windows PowerShell without pwsh",
      onPath("powershell", "cmd"),
      "C:\\cmd.exe",
      ["C:\\bin\\powershell.exe", "-NoLogo"],
    ],
    ["ComSpec without either", onPath("cmd"), "C:\\Windows\\cmd.exe", ["C:\\Windows\\cmd.exe"]],
    ["cmd on PATH without ComSpec", onPath("cmd"), undefined, ["C:\\bin\\cmd.exe"]],
  ])("the Windows shell is %s", (_, find, comSpec, expected) => {
    expect(windowsShell({ find, comSpec })).toEqual(expected);
  });

  const isRunning = (pid: number) => {
    try {
      process.kill(pid, 0);

      return true;
    } catch {
      return false;
    }
  };

  windowsOnly(
    "the default shell echoes, resizes, and closing it ends its whole tree",
    async () => {
      const { dir, run, attach } = setup();
      const id = await run((t) => t.open({ cwd: dir, cols: 80, rows: 24, argv: null }));
      const a = attach(id);
      await run((t) => t.input(id, encode("echo round-$(40+2)-trip\r")));
      await a.waitFor("round-42-trip", 15_000);

      await run((t) => t.resize(id, 132, 41));
      await run((t) =>
        t.input(
          id,
          encode(
            'echo "size=$($Host.UI.RawUI.WindowSize.Width)x$($Host.UI.RawUI.WindowSize.Height)"\r'
          )
        )
      );
      await a.waitFor("size=132x41");

      const ping =
        "$p = Start-Process ping -ArgumentList '-n','600','127.0.0.1' -NoNewWindow -PassThru";

      await run((t) => t.input(id, encode(`${ping}; echo "child=$($p.Id)"\r`)));
      await a.waitFor(/child=\d+/);
      const child = Number(/child=(\d+)/.exec(a.text())![1]);
      const shell = (await run((t) => t.list)).find((info) => info.id === id)!.pid;
      expect([isRunning(shell), isRunning(child)]).toEqual([true, true]);

      await run((t) => t.close(id));
      await a.waitFor("<exit null>");
      expect([isRunning(shell), isRunning(child)]).toEqual([false, false]);
    },
    30_000
  );
});
