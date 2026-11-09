/**
 * Launching the real Daemon for a scenario and connecting Clients to it.
 *
 * Each scenario gets a fresh `polaris serve --foreground` with a throwaway
 * `POLARIS_HOME` (from source with `bun apps/daemon/src/main.ts`, or a compiled
 * binary from `scripts/build-daemon.ts`), with the scripted bench Harness enabled.
 * Clients connect through `polaris bridge` (as `ssh <host> polaris bridge` would)
 * or straight to the Unix socket, and speak the real wire via `@polaris/client`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { connectRpc, type RpcConnection, socketTransport, spawnTransport } from "@polaris/client";
import type { Capability } from "@polaris/protocol";
import { Duration, Effect, Redacted, type Scope } from "effect";
import { startSampler, type Sampler } from "./sampler.ts";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

export const DAEMON_MAIN = join(REPO_ROOT, "apps", "daemon", "src", "main.ts");

export type TransportKind = "bridge" | "socket";

export interface LaunchOptions {
  /** Compiled `polaris` binary; null runs from source. */
  readonly binary: string | null;
  /** Reuse a POLARIS_HOME (e.g. to restart onto an existing store); null makes a fresh one. */
  readonly home?: string | null;
  /** Write a CPU profile (on exit) and allow heap snapshots into this directory. */
  readonly profileDir?: string | null;
  /** POLARIS_DEVELOPER_MODE for the Daemon (default off: the untraced path). */
  readonly developerMode?: DeveloperModeSetting;
  readonly env?: Record<string, string>;
}

export type DeveloperModeSetting = "off" | "on";

export interface Daemon {
  readonly pid: number;
  readonly home: string;
  readonly socketPath: string;
  readonly env: Record<string, string>;
  /** Environment for `polaris bridge` (no profiling flags). */
  readonly bridgeEnv: Record<string, string>;
  readonly spawnedAt: number;
  readonly argv: ReadonlyArray<string>;
  /** argv that runs `polaris bridge` against this Daemon. */
  readonly bridgeArgv: ReadonlyArray<string>;
  /** The Daemon's stderr (logs), most recent 64 KiB. */
  readonly logs: () => string;
  /** Ask the Daemon for a heap snapshot (needs profileDir); resolves with its path. */
  readonly heapSnapshot: () => Promise<string | null>;
  /** SIGTERM and wait for exit; the CPU profile is written then. */
  readonly stop: () => Promise<void>;
}

/** Short paths: a Unix socket path must stay under ~104 bytes. */
const tempRoot = () => {
  const dir = "/tmp/polaris-bench";
  mkdirSync(dir, { recursive: true });

  return dir;
};

/** This process's environment, without unset variables. */
const inheritedEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]): Array<[string, string]> =>
      value === undefined ? [] : [[key, value]]
    )
  );

export const createTempDir = (prefix: string) => mkdtempSync(join(tempRoot(), `${prefix}-`));

