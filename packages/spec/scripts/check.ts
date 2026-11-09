#!/usr/bin/env bun
/**
 * Runs every check of the Quint spec (CI's `spec` and `spec-simulate` jobs split it with --part).
 *
 *   bun run spec                      typecheck, scenario tests, simulator
 *   bun run spec -- --samples 20000   a longer simulation
 *   bun run spec -- --verify          also Apalache (`quint verify`, needs Java 17+)
 *   bun run spec -- --verify --steps 5
 *   bun run spec -- --part checks     typecheck and scenario tests only (CI's `spec` job)
 *   bun run spec -- --part simulate   simulator runs only (CI's `spec-simulate` job)
 *
 * The simulator runs with a fixed seed, so a run is reproducible and the
 * witness counts below are stable; change `--seed` to explore elsewhere.
 */
import { join } from "node:path";

const args = process.argv.slice(2);

const option = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);

  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};

const samples = option("samples", "3000");

const steps = option("steps", "4");

const seed = option("seed", "0x5eed");

const verify = args.includes("--verify");

const part = option("part", "all");

if (!["all", "checks", "simulate"].includes(part)) {
  console.log(`--part must be all, checks or simulate, not ${part}`);
  process.exit(2);
}

/** Simulator and Apalache runs belong to `simulate`; typecheck and `quint test` to `checks`. */

const inPart = (command: string | undefined) =>
  part === "all" || (part === "simulate") === (command === "run" || command === "verify");

const dir = join(import.meta.dir, "..");

const quint = join(dir, "node_modules", ".bin", "quint");

/** States the simulation must reach, or its checks prove little (see polaris.qnt). */

const WITNESSES = [
  "witnessDropped",
  "witnessFeedFailed",
  "witnessResumedAfterDrop",
  "witnessDuplicateAnswered",
  "witnessRetryAfterCrash",
  "witnessAnswerRace",
  "witnessHarnessWithdrew",
  "witnessRestartWithdrew",
  "witnessContinued",
  "witnessLimited",
  "witnessRetried",
  "witnessBatchOfTwo",
  "witnessArchived",
  "witnessUnarchived",
  "witnessArchiveRefused",
  "witnessLateRequest",
];

/** The same for the `review` instance (Clients accepting Turns and recording Verdicts). */

const REVIEW_WITNESSES = ["witnessAccepted", "witnessAcceptRefused", "witnessVerdict"];

/** The same for the `removal` instance (Clients removing the Workspace, ADR 0086). */

const REMOVAL_WITNESSES = ["witnessRemoved", "witnessRemoveRefused", "witnessPurgedRefused"];

/** Each ENG-209 finding: the instance of the code before its fix, and the property it breaks. */

const FINDINGS = [
  { main: "finding1", invariant: "hostFeedCanProgress", what: "the host feed stalls on a gap" },
  { main: "finding2", invariant: "archivedIsClosed", what: "Archive leaves a Turn in flight" },
  { main: "finding3", invariant: "approvalsNeedATurn", what: "a late request is recorded" },
  {
    main: "finding4",
    invariant: "acceptedNeverInFlight",
    what: "Continue reopens an accepted Turn",
  },
  {
    main: "finding5",
    invariant: "feedsFailVisibly",
    what: "an upstream defect leaves the feed silent",
  },
];

let failed = false;

const run = (label: string, argv: ReadonlyArray<string>, expectFailure = false) => {
  if (!inPart(argv[0])) return "";

  const started = performance.now();

  const result = Bun.spawnSync([quint, ...argv], { cwd: dir, stdout: "pipe", stderr: "pipe" });

  const seconds = ((performance.now() - started) / 1000).toFixed(1);

  const output = `${result.stdout.toString()}${result.stderr.toString()}`;

  const ok = expectFailure ? result.exitCode !== 0 : result.exitCode === 0;

  console.log(`${ok ? "✓" : "✗"} ${label} (${seconds}s)`);

  const summary = output
    .split("\n")
    .filter((line) => /^\[(ok|violation)\]|witnessed in|passing|failing|failed/.test(line.trim()));

  for (const line of summary) console.log(`    ${line.trim()}`);

  if (!ok) {
    failed = true;

    if (expectFailure) {
      console.log("    expected a violation (a fixed finding's mutant) but found none");
    } else {
      console.log(output);
    }
  }

  return output;
};

