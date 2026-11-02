/**
 * The noise of a gate: many results of one commit against a baseline. Prints which results the
 * gate would fail and, per gated metric and CPU model, the spread and the worst worsening as a
 * share of what the tolerance allows (README "CI").
 *
 *   bun packages/bench/src/noise.ts --baseline <b.json> [--fail-on GATES] [--gate-same-machine]
 *                                   [--per-run] <result.json>...
 */
import { readFileSync } from "node:fs";
import { compare, compareMetric, gatingKinds, parseFailOn } from "./compare.ts";
import { median } from "./stats.ts";
import { type AggregatedMetric, type BenchResult, parseBenchResult } from "./types.ts";

export interface NoiseRow {
  readonly metric: string;
  readonly cpu: string;
  readonly values: ReadonlyArray<number>;
  /** (max − min) / median. */
  readonly spread: number;
  /** The worst worsening against the baseline divided by the allowed worsening; ≥ 1 fails. */
  readonly worstUse: number;
}

export interface NoiseReport {
  readonly failures: ReadonlyArray<{ readonly index: number; readonly metrics: Array<string> }>;
  readonly gated: number;
  readonly rows: ReadonlyArray<NoiseRow>;
}

/** Each value as a one-run metric, so a single run's worsening can be judged like a median's. */
const valuesOf = (m: AggregatedMetric, perRun: boolean): Array<AggregatedMetric> =>
  (perRun ? m.runs : [m.value]).map((value) => ({ ...m, value }));

const usesOf = (base: AggregatedMetric, metrics: ReadonlyArray<AggregatedMetric>) =>
  metrics.map((m) => {
    const { change, allowed } = compareMetric(base, m);

    return allowed === 0 ? 0 : (change * Math.abs(base.value)) / allowed;
  });

export const noiseReport = (
  baseline: BenchResult,
  results: ReadonlyArray<BenchResult>,
  failOn: ReadonlySet<string>,
  sameMachineOnly: boolean,
  perRun = false
): NoiseReport => {
  const failures: Array<{ index: number; metrics: Array<string> }> = [];
  const gatedNames = new Set<string>();
  let gated = 0;

  results.forEach((result, index) => {
    const gates = gatingKinds(baseline, result, failOn, sameMachineOnly);
    const comparison = compare(baseline, result, gates);

    if (gates.size > 0) gated++;

    for (const row of comparison.rows) {
      if (row.gating) gatedNames.add(`${row.scenario}.${row.metric}`);
    }

    if (comparison.regressions.length > 0) {
      failures.push({
        index,
        metrics: comparison.regressions.map((r) => `${r.scenario}.${r.metric}`),
      });
    }
  });

  const rows: Array<NoiseRow> = [];

  for (const name of [...gatedNames].sort()) {
    const [scenario, ...rest] = name.split(".");
    const metric = rest.join(".");
    const base = baseline.scenarios[scenario!]?.metrics[metric];

    if (base === undefined) continue;

    for (const cpu of [...new Set(results.map((r) => r.env.cpu))].sort()) {
      const metrics = results
        .filter((r) => r.env.cpu === cpu)
        .flatMap((r) => {
          const m = r.scenarios[scenario!]?.metrics[metric];

          return m === undefined ? [] : valuesOf(m, perRun);
        });

      if (metrics.length === 0) continue;

      const values = metrics.map((m) => m.value).sort((a, b) => a - b);
      const mid = median(values);

      rows.push({
        metric: name,
        cpu,
        values,
        spread: mid === 0 ? 0 : (values.at(-1)! - values[0]!) / Math.abs(mid),
        worstUse: Math.max(...usesOf(base, metrics)),
      });
    }
  }

  return { failures, gated, rows };
};

const render = (report: NoiseReport, results: ReadonlyArray<BenchResult>): string => {
  const lines = [
    `${report.failures.length} of ${results.length} results fail the gate (${report.gated} gated)`,
  ];

  for (const f of report.failures) {
    lines.push(`  #${f.index + 1} ${results[f.index]!.env.cpu}: ${f.metrics.join(", ")}`);
  }

  lines.push("", "metric | cpu | n | median | min–max | spread | worst use of tolerance");

  for (const r of report.rows) {
    lines.push(
      [
        r.metric,
        r.cpu,
        r.values.length,
        median(r.values).toFixed(1),
        `${r.values[0]!.toFixed(1)}–${r.values.at(-1)!.toFixed(1)}`,
        `${(r.spread * 100).toFixed(1)}%`,
        `${(r.worstUse * 100).toFixed(0)}%`,
      ].join(" | ")
    );
  }

  return lines.join("\n");
};

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let baselinePath: string | null = null;
  let failOn = parseFailOn("memory,count");
  let sameMachine = false;
  let perRun = false;
  const inputs: Array<string> = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--baseline") baselinePath = argv[++i] ?? null;
    else if (arg === "--fail-on") failOn = parseFailOn(argv[++i] ?? "");
    else if (arg === "--gate-same-machine") sameMachine = true;
    else if (arg === "--per-run") perRun = true;
    else inputs.push(arg);
  }

  if (baselinePath === null || inputs.length === 0) {
    console.error(
      "usage: bun packages/bench/src/noise.ts --baseline <b.json> [--fail-on GATES] [--gate-same-machine] [--per-run] <result.json>..."
    );
    process.exit(2);
  }

  const baseline = parseBenchResult(readFileSync(baselinePath, "utf8"));
  const results = inputs.map((path) => parseBenchResult(readFileSync(path, "utf8")));

  console.log(render(noiseReport(baseline, results, failOn, sameMachine, perRun), results));
}
