/**
 * Gate several results of one commit, each from its own runner, as one: merge them into
 * per-metric medians and compare with a baseline. CI's bench job runs its repetitions as
 * parallel shards and gates here (README "CI").
 *
 *   bun packages/bench/src/gate.ts --compare <baseline.json> [--fail-on GATES]
 *       [--gate-same-machine] [--markdown PATH] [--json PATH] <result.json>...
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  type Comparison,
  compare,
  coversCpus,
  gatingKinds,
  memoryClass,
  parseFailOn,
  ungatedReason,
} from "./compare.ts";
import { mergeResults } from "./merge.ts";
import { renderComparison, renderMarkdown } from "./report.ts";
import { type BenchResult, parseBenchResult } from "./types.ts";

/** With fewer results than this on the baseline's CPU models, the shards are gated as they are. */
const MIN_COVERED = 2;

export interface Gate {
  readonly merged: BenchResult;
  readonly comparison: Comparison;
  readonly ungated: string | null;
  /** Scenarios a shard failed to run, with the shard's number. */
  readonly failedScenarios: ReadonlyArray<string>;
  readonly dropped: ReadonlyArray<string>;
}

/**
 * Merges the results the baseline can judge: with `sameMachineOnly`, shards on a CPU model the
 * baseline lacks are dropped as long as `MIN_COVERED` remain, so one odd runner doesn't ungate.
 */
export const gate = (
  baseline: BenchResult,
  results: ReadonlyArray<BenchResult>,
  failOn: ReadonlySet<string>,
  sameMachineOnly: boolean
): Gate => {
  const failedScenarios = results.flatMap((r, i) =>
    Object.entries(r.scenarios).flatMap(([name, s]) =>
      s.error === undefined ? [] : [`${name} (shard ${i + 1})`]
    )
  );

  const comparable = results.filter(
    (r) => memoryClass(r.env) === memoryClass(baseline.env) && coversCpus(baseline.env, r.env)
  );

  // Too few to judge: merge one class anyway (merge.ts refuses mixed ones) and report ungated.
  const kept =
    sameMachineOnly && comparable.length >= MIN_COVERED
      ? comparable
      : results.filter((r) => memoryClass(r.env) === memoryClass(results[0]!.env));

  const dropped = results.flatMap((r) => (kept.includes(r) ? [] : [r.env.cpu]));
  const merged = mergeResults(kept);
  const gates = gatingKinds(baseline, merged, failOn, sameMachineOnly);

  return {
    merged,
    comparison: compare(baseline, merged, gates),
    ungated: sameMachineOnly ? ungatedReason(baseline.env, merged.env) : null,
    failedScenarios,
    dropped,
  };
};

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let baselinePath: string | null = null;
  let failOn = parseFailOn("memory,cpu,latency,time,throughput,count");
  let sameMachine = false;
  let markdown: string | null = null;
  let json: string | null = null;
  const inputs: Array<string> = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => argv[++i] ?? "";

    if (arg === "--compare") baselinePath = value();
    else if (arg === "--fail-on") failOn = parseFailOn(value());
    else if (arg === "--gate-same-machine") sameMachine = true;
    else if (arg === "--markdown") markdown = value();
    else if (arg === "--json") json = value();
    else inputs.push(arg);
  }

  if (baselinePath === null || inputs.length === 0) {
    console.error(
      "usage: bun packages/bench/src/gate.ts --compare <baseline.json> [--fail-on GATES] [--gate-same-machine] [--markdown PATH] [--json PATH] <result.json>..."
    );
    process.exit(2);
  }

  const baseline = parseBenchResult(readFileSync(baselinePath, "utf8"));
  const results = inputs.map((path) => parseBenchResult(readFileSync(path, "utf8")));
  const outcome = gate(baseline, results, failOn, sameMachine);

  console.log(`merged ${results.length} results: ${results.map((r) => r.env.cpu).join("; ")}`);

  if (outcome.dropped.length > 0)
    console.log(`not merged (CPU model not in the baseline): ${outcome.dropped.join("; ")}`);

  if (outcome.ungated !== null) console.log(`not gating: ${outcome.ungated}`);

  console.log(`\ncompared with ${baselinePath}\n${renderComparison(outcome.comparison)}`);

  if (json !== null) writeFileSync(json, `${JSON.stringify(outcome.merged, null, 2)}\n`);

  if (markdown !== null)
    appendFileSync(markdown, `${renderMarkdown(outcome.merged, outcome.comparison)}\n`);

  if (outcome.failedScenarios.length > 0)
    console.log(`scenarios failed: ${outcome.failedScenarios.join(", ")}`);

  const failed = outcome.failedScenarios.length > 0 || outcome.comparison.regressions.length > 0;

  process.exit(failed ? 1 : 0);
}
