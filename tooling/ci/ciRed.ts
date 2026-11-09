#!/usr/bin/env bun
/**
 * Rolling ci-red issues: after a workflow run, one Linear issue per failing job (created, or
 * commented on when already open), and a comment once it recovers. Issues are never closed here.
 * Jobs no runner acquired aren't failures and file nothing; the job summary names them.
 *
 *   bun tooling/ci/ciRed.ts --workflow <name> [--ignore <job>]… [--dry-run] [--fake <fixture.json>]
 *
 * The run comes from GitHub Actions' env (GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_TOKEN…); Linear's
 * from LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET, and without them it warns and passes.
 * `--dry-run` reads but prints what it would write; `--fake` answers GitHub and Linear from a fixture;
 * `--probe <job>` files, comments on and recovers a throwaway issue for that job name.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { decodeFixture, fakeFetch } from "./fake.ts";
import { checksOf, type Fetch, gitHubRunOf } from "./github.ts";
import {
  LABEL_NAME,
  type Linear,
  type LinearContext,
  linearClient,
  requestToken,
} from "./linear.ts";
import { type Action, type Check, NO_RUNNER, plan, type Run } from "./plan.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface Options {
  readonly workflow: string;
  readonly ignore: ReadonlySet<string>;
  readonly dryRun: boolean;
  /** Checks to report instead of the run's jobs: `--probe` fakes them. */
  readonly checks?: ReadonlyArray<Check>;
}

const describeAction = (action: Action): string =>
  action.kind === "create"
    ? `create "${action.title}"`
    : `comment on ${action.issue.identifier} (${action.kind})`;

const applyAction = async (action: Action, linear: Linear, context: LinearContext) => {
  if (action.kind !== "create") return linear.comment(action.issue.id, action.body);

  return linear.createIssue({
    teamId: context.teamId,
    title: action.title,
    description: action.body,
    // JSON drops the undefined ones.
    projectId: context.projectId,
    labelIds: context.labelId ? [context.labelId] : undefined,
  });
};

const warnSetup = (context: LinearContext) => {
  if (!context.labelId)
    console.warn(`::warning::Linear has no "${LABEL_NAME}" label; issues are filed without it.`);

  if (!context.projectId)
    console.warn("::warning::Linear has no Polaris project visible to the app.");
};

const summarize = (env: Env, lines: ReadonlyArray<string>) => {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
};

const runOf = (env: Env, workflow: string): Run => {
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";

  return {
    workflow,
    url: `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    sha: env.GITHUB_SHA ?? "",
    ref: env.GITHUB_REF_NAME ?? "",
    attempt: Number(env.GITHUB_RUN_ATTEMPT ?? "1"),
  };
};

const report = (checks: ReadonlyArray<Check>) => {
  const red = checks.filter(
    (check) => check.conclusion !== "success" && check.conclusion !== "skipped"
  );

  console.log(red.length === 0 ? "Every check passed or was skipped." : "Not passing:");

  for (const check of red)
    console.log(
      check.conclusion === NO_RUNNER
        ? `::warning::${check.name}: no runner acquired it, so it has no result`
        : `  ${check.name}: ${check.conclusion}`
    );
};

/** Files, comments or (dry run) prints what this run calls for; the exit code. */
export const ciRed = async (options: Options, env: Env, fetch: Fetch): Promise<number> => {
  const checks = options.checks ?? (await checksOf(gitHubRunOf(env), options.ignore, fetch));

  report(checks);

  const { LINEAR_CLIENT_ID: id, LINEAR_CLIENT_SECRET: secret } = env;

  if (!id || !secret) {
    console.warn(
      "::warning::LINEAR_CLIENT_ID or LINEAR_CLIENT_SECRET is not set; no ci-red issue is filed."
    );

    return 0;
  }

  const linear = linearClient(await requestToken(id, secret, fetch), fetch);
  const context = await linear.context();
  const actions = plan(runOf(env, options.workflow), checks, context.open);

  warnSetup(context);

  for (const action of actions) {
    console.log(`${options.dryRun ? "Would " : ""}${describeAction(action)}\n${action.body}\n`);

    if (!options.dryRun) await applyAction(action, linear, context);
  }

  summarize(env, [
    `### ci-red${options.dryRun ? " (dry run)" : ""}`,
    ...(actions.length === 0 ? ["Nothing to file."] : actions.map((a) => `- ${describeAction(a)}`)),
  ]);

  return 0;
};

/** Proves the real Linear path end to end on a throwaway job: red files, red again comments, green recovers. */
const probe = async (options: Options, job: string, fetch: Fetch): Promise<number> => {
  for (const conclusion of ["failure", "failure", "success"]) {
    const checks = [{ name: job, conclusion, url: "", failingTests: [`${job} > probe`] }];
    const code = await ciRed({ ...options, checks }, process.env, fetch);

    if (code !== 0) return code;
  }

  return 0;
};

const main = async (argv: ReadonlyArray<string>): Promise<number> => {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      workflow: { type: "string" },
      ignore: { type: "string", multiple: true },
      "dry-run": { type: "boolean" },
      fake: { type: "string" },
      probe: { type: "string" },
    },
  });

  const workflow = values.workflow ?? process.env.GITHUB_WORKFLOW;

  if (!workflow) {
    console.error(
      "usage: bun tooling/ci/ciRed.ts --workflow <name> [--ignore <job>]… [--dry-run] [--fake <file>] [--probe <job>]"
    );

    return 2;
  }

  const fetch = values.fake
    ? fakeFetch(decodeFixture(readFileSync(values.fake, "utf8"))).fetch
    : globalThis.fetch;

  const options = {
    workflow,
    ignore: new Set(values.ignore ?? []),
    dryRun: values["dry-run"] ?? false,
  };

  return values.probe ? probe(options, values.probe, fetch) : ciRed(options, process.env, fetch);
};

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
