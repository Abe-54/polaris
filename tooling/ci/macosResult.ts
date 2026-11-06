#!/usr/bin/env bun
/**
 * What the run's macOS jobs add up to, for `CI (macOS)`: `passed`, `red` or `no-result`, written to
 * GITHUB_OUTPUT as `result`. `no-result` means no runner acquired one of them and none failed.
 *
 *   bun tooling/ci/macosResult.ts [--fake <fixture.json>]
 */
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { decodeFixture, fakeFetch } from "./fake.ts";
import { checksOf, type Fetch, gitHubRunOf } from "./github.ts";
import { type MacosResult, macosResultOf, NO_RUNNER } from "./plan.ts";

const SAID: Readonly<Record<MacosResult, string>> = {
  passed: "Every macOS job passed.",
  red: "A macOS job failed, timed out or was cancelled after a runner took it.",
  "no-result":
    "No result: no runner acquired a macOS job and none failed, so `CI (macOS)` is skipped. This is not a pass.",
};

type Env = Readonly<Record<string, string | undefined>>;

export const macosResult = async (env: Env, fetch: Fetch): Promise<MacosResult> => {
  const checks = await checksOf(gitHubRunOf(env), new Set(), fetch);
  const result = macosResultOf(checks);

  const lines = [
    `### macOS result: ${result}`,
    SAID[result],
    ...checks
      .filter((check) => check.conclusion === NO_RUNNER)
      .map((check) => `- ${check.name}: no runner acquired it`),
  ];

  console.log(lines.join("\n"));

  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);

  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `result=${result}\n`);

  return result;
};

if (import.meta.main) {
  const { values } = parseArgs({ options: { fake: { type: "string" } } });

  const fetch = values.fake
    ? fakeFetch(decodeFixture(readFileSync(values.fake, "utf8"))).fetch
    : globalThis.fetch;

  await macosResult(process.env, fetch);
}
