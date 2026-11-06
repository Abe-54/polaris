import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciRed } from "./ciRed.ts";
import { decodeFixture, type Fixture, fakeFetch } from "./fake.ts";
import { Annotations, checksOf, JobsPage } from "./github.ts";
import { macosReasons } from "./macosScope.ts";
import { macosResult } from "./macosResult.ts";
import { rerun } from "./rerun.ts";
import { SCOPES } from "./linear.ts";
import {
  type Check,
  decideRerun,
  failingTestsIn,
  macosResultOf,
  NO_RUNNER,
  type OpenIssue,
  plan,
  type Run,
} from "./plan.ts";

const decodeWrite = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      variables: Schema.Struct({
        input: Schema.Struct({ issueId: Schema.optional(Schema.String) }),
      }),
    })
  )
);

const run: Run = {
  workflow: "CI",
  url: "https://gh/run/7",
  sha: "0123456789abc",
  ref: "main",
  attempt: 1,
};

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

  test("files an issue for a job cancelled inside a run that wasn't", () => {
    const [action] = plan(run, [check("Test Daemon 1/3 (macos-15)", "cancelled")], []);

    expect(action?.kind === "create" && action.body).toContain("cancelled on");
  });

  test.each(["skipped", "success"])(
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

test("reads failing tests from a job log, through prefixes and timings, ignoring quoted ones", () => {
  const log = [
    "2026-11-02T03:00:00.1Z @polaris/client:test: (pass) ok",
    "2026-11-02T03:00:00.2Z @polaris/client:test: (fail) resume > replays [3.10ms]",
    "2026-11-02T03:00:00.3Z (fail) resume > replays [1.00s]",
    "2026-11-02T03:00:00.4Z bun test stalled: no output for 300s, in a.test.ts",
    "2026-11-02T03:00:00.5Z - `bun test stalled: no output for 300s, in quoted.test.ts`",
    "2026-11-02T03:00:00.6Z Failing tests: - `(fail) quoted`",
  ].join("\n");

  expect(failingTestsIn(log)).toEqual([
    "resume > replays",
    "bun test stalled: no output for 300s, in a.test.ts",
  ]);
});

describe("plan for jobs no runner acquired", () => {
  const noRunner = check("Test Daemon 1/3 (macos-15)", NO_RUNNER);
  const lastAttempt = { ...run, attempt: 2 };

  test("files nothing while a re-run is coming, and never says it recovered", () => {
    const open = [issue("Test Daemon 1/3 (macos-15)"), issue("no runner")];

    expect(plan(run, [noRunner], open)).toEqual([]);
  });

  test("once the re-run is spent, files one issue that blames no test", () => {
    const other = check("Test other packages (macos-15)", NO_RUNNER);
    const actions = plan(lastAttempt, [noRunner, other], []);

    expect(actions.map((a) => a.kind === "create" && a.title)).toEqual(["CI red: CI / no runner"]);
    expect(actions[0]?.body).toContain("no test failed and none passed");
    expect(actions[0]?.body).not.toContain("Failing tests");
    expect(actions[0]?.body).toContain("Test other packages (macos-15)");
  });

  test("a real failure beside one keeps its own issue and names why nothing re-ran", () => {
    const red = check("Test Daemon 1/3 (windows-latest)", "failure", ["a > b"]);
    const actions = plan(run, [noRunner, red], []);

    expect(actions.map((a) => a.kind === "create" && a.title)).toEqual([
      "CI red: CI / Test Daemon 1/3 (windows-latest)",
      "CI red: CI / no runner",
    ]);
    expect(actions[0]?.body).toContain("- `a > b`");
    expect(actions[1]?.body).toContain("would also retry: `Test Daemon 1/3 (windows-latest)`");
  });

  test("says the no-runner issue recovered once every job got a runner", () => {
    const passed = check("Test Daemon 1/3 (macos-15)", "success");
    const [recovered] = plan(run, [passed], [issue("no runner")]);

    expect(recovered?.kind).toBe("recovered");
    expect(plan(run, [passed], [issue("no runner", recovered?.body)])).toEqual([]);
  });
});

describe("macosResultOf and decideRerun", () => {
  const macos = (conclusion: string, name = "Test Daemon 1/3 (macos-15)") =>
    check(name, conclusion);

  test.each([
    ["every job passed", [macos("success")], "passed"],
    [
      "one has no runner",
      [macos("success", "Platform checks (macos-15)"), macos(NO_RUNNER)],
      "no-result",
    ],
    [
      "one failed beside one with no runner",
      [macos("failure", "Platform checks (macos-15)"), macos(NO_RUNNER)],
      "red",
    ],
    ["one was cancelled after a runner took it", [macos("cancelled")], "red"],
    ["one timed out", [macos("timed_out")], "red"],
    ["none ran at all", [macos("skipped")], "no-result"],
    ["a job off macOS failed", [macos("success"), check("Lint", "failure")], "passed"],
  ] as const)("when %s", (_, checks, result) => {
    expect(macosResultOf(checks)).toBe(result);
  });

  test.each([
    ["nothing lacks a result", [macos("success")], 1, "none"],
    ["only no-runner jobs are left", [macos(NO_RUNNER), macos("success", "b")], 1, "rerun"],
    ["its re-run is spent", [macos(NO_RUNNER)], 2, "exhausted"],
    ["another job failed", [macos(NO_RUNNER), check("Lint", "failure")], 1, "blocked"],
    ["another job was cancelled", [macos(NO_RUNNER), check("Lint", "cancelled")], 1, "blocked"],
    ["another job timed out", [macos(NO_RUNNER), check("Lint", "timed_out")], 1, "blocked"],
  ] as const)("re-run decision when %s", (_, checks, attempt, kind) => {
    expect(decideRerun(checks, attempt).kind).toBe(kind);
  });
});

describe("real runs", () => {
  const annotated = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Record(
        Schema.String,
        Schema.Struct({
          run: Schema.Number,
          jobs: JobsPage,
          annotations: Schema.Record(Schema.String, Annotations),
        })
      )
    )
  )(readFileSync(join(import.meta.dir, "fixtures/real-runs.json"), "utf8"));

  const real = (name: string): Fixture => {
    const found = annotated[name];

    if (!found) throw new Error(`no fixture ${name}`);

    return {
      jobs: found.jobs,
      logs: {},
      annotations: found.annotations,
      linear: {
        teams: { nodes: [] },
        projects: { nodes: [] },
        issueLabels: { nodes: [] },
        issues: { nodes: [] },
      },
    };
  };

  const gitHub = { repository: "o/r", runId: "9", attempt: "1", token: "t", api: "https://gh" };

  const checksFrom = (fixture: Fixture) => checksOf(gitHub, new Set(), fakeFetch(fixture).fetch);

  const named = (checks: ReadonlyArray<Check>, conclusion: string) =>
    checks.flatMap((c) => (c.conclusion === conclusion ? [c.name] : [])).toSorted();

  test("42265095095: GitHub's cancel with no steps is no result, and a re-run is due", async () => {
    const checks = await checksFrom(real("pr-no-runner-only"));

    expect(named(checks, NO_RUNNER)).toEqual(["Test Daemon 1/3 (macos-15)"]);
    expect(named(checks, "cancelled")).toEqual([]);
    expect(macosResultOf(checks)).toBe("no-result");
    expect(decideRerun(checks, 1).kind).toBe("rerun");
  });

  test("41862561967: six with no runner don't hide the Windows failure, and block the re-run", async () => {
    const checks = await checksFrom(real("main-no-runner-and-windows-red"));
    const decision = decideRerun(checks, 1);

    expect(named(checks, NO_RUNNER)).toHaveLength(6);
    expect(named(checks, "failure")).toContain("Test Daemon 1/3 (windows-latest)");
    expect(macosResultOf(checks)).toBe("no-result");
    expect(decision.kind === "blocked" && decision.by).toContain(
      "Test Daemon 1/3 (windows-latest)"
    );
  });

  test("42259595632: capacity alone turned main red; now it's no result and a re-run", async () => {
    const checks = (await checksFrom(real("main-capacity-alone"))).filter(
      (check) => check.name !== "CI (macOS)"
    );

    expect(named(checks, NO_RUNNER)).toEqual(["Test Daemon 2/3 (macos-15)"]);
    expect(macosResultOf(checks)).toBe("no-result");
    expect(decideRerun(checks, 1).kind).toBe("rerun");
    expect(plan(run, checks, [])).toEqual([]);
  });

  test("40980865529: a job timeout cancelled with no steps stays red", async () => {
    const checks = await checksFrom(real("main-job-timeout-no-steps"));

    expect(named(checks, NO_RUNNER)).toEqual([]);
    expect(named(checks, "cancelled")).toContain("Test other packages (macos-15)");
    expect(macosResultOf(checks)).toBe("red");
  });

  test("41370043095: a job cancelled after running steps stays red", async () => {
    const checks = await checksFrom(real("main-cancelled-with-steps"));

    expect(named(checks, "cancelled")).toEqual(["Lint, typecheck, licences (macos-15)"]);
    expect(macosResultOf(checks)).toBe("red");
  });

  test("a job that ran steps can't print its way out of red with GitHub's words", async () => {
    const fixture = real("main-cancelled-with-steps");
    const id = fixture.jobs.jobs.find((job) => job.conclusion === "cancelled")?.id ?? 0;
    const said = { annotation_level: "failure", message: "The job was not acquired by Runner" };
    const checks = await checksFrom({ ...fixture, annotations: { [id]: [said] } });

    expect(named(checks, NO_RUNNER)).toEqual([]);
  });

  test("when GitHub won't give the annotations, it stays red", async () => {
    const fake = fakeFetch(real("pr-no-runner-only"));

    const denied = (input: string, init?: RequestInit) =>
      input.includes("/annotations")
        ? Promise.resolve(new Response("no", { status: 403 }))
        : fake.fetch(input, init);

    const checks = await checksOf(gitHub, new Set(), denied);

    expect(named(checks, NO_RUNNER)).toEqual([]);
    expect(named(checks, "cancelled")).toEqual(["Test Daemon 1/3 (macos-15)"]);
    expect(macosResultOf(checks)).toBe("red");
  });

  describe("rerun", () => {
    const options = { runId: "9", attempt: 1, ignore: new Set<string>(), dryRun: false };
    const env = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t" };

    const posted = (fake: ReturnType<typeof fakeFetch>) =>
      fake.requests.filter((r) => r.url.endsWith("/rerun-failed-jobs")).map((r) => r.url);

    test("re-runs a run left only without a result, reading that run's attempt", async () => {
      const fake = fakeFetch(real("nightly-no-runner-only"));

      expect((await rerun(options, env, fake.fetch)).kind).toBe("rerun");
      expect(posted(fake)).toEqual([
        "https://api.github.com/repos/o/r/actions/runs/9/rerun-failed-jobs",
      ]);
      expect(fake.requests[0]?.url).toContain("/runs/9/attempts/1/jobs");
    });

    test.each([
      ["a real failure is there", "main-no-runner-and-windows-red", options],
      ["its re-run is spent", "nightly-no-runner-only", { ...options, attempt: 2 }],
      ["it's a dry run", "nightly-no-runner-only", { ...options, dryRun: true }],
      ["a job timeout is the only cancel", "main-job-timeout-no-steps", options],
    ] as const)("doesn't re-run when %s", async (_, fixture, given) => {
      const fake = fakeFetch(real(fixture));

      await rerun(given, env, fake.fetch);

      expect(posted(fake)).toEqual([]);
    });
  });

  test("macosResult writes the result GitHub's `if` reads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "macos-result-"));
    const output = join(dir, "output");

    await macosResult(
      { GITHUB_REPOSITORY: "o/r", GITHUB_OUTPUT: output },
      fakeFetch(real("pr-no-runner-only")).fetch
    );

    expect(readFileSync(output, "utf8")).toBe("result=no-result\n");
  });
});

describe("macosReasons", () => {
  const mentions = new Set([
    "apps/daemon/src/service.ts",
    "apps/daemon/src/service.test.ts",
    "docs/adr/0097.md",
    "apps/desktop/fixtures/mac.json",
  ]);

  test.each([
    [
      "docs and a test file that mentions darwin",
      ["docs/adr/0097.md", "apps/daemon/src/service.test.ts"],
      [],
    ],
    ["source that never mentions macOS", ["apps/desktop/src/app.ts"], []],
    [
      "tooling off the macOS jobs' path",
      ["tooling/ci/plan.ts", ".github/workflows/nightly.yml"],
      [],
    ],
    [
      "source that branches on the platform",
      ["apps/daemon/src/service.ts"],
      ["apps/daemon/src/service.ts"],
    ],
    [
      "the workflow that defines the jobs",
      [".github/workflows/ci.yml"],
      [".github/workflows/ci.yml"],
    ],
    ["the lockfile", ["bun.lock"], ["bun.lock"]],
    ["the test runner", ["tooling/test/watchdog.ts"], ["tooling/test/watchdog.ts"]],
  ] as const)("%s", (_, changed, reasons) => {
    expect(macosReasons(changed, mentions)).toEqual(reasons);
  });
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
