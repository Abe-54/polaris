/**
 * Proof of the execve hand-off: a running (miniature) Daemon with a Harness
 * child execs into a new binary in the same PID; the child survives and is
 * still reachable, clients keep being served through the switch, and a new
 * connection afterwards talks to the new version.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Effect, Schema } from "effect";
import { CommandRunner } from "./CommandRunner.ts";
import { clearCloseOnExec, closeFd, isCloseOnExec, socketPair } from "./libc.ts";
import { runtimePlatform } from "./platform.ts";
import { HANDOFF_ENV, prepareHandoff, requestUpgrade, runningDaemonPid } from "./upgrade.ts";
import { posixDescribe } from "../platform/testing.ts";

const execveOnly = posixDescribe("execve and libc, which Windows upgrades don't use (ADR 0060)");

const fixture = join(import.meta.dir, "fixtures", "handoff-daemon.ts");

const platform = runtimePlatform();

const Info = Schema.Struct({
  version: Schema.String,
  pid: Schema.Number,
  childPid: Schema.Number,
  echo: Schema.String,
  adopted: Schema.Boolean,
});

type Info = typeof Info.Type;

const decodeInfo = Schema.decodeUnknownSync(Schema.fromJsonString(Info));

/** Connect to the Daemon socket and ask for `info`. */
const info = (socketPath: string): Promise<Info> =>
  new Promise((resolve, reject) => {
    let buffered = "";
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write("info\n");
        },
        data(socket, data) {
          buffered += data.toString();

          if (buffered.includes("\n")) {
            resolve(decodeInfo(buffered.slice(0, buffered.indexOf("\n"))));
            socket.end();
          }
        },
        close() {
          reject(new Error("closed before answering"));
        },
        error(_socket, error) {
          reject(error);
        },
        connectError(_socket, error: NodeJS.ErrnoException) {
          // Bun reports a connection accepted then closed before `open` as ECONNREFUSED; a refusal is ENOENT.
          reject(error.code === "ECONNREFUSED" ? new Error("closed before answering") : error);
        },
      },
    }).catch(reject);
  });

const waitFor = async (condition: () => boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

let home: string;

let daemon: Subprocess | null = null;

const previousHome = process.env.POLARIS_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "polaris-upgrade-"));
  process.env.POLARIS_HOME = home;
});

