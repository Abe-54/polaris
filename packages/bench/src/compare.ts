/**
 * Compare a result against a baseline, metric by metric, with per-kind tolerances.
 *
 * A metric regresses when it is worse than the baseline's median by more than
 * max(relative × baseline, absolute). The defaults below were chosen from the
 * spread seen between repeated runs on one machine (see README "Tolerances"):
 * memory is steady run to run (a few MiB), so it is held tightly; CPU at low load
 * and tail latencies swing by tens of percent, so they are held loosely.
 */
import type {
  AggregatedMetric,
  BenchResult,
  Environment,
  MetricKind,
  ScenarioResult,
} from "./types.ts";

export const ALL_KINDS: ReadonlyArray<MetricKind> = [
  "memory",
  "cpu",
  "latency",
  "time",
  "throughput",
  "count",
];

const isMetricKind = (kind: string): kind is MetricKind => ALL_KINDS.some((k) => k === kind);

const isMetricName = (gate: string) => /^[\w-]+\.[\w.-]+$/.test(gate);

/** `--fail-on memory,cold-start.startup_modules,-git.rss_peak_mib` (or `none`): kinds and metrics that gate `--compare`; `-` drops one. */
export const parseFailOn = (value: string): Set<string> => {
  const gates = value
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  for (const gate of gates) {
    const excluded = gate.startsWith("-") && isMetricName(gate.slice(1));

    if (!isMetricKind(gate) && !isMetricName(gate) && !excluded && gate !== "none")
      throw new Error(`unknown kind ${gate}`);
  }

  return new Set(gates.filter((gate) => gate !== "none"));
};

export const DEFAULT_TOLERANCE: Record<MetricKind, { relative: number; absolute: number }> = {
  memory: { relative: 0.1, absolute: 5 },
  cpu: { relative: 0.5, absolute: 2 },
  latency: { relative: 0.5, absolute: 5 },
  time: { relative: 0.35, absolute: 5 },
  throughput: { relative: 0.3, absolute: 0 },
  count: { relative: 0.25, absolute: 1 },
};

export type Status = "ok" | "regressed" | "improved" | "new" | "missing";

export interface ComparisonRow {
  readonly scenario: string;
  readonly metric: string;
  readonly unit: string;
  readonly kind: MetricKind | null;
  readonly baseline: number | null;
  readonly current: number | null;
  /** Relative change, positive = worse. */
  readonly change: number | null;
  readonly allowed: number | null;
  readonly status: Status;
  /** Counted toward the exit status (its kind is in `failOn` and it is not informational). */
  readonly gating: boolean;
}

export interface Comparison {
  readonly rows: ReadonlyArray<ComparisonRow>;
  readonly regressions: ReadonlyArray<ComparisonRow>;
  readonly warnings: ReadonlyArray<string>;
}

export interface MetricComparison {
  readonly status: Status;
  readonly change: number;
  readonly allowed: number;
}

export const compareMetric = (
  base: AggregatedMetric,
  current: AggregatedMetric
): MetricComparison => {
  const tolerance = current.tolerance ?? base.tolerance ?? DEFAULT_TOLERANCE[current.kind];
  const sign = current.better === "lower" ? 1 : -1;
  const worsening = sign * (current.value - base.value);
  const allowed = Math.max(tolerance.relative * Math.abs(base.value), tolerance.absolute);

  const change =
    base.value === 0
      ? worsening === 0
        ? 0
        : Math.sign(worsening)
      : worsening / Math.abs(base.value);

  if (worsening > allowed) return { status: "regressed", change, allowed };

  if (-worsening > allowed) return { status: "improved", change, allowed };

  return { status: "ok", change, allowed };
};

/**
 * Above this many cores busy with other work, a run is not comparable with a baseline taken on a
 * quiet machine. Load moves the PTY-bound `terminal` scenario most: four `nice yes` processes on a
 * 12-core M2 Max cut its throughput from ~24 to ~6.5 MB/s with no code change.
 */
