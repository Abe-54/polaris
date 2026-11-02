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

const RED = new Set(["failure", "timed_out"]);

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

/** The comments and issues this run calls for; a recovery is said once, never repeated. */
export const plan = (
  run: Run,
  checks: ReadonlyArray<Check>,
  open: ReadonlyArray<OpenIssue>
): ReadonlyArray<Action> => {
  const byTitle = new Map(open.map((issue) => [issue.title, issue]));

  return checks.flatMap((check) => {
    const action = actionFor(run, check, byTitle.get(titleOf(run.workflow, check.name)));

    return action ? [action] : [];
  });
};

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /;

const FAIL = /\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/;

const STALL = /bun test stalled: .*/;

/** The failing tests a job log names: bun's `(fail)` lines and the watchdog's stall reports. */
export const failingTestsIn = (log: string): ReadonlyArray<string> => {
  const found = new Set<string>();

  for (const raw of log.split(/\r?\n/)) {
    const line = raw.replace(TIMESTAMP, "");
    const failed = FAIL.exec(line)?.[1] ?? STALL.exec(line)?.[0];

    if (failed) found.add(failed.trim());
  }

  return [...found];
};
