#!/usr/bin/env bun
/**
 * Daemon benchmarks. See packages/bench/README.md.
 *
 *   bun run bench [scenario...] [--quick] [--runs N] [--json out.json]
 *                 [--compare baseline.json] [--fail-on kinds] [--save-baseline]
 *                 [--markdown out.md] [--profile] [--binary path] [--transport bridge|socket]
 *                 [--developer-mode off|on] [--client-self-traces]
 *                 [--list]
 *
 * Relative paths are resolved against the repository root.
 */
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  ALL_KINDS,
  BUSY_BACKGROUND_CORES,
  parseFailOn,
  type Comparison,
  compare,
  gatingKinds,
  ungatedReason,
} from "./compare.ts";
import { type DeveloperModeSetting, REPO_ROOT, type TransportKind } from "./daemon.ts";
import { environment, measureBackgroundCores } from "./env.ts";
import { renderComparison, renderMarkdown, renderResult } from "./report.ts";
import { runScenario } from "./runner.ts";
import { SCENARIOS } from "./scenarios/index.ts";
import { type BenchResult, parseBenchResult, type ScenarioResult } from "./types.ts";

import { takeScriptLease } from "../../../tooling/leases.ts";

await takeScriptLease("bench");

export const BENCH_DIR = resolve(import.meta.dir, "..");

const usage = `usage: bun run bench [scenario...] [options]

scenarios: ${SCENARIOS.map((s) => s.name).join(", ")} (default: all)

  --quick               smaller sizes, for CI and quick checks
  --runs N              runs per scenario, each with fresh Daemons (default 1); medians are reported
  --json PATH           also write the result JSON to PATH
  --compare PATH        compare with a baseline; exit 1 on regressions beyond tolerance
  --fail-on GATES       comma-separated kinds that gate --compare (default: all):
                        ${ALL_KINDS.join(",")}; or single metrics as scenario.metric
                        (e.g. cold-start.startup_modules), -scenario.metric to drop
                        one; none for no gate
  --gate-same-machine   gate memory and counts only on the baseline's OS, arch and core count,
                        and CPU, latency, time and throughput only on its CPU model; the rest
                        is compared and reported without failing (CI)
  --save-baseline       write the result to packages/bench/baselines/<machine>.json
  --markdown PATH       append a Markdown summary to PATH (e.g. $GITHUB_STEP_SUMMARY)
  --profile             CPU profile + heap snapshot at peak for each scenario run
  --binary PATH         bench a compiled polaris binary instead of the source
  --transport KIND      bridge (default: polaris bridge, like ssh) or socket (direct)
  --developer-mode M    off (default: the untraced path) or on (Self-Traces recorded)
  --client-self-traces  with Developer Mode on, sessions' Clients also send Self-Traces
  --list                list scenarios and exit`;

interface Args {
  scenarios: Array<string>;
  quick: boolean;
  runs: number;
  json: string | null;
  compare: string | null;
  failOn: Set<string>;
  gateSameMachine: boolean;
  saveBaseline: boolean;
  markdown: string | null;
  profile: boolean;
  binary: string | null;
  transport: TransportKind;
  developerMode: DeveloperModeSetting;
  clientSelfTraces: boolean;
  list: boolean;
}

const parseTransport = (value: string): TransportKind => {
  if (value !== "bridge" && value !== "socket") throw new Error(`unknown transport ${value}`);

  return value;
};

const parseDeveloperMode = (value: string): DeveloperModeSetting => {
  if (value !== "off" && value !== "on") throw new Error(`unknown developer mode ${value}`);

  return value;
};

const fromRoot = (path: string) => (isAbsolute(path) ? path : join(REPO_ROOT, path));

const parseArgs = (argv: ReadonlyArray<string>): Args => {
  const args: Args = {
    scenarios: [],
    quick: false,
    runs: 1,
    json: null,
    compare: null,
    failOn: new Set<string>(ALL_KINDS),
    gateSameMachine: false,
    saveBaseline: false,
    markdown: null,
    profile: false,
    binary: null,
    transport: "bridge",
    developerMode: "off",
    clientSelfTraces: false,
    list: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    const value = () => {
      const v = argv[++i];

      if (v === undefined) throw new Error(`${arg} needs a value`);

      return v;
    };

    switch (arg) {
      case "--quick":
        args.quick = true;
        break;
      case "--runs":
        args.runs = Math.max(1, Number.parseInt(value(), 10) || 1);
        break;
      case "--json":
        args.json = fromRoot(value());
        break;
      case "--compare":
        args.compare = fromRoot(value());
        break;
      case "--fail-on":
        args.failOn = parseFailOn(value());
        break;
      case "--gate-same-machine":
        args.gateSameMachine = true;
        break;

      case "--save-baseline":
        args.saveBaseline = true;
        break;
      case "--markdown":
        args.markdown = fromRoot(value());
        break;
      case "--profile":
        args.profile = true;
        break;
      case "--binary":
        args.binary = fromRoot(value());
        break;
      case "--transport":
        args.transport = parseTransport(value());
        break;
      case "--developer-mode":
        args.developerMode = parseDeveloperMode(value());
        break;
      case "--client-self-traces":
        args.clientSelfTraces = true;
        break;

      case "--list":
        args.list = true;
        break;
      case "-h":
      case "--help":
        console.log(usage);
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        args.scenarios.push(arg);
    }
  }

  // The Daemon refuses `traces.ingestSelf` while Developer Mode is off.
  if (args.clientSelfTraces && args.developerMode !== "on")
    throw new Error("--client-self-traces needs --developer-mode on");

  return args;
};

