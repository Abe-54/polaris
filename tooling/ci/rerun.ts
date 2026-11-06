#!/usr/bin/env bun
/**
 * After a run on main, re-runs the jobs no runner acquired, once: only when nothing else in that
 * attempt went red, since GitHub's re-run would retry those too.
 *
 *   bun tooling/ci/rerun.ts --run <id> --attempt <n> [--ignore <job>]… [--dry-run]
 *
 * Needs `actions: write`; GITHUB_REPOSITORY and GITHUB_TOKEN come from the env.
 */
import { parseArgs } from "node:util";
import { checksOf, type Fetch, gitHubRunOf, headers, ok } from "./github.ts";
import { decideRerun, type RerunDecision } from "./plan.ts";

export interface RerunOptions {
  readonly runId: string;
  readonly attempt: number;
  readonly ignore: ReadonlySet<string>;
  readonly dryRun: boolean;
}

const describe = (decision: RerunDecision): string => {
  if (decision.kind === "none") return "Every job has a result; nothing to re-run.";

  const jobs = decision.jobs.join(", ");

  if (decision.kind === "rerun") return `No runner acquired ${jobs}: re-running.`;

  return decision.kind === "exhausted"
    ? `No runner acquired ${jobs}, and its re-run is spent: no result.`
    : `No runner acquired ${jobs}, but no re-run, since it would retry: ${decision.by.join(", ")}.`;
};

/** The decision this run got; re-runs its failed jobs when it says to. */
export const rerun = async (
  options: RerunOptions,
  env: Readonly<Record<string, string | undefined>>,
  fetch: Fetch
): Promise<RerunDecision> => {
  const run = {
    ...gitHubRunOf(env),
    runId: options.runId,
    attempt: String(options.attempt),
  };

  const decision = decideRerun(await checksOf(run, options.ignore, fetch), options.attempt);

  console.log(describe(decision));

  if (decision.kind === "rerun" && !options.dryRun) {
    const url = `${run.api}/repos/${run.repository}/actions/runs/${run.runId}/rerun-failed-jobs`;

    await ok(await fetch(url, { method: "POST", headers: headers(run.token) }), "re-run");
  }

  return decision;
};

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      attempt: { type: "string" },
      ignore: { type: "string", multiple: true },
      "dry-run": { type: "boolean" },
    },
  });

  if (!values.run || !values.attempt) {
    console.error(
      "usage: bun tooling/ci/rerun.ts --run <id> --attempt <n> [--ignore <job>]… [--dry-run]"
    );
    process.exit(2);
  }

  await rerun(
    {
      runId: values.run,
      attempt: Number(values.attempt),
      ignore: new Set(values.ignore ?? []),
      dryRun: values["dry-run"] ?? false,
    },
    process.env,
    globalThis.fetch
  );
}