export const BUSY_BACKGROUND_CORES = 2;

/** Kinds that move with the CPU model; memory and counts don't (README "CI"). */
const CPU_BOUND_KINDS: ReadonlySet<string> = new Set<MetricKind>([
  "cpu",
  "latency",
  "time",
  "throughput",
]);

/**
 * What memory and counts depend on: OS, architecture and core count, not the CPU model. GitHub's
 * 4-core runners agree within a few MiB across EPYC 7763, 9V74, 9V45 and Xeon.
 */
export const memoryClass = (env: Environment): string => {
  const kernel = /\((\w+) /.exec(env.os)?.[1] ?? env.os;

  return `${kernel}-${env.arch}-${env.cores}c`.toLowerCase();
};

/** The CPU models a result was taken on: `merge.ts` joins several with ` | `. */
export const cpusOf = (env: Environment): ReadonlyArray<string> => env.cpu.split(" | ");

/** Whether every CPU model behind `current` is one the baseline was taken on. */
export const coversCpus = (baseline: Environment, current: Environment): boolean =>
  cpusOf(current).every((cpu) => cpusOf(baseline).includes(cpu));

/**
 * Why `--gate-same-machine` gates nothing for this pair, or null when it gates: another OS, arch
 * or core count, or a CPU model none of the baseline's runs had (peaks moved 28% on one).
 */
export const ungatedReason = (baseline: Environment, current: Environment): string | null => {
  if (memoryClass(baseline) !== memoryClass(current))
    return `the baseline is ${memoryClass(baseline)}, this run ${memoryClass(current)}`;

  if (!coversCpus(baseline, current))
    return `the baseline covers ${cpusOf(baseline).join(", ")}, not ${cpusOf(current).join(", ")}`;

  return null;
};

const singleCpu = (env: Environment) => cpusOf(env).length === 1;

/**
 * What gates a comparison: `failOn` (metric kinds, or `scenario.metric` names), narrowed with
 * `sameMachineOnly` when the results come from different machines. CI uses it: memory, counts
 * and named metrics gate on the baseline's OS, arch, core count and CPU models; CPU, latency,
 * time and throughput only on its single CPU model.
 */
export const gatingKinds = (
  baseline: BenchResult,
  current: BenchResult,
  failOn: ReadonlySet<string>,
  sameMachineOnly: boolean
): ReadonlySet<string> => {
  if (!sameMachineOnly) return failOn;

  // Timings gate only between single runs on one CPU model, never against a merged result.
  if (
    baseline.env.machineSlug === current.env.machineSlug &&
    singleCpu(baseline.env) &&
    singleCpu(current.env)
  )
    return failOn;

  if (ungatedReason(baseline.env, current.env) !== null) return new Set();

  return new Set([...failOn].filter((gate) => !CPU_BOUND_KINDS.has(gate)));
};

const developerModeOf = (result: BenchResult) => result.env.developerMode ?? "off";

const clientSelfTracesOf = (result: BenchResult) => result.options.clientSelfTraces ?? false;

/** Developer Mode and Client Self-Traces: both absent in older results, which ran them off. */
const selfTraceWarnings = (baseline: BenchResult, current: BenchResult): Array<string> => {
  const warnings: Array<string> = [];

  if (developerModeOf(baseline) !== developerModeOf(current)) {
    warnings.push(
      `baseline ran with Developer Mode ${developerModeOf(baseline)}, this run ${developerModeOf(current)}`
    );
  }

  if (clientSelfTracesOf(baseline) !== clientSelfTracesOf(current)) {
    warnings.push(
      `baseline's Clients ${clientSelfTracesOf(baseline) ? "sent" : "sent no"} Self-Traces, this run's ${clientSelfTracesOf(current) ? "did" : "did not"}`
    );
  }

  return warnings;
};

/** Differences in how the two results were produced that make them less comparable. */
const environmentWarnings = (baseline: BenchResult, current: BenchResult): Array<string> => {
  const warnings: Array<string> = [];

  if (memoryClass(baseline.env) !== memoryClass(current.env)) {
    warnings.push(
      `baseline is from ${baseline.env.machineSlug}, this run is ${current.env.machineSlug}: numbers are not comparable`
    );
  } else if (!coversCpus(baseline.env, current.env)) {
    warnings.push(
      `baseline ran on ${cpusOf(baseline.env).join(", ")}, this run on ${current.env.cpu}: --gate-same-machine gates nothing`
    );
  } else if (baseline.env.machineSlug !== current.env.machineSlug) {
    warnings.push(
      `baseline ran on ${baseline.env.cpu}, this run on ${current.env.cpu}: memory and counts compare, CPU and timings do not`
    );
  }

  if (baseline.options.quick !== current.options.quick) {
    warnings.push(
      `baseline ran ${baseline.options.quick ? "--quick" : "full"}, this run ${current.options.quick ? "--quick" : "full"}: sizes differ`
    );
  }

  if (baseline.env.daemon !== current.env.daemon) {
    warnings.push(
      `baseline ran the ${baseline.env.daemon} Daemon, this run the ${current.env.daemon} one`
    );
  }

  if (baseline.env.transport !== current.env.transport) {
    warnings.push(
      `baseline used the ${baseline.env.transport} transport, this run ${current.env.transport}`
    );
  }

  warnings.push(...selfTraceWarnings(baseline, current));

  if (current.options.profile)
    warnings.push("this run was profiled: timings include profiler overhead");

  for (const [which, result] of [
    ["baseline", baseline],
    ["this run", current],
  ] as const) {
    const busy = result.env.backgroundCores;

    if (busy !== undefined && busy > BUSY_BACKGROUND_CORES) {
      warnings.push(
        `${which} started with ${busy} cores busy with other work: throughput and CPU are not comparable`
      );
    }
  }

  return warnings;
};

/** One scenario's rows: every current metric against the baseline, then those it lost. */
const scenarioRows = (
  scenario: string,
  result: ScenarioResult,
  base: ScenarioResult | undefined,
  failOn: ReadonlySet<string>
): Array<ComparisonRow> => {
  const rows: Array<ComparisonRow> = [];

  for (const [metric, m] of Object.entries(result.metrics)) {
    const b = base?.metrics[metric];

    if (b === undefined) {
      rows.push({
        scenario,
        metric,
        unit: m.unit,
        kind: m.kind,
        baseline: null,
        current: m.value,
        change: null,
        allowed: null,
        status: "new",
        gating: false,
      });
      continue;
    }

    const { status, change, allowed } = compareMetric(b, m);
    rows.push({
      scenario,
      metric,
      unit: m.unit,
      kind: m.kind,
      baseline: b.value,
      current: m.value,
      change,
      allowed,
      status,
      gating:
        (failOn.has(m.kind) || failOn.has(`${scenario}.${metric}`)) &&
        !failOn.has(`-${scenario}.${metric}`) &&
        !m.info &&
        !b.info,
    });
  }

  for (const [metric, b] of Object.entries(base?.metrics ?? {})) {
    if (result.metrics[metric] !== undefined) continue;
    rows.push({
      scenario,
      metric,
      unit: b.unit,
      kind: b.kind,
      baseline: b.value,
      current: null,
      change: null,
      allowed: null,
      status: "missing",
      gating: false,
    });
  }

  return rows;
};

export const compare = (
  baseline: BenchResult,
  current: BenchResult,
  failOn: ReadonlySet<string>
): Comparison => {
  const rows = Object.entries(current.scenarios).flatMap(([scenario, result]) =>
    scenarioRows(scenario, result, baseline.scenarios[scenario], failOn)
  );

  return {
    rows,
    regressions: rows.filter((r) => r.status === "regressed" && r.gating),
    warnings: environmentWarnings(baseline, current),
  };
};