run("typecheck polaris.qnt", ["typecheck", "polaris.qnt"]);

run("Schema Diff attribution scenarios", ["test", "polaris.qnt", "--main=data_snapshots"]);

run("Schema Diff attribution safety", [
  "run",
  "polaris.qnt",
  "--main=data_snapshots",
  "--invariant=safety",
  `--max-samples=${samples}`,
  "--max-steps=60",
  `--seed=${seed}`,
]);

run("Inspector attach approval scenarios", ["test", "polaris.qnt", "--main=profile_attach"]);

run("Inspector attach approval safety", [
  "run",
  "polaris.qnt",
  "--main=profile_attach",
  "--invariant=safety",
  `--max-samples=${samples}`,
  "--max-steps=60",
  `--seed=${seed}`,
]);

run("Data approval scenarios", ["test", "polaris.qnt", "--main=data_approvals"]);

run("Data approval safety", [
  "run",
  "polaris.qnt",
  "--main=data_approvals",
  "--invariant=safety",
  `--max-samples=${samples}`,
  "--max-steps=60",
  `--seed=${seed}`,
]);

run("Data write scenarios", ["test", "polaris.qnt", "--main=data_writes"]);

run("Data write safety", [
  "run",
  "polaris.qnt",
  "--main=data_writes",
  "--invariant=safety",
  `--max-samples=${samples}`,
  "--max-steps=60",
  `--seed=${seed}`,
]);

for (const mutant of ["default", "once", "cards"]) {
  const main = `data_approvals_${mutant}_mutant`;
  run(`Data approval ${mutant} regression witness`, ["test", "polaris.qnt", `--main=${main}`]);
  run(
    `Data approval ${mutant} mutant violates safety`,
    [
      "run",
      "polaris.qnt",
      `--main=${main}`,
      "--invariant=safety",
      `--max-samples=${samples}`,
      "--max-steps=60",
      `--seed=${seed}`,
    ],
    true
  );
}

run("typecheck polaris_test.qnt", ["typecheck", "polaris_test.qnt"]);

run("typecheck worker-admission.qnt", ["typecheck", "worker-admission.qnt"]);

run("Worker admission scenarios", ["test", "worker-admission.qnt", "--main=worker_admission_test"]);

run("Worker admission safety", [
  "run",
  "worker-admission.qnt",
  "--main=worker_admission",
  "--invariant=safety",
  `--max-samples=${samples}`,
  "--max-steps=60",
  `--seed=${seed}`,
]);

run("typecheck constellations.qnt", ["typecheck", "constellations.qnt"]);

run("typecheck constellations_test.qnt", ["typecheck", "constellations_test.qnt"]);

run("typecheck file-edits.qnt", ["typecheck", "file-edits.qnt"]);

run("file operation recovery scenarios", ["test", "file-edits.qnt", "--main=file_edits_test"]);

run("file operation recovery simulation", [
  "run",
  "file-edits.qnt",
  "--main=file_edits",
  "--invariant=safety",
  `--max-samples=${samples}`,
  "--max-steps=60",
  `--seed=${seed}`,
]);

run("typecheck tree-edits.qnt", ["typecheck", "tree-edits.qnt"]);

run("tree recovery scenarios", ["test", "tree-edits.qnt", "--main=tree_edits_test"]);

run("tree descendant guards", ["test", "tree-edits.qnt", "--main=tree_descendants_test"]);

run("tree recovery safety", [
  "run",
  "tree-edits.qnt",
  "--main=tree_edits",
  "--invariants",
  "safety",
  `--max-samples=${samples}`,
  "--max-steps=60",
  `--seed=${option("seed", "31")}`,
  "--verbosity=1",
]);

run("typecheck resource receipts", ["typecheck", "resource-receipts.qnt"]);

run("resource receipt scenarios", ["test", "resource-receipts.qnt", "--main=resource_receipts"]);

run("resource receipt simulation", [
  "run",
  "resource-receipts.qnt",
  "--main=resource_receipts",
  "--invariant=safety",
  `--max-samples=${samples}`,
  "--max-steps=60",
  `--seed=${seed}`,
]);

