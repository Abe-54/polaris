/**
 * The `--parallel` default for local `bun test` runs. CI and explicit flags keep their own;
 * `POLARIS_TEST_PARALLEL=N` overrides it, and `1` runs serially.
 */
import { availableParallelism, loadavg } from "node:os";

/** Flags that already choose how bun schedules files. */
const SCHEDULING = /^--(?:parallel|isolate|no-isolate)(?:=|$)/;

export interface Machine {
  readonly cores: number;
  /** The one-minute load average. */
  readonly load: number;
}

export const thisMachine = (): Machine => ({
  cores: availableParallelism(),
  load: loadavg()[0] ?? 0,
});

/**
 * Workers for a local run: the idle cores, at least 2 and at most half the cores, so
 * many agents testing at once each get a share instead of all asking for every core.
 */
export const defaultWorkers = ({ cores, load }: Machine): number => {
  const cap = Math.max(2, Math.floor(cores / 2));
  const idle = Math.floor(cores - load);

  return Math.min(cap, Math.max(2, idle));
};

const parseOverride = (value: string): number => {
  const workers = Number(value);

  if (!Number.isInteger(workers) || workers < 1)
    throw new Error(
      `POLARIS_TEST_PARALLEL must be a whole number of workers, 1 or more: "${value}"`
    );

  return workers;
};

const inCi = (value: string | undefined) => Boolean(value) && value !== "false" && value !== "0";

const workersFor = (
  env: Readonly<Record<string, string | undefined>>,
  machine: () => Machine
): number => {
  const override = env.POLARIS_TEST_PARALLEL;

  if (override) return parseOverride(override);

  if (inCi(env.CI)) return 1;

  return defaultWorkers(machine());
};

/** The flags to add to `bun test args`: none when the run is serial or already chose. */
export const parallelFlags = (
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  machine: () => Machine = thisMachine
): ReadonlyArray<string> => {
  if (args.some((arg) => SCHEDULING.test(arg))) return [];

  const workers = workersFor(env, machine);

  return workers > 1 ? [`--parallel=${workers}`] : [];
};
