import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { PlanLimit } from "@polaris/protocol";
import { Schema } from "effect";
import {
  CodexLimitTracker,
  CodexRateLimitsRead,
  CodexRateLimitsUpdated,
  fromRolloutText,
  fromSnapshot,
} from "./codex.ts";
import { latestRolloutLimits } from "./rollout.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const fixtureText = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

const AT = "2026-09-29T05:08:20.000Z";

const read = Schema.decodeUnknownSync(CodexRateLimitsRead);

const updated = Schema.decodeUnknownSync(CodexRateLimitsUpdated);

const summary = (
  limits: ReadonlyArray<{
    kind: string;
    scope: string | null;
    usedPercent: number | null;
    status: string;
  }>
) => limits.map((l) => [l.kind, l.scope, l.usedPercent, l.status]);

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDir(dir);
});

describe("account/rateLimits", () => {
  test("reads a real reply (codex-cli 0.158.0, Pro Lite: a weekly window only)", () => {
    const limits = new CodexLimitTracker().onRead(
      read(JSON.parse(fixtureText("codex-rate-limits-read.json"))),
      AT
    );

    expect(limits).toEqual([
      new PlanLimit({
        harness: "codex",
        kind: "weekly",
        scope: null,
        windowMinutes: 10080,
        usedPercent: 7,
        status: "ok",
        resetsAt: "2026-10-04T07:16:26.000Z",
        observedAt: AT,
        plan: "prolite",
      }),
    ]);
  });

  test("paid plans: primary is five hours, secondary weekly, even when the duration is missing", () => {
    const limits = fromSnapshot(
      {
        planType: "pro",
        primary: { usedPercent: 100, resetsAt: 1790671800 },
        secondary: { usedPercent: 41.5, windowDurationMins: 10080 },
      },
      AT
    );

    expect(summary(limits)).toEqual([
      ["five-hour", null, 100, "reached"],
      ["weekly", null, 41.5, "ok"],
    ]);
  });

  test("free and go plans have one monthly allowance", () => {
    expect(summary(fromSnapshot({ planType: "free", primary: { usedPercent: 3 } }, AT))).toEqual([
      ["monthly", null, 3, "ok"],
    ]);
  });

  test("a Model's own quota is a scoped limit", () => {
    const limits = new CodexLimitTracker().onRead(
      read({
        rateLimits: { limitId: "codex", primary: { usedPercent: 1, windowDurationMins: 300 } },
        rateLimitsByLimitId: {
          codex: { limitId: "codex", primary: { usedPercent: 1, windowDurationMins: 300 } },
          spark: {
            limitId: "spark",
            limitName: "GPT-5.3 Spark",
            primary: { usedPercent: 12, windowDurationMins: 300 },
          },
        },
      }),
      AT
    );

    expect(summary(limits)).toEqual([
      ["five-hour", null, 1, "ok"],
      ["five-hour", "GPT-5.3 Spark", 12, "ok"],
    ]);
  });

  test("a sparse update keeps what it leaves out", () => {
    const tracker = new CodexLimitTracker();
    tracker.onRead(
      read({
        rateLimits: {
          limitId: "codex",
          planType: "plus",
          primary: { usedPercent: 10, windowDurationMins: 300 },
          secondary: { usedPercent: 20, windowDurationMins: 10080 },
        },
      }),
      AT
    );

    const limits = tracker.onUpdated(
      updated({
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 11, windowDurationMins: 300 },
          secondary: null,
        },
      }),
      AT
    );

    expect(limits.map((l) => [l.kind, l.usedPercent, l.plan])).toEqual([
      ["five-hour", 11, "plus"],
      ["weekly", 20, "plus"],
    ]);
  });
});

describe("rollout logs", () => {
  test("the last token_count wins, and its timestamp is the observation time", () => {
    const limits = fromRolloutText(fixtureText("codex-rollout.jsonl"));

    expect(limits.map((l) => [l.kind, l.usedPercent, l.plan, l.observedAt])).toEqual([
      ["weekly", 7, "prolite", "2026-09-29T05:08:15.058Z"],
    ]);
  });

  test("nothing in a log without rate limits", () => {
    expect(fromRolloutText('{"type":"event_msg","payload":{"type":"task_started"}}\n')).toEqual([]);
  });

  test("reads the most recently written rollout under CODEX_HOME", async () => {
    const home = newTempDir("polaris-codex-home-");
    dirs.push(home);
    const older = join(home, "sessions/2026/09/29");
    const newer = join(home, "sessions/2026/09/28");
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });

    const line = (percent: number, timestamp: string) =>
      `${JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: percent, window_minutes: 300 } } } })}\n`;

    writeFileSync(join(older, "rollout-a.jsonl"), line(10, "2026-09-29T01:00:00Z"));
    // A session started a day earlier but still running is the newest write.
    writeFileSync(join(newer, "rollout-b.jsonl"), line(55, "2026-09-29T02:00:00Z"));
    utimesSync(join(older, "rollout-a.jsonl"), 1000, 1000);

    const limits = await Effect.runPromise(latestRolloutLimits(home));
    expect(limits.map((l) => [l.kind, l.usedPercent])).toEqual([["five-hour", 55]]);
  });

  test("passes over newer rollouts without a reading (a session that ended before any response)", async () => {
    const home = newTempDir("polaris-codex-home-");
    dirs.push(home);
    const day = join(home, "sessions/2026/09/30");
    mkdirSync(day, { recursive: true });

    const reading = JSON.stringify({
      timestamp: "2026-09-30T20:06:17.011Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 15, window_minutes: 10080, resets_at: 1791098186 },
          plan_type: "prolite",
        },
      },
    });

    writeFileSync(join(day, "rollout-with-reading.jsonl"), `${reading}\n`);
    writeFileSync(
      join(day, "rollout-empty.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "empty" } })}\n`
    );
    utimesSync(join(day, "rollout-with-reading.jsonl"), 1000, 1000);

    const limits = await Effect.runPromise(latestRolloutLimits(home));
    expect(limits.map((l) => [l.kind, l.usedPercent, l.plan])).toEqual([["weekly", 15, "prolite"]]);
  });

  test("nothing when Codex never ran", async () => {
    expect(await Effect.runPromise(latestRolloutLimits("/nonexistent/codex-home"))).toEqual([]);
  });
});
