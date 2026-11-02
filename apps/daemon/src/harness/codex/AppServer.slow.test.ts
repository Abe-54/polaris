import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import {
  isOurAppServer,
  launchArgv,
  acquireAppServer,
  readAppServerState,
  remoteTuiArgv,
  stopAppServer,
  tokenFileOf,
} from "./AppServer.ts";
import { makeFakeCodex } from "./testing/fakeCodex.ts";
import { posixTest, shortTemp } from "../../platform/testing.ts";

const dirs: Array<string> = [];

const pids: Array<number> = [];

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }

  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const setup = (version = "1.0.0") => {
  // Short: Unix socket paths are capped near 104 bytes.
  const dir = mkdtempSync(shortTemp("pas-"));
  dirs.push(dir);
  const codex = makeFakeCodex(dir, version);
  const socketPath = join(dir, "c.sock");
  const stateFile = join(dir, "codex-app-server.json");
  const options = { codexPath: codex.path, socketPath, spawn: true, stateFile, systemdRun: null };

  return { dir, codex, socketPath, stateFile, options };
};

/** One "Daemon lifetime": make the server handle, connect once, close the scope. */
const connectOnce = (options: Parameters<typeof acquireAppServer>[0]) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* acquireAppServer(options);
        const conn = yield* server.connect;
        yield* conn.request("initialize", {});
      })
    )
  );

const recordedPid = (stateFile: string) => {
  const state = readAppServerState(stateFile);

  if (state === null) throw new Error("no state file");
  pids.push(state.pid);

  return state.pid;
};

const parentOf = (pid: number) =>
  Number(
    Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)])
      .stdout.toString()
      .trim()
  );

/**
 * On Windows the server is the Daemon's hidden child on a loopback port, not a detached
 * server on a socket (ADR 0061); windowsServer.test.ts covers that one.
 */
const detachedServer = posixTest(
  "the Windows Codex server is the Daemon's child on a loopback port, not detached on a socket (ENG-318)"
);