/** Developer Mode runs keep their own baselines beside the off path's. */
const baselineSuffix = (args: Args) => {
  if (args.developerMode === "off") return "";

  return args.clientSelfTraces ? "-developer-mode-clients" : "-developer-mode";
};

/** Writes `result.json` and `summary.txt` under `runDir`, plus `--json` and `--save-baseline`. */
const writeResult = (result: BenchResult, args: Args, runDir: string, log: (m: string) => void) => {
  const resultPath = join(runDir, "result.json");
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  if (args.json) {
    mkdirSync(dirname(args.json), { recursive: true });
    copyFileSync(resultPath, args.json);
  }

  if (args.saveBaseline) {
    const baselinePath = join(
      BENCH_DIR,
      "baselines",
      `${result.env.machineSlug}${args.quick ? "-quick" : ""}${baselineSuffix(args)}.json`
    );

    copyFileSync(resultPath, baselinePath);
    log(`baseline written to ${baselinePath}`);
  }

  const text = renderResult(result);
  console.log(text);
  writeFileSync(join(runDir, "summary.txt"), `${text}\n`);
};

const compareWithBaseline = (
  baselinePath: string,
  result: BenchResult,
  args: Pick<Args, "failOn" | "gateSameMachine">,
  runDir: string
): Comparison => {
  const baseline = parseBenchResult(readFileSync(baselinePath, "utf8"));
  const failOn = gatingKinds(baseline, result, args.failOn, args.gateSameMachine);

  const ungated = [...args.failOn].filter((kind) => !failOn.has(kind));

  if (ungated.length > 0) {
    const reason =
      ungatedReason(baseline.env, result.env) ??
      `the baseline is from ${baseline.env.cpu}, this run ${result.env.cpu}`;

    console.log(`\nnot gating ${ungated.join(", ")}: ${reason}`);
  }

  const comparison = compare(baseline, result, failOn);
  const rendered = renderComparison(comparison);
  console.log(`\ncompared with ${baselinePath}\n${rendered}`);
  writeFileSync(join(runDir, "comparison.txt"), `${rendered}\n`);

  return comparison;
};

/** 1 when a scenario failed or a gating metric regressed, else 0. */
const exitCode = (
  scenarios: Record<string, ScenarioResult>,
  comparison: Comparison | null,
  log: (m: string) => void
) => {
  const failed = Object.values(scenarios).some((s) => s.error !== undefined);

  if (failed) log("some scenarios failed");

  if (comparison && comparison.regressions.length > 0) return 1;

  return failed ? 1 : 0;
};

const main = async () => {
  let args: Args;

  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);

    return 2;
  }

  if (args.list) {
    for (const s of SCENARIOS) console.log(`${s.name.padEnd(12)} ${s.description}`);

    return 0;
  }

  const unknown = args.scenarios.filter((name) => !SCENARIOS.some((s) => s.name === name));

  if (unknown.length > 0) {
    console.error(`unknown scenario(s): ${unknown.join(", ")}\n\n${usage}`);

    return 2;
  }

  const selected =
    args.scenarios.length === 0
      ? SCENARIOS
      : SCENARIOS.filter((s) => args.scenarios.includes(s.name));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(BENCH_DIR, "results", stamp);
  mkdirSync(runDir, { recursive: true });
  const started = performance.now();

  const log = (message: string) =>
    process.stderr.write(
      `[bench ${((performance.now() - started) / 1000).toFixed(1)}s] ${message}\n`
    );

  const env = {
    ...environment({
      binary: args.binary,
      transport: args.transport,
      developerMode: args.developerMode,
    }),
    backgroundCores: await measureBackgroundCores(),
  };

  log(`${env.machine} (${env.cpu}), ${env.daemon} Daemon, results in ${runDir}`);

  if (env.backgroundCores > BUSY_BACKGROUND_CORES) {
    log(
      `warning: ${env.backgroundCores} cores are busy with other work; throughput and CPU will not match a quiet baseline`
    );
  }

  const scenarios: Record<string, ScenarioResult> = {};

  for (const scenario of selected) {
    scenarios[scenario.name] = await runScenario(scenario, {
      quick: args.quick,
      runs: args.runs,
      binary: args.binary,
      transport: args.transport,
      developerMode: args.developerMode,
      clientSelfTraces: args.clientSelfTraces,
      profileRoot: args.profile ? runDir : null,
      log,
    });
  }

  const result: BenchResult = {
    schema: 1,
    env,
    options: {
      quick: args.quick,
      runs: args.runs,
      profile: args.profile,
      clientSelfTraces: args.clientSelfTraces,
      scenarios: selected.map((s) => s.name),
    },
    scenarios,
  };

  writeResult(result, args, runDir, log);

  const comparison = args.compare ? compareWithBaseline(args.compare, result, args, runDir) : null;

  if (args.markdown) appendFileSync(args.markdown, `${renderMarkdown(result, comparison)}\n`);

  return exitCode(scenarios, comparison, log);
};

process.exit(await main());
