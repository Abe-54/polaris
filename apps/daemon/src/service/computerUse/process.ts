/**
 * A process running inside the helper app, as the Daemon sees it, and the setting that picks
 * how its launcher is started (ADR 0107).
 */
import type { HelperTool } from "./bundle.ts";

/** `disclaim` is the default; `launch-services` is the fallback that needs no private SPI. */
export type SpawnVia = "disclaim" | "launch-services";

/** The launcher's exit code when macOS has no disclaim SPI or refuses it (`launcher.c`). */
export const EXIT_NO_DISCLAIM = 70;

/** The launcher's exit code when its caller is not the Daemon (`launcher.c`, ENG-867). */
export const EXIT_REFUSED = 77;

export type Env = Readonly<Record<string, string | undefined>>;

export interface HelperRequest {
  readonly tool: HelperTool;
  readonly args: ReadonlyArray<string>;
  /** The tool's whole environment; the Daemon's own (`childEnv`) when absent. */
  readonly env?: Env;
  readonly cwd?: string;
  /** Overrides the Host's setting for this one process. */
  readonly via?: SpawnVia;
}

/** The tool's stdio and exit, the same whichever way it was started. */
export interface HelperProcess {
  readonly via: SpawnVia;
  /** Writes to the tool's stdin. */
  readonly write: (chunk: string | Uint8Array) => void;
  /** Closes the tool's stdin; its stdout and stderr stay open. */
  readonly end: () => void;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** The tool's exit code, or 128 plus the signal that ended it. */
  readonly exited: Promise<number>;
  readonly kill: (signal?: "SIGTERM" | "SIGKILL") => void;
}

/** The setting that picks the fallback: `POLARIS_COMPUTER_USE_SPAWN=launch-services`. */
export const spawnSetting = (env: Env = process.env): SpawnVia =>
  env.POLARIS_COMPUTER_USE_SPAWN === "launch-services" ? "launch-services" : "disclaim";
