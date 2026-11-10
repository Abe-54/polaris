/**
 * A process running inside the helper app, and the default way to start one: the launcher's
 * `run`, which disclaims responsibility so TCC charges the helper (ADR 0104).
 */
import { executableOf } from "../../platform/executable.ts";
import { childEnv } from "../childEnv.ts";
import { type HelperTool, launcherOf } from "./bundle.ts";

/** `disclaim` is the default; `launch-services` is the fallback that needs no private SPI. */
export type SpawnVia = "disclaim" | "launch-services";

/** The launcher's exit code when macOS has no disclaim SPI or refuses it (`launcher.c`). */
export const EXIT_NO_DISCLAIM = 70;

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

/** Starts `request.tool` through the launcher's `run`, with pipes for its stdio. */
export const spawnDisclaimed = (helper: string, request: HelperRequest): HelperProcess => {
  const args = ["run", request.tool, ...request.args];
  const stdio = { stdin: "pipe", stdout: "pipe", stderr: "pipe" } as const;
  const env = request.env ?? childEnv();

  const proc =
    request.cwd === undefined
      ? Bun.spawn([executableOf(launcherOf(helper)), ...args], { env, ...stdio })
      : Bun.spawn([executableOf(launcherOf(helper)), ...args], {
          env,
          cwd: request.cwd,
          ...stdio,
        });

  return {
    via: "disclaim",
    write: (chunk) => {
      void proc.stdin.write(chunk);
      void proc.stdin.flush();
    },
    end: () => void proc.stdin.end(),
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    kill: (signal = "SIGTERM") => proc.kill(signal),
  };
};
