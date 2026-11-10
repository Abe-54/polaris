/**
 * The ways the Daemon starts the helper's launcher (`launcher.c`) to serve the Mach service
 * `service`: its `run`, which disclaims responsibility so TCC charges the helper (the
 * default), or LaunchServices, the fallback for a macOS without the disclaim SPI (ADR 0107).
 */
import { executableOf } from "../../platform/executable.ts";
import { childEnv } from "../childEnv.ts";
import { launcherOf } from "./bundle.ts";

/** How a launcher the Daemon started itself ended, with what it wrote to stderr. */
export interface LauncherExit {
  readonly code: number;
  readonly stderr: string;
}

export interface Launched {
  /** Null when another process (LaunchServices) is the launcher's parent. */
  readonly exited: Promise<LauncherExit> | null;
}

/** Starts the launcher so that it serves `service`; resolves once it was asked to start. */
export type Launch = (helper: string, service: string) => Promise<Launched>;

const startLauncher = (helper: string, verb: "run" | "connect", service: string): Launched => {
  const proc = Bun.spawn([executableOf(launcherOf(helper)), verb, service], {
    env: childEnv(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });

  const exited = Promise.all([proc.exited, new Response(proc.stderr).text()]).then(
    ([code, stderr]) => ({ code, stderr: stderr.trim() })
  );

  return { exited };
};

/** The launcher's `run`: it restarts itself with responsibility disclaimed, then serves. */
export const runDisclaimed: Launch = (helper, service) =>
  Promise.resolve(startLauncher(helper, "run", service));

/** `open -n` starts a new instance per process; `-g -j` keep it hidden and in the background. */
export const openHelper: Launch = async (helper, service) => {
  const proc = Bun.spawn(
    ["/usr/bin/open", "-n", "-g", "-j", "-a", helper, "--args", "connect", service],
    { env: childEnv(), stdin: "ignore", stdout: "ignore", stderr: "pipe" }
  );

  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

  if (code !== 0) throw new Error(`open exited ${code}: ${stderr.trim()}`);

  return { exited: null };
};

/** Starts the launcher's `connect` directly, without LaunchServices: tests use this. */
export const execHelper: Launch = (helper, service) =>
  Promise.resolve(startLauncher(helper, "connect", service));