describe("the shared app-server outlives the Daemon", () => {
  detachedServer(
    "an idle legacy server is replaced with a sanitized server",
    async () => {
      const { socketPath, stateFile, options } = setup();
      await connectOnce(options);
      const old = recordedPid(stateFile);
      const state = readAppServerState(stateFile);
      writeFileSync(stateFile, JSON.stringify({ ...state, sanitizedEnv: undefined }));
      await connectOnce(options);
      expect(recordedPid(stateFile)).not.toBe(old);
      expect(isOurAppServer(old, socketPath)).toBe(false);
      expect(readAppServerState(stateFile)?.sanitizedEnv).toBe(true);
    },
    30_000
  );

  detachedServer(
    "a live legacy server is reused, then replaced once idle",
    async () => {
      const { codex, socketPath, stateFile, options } = setup();
      codex.setLoaded(["thread-live"]);
      await connectOnce(options);
      const old = recordedPid(stateFile);
      const state = readAppServerState(stateFile);
      writeFileSync(stateFile, JSON.stringify({ ...state, sanitizedEnv: undefined }));
      await connectOnce(options);
      expect(recordedPid(stateFile)).toBe(old);
      expect(isOurAppServer(old, socketPath)).toBe(true);
      expect(readAppServerState(stateFile)?.sanitizedEnv).toBeUndefined();
      codex.setLoaded([]);
      await connectOnce(options);
      expect(recordedPid(stateFile)).not.toBe(old);
      expect(readAppServerState(stateFile)?.sanitizedEnv).toBe(true);
    },
    30_000
  );

  detachedServer(
    "it is started detached, recorded, and not killed when the scope closes",
    async () => {
      const { socketPath, stateFile, options } = setup();
      await connectOnce(options);
      const state = readAppServerState(stateFile);
      expect(state).toMatchObject({ version: "1.0.0", socketPath });
      const pid = recordedPid(stateFile);
      // Still running after the "Daemon" is gone, and not our child.
      expect(isOurAppServer(pid, socketPath)).toBe(true);
      expect(parentOf(pid)).not.toBe(process.pid);
    },
    20_000
  );

  detachedServer(
    "the next Daemon adopts it through the socket instead of starting another",
    async () => {
      const { stateFile, options } = setup();
      await connectOnce(options);
      const first = recordedPid(stateFile);
      await connectOnce(options);
      expect(recordedPid(stateFile)).toBe(first);
    },
    20_000
  );

  detachedServer(
    "after a codex upgrade an idle server is replaced",
    async () => {
      const { codex, socketPath, stateFile, options } = setup("1.0.0");
      await connectOnce(options);
      const old = recordedPid(stateFile);
      codex.setVersion("1.1.0");
      await connectOnce(options);
      const fresh = recordedPid(stateFile);
      expect(fresh).not.toBe(old);
      expect(readAppServerState(stateFile)?.version).toBe("1.1.0");
      expect(isOurAppServer(old, socketPath)).toBe(false);
    },
    30_000
  );

  detachedServer(
    "after a codex upgrade a server with a loaded thread is kept",
    async () => {
      const { codex, stateFile, options } = setup("1.0.0");
      codex.setLoaded(["thread-live"]);
      await connectOnce(options);
      const old = recordedPid(stateFile);
      codex.setVersion("1.1.0");
      await connectOnce(options);
      expect(recordedPid(stateFile)).toBe(old);
      expect(readAppServerState(stateFile)?.version).toBe("1.0.0");
    },
    30_000
  );

  detachedServer(
    "a dead server with a stale state file and socket is replaced",
    async () => {
      const { socketPath, stateFile, options } = setup();
      await connectOnce(options);
      const old = recordedPid(stateFile);
      process.kill(old, "SIGKILL");

      while (isOurAppServer(old, socketPath)) await Bun.sleep(20);
      await connectOnce(options);
      expect(recordedPid(stateFile)).not.toBe(old);
    },
    30_000
  );

  detachedServer(
    "stopAppServer (uninstall) stops it and cleans up",
    async () => {
      const { socketPath, stateFile, options } = setup();
      await connectOnce(options);
      const pid = recordedPid(stateFile);
      const { stopped } = await Effect.runPromise(stopAppServer({ stateFile }));
      expect(stopped).toBe(pid);
      expect(isOurAppServer(pid, socketPath)).toBe(false);
      expect(existsSync(stateFile)).toBe(false);
      expect(existsSync(socketPath)).toBe(false);
    },
    20_000
  );

  test("stopAppServer leaves an unrelated process alone when the pid was reused", async () => {
    const { dir, socketPath } = setup();
    const stateFile = join(dir, "state.json");
    const unrelated = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30_000)"]);
    pids.push(unrelated.pid);
    await Bun.write(
      stateFile,
      JSON.stringify({
        pid: unrelated.pid,
        version: "1.0.0",
        codexPath: "/nonexistent",
        socketPath,
        startedAt: 0,
      })
    );
    expect((await Effect.runPromise(stopAppServer({ stateFile }))).stopped).toBeNull();
    expect(unrelated.exitCode).toBeNull();
  });

  test("under systemd it runs in its own transient scope", () => {
    const argv = launchArgv({
      codexPath: "/usr/bin/codex",
      socketPath: "/home/u/.polaris/codex.sock",
      logFile: "/home/u/.polaris/logs/codex-app-server.log",
      systemdRun: "/usr/bin/systemd-run",
    });

    expect(argv.slice(0, 4)).toEqual([
      "/bin/sh",
      "-c",
      '"$@" </dev/null >>"$0" 2>&1 & echo $!',
      "/home/u/.polaris/logs/codex-app-server.log",
    ]);
    expect(argv.slice(4, 9)).toEqual([
      "/usr/bin/systemd-run",
      "--user",
      "--scope",
      "--quiet",
      "--collect",
    ]);
    expect(argv.slice(-4)).toEqual([
      "/usr/bin/codex",
      "app-server",
      "--listen",
      "unix:///home/u/.polaris/codex.sock",
    ]);
  });
});

describe("remoteTuiArgv", () => {
  const recorded = () => {
    const dir = mkdtempSync(join(tmpdir(), "pas-tui-"));
    dirs.push(dir);
    const stateFile = join(dir, "codex-app-server.json");
    const state = { pid: 1, version: null, codexPath: "x", socketPath: "s", startedAt: 0 };
    writeFileSync(stateFile, JSON.stringify({ ...state, listen: "ws://127.0.0.1:4100" }));
    mkdirSync(dirname(tokenFileOf(stateFile)), { recursive: true });
    writeFileSync(tokenFileOf(stateFile), "secret-token");

    return { socketPath: join(dir, "codex.sock"), stateFile };
  };

  test("a Unix Host attaches the TUI to the socket", () => {
    const server = recorded();

    expect(remoteTuiArgv(server, "/bin/codex", "thr", "linux")).toEqual([
      "/bin/codex",
      "resume",
      "thr",
      "--remote",
      `unix://${server.socketPath}`,
    ]);
  });

  test("Windows reads the token into the TUI's environment, never its argv", () => {
    const server = recorded();
    const argv = remoteTuiArgv(server, "C:\\it's\\codex.cmd", "thr", "win32");
    const script = Buffer.from(argv.at(-1)!, "base64").toString("utf16le");

    expect(argv.slice(0, -1)).toEqual([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-EncodedCommand",
    ]);
    expect(argv.join(" ")).not.toContain("secret-token");
    expect(script).toContain(`-LiteralPath '${tokenFileOf(server.stateFile)}'`);
    expect(script).toContain(
      "& 'C:\\it''s\\codex.cmd' resume 'thr' --remote 'ws://127.0.0.1:4100' --remote-auth-token-env POLARIS_CODEX_TOKEN"
    );
  });
});
