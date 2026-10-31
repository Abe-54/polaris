/**
 * Which Daemon socket the local Host connects to, and, in dev only, a Daemon
 * this app starts from source and owns. See docs/adr/0007-the-desktop-dev-daemon-is-its-own.md.
 *
 *   POLARIS_DESKTOP_LOCAL_SOCKET=<path>   use this socket (benchmarks, smoke tests)
 *   POLARIS_DESKTOP_BENCH_HARNESS=1       …and it runs the scripted bench Harness
 *   POLARIS_DESKTOP_DAEMON=system|dev     dev only: force the system or the dev Daemon
 *   POLARIS_DESKTOP_LOCAL_HOME=<dir>      with a given socket: its Daemon is installed in
 *                                         <dir>/.polaris and upgrades like the system one (tests)
 */
import { existsSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isPipePath, localDaemonFailure } from "@polaris/client";
import { childProcesses, type Spawned, stopChild } from "@polaris/client/process";
import { localEndpoint } from "@polaris/protocol/endpoint";
import { assertScriptedDaemon, scriptedInstallHome } from "./scripted.ts";

export interface LocalDaemon {
  readonly socketPath: string;
  /** The Daemon runs `POLARIS_BENCH_HARNESS=1`, so the proof session spends no tokens. */
  readonly benchHarness: boolean;
  /**
   * The home whose installed Daemon (`~/.polaris/bin/current`) this is, so the
   * app upgrades it like a remote Host's; null for the app's own dev Daemon.
   */
  readonly installedHome: string | null;
  /** Stops the Daemon if this app started it; a no-op otherwise. */
  readonly stop: () => Promise<void>;
}

export interface LocalDaemonOptions {
  readonly dev: boolean;
  /** The repository root; the dev Daemon runs from `apps/daemon/src/main.ts` there. */
  readonly repoRoot: string;
  readonly env: NodeJS.ProcessEnv;
}

export const systemSocket = () => localEndpoint(join(homedir(), ".polaris"));

/** The dev Daemon's own `POLARIS_HOME`, kept apart from the real `~/.polaris`. */
export const devHome = () => join(tmpdir(), "polaris-desktop-dev");

const external = (
  socketPath: string,
  benchHarness: boolean,
  installedHome: string | null
): LocalDaemon => ({
  socketPath,
  benchHarness,
  installedHome,
  stop: () => Promise.resolve(),
});

/** Whether something accepts connections on the socket within `timeoutMs`. */
export const socketLive = (socketPath: string, timeoutMs = 500): Promise<boolean> =>
  new Promise((resolve) => {
    // Stat on a Windows pipe opens it, taking an instance; connecting below answers either way.
    if (!isPipePath(socketPath) && !existsSync(socketPath)) {
      resolve(false);

      return;
    }

    const socket = connect(socketPath);

    const done = (live: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(live);
    };

    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForSocket = async (socketPath: string, child: Spawned, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dev Daemon exited with ${child.exitCode}`);

    if (await socketLive(socketPath, 200)) return;
    await sleep(50);
  }

  throw new Error(`dev Daemon did not open ${socketPath} within ${timeoutMs} ms`);
};

/** Starts `bun apps/daemon/src/main.ts serve --foreground` with the bench Harness and its own home. */
export const startDevDaemon = async ({
  repoRoot,
  env,
}: LocalDaemonOptions): Promise<LocalDaemon> => {
  const home = devHome();
  const socketPath = localEndpoint(home);

  mkdirSync(home, { recursive: true });

  if (await socketLive(socketPath)) {
    console.log(`polaris: reusing the dev Daemon at ${socketPath}`);

    return external(socketPath, true, null);
  }

  const child = childProcesses.spawn({
    file: "bun",
    args: [join(repoRoot, "apps/daemon/src/main.ts"), "serve", "--foreground"],
    cwd: repoRoot,
    env: { ...env, POLARIS_HOME: home, POLARIS_BENCH_HARNESS: "1" },
    stdio: ["ignore", "inherit", "inherit"],
  });

  console.log(`polaris: started the dev Daemon (pid ${child.pid}, home ${home})`);
  await waitForSocket(socketPath, child, 15_000);

  return { socketPath, benchHarness: true, installedHome: null, stop: () => stopChild(child) };
};

/**
 * Waits for the Daemon `polaris install` just started from `home` to listen
 * (launchd takes a second or two); on timeout, fails with what its log says.
 */
export const awaitInstalledDaemon = async (
  socketPath: string,
  home: string,
  timeoutMs = 15_000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await socketLive(socketPath, 200)) return;
    await sleep(100);
  }

  const evidence = localDaemonFailure(socketPath, home).detail.split("\n").slice(1);

  throw new Error(
    [`the daemon didn't start listening within ${timeoutMs / 1000} s`, ...evidence].join(" · ")
  );
};

/** The given socket, the system Daemon (`~/.polaris`, on Windows its pipe), or in dev the app's own. */
export const resolveLocalDaemon = async (options: LocalDaemonOptions): Promise<LocalDaemon> => {
  const { env } = options;
  const explicit = env.POLARIS_DESKTOP_LOCAL_SOCKET;
  const home = env.POLARIS_DESKTOP_LOCAL_HOME || null;

  const installedHome =
    env.POLARIS_DESKTOP_SCRIPTED === "1" ? scriptedInstallHome(home, env) : home;

  if (env.POLARIS_DESKTOP_SCRIPTED === "1") {
    if (explicit === undefined || explicit === "")
      throw new Error("scripted launches have no automatic local Daemon");
    assertScriptedDaemon(explicit, installedHome);
  }

  if (explicit !== undefined && explicit !== "") {
    return external(explicit, env.POLARIS_DESKTOP_BENCH_HARNESS === "1", installedHome);
  }

  const system = systemSocket();

  if (!options.dev || env.POLARIS_DESKTOP_DAEMON === "system")
    return external(system, false, homedir());

  if (env.POLARIS_DESKTOP_DAEMON !== "dev" && (await socketLive(system))) {
    return external(system, false, homedir());
  }

  return startDevDaemon(options);
};
