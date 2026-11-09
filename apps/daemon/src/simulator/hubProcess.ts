/**
 * One expo-device-hub child process (ADR 0099): a free loopback port, `--require-token`, and a
 * private state dir and `TMPDIR` under `dir`, removed when it stops. The hub picks its own token.
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Option, Schema } from "effect";
import { childEnv } from "../service/childEnv.ts";

/** Where a running hub listens, and the token every gated request carries. */
export interface HubEndpoint {
  readonly port: number;
  readonly token: string;
}

/** How to run the hub: `argv` before the hub's own flags, and environment added to the Daemon's. */
export interface HubCommand {
  readonly argv: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

export interface HubProcess {
  readonly endpoint: HubEndpoint;
  readonly pid: number;
  /** Resolves with the exit code once the process has exited, however it ended. */
  readonly exited: Promise<number | null>;
  /** SIGTERM, then SIGKILL after `graceMs`; removes the private directories. */
  readonly stop: (graceMs: number) => Promise<void>;
}

export class HubStartError extends Error {}

const StateFile = Schema.Struct({ pid: Schema.Number, port: Schema.Number, token: Schema.String });

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(StateFile));

/** A port the OS just handed out on loopback; the hub binds it a moment later. */
export const freeLoopbackPort = (): number => {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => undefined },
  });

  const { port } = listener;
  listener.stop(true);

  return port;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const readState = async (path: string, pid: number) => {
  const text = await readFile(path, "utf8").catch(() => null);

  if (text === null) return null;
  const state = Option.getOrNull(decodeState(text));

  return state?.pid === pid ? state : null;
};

const healthy = (port: number) =>
  fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_000) }).then(
    (response) => response.ok,
    () => false
  );

/** Waits for the state file the hub writes once it listens, then for `/healthz`. */
const awaitReady = async (
  statePath: string,
  pid: number,
  exited: Promise<number | null>,
  timeoutMs: number
): Promise<HubEndpoint> => {
  let gone: number | null | undefined;
  void exited.then((code) => {
    gone = code;
  });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (gone !== undefined) throw new HubStartError(`the hub exited with code ${gone} on start`);
    const state = await readState(statePath, pid);

    if (state !== null && (await healthy(state.port)))
      return { port: state.port, token: state.token };
    await sleep(100);
  }

  throw new HubStartError(`the hub didn't answer within ${Math.round(timeoutMs / 1000)} s`);
};

const stopWith =
  (proc: Bun.Subprocess, exited: Promise<number | null>, dir: string) =>
  async (graceMs: number) => {
    proc.kill("SIGTERM");
    const ended = await Promise.race([exited.then(() => true), sleep(graceMs).then(() => false)]);

    if (!ended) {
      proc.kill("SIGKILL");
      await exited;
    }

    await rm(dir, { recursive: true, force: true });
  };

/**
 * Starts the hub with its state and temp files under `dir`, cleared first so a dead hub's
 * `serve-sim/` files and token never carry over.
 */
export const spawnHub = async (
  command: HubCommand,
  dir: string,
  startTimeoutMs: number
): Promise<HubProcess> => {
  const stateDir = join(dir, "state");
  const tmpDir = join(dir, "tmp");
  await rm(dir, { recursive: true, force: true });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const port = freeLoopbackPort();

  const proc = Bun.spawn(
    [...command.argv, "--host", "127.0.0.1", "--port", String(port), "--require-token"],
    {
      env: {
        ...childEnv(),
        ...command.env,
        EXPO_DEVICE_HUB_STATE_DIR: stateDir,
        TMPDIR: `${tmpDir}/`,
      },
      stdin: "ignore",
      stdout: Bun.file(join(dir, "hub.log")),
      stderr: Bun.file(join(dir, "hub.err.log")),
    }
  );

  const exited = proc.exited.then(
    (code) => code,
    () => null
  );

  const stop = stopWith(proc, exited, dir);

  try {
    const endpoint = await awaitReady(
      join(stateDir, `server-${port}.json`),
      proc.pid,
      exited,
      startTimeoutMs
    );

    return { endpoint, pid: proc.pid, exited, stop };
  } catch (error) {
    await stop(2_000);
    throw error;
  }
};
