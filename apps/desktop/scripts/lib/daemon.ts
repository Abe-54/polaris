/** A throwaway Daemon from source for the smoke test; runs under Bun and Node. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { REPO_ROOT } from "./electron.ts";

export interface TestDaemon {
  readonly socketPath: string;
  readonly pid: number | undefined;
  readonly stop: () => Promise<void>;
}

export interface StartDaemonInput {
  /** The Daemon's `POLARIS_HOME`. */
  readonly home: string;
  readonly benchHarness: boolean;
  /** The user's home directory as the Daemon sees it (`HOME`); the real one when absent. */
  readonly userHome?: string;
  /** More environment for the Daemon (a fake Harness's PATH, for one). */
  readonly env?: Readonly<Record<string, string>>;
}

const live = (socketPath: string) =>
  new Promise<boolean>((resolve) => {
    if (!existsSync(socketPath)) {
      resolve(false);

      return;
    }

    const socket = connect(socketPath);

    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

/**
 * The test Daemon's environment: its own POLARIS_HOME and HOME, so it never reads (or
 * indexes, for Usage) the developer's real Harness logs and settings.
 */
export const testEnv = (
  home: string,
  benchHarness: boolean,
  userHome: string | undefined,
  extra: Readonly<Record<string, string>>
) => {
  // A fresh child does not inherit the listener described by a Daemon upgrade hand-off.
  const {
    CLAUDE_CONFIG_DIR: _claude,
    CODEX_HOME: _codex,
    POLARIS_HANDOFF: _handoff,
    ...env
  } = process.env;

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    HOME: userHome ?? home,
    POLARIS_HOME: home,
    POLARIS_BENCH_HARNESS: benchHarness ? "1" : "0",
    // Run from source, but not tracing itself unless a script turns Developer Mode on (ENG-709).
    POLARIS_DEVELOPER_MODE: "off",
    ...extra,
  };

  delete childEnv.POLARIS_HANDOFF;

  return childEnv;
};

/**
 * The Codex app-server a Daemon starts is detached and outlives it by design
 * (`AppServer.ts`); stop the one this home's Daemon started, and no other.
 */
const stopCodexAppServer = (home: string) => {
  const result = spawnSync(
    "bun",
    [join(REPO_ROOT, "apps/daemon/scripts/stop-codex-app-server.ts"), home],
    { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "inherit"] }
  );

  if (result.status !== 0) console.error(`could not stop the Codex app-server under ${home}`);
};

export const startDaemon = async ({
  home,
  benchHarness,
  userHome,
  env = {},
}: StartDaemonInput): Promise<TestDaemon> => {
  const socketPath = join(home, "daemon.sock");

  const child = spawn(
    "bun",
    [join(REPO_ROOT, "apps/daemon/src/main.ts"), "serve", "--foreground"],
    {
      cwd: REPO_ROOT,
      env: testEnv(home, benchHarness, userHome, env),
      stdio: ["ignore", "ignore", "inherit"],
    }
  );

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const deadline = Date.now() + 15_000;

  while (!(await live(socketPath))) {
    if (child.exitCode !== null) throw new Error(`the Daemon exited with ${child.exitCode}`);

    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("the Daemon did not open its socket in 15 s");
    }

    await sleep(50);
  }

  return {
    socketPath,
    pid: child.pid,
    stop: async () => {
      child.kill("SIGTERM");
      const killed = setTimeout(() => child.kill("SIGKILL"), 3000);

      await exited;
      clearTimeout(killed);
      stopCodexAppServer(home);
    },
  };
};
