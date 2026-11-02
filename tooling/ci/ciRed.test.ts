import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ciRed } from "./ciRed.ts";
import { decodeFixture, type Fixture, fakeFetch } from "./fake.ts";
import { SCOPES } from "./linear.ts";
import { type Check, failingTestsIn, type OpenIssue, plan, type Run } from "./plan.ts";

const decodeWrite = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      variables: Schema.Struct({
        input: Schema.Struct({ issueId: Schema.optional(Schema.String) }),
      }),
    })
  )
);

const run: Run = { workflow: "CI", url: "https://gh/run/7", sha: "0123456789abc", ref: "main" };

const check = (name: string, conclusion: string, failingTests: Array<string> = []): Check => ({
  name,
  conclusion,
  url: `https://gh/job/${name}`,
  failingTests,
});

const issue = (job: string, lastComment?: string): OpenIssue => ({
  id: `id-${job}`,
  identifier: "ENG-1",
  title: `CI red: CI / ${job}`,
  url: "https://linear/ENG-1",
  lastComment,
});

describe("plan", () => {
  test("files a new issue for a red check, with the run and its failing tests", () => {
    const [action] = plan(run, [check("Lint", "failure", ["a > b"])], []);

    expect(action?.kind).toBe("create");
    expect(action?.kind === "create" && action.title).toBe("CI red: CI / Lint");
    expect(action?.body).toContain("https://gh/run/7");
    expect(action?.body).toContain("- `a > b`");
  });

  test("comments on the open issue instead of filing a second", () => {
    const [action] = plan(run, [check("Lint", "timed_out")], [issue("Lint")]);

    expect(action?.kind).toBe("red");
    expect(action && action.kind !== "create" && action.issue.id).toBe("id-Lint");
  });

  test("says a check recovered once, not on every green run", () => {
    const first = plan(run, [check("Lint", "success")], [issue("Lint", "Red again: …")]);
    const [recovered] = first;
    const again = plan(run, [check("Lint", "success")], [issue("Lint", recovered?.body)]);

    expect(first.map((action) => action.kind)).toEqual(["recovered"]);
    expect(again).toEqual([]);
  });

  test.each(["skipped", "cancelled", "success"])(
    "leaves a %s check without an open issue alone",
    (conclusion) => {
      expect(plan(run, [check("Lint", conclusion)], [issue("Other")])).toEqual([]);
    }
  );

  test("matches issues by workflow as well as job", () => {
    const nightly = { ...issue("Lint"), title: "CI red: Nightly / Lint" };

    expect(plan(run, [check("Lint", "failure")], [nightly]).map((a) => a.kind)).toEqual(["create"]);
  });
});

test("reads failing tests from a job log, through timestamps, turbo prefixes and timings", () => {
  const log = [
    "2026-11-02T03:00:00.1Z @polaris/client:test: (pass) ok",
    "2026-11-02T03:00:00.2Z @polaris/client:test: (fail) resume > replays [3.10ms]",
    "2026-11-02T03:00:00.3Z (fail) resume > replays [1.00s]",
    "2026-11-02T03:00:00.4Z bun test stalled: no output for 300s, in a.test.ts",
  ].join("\n");

  expect(failingTestsIn(log)).toEqual([
    "resume > replays",
    "bun test stalled: no output for 300s, in a.test.ts",
  ]);
});

describe("ciRed against a fake GitHub and Linear", () => {
  const fixture: Fixture = decodeFixture(
    readFileSync(join(import.meta.dir, "fixtures/nightly.json"), "utf8")
  );

  const env = {
    GITHUB_REPOSITORY: "o/r",
    GITHUB_RUN_ID: "9",
    GITHUB_SHA: "abcdef1234567",
    GITHUB_REF_NAME: "main",
    LINEAR_CLIENT_ID: "client",
    LINEAR_CLIENT_SECRET: "secret",
  };

  const options = { workflow: "Nightly", ignore: new Set<string>(), dryRun: false };

  test("asks for a client-credentials token with the fixed scopes, then writes", async () => {
    const fake = fakeFetch(fixture);

    expect(await ciRed(options, env, fake.fetch)).toBe(0);
    const token = fake.requests.find((r) => r.url.includes("/oauth/token"));
    const writes = fake.requests.filter((r) => r.body.includes("mutation"));

    expect(token?.headers.authorization).toBe(`Basic ${btoa("client:secret")}`);
    expect(new URLSearchParams(token?.body).get("grant_type")).toBe("client_credentials");
    expect(new URLSearchParams(token?.body).get("scope")).toBe(SCOPES);
    expect(writes.map((w) => decodeWrite(w.body).variables.input.issueId ?? "new")).toEqual([
      "new",
      "issue-macos",
      "issue-apalache",
    ]);
    expect(writes[0]?.body).toContain("store > replays after a crash");
    expect(writes[0]?.body).toContain("project-polaris");
  });

  test("a dry run reads but writes nothing", async () => {
    const fake = fakeFetch(fixture);

    await ciRed({ ...options, dryRun: true }, env, fake.fetch);

    expect(fake.requests.some((r) => r.body.includes("mutation"))).toBe(false);
  });

  test("without the app's secrets it warns, passes and never calls Linear", async () => {
    const fake = fakeFetch(fixture);
    const { LINEAR_CLIENT_SECRET: _, ...missing } = env;

    expect(await ciRed(options, missing, fake.fetch)).toBe(0);
    expect(fake.requests.some((r) => r.url.includes("linear"))).toBe(false);
  });
});