run("typecheck language identity", ["typecheck", "language-identity.qnt"]);

run("language identity scenarios", [
  "test",
  "language-identity.qnt",
  "--main=language_identity_test",
]);

run("language identity simulation", [
  "run",
  "language-identity.qnt",
  "--main=language_identity",
  "--invariant=safety",
  `--max-samples=${samples}`,
  "--max-steps=60",
  `--seed=${seed}`,
]);

run("typecheck extensions.qnt", ["typecheck", "extensions.qnt"]);

run("typecheck RPC admission", ["typecheck", "rpc-admission.qnt"]);

run("RPC admission scenarios", ["test", "rpc-admission.qnt", "--main=rpc_admission_test"]);

run("RPC admission safety", [
  "run",
  "rpc-admission.qnt",
  "--main=rpc_admission",
  "--invariant=safety",
  `--max-samples=${samples}`,
  "--max-steps=40",
  `--seed=${seed}`,
]);

run("Extension scenarios", ["test", "extensions.qnt", "--main=extensions_test"]);

run("Extension safety", [
  "run",
  "extensions.qnt",
  "--main=extensions",
  "--invariant=safety",
  `--max-samples=${samples}`,
  "--max-steps=40",
  `--seed=${seed}`,
  "--witnesses",
  "witnessScoped",
  "witnessRefused",
  "witnessRevokedClosed",
]);

run("typecheck languages.qnt", ["typecheck", "languages.qnt"]);

run("language contract scenarios", ["test", "languages.qnt", "--main=languages_test"]);

run("language contract safety", [
  "run",
  "languages.qnt",
  "--main=languages",
  "--invariants",
  "safety",
  `--max-samples=${samples}`,
  "--max-steps=60",
  `--seed=${seed}`,
]);

run("typecheck language-host-state.qnt", ["typecheck", "language-host-state.qnt"]);

run("Host state snapshot scenarios", [
  "test",
  "language-host-state.qnt",
  "--main=language_host_state_test",
]);

run("Host state snapshot safety", [
  "run",
  "language-host-state.qnt",
  "--main=language_host_state",
  "--invariant=safety",
  `--max-samples=${samples}`,
  "--max-steps=60",
  `--seed=${seed}`,
]);

run("typecheck language-logs.qnt", ["typecheck", "language-logs.qnt"]);

run("language log scenarios", ["test", "language-logs.qnt", "--main=language_logs_test"]);

run("language log safety", [
  "run",
  "language-logs.qnt",
  "--main=language_logs",
  "--invariants",
  "safety",
  `--max-samples=${samples}`,
  "--max-steps=60",
  `--seed=${seed}`,
]);

run("typecheck sql-dialect.qnt", ["typecheck", "sql-dialect.qnt"]);

run("SQL dialect scenarios", ["test", "sql-dialect.qnt", "--main=sql_dialect_test"]);

run("SQL dialect simulation", [
  "run",
  "sql-dialect.qnt",
  "--main=sql_dialect",
  "--invariant=safety",
  `--max-samples=${samples}`,
  "--max-steps=30",
  `--seed=${seed}`,
]);

run("typecheck python-environment.qnt", ["typecheck", "python-environment.qnt"]);

run("Python interpreter scenarios", [
  "test",
  "python-environment.qnt",
  "--main=python_environment_test",
]);

run("Python interpreter simulation", [
  "run",
  "python-environment.qnt",
  "--main=python_environment",
  "--invariant=safety",
  `--max-samples=${samples}`,
  "--max-steps=30",
  `--seed=${seed}`,
]);

run("typecheck language-runtime.qnt", ["typecheck", "language-runtime.qnt"]);

run("language runtime scenarios", ["test", "language-runtime.qnt", "--main=language_runtime_test"]);

run("language runtime safety", [
  "run",
  "language-runtime.qnt",
  "--main=language_runtime",
  "--invariants",
  "safety",
  `--max-samples=${samples}`,
  "--max-steps=60",
  `--seed=${seed}`,
]);

run("typecheck worktree_setup.qnt", ["typecheck", "worktree_setup.qnt"]);

