/**
 * What the rolling ci-red issues need after a run: pure, so it is tested without Linear or GitHub.
 * One open issue per failing check, titled `CI red: <workflow> / <job>`.
 */

/** One job of the run, as GitHub reports it once it completed. */
export interface Check {
  readonly name: string;
  /** GitHub's conclusion: success, failure, timed_out, cancelled, skipped… */
  readonly conclusion: string;
  readonly url: string;
  readonly failingTests: ReadonlyArray<string>;
}

/** An open Linear issue whose title starts with `CI red: `. */
export interface OpenIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  /** The body of its latest comment, if any. */
  readonly lastComment: string | undefined;
}

export interface Run {
  readonly workflow: string;
  readonly url: string;
  readonly sha: string;
  readonly ref: string;
  /** Which attempt of the run this is: 1, then 2 after its re-run. */
  readonly attempt: number;
}

export type Action =
  | { readonly kind: "create"; readonly title: string; readonly body: string }
  | {
      readonly kind: "red" | "recovered";
      readonly issue: OpenIssue;
      readonly body: string;
    };

export const TITLE_PREFIX = "CI red: ";

const RECOVERED = "Recovered:";

/** What a check reports when no runner acquired its job: no result, so neither red nor green. */
export const NO_RUNNER = "no_runner";

/** The one rolling issue for jobs left without a result, since runners run out together. */
export const NO_RUNNER_CHECK = "no runner";

/** Attempts a run gets: the first, and one re-run of jobs no runner acquired. */
export const MAX_ATTEMPTS = 2;

/** A job cancelled inside a run that wasn't: a job timeout or a lost runner. */
const RED = new Set(["failure", "timed_out", "cancelled"]);

const PASSED = new Set(["success", "skipped"]);

/** Failing test lines kept per check; the job log has the rest. */
export const MAX_TESTS = 30;

export const titleOf = (workflow: string, check: string) => `${TITLE_PREFIX}${workflow} / ${check}`;

const testsSection = (check: Check): string => {
  if (check.failingTests.length === 0)
    return "No failing test was named in the log; the job's log has the failure.";

  const shown = check.failingTests.slice(0, MAX_TESTS).map((line) => `- \`${line}\``);
  const more = check.failingTests.length - shown.length;

  return ["Failing tests:", ...shown, ...(more > 0 ? [`- …and ${more} more`] : [])].join("\n");
};

const redComment = (run: Run, check: Check): string =>
  [
    `Red again: \`${check.name}\` ${check.conclusion} on \`${run.ref}\` at \`${run.sha.slice(0, 9)}\`.`,
    "",
    `Run: ${run.url}`,
    `Job: ${check.url}`,
    "",
    testsSection(check),
  ].join("\n");

const createBody = (run: Run, check: Check): string =>
  [
    `\`${run.workflow} / ${check.name}\` ${check.conclusion} on \`${run.ref}\` at \`${run.sha.slice(0, 9)}\`.`,
    "",
    `Run: ${run.url}`,
    `Job: ${check.url}`,
    "",
    testsSection(check),
    "",
    "Filed by `tooling/ci/ciRed.ts`. Each red run comments here, and the first green run says it recovered; close the issue once the cause is fixed.",
  ].join("\n");

const recoveredComment = (run: Run, check: Check): string =>
  `${RECOVERED} \`${check.name}\` passed on \`${run.ref}\` at \`${run.sha.slice(0, 9)}\`: ${run.url}`;

const actionFor = (run: Run, check: Check, open: OpenIssue | undefined): Action | undefined => {
  const title = titleOf(run.workflow, check.name);

  if (RED.has(check.conclusion))
    return open
      ? { kind: "red", issue: open, body: redComment(run, check) }
      : { kind: "create", title, body: createBody(run, check) };

  const alreadySaid = open?.lastComment?.startsWith(RECOVERED) ?? false;

  if (check.conclusion === "success" && open && !alreadySaid)
    return { kind: "recovered", issue: open, body: recoveredComment(run, check) };

  return undefined;
};

export type RerunDecision =
  | { readonly kind: "none" }
  | { readonly kind: "rerun"; readonly jobs: ReadonlyArray<string> }
  | { readonly kind: "exhausted"; readonly jobs: ReadonlyArray<string> }
  | {
      readonly kind: "blocked";
      readonly jobs: ReadonlyArray<string>;
      readonly by: ReadonlyArray<string>;
    };

/**
 * Whether this attempt's jobs without a result get a re-run. GitHub's re-run takes every failed
 * job, so any red job blocks it: a retry must never turn a real failure green (ADR 0097).
 */
