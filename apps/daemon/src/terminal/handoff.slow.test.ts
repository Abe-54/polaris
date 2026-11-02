/**
 * Terminals across Daemon restarts, with a real fixture Daemon:
 * - an execve upgrade keeps the shell, its state, the scrollback, input,
 *   resize and the exit code;
 * - a crash ends terminals cleanly: the next Daemon reports them ended.
 */
import { afterEach, beforeEach, describe, expect } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Effect, Schema } from "effect";
import { CommandRunner } from "../service/CommandRunner.ts";
import { runtimePlatform } from "../service/platform.ts";
import { requestUpgrade, runningDaemonPid } from "../service/upgrade.ts";
import { posixTest } from "../platform/testing.ts";

const fixture = join(import.meta.dir, "fixtures", "terminal-daemon.ts");

const platform = runtimePlatform();

let home: string;

let daemon: Subprocess | null = null;

const previousHome = process.env.POLARIS_HOME;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "polaris-term-up-")));
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

const socketPath = () => join(home, "daemon.sock");

/** A request line for the fixture Daemon (see fixtures/terminal-daemon.ts). */
interface FixtureRequest {
  readonly op: "info" | "open" | "input" | "resize" | "read" | "list";
  readonly id?: string;
  readonly cwd?: string;
  readonly text?: string;
  readonly cols?: number;
  readonly rows?: number;
}

const Info = Schema.Struct({ version: Schema.String, pid: Schema.Number, adopted: Schema.Boolean });

const Listed = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    cwd: Schema.String,
    exit: Schema.NullOr(Schema.Struct({ code: Schema.NullOr(Schema.Number) })),
    endedBy: Schema.NullOr(Schema.String),
  })
);

const Ok = Schema.Literal("ok");

/** One request to the fixture Daemon, its reply parsed with `reply`. */
const call = <A>(request: FixtureRequest, reply: Schema.ConstraintDecoder<A>): Promise<A> =>
  new Promise((resolve, reject) => {
    const decode = Schema.decodeUnknownSync(Schema.fromJsonString(reply));
    let buffered = "";
    Bun.connect({
      unix: socketPath(),
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify(request)}\n`);
        },
        data(socket, data) {
          buffered += data.toString();

          if (buffered.includes("\n")) {
            try {
              resolve(decode(buffered.slice(0, buffered.indexOf("\n"))));
            } catch (error) {
              reject(error);
            }

            socket.end();
          }
        },
        close() {
          reject(new Error("closed before answering"));
        },
        connectError(_socket, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });

const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;

  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(30);
  }
};

const readUntil = async (id: string, needle: string | RegExp) => {
  let text = "";
  await waitFor(async () => {
    text = await call({ op: "read", id }, Schema.String);

    return needle instanceof RegExp ? needle.test(text) : text.includes(needle);
  }).catch(() => {
    throw new Error(`timed out waiting for ${needle}; got ${JSON.stringify(text)}`);
  });

  return text;
};

const start = async (version: string) => {
  daemon = Bun.spawn([process.execPath, fixture, "--as", version], {
    env: { ...process.env, POLARIS_HOME: home },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitFor(() => existsSync(socketPath()) && runningDaemonPid() !== null);
  await waitFor(() =>
    call({ op: "info" }, Info).then(
      () => true,
      () => false
    )
  );
};

describe("terminals across Daemon restarts", () => {
  posixTest("execve, which Windows upgrades don't use (ADR 0060)")(
    "an execve upgrade keeps the shell, its scrollback, input, resize and exit code",
    async () => {
      await start("1.0.0");
      const id = await call({ op: "open", cwd: home }, Schema.String);
      await call({ op: "input", id, text: "X=kept; echo ready-$$\n" }, Ok);
      const before = await readUntil(id, /ready-\d+/);
      const shellPid = before.match(/ready-(\d+)/)![1];

      const next = join(home, "polaris-2.0.0");
      writeFileSync(
        next,
        `#!/bin/sh
if [ "$1" = version ]; then echo "polaris 2.0.0 ${platform}"; exit 0; fi
exec "${process.execPath}" "${fixture}" --as 2.0.0
`
      );
      chmodSync(next, 0o755);

      const status = await Effect.runPromise(
        requestUpgrade({ pid: daemon!.pid, binary: next, version: "2.0.0" }).pipe(
          Effect.provide(CommandRunner.layer)
        )
      );

      expect(status).toMatchObject({ state: "done", pid: daemon!.pid });
      expect(await call({ op: "info" }, Info)).toMatchObject({ version: "2.0.0", adopted: true });

      // Same terminal id, scrollback replayed, same shell with its variables.
      expect(await call({ op: "read", id }, Schema.String)).toContain(`ready-${shellPid}`);
      await call({ op: "input", id, text: "echo $X-after-$$\n" }, Ok);
      await readUntil(id, `kept-after-${shellPid}`);

      await call({ op: "resize", id, cols: 100, rows: 40 }, Ok);
      await Bun.sleep(200); // the adopted PTY resizes through stty
      await call({ op: "input", id, text: "stty size\n" }, Ok);
      await readUntil(id, "40 100");

      await call({ op: "input", id, text: "exit 3\n" }, Ok);
      await readUntil(id, "<exit 3>");
      const list = await call({ op: "list" }, Listed);
      expect(list.find((t) => t.id === id)).toMatchObject({ exit: { code: 3 }, endedBy: "exit" });
    },
    30_000
  );

  posixTest("the fixture Daemon serves a Unix socket path and a POSIX shell (ENG-318)")(
    "a crash ends terminals; the next Daemon reports them ended in their cwd",
    async () => {
      await start("1.0.0");
      const id = await call({ op: "open", cwd: home }, Schema.String);
      await call({ op: "input", id, text: "echo alive\n" }, Ok);
      await readUntil(id, "alive");
      daemon!.kill("SIGKILL");
      await daemon!.exited;

      await start("1.0.0");
      expect(await call({ op: "read", id }, Schema.String)).toBe("<exit null>");
      const list = await call({ op: "list" }, Listed);
      expect(list.find((t) => t.id === id)).toMatchObject({
        cwd: home,
        exit: { code: null },
        endedBy: "daemon-restart",
      });
    },
    30_000
  );
});
