/** Runs scenarios (each run with fresh Daemons) and aggregates runs into medians. */
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Duration, Effect, Exit } from "effect";
import {
  cleanup,
  type DeveloperModeSetting,
  launchDaemon,
  sampleDaemon,
  type TransportKind,
} from "./daemon.ts";
import { median } from "./stats.ts";
import type {
  AggregatedMetric,
  Metric,
  Scenario,
  ScenarioContext,
  ScenarioResult,
  ScenarioRun,
} from "./types.ts";

export interface RunnerOptions {
  readonly quick: boolean;
  readonly runs: number;
  readonly binary: string | null;
  readonly transport: TransportKind;
  readonly developerMode: DeveloperModeSetting;
  readonly clientSelfTraces: boolean;
  /** Directory for this invocation's profiles; null without --profile. */
  readonly profileRoot: string | null;
  readonly log: (message: string) => void;
}

const SCENARIO_TIMEOUT = Duration.minutes(30);

const contextFor = (options: RunnerOptions, profileDir: string | null): ScenarioContext => ({
  quick: options.quick,
  transport: options.transport,
  clientSelfTraces: options.clientSelfTraces,
  profileDir,
  log: options.log,
  launch: (launch = {}) =>
    Effect.acquireRelease(
      Effect.promise(() =>
        launchDaemon({
          binary: options.binary,
          developerMode: options.developerMode,
          profileDir,
          ...launch,
          home: launch.home ?? null,
        })
      ),
      (daemon) =>
        Effect.promise(async () => {
          await daemon.stop();

          // A home the scenario passed in is the scenario's to remove.
          if (!launch.home) cleanup(daemon.home);
        })
    ),
  sample: (daemon, intervalMs = 250) =>
    Effect.acquireRelease(
      Effect.sync(() => sampleDaemon(daemon, intervalMs)),
      (sampler) => Effect.sync(() => sampler.stop())
    ),
  peak: (daemon, label) =>
    profileDir === null
      ? Effect.void
      : Effect.promise(async () => {
          options.log(`heap snapshot (${label})…`);
          const file = await daemon.heapSnapshot();

          if (file) renameSync(file, join(profileDir, `heap-${label}.heapsnapshot`));
        }),
});

const aggregate = (runs: ReadonlyArray<ScenarioRun>) => {
  const byName = new Map<string, Array<Metric>>();

  for (const run of runs) {
    for (const [name, metric] of Object.entries(run.metrics)) {
      if (!Number.isFinite(metric.value)) continue;
      byName.set(name, [...(byName.get(name) ?? []), metric]);
    }
  }

  const out: Record<string, AggregatedMetric> = {};

  for (const [name, metrics] of byName) {
    const values = metrics.map((m) => m.value);
    out[name] = {
      ...metrics[0]!,
      value: median(values),
      runs: values,
      min: Math.min(...values),
      max: Math.max(...values),
    };
  }

  return out;
};

export const runScenario = async (
  scenario: Scenario,
  options: RunnerOptions
): Promise<ScenarioResult> => {
  const started = performance.now();
  const runs: Array<ScenarioRun> = [];
  let error: string | undefined;

  for (let i = 1; i <= options.runs; i++) {
    options.log(`${scenario.name}: run ${i}/${options.runs}`);

    const profileDir = options.profileRoot
      ? join(options.profileRoot, `${scenario.name}-run${i}`)
      : null;

    if (profileDir) mkdirSync(profileDir, { recursive: true });

    const exit = await Effect.runPromiseExit(
      Effect.scoped(scenario.run(contextFor(options, profileDir))).pipe(
        Effect.timeout(SCENARIO_TIMEOUT)
      )
    );

    if (Exit.isSuccess(exit)) {
      runs.push(exit.value);
    } else {
      error = String(exit.cause).split("\n").slice(0, 8).join("\n");
      options.log(`${scenario.name}: run ${i} failed\n${error}`);
      break;
    }

    if (profileDir && existsSync(profileDir)) {
      const files = readdirSync(profileDir);

      if (files.length > 0) options.log(`${scenario.name}: profiles in ${profileDir}`);
    }
  }

  // A note every run agrees on appears once; one that differs is labelled with its run.
  const notes = [...new Set(runs.flatMap((r) => r.notes))].flatMap((note) =>
    runs.every((r) => r.notes.includes(note))
      ? [note]
      : runs.flatMap((r, i) => (r.notes.includes(note) ? [`run ${i + 1}: ${note}`] : []))
  );

  const result: ScenarioResult = {
    metrics: aggregate(runs),
    notes,
    durationMs: performance.now() - started,
  };

  return error === undefined ? result : { ...result, error };
};