export const decideRerun = (checks: ReadonlyArray<Check>, attempt: number): RerunDecision => {
  const namesWhere = (keep: (check: Check) => boolean) =>
    checks.flatMap((check) => (keep(check) ? [check.name] : []));

  const jobs = namesWhere((check) => check.conclusion === NO_RUNNER);

  if (jobs.length === 0) return { kind: "none" };

  const by = namesWhere((check) => check.conclusion !== NO_RUNNER && !PASSED.has(check.conclusion));

  if (by.length > 0) return { kind: "blocked", jobs, by };

  return attempt < MAX_ATTEMPTS ? { kind: "rerun", jobs } : { kind: "exhausted", jobs };
};

export type MacosResult = "passed" | "red" | "no-result";

const MACOS_JOB = /\(macos-\d+\)$/;

/** What the macOS jobs add up to: a job with no result never counts as a pass, nor as a failure. */
export const macosResultOf = (checks: ReadonlyArray<Check>): MacosResult => {
  const macos = checks.filter((check) => MACOS_JOB.test(check.name));

  if (macos.some((check) => check.conclusion !== NO_RUNNER && !PASSED.has(check.conclusion)))
    return "red";

  const ran = macos.some((check) => check.conclusion === "success");

  return ran && macos.every((check) => check.conclusion !== NO_RUNNER) ? "passed" : "no-result";
};

const whyNoResult = (decision: RerunDecision): string =>
  decision.kind === "blocked"
    ? `No re-run, since a re-run would also retry: ${decision.by.map((name) => `\`${name}\``).join(", ")}.`
    : `Still none after ${MAX_ATTEMPTS} attempts.`;

const noRunnerBody = (run: Run, decision: RerunDecision, jobs: ReadonlyArray<string>): string =>
  [
    `No result, not a failure: no runner acquired ${jobs.map((name) => `\`${name}\``).join(", ")} on \`${run.ref}\` at \`${run.sha.slice(0, 9)}\`. GitHub cancelled them before any step ran, so no test failed and none passed.`,
    whyNoResult(decision),
    "",
    `Run: ${run.url}`,
  ].join("\n");

const noRunnerAction = (
  run: Run,
  checks: ReadonlyArray<Check>,
  open: OpenIssue | undefined
): Action | undefined => {
  const decision = decideRerun(checks, run.attempt);

  if (decision.kind === "rerun") return undefined;

  if (decision.kind === "none")
    return open && !open.lastComment?.startsWith(RECOVERED)
      ? {
          kind: "recovered",
          issue: open,
          body: `${RECOVERED} a runner acquired every job on \`${run.ref}\` at \`${run.sha.slice(0, 9)}\`: ${run.url}`,
        }
      : undefined;

  const body = noRunnerBody(run, decision, decision.jobs);

  return open
    ? { kind: "red", issue: open, body }
    : { kind: "create", title: titleOf(run.workflow, NO_RUNNER_CHECK), body };
};

/**
 * The comments and issues this run calls for; a recovery is said once, never repeated. Jobs no
 * runner acquired share one issue that names no test, and only once no re-run is coming.
 */
export const plan = (
  run: Run,
  checks: ReadonlyArray<Check>,
  open: ReadonlyArray<OpenIssue>
): ReadonlyArray<Action> => {
  const byTitle = new Map(open.map((issue) => [issue.title, issue]));

  const perJob = checks.flatMap((check) => {
    const action = actionFor(run, check, byTitle.get(titleOf(run.workflow, check.name)));

    return action ? [action] : [];
  });

  const noRunner = noRunnerAction(run, checks, byTitle.get(titleOf(run.workflow, NO_RUNNER_CHECK)));

  return noRunner ? [...perJob, noRunner] : perJob;
};

/** GitHub's timestamp, then turbo's `@pkg:task: ` prefix, both optional. */
const PREFIX = /^(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z )?(?:\S+:\S+: )?/;

/** Anchored, so output quoting a failure (a printed issue body, a test's own logs) doesn't count. */
const FAIL = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/;

const STALL = /^bun test stalled: .*/;

/** The failing tests a job log names: bun's `(fail)` lines and the watchdog's stall reports. */
export const failingTestsIn = (log: string): ReadonlyArray<string> => {
  const found = new Set<string>();

  for (const raw of log.split(/\r?\n/)) {
    const line = raw.replace(PREFIX, "");
    const failed = FAIL.exec(line)?.[1] ?? STALL.exec(line)?.[0];

    if (failed) found.add(failed.trim());
  }

  return [...found];
};