afterEach(async () => {
  daemon?.kill("SIGKILL");
  await daemon?.exited;
  daemon = null;

  if (previousHome === undefined) delete process.env.POLARIS_HOME;
  else process.env.POLARIS_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

execveOnly("libc", () => {
  test("clears close-on-exec and builds an env for the new image", async () => {
    const [a, b] = socketPair();

    try {
      clearCloseOnExec(a);
      expect(isCloseOnExec(a)).toBe(false);
      const env = await Effect.runPromise(prepareHandoff(a, { fds: { "harness:x": b } }));
      expect(isCloseOnExec(b)).toBe(false);
      expect(JSON.parse(env[HANDOFF_ENV])).toMatchObject({
        listenerFd: a,
        fds: { "harness:x": b },
      });
    } finally {
      closeFd(a);
      closeFd(b);
    }
  });
});

/** Runs the fixture Daemon via `launch`, upgrades it in place, and checks what survived. */
const handoffScenario = async (launch: ReadonlyArray<string>) => {
  const socketPath = join(home, "daemon.sock");
  daemon = Bun.spawn([...launch, "--as", "1.0.0"], {
    env: { ...process.env, POLARIS_HOME: home },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitFor(() => existsSync(socketPath) && runningDaemonPid() !== null);

  const before = await info(socketPath);
  expect(before).toMatchObject({ version: "1.0.0", pid: daemon.pid, echo: "ok", adopted: false });

  // The "new binary": validates as a Daemon build, then becomes version 2.0.0.
  const next = join(home, "polaris-2.0.0");
  writeFileSync(
    next,
    `#!/bin/sh
if [ "$1" = version ]; then echo "polaris 2.0.0 ${platform}"; exit 0; fi
exec ${launch.map((arg) => `"${arg}"`).join(" ")} --as 2.0.0
`
  );
  chmodSync(next, 0o755);

  // Hammer the socket throughout the switch: nothing may be refused.
  let stop = false;
  const refused: Array<string> = [];
  const answered: Array<string> = [];

  const hammer = (async () => {
    while (!stop) {
      await info(socketPath).then(
        (reply) => answered.push(reply.version),
        (error: NodeJS.ErrnoException) => {
          // Accepted by the old image just before exec: closed, the Client reconnects.
          if (error.message === "closed before answering") return;
          refused.push(error.code ?? error.message);
        }
      );
      await Bun.sleep(5);
    }
  })();

  await waitFor(() => answered.length > 0);

  const status = await Effect.runPromise(
    requestUpgrade({ pid: daemon.pid, binary: next, version: "2.0.0" }).pipe(
      Effect.provide(CommandRunner.layer)
    )
  );

  expect(status).toMatchObject({ state: "done", pid: daemon.pid });

  const after = await info(socketPath);
  stop = true;
  await hammer;

  expect(after).toMatchObject({
    version: "2.0.0",
    pid: before.pid,
    childPid: before.childPid,
    echo: "ok",
    adopted: true,
  });
  expect(alive(before.childPid)).toBe(true);
  expect(refused).toEqual([]);
  expect(answered).toContain("1.0.0");
  expect(answered).toContain("2.0.0");
};

execveOnly("execve hand-off", () => {
  test("keeps the PID, the Harness child and the listener across an upgrade", async () => {
    await handoffScenario([process.execPath, fixture]);
  }, 30_000);

  test("works between compiled binaries (bun:ffi inside bun build --compile)", async () => {
    const binary = join(home, "fixture-bin");

    const build = Bun.spawnSync([
      process.execPath,
      "build",
      fixture,
      "--compile",
      `--outfile=${binary}`,
    ]);

    expect(build.stderr.toString()).not.toContain("error");
    expect(build.exitCode).toBe(0);

    if (process.platform === "darwin") {
      // See scripts/build-daemon.ts: Bun leaves an invalid ad-hoc signature.
      expect(Bun.spawnSync(["codesign", "--force", "--sign", "-", binary]).exitCode).toBe(0);
    }

    await handoffScenario([binary]);
  }, 60_000);

  test("rejects a binary for another platform and keeps running", async () => {
    const socketPath = join(home, "daemon.sock");
    daemon = Bun.spawn([process.execPath, fixture, "--as", "1.0.0"], {
      env: { ...process.env, POLARIS_HOME: home },
      stdio: ["ignore", "inherit", "inherit"],
    });
    await waitFor(() => existsSync(socketPath) && runningDaemonPid() !== null);
    const wrong = join(home, "polaris-wrong");
    writeFileSync(wrong, `#!/bin/sh\necho "polaris 2.0.0 plan9-mips"\n`);
    chmodSync(wrong, 0o755);

    const error = await Effect.runPromise(
      requestUpgrade({ pid: daemon.pid, binary: wrong, version: "2.0.0" }).pipe(
        Effect.flip,
        Effect.provide(CommandRunner.layer)
      )
    );

    expect(error.message).toContain("plan9-mips");
    expect((await info(socketPath)).version).toBe("1.0.0");
  }, 30_000);

  test("a SIGUSR2 sent the moment the pid file appears doesn't kill the Daemon", async () => {
    const pidFile = join(home, "daemon.pid");
    daemon = Bun.spawn([process.execPath, fixture, "--as", "1.0.0"], {
      env: { ...process.env, POLARIS_HOME: home },
      stdio: ["ignore", "ignore", "ignore"],
    });

    const deadline = Date.now() + 10_000;

    // Spin, not sleep: the signal must land right after the pid file is written.
    while (!existsSync(pidFile) && Date.now() < deadline) {}

    process.kill(daemon.pid, "SIGUSR2");
    await Bun.sleep(300);
    expect({ exit: daemon.exitCode, signal: daemon.signalCode }).toEqual({
      exit: null,
      signal: null,
    });
    expect((await info(join(home, "daemon.sock"))).version).toBe("1.0.0");
  }, 30_000);

  test("a Daemon that dies instead of upgrading fails the request at once", async () => {
    // `sleep` has no SIGUSR2 handler, so the request's signal kills it.
    daemon = Bun.spawn(["sleep", "30"]);
    const started = Date.now();

    const error = await Effect.runPromise(
      requestUpgrade({ pid: daemon.pid, binary: "/bin/true", version: "2.0.0" }).pipe(
        Effect.flip,
        Effect.provide(CommandRunner.layer)
      )
    );

    expect(error.message).toBe(`the Daemon (PID ${daemon.pid}) exited instead of upgrading`);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 30_000);
});