export const launchDaemon = async (options: LaunchOptions): Promise<Daemon> => {
  const home = options.home ?? createTempDir("home");
  const profileDir = options.profileDir ?? null;

  const env = inheritedEnv();
  env.POLARIS_HOME = home;
  env.POLARIS_BENCH_HARNESS = "1";
  // The gateway on an ephemeral port: the same listener, without taking 7477 from a real Daemon.
  env.POLARIS_GATEWAY_PORT = "0";

  // From source counts as Developer Mode; off unless asked, so scenarios measure the untraced path (ENG-709).
  env.POLARIS_DEVELOPER_MODE = options.developerMode ?? "off";

  if (profileDir) env.POLARIS_DEBUG_DIR = profileDir;
  Object.assign(env, options.env);
  // Disposable Daemons cannot inherit or override the Host's upgrade descriptors.
  delete env.POLARIS_HANDOFF;

  // A .cpuprofile (Chrome DevTools, speedscope) and a grep-friendly .md summary, on exit.
  const profileFlags = profileDir
    ? ["--cpu-prof", "--cpu-prof-md", `--cpu-prof-dir=${profileDir}`]
    : [];

  let argv: Array<string>;
  let bridgeArgv: Array<string>;

  if (options.binary) {
    argv = [options.binary, "serve", "--foreground"];
    bridgeArgv = [options.binary, "bridge"];

    // A compiled Bun binary reads runtime flags from BUN_OPTIONS.
    if (profileFlags.length > 0) env.BUN_OPTIONS = profileFlags.join(" ");
  } else {
    argv = ["bun", ...profileFlags, DAEMON_MAIN, "serve", "--foreground"];
    bridgeArgv = ["bun", DAEMON_MAIN, "bridge"];
  }

  const spawnedAt = performance.now();

  const child: ChildProcess = spawn(argv[0]!, argv.slice(1), {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-64 * 1024);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-64 * 1024);
  });
  const exited = new Promise<void>((done) => child.once("exit", () => done()));

  if (child.pid === undefined) throw new Error(`could not spawn ${argv.join(" ")}`);
  const socketPath = join(home, "daemon.sock");
  // The bridge must not profile itself or take heap-snapshot signals.
  const { BUN_OPTIONS: _, POLARIS_DEBUG_DIR: __, ...bridgeEnv } = env;

  return {
    pid: child.pid,
    home,
    socketPath,
    env,
    bridgeEnv,
    spawnedAt,
    argv,
    bridgeArgv,
    logs: () => logs,
    heapSnapshot: async () => {
      if (!profileDir) return null;
      const before = new Set(existsSync(profileDir) ? readdirSync(profileDir) : []);
      child.kill("SIGUSR1");
      const deadline = Date.now() + 120_000;

      while (Date.now() < deadline) {
        await Bun.sleep(100);

        const added = readdirSync(profileDir).find(
          (f) => f.endsWith(".heapsnapshot") && !before.has(f)
        );

        if (added) return join(profileDir, added);
      }

      return null;
    },
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const killed = setTimeout(() => child.kill("SIGKILL"), 10_000);
        await exited;
        clearTimeout(killed);
      }
    },
  };
};

/** Daemon measurements must include a process in the requested report window. */
export const sampleDaemon = (daemon: Daemon, intervalMs: number): Sampler => {
  const sampler = startSampler({ roots: () => [daemon.pid], intervalMs });

  return {
    ...sampler,
    report: (from, to) => {
      const report = sampler.report(from, to);

      if (report.maxProcesses === 0) {
        throw new Error(
          `benchmark measured zero Daemon processes for PID ${daemon.pid} (${report.samples} samples, ${report.backend})\n${daemon.logs()}`
        );
      }

      return report;
    },
  };
};

/** Remove a Daemon's POLARIS_HOME. */
export const cleanup = (dir: string) => rmSync(dir, { recursive: true, force: true });

export interface Client {
  readonly connection: RpcConnection;
  readonly label: string;
  /** What the Daemon announced in `hello`. */
  readonly capabilities: ReadonlyArray<Capability>;
}

/** The bench acts as the Desktop App: its fresh home enrols this key on first hello (ADR 0099). */
const BENCH_USER_KEY = Redacted.make("b".repeat(64));

const identity = (label: string) => ({
  clientName: "polaris-bench",
  clientVersion: "0.0.0",
  deviceLabel: label,
  capabilities: [],
  userKey: BENCH_USER_KEY,
});

/** Connect one Client and say hello. */
export const connect = (
  daemon: Daemon,
  transport: TransportKind,
  label = "bench"
): Effect.Effect<Client, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const t =
      transport === "socket"
        ? yield* socketTransport(daemon.socketPath)
        : yield* spawnTransport(daemon.bridgeArgv, { env: daemon.bridgeEnv });

    const connection = yield* connectRpc(t);

    const hello = yield* connection.client
      .hello(identity(label))
      .pipe(Effect.timeout(Duration.seconds(30)));

    return { connection, label, capabilities: hello.capabilities };
  });

/**
 * Wait until the Daemon answers `hello` on its socket, retrying every 2 ms.
 * Resolves with the ms from spawn to the first successful hello.
 */
export const awaitReady = (daemon: Daemon, timeoutMs = 30_000): Effect.Effect<number, Error> =>
  Effect.gen(function* () {
    const deadline = performance.now() + timeoutMs;

    while (performance.now() < deadline) {
      const ok = yield* Effect.scoped(
        Effect.gen(function* () {
          const t = yield* socketTransport(daemon.socketPath);
          const connection = yield* connectRpc(t);
          yield* connection.client.hello(identity("bench-probe"));
        })
      ).pipe(
        Effect.timeout(Duration.seconds(5)),
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      );

      if (ok) return performance.now() - daemon.spawnedAt;
      yield* Effect.sleep(Duration.millis(2));
    }

    return yield* Effect.fail(
      new Error(`the Daemon did not answer within ${timeoutMs} ms\n${daemon.logs()}`)
    );
  });
