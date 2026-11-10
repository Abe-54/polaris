/**
 * The Host's Simulator support (ADR 0099), detected on first use and cached: an idle Daemon
 * runs nothing. `refresh` checks again (a `simulator.watch` subscribe, "Check again").
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { HostSimulatorSupport } from "@polaris/protocol";
import { Context, Effect, Layer, Predicate, PubSub, Schema, Stream } from "effect";
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

/** Xcode's first launch took ~6 min in the spike; a check every 30 s while it runs. */
export const UPDATE_RECHECK_MS = 30_000;

const sameSupport = Schema.toEquivalence(HostSimulatorSupport);

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
    /** The support each time a detection finds it changed: a `SupportChanged`. */
    readonly changes: Stream.Stream<HostSimulatorSupport>;
  }
>()("polaris/daemon/simulator/SimulatorDetection") {
  /** `updateRecheckMs`: how often iOS is checked again while Xcode is `Updating`, and only then. */
  static readonly layerWith = (probe: () => SupportProbe, updateRecheckMs = UPDATE_RECHECK_MS) =>
    Layer.effect(
      SimulatorDetection,
      Effect.gen(function* () {
        const facts = yield* HostPlatform;
        const published = yield* PubSub.unbounded<HostSimulatorSupport>();
        let latest: Promise<SupportReport> | null = null;
        let running: Promise<SupportReport> | null = null;
        let seen: HostSimulatorSupport | null = null;
        let recheck: ReturnType<typeof setTimeout> | null = null;

        const settle = (report: SupportReport) => {
          if (seen !== null && !sameSupport(seen, report.support))
            PubSub.publishUnsafe(published, report.support);
          seen = report.support;

          if (Predicate.isTagged(report.support.ios, "Updating") && recheck === null) {
            recheck = setTimeout(() => {
              recheck = null;
              void detect();
            }, updateRecheckMs);
            recheck.unref();
          }

          return report;
        };

        const detect = (): Promise<SupportReport> => {
          running ??= detectSupport(facts, probe())
            .then(settle)
            .finally(() => {
              running = null;
            });
          latest = running;

          return running;
        };

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (recheck !== null) clearTimeout(recheck);
          })
        );

        return SimulatorDetection.of({
          current: Effect.promise(() => latest ?? detect()),
          refresh: Effect.promise(detect),
          changes: Stream.fromPubSub(published),
        });
      })
    );

  static readonly layer = SimulatorDetection.layerWith(liveProbe);
}
