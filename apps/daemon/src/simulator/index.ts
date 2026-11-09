/**
 * The Host's Simulator support (ADR 0099), detected on first use and cached: an idle Daemon
 * runs nothing. `refresh` checks again (a `simulator.watch` subscribe, "Check again").
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { Context, Effect, Layer } from "effect";
import { HostPlatform } from "../platform/index.ts";
import { findExecutable } from "../platform/executable.ts";
import { childEnv } from "../service/childEnv.ts";
import {
  type CommandResult,
  detectSupport,
  type SupportProbe,
  type SupportReport,
} from "./support.ts";

export {
  androidPossible,
  detectSupport,
  FIRST_LAUNCH_MESSAGE,
  iosPossible,
  simulatorCapable,
  type SupportProbe,
  type SupportReport,
} from "./support.ts";

const runLive = async (
  argv: ReadonlyArray<string>,
  timeoutMs: number
): Promise<CommandResult | "timeout" | null> => {
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;

  try {
    proc = Bun.spawn([...argv], {
      env: childEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return null;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const finished = Promise.all([new Response(proc.stdout).text(), proc.exited]).then(
    ([stdout, exitCode]) => ({ stdout, exitCode })
  );

  const result = await Promise.race([finished, timedOut]);
  clearTimeout(timer);

  if (result === "timeout") proc.kill();

  return result;
};

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const canReadWrite = (path: string) => {
  try {
    accessSync(path, constants.R_OK | constants.W_OK);

    return true;
  } catch {
    return false;
  }
};

export const liveProbe = (): SupportProbe => ({
  run: runLive,
  which: (program) => findExecutable(program),
  isFile,
  canReadWrite,
  env: process.env,
  home: homedir(),
});

export class SimulatorDetection extends Context.Service<
  SimulatorDetection,
  {
    /** The last detection, or the first one when none has run. */
    readonly current: Effect.Effect<SupportReport>;
    /** Detects again; concurrent callers share one run. */
    readonly refresh: Effect.Effect<SupportReport>;
  }
>()("polaris/daemon/simulator/SimulatorDetection") {
  static readonly layerWith = (probe: () => SupportProbe) =>
    Layer.effect(
      SimulatorDetection,
      Effect.gen(function* () {
        const facts = yield* HostPlatform;
        let latest: Promise<SupportReport> | null = null;
        let running: Promise<SupportReport> | null = null;

        const detect = () => {
          running ??= detectSupport(facts, probe()).finally(() => {
            running = null;
          });
          latest = running;

          return running;
        };

        return SimulatorDetection.of({
          current: Effect.promise(() => latest ?? detect()),
          refresh: Effect.promise(detect),
        });
      })
    );

  static readonly layer = SimulatorDetection.layerWith(liveProbe);
}