run("worktree setup scenarios", ["test", "worktree_setup.qnt", "--main=worktree_setup_test"]);

run("Session input queue scenarios", [
  "test",
  "worktree_setup.qnt",
  "--main=session_input_queue_test",
]);

run("Session input queue safety", [
  "run",
  "worktree_setup.qnt",
  "--main=session_input_queue",
  "--invariant=safety",
  "--max-samples=3000",
  "--max-steps=60",
]);

run("worktree setup safety", [
  "run",
  "worktree_setup.qnt",
  "--main=worktree_setup",
  "--invariants",
  "safety",
  `--max-samples=${samples}`,
  "--max-steps=30",
  `--seed=${seed}`,
]);

run("typecheck delivery_relay_test.qnt", ["typecheck", "delivery_relay_test.qnt"]);

run("Delivery relay scenarios", ["test", "delivery_relay_test.qnt", "--main=delivery_relay_test"]);

run("Constellation scenarios", ["test", "constellations_test.qnt", "--main=constellations_test"]);

run("Constellation property probes", [
  "test",
  "constellations_test.qnt",
  "--main=constellations_property_test",
]);

run("scenario tests", ["test", "polaris_test.qnt", "--main=polaris_test"]);

for (const n of [1, 2, 3, 4, 5]) {
  run(`scenario tests (finding ${n}, before its fix)`, [
    "test",
    "polaris_test.qnt",
    `--main=polaris_finding${n}_test`,
  ]);
}

const simulate = (
  main: string,
  invariants: ReadonlyArray<string>,
  witnesses: ReadonlyArray<string> = [],
  file = "polaris.qnt",
  step = "step"
) => [
  "run",
  file,
  `--main=${main}`,
  `--step=${step}`,
  "--invariants",
  ...invariants,
  `--max-samples=${samples}`,
  "--max-steps=60",
  `--seed=${seed}`,
  "--verbosity=1",
  ...(witnesses.length > 0 ? ["--witnesses", ...witnesses] : []),
];

/** Simulate `main` against `safety` and fail if a witness is never reached. */

const simulateWitnessed = (
  main: string,
  witnesses: ReadonlyArray<string>,
  file = "polaris.qnt",
  step = "step"
) => {
  const label = step === "step" ? main : `${main} (${step})`;

  const simulated = run(
    `simulate ${label}: safety, ${samples} traces of up to 60 steps`,
    simulate(main, ["safety"], witnesses, file, step)
  );

  for (const witness of witnesses) {
    if (new RegExp(`${witness} was witnessed in 0 trace`).test(simulated)) {
      failed = true;

      console.log(`✗ ${witness} was never reached: the simulation no longer covers it`);
    }
  }
};

simulateWitnessed("current", WITNESSES);

simulateWitnessed("review", REVIEW_WITNESSES);

simulateWitnessed("removal", REMOVAL_WITNESSES);

simulateWitnessed(
  "current_constellations",
  [
    "witnessClaim",
    "witnessAccepted",
    "witnessGate",
    "witnessHandover",
    "witnessDelivery",
    "witnessSteeredDelivery",
    "witnessAudit",
    "witnessSlotAudit",
    "witnessRelay",
    "witnessLease",
  ],
  "constellations.qnt"
);

// `step` reached recovery in 1 of 3000 traces; its own step keeps it covered (ENG-352).
simulateWitnessed(
  "current_constellations",
  ["witnessRecovery"],
  "constellations.qnt",
  "recoveryStep"
);

simulateWitnessed(
  "constellation_delivery_relay",
  ["witnessReconnectAck", "witnessRetry"],
  "constellations.qnt"
);

// The mutants: the simulator must still find each finding, or `safety` no longer guards it.

for (const finding of FINDINGS) {
  run(
    `simulate ${finding.main}: ${finding.invariant} is violated (${finding.what})`,
    simulate(finding.main, [finding.invariant]),
    true
  );
}

if (verify) {
  run(`verify small with Apalache: safety, up to ${steps} steps`, [
    "verify",
    "polaris.qnt",
    "--main=small",
    "--invariants",
    "safety",
    `--max-steps=${steps}`,
    "--verbosity=1",
  ]);
}

process.exit(failed ? 1 : 0);
