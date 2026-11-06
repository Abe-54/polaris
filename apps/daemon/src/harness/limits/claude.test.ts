import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PlanLimit } from "@polaris/protocol";
import { Schema } from "effect";
import {
  ClaudeRateLimitEvent,
  ClaudeUsageResponse,
  emptyClaudeLimitContext,
  fromRateLimitEvent,
  fromUsageResponse,
} from "./claude.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

const usage = Schema.decodeUnknownSync(ClaudeUsageResponse);

const event = Schema.decodeUnknownSync(ClaudeRateLimitEvent);

const AT = "2026-09-29T05:06:37.000Z";

const claude = (
  fields: Pick<PlanLimit, "kind" | "scope" | "windowMinutes" | "usedPercent" | "resetsAt">
) => new PlanLimit({ harness: "claude", status: "ok", observedAt: AT, plan: "max", ...fields });

const brief = (limits: ReadonlyArray<PlanLimit>) =>
  limits.map((l) => [l.kind, l.scope, l.usedPercent, l.status]);

describe("get_usage", () => {
  test("reads the server's rows from a real reply (Claude Code 2.1.284, Max)", () => {
    const context = emptyClaudeLimitContext();
    const reply = usage(JSON.parse(fixture("claude-get-usage.json")));
    const limits = fromUsageResponse(reply, AT, context);

    expect(limits).toEqual([
      claude({
        kind: "five-hour",
        scope: null,
        windowMinutes: 300,
        usedPercent: 16,
        resetsAt: "2026-09-29T08:50:00.000Z",
      }),
      claude({
        kind: "weekly",
        scope: null,
        windowMinutes: 10080,
        usedPercent: 4,
        resetsAt: "2026-10-06T03:00:00.000Z",
      }),
      claude({
        kind: "weekly",
        scope: "Fable",
        windowMinutes: 10080,
        usedPercent: 0,
        resetsAt: "2026-10-06T03:00:00.000Z",
      }),
    ]);
    expect(context).toEqual({ plan: "max", overageIncluded: "Fable" });
  });

  test("falls back to the named windows when the CLI sends no rows", () => {
    const reply = usage({
      subscription_type: "pro",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 100, resets_at: "2026-09-29T08:00:00Z" },
        seven_day: null,
        seven_day_opus: { utilization: 50, resets_at: null },
        model_scoped: [{ display_name: "Fable", utilization: null, resets_at: null }],
      },
    });

    const limits = fromUsageResponse(reply, AT, emptyClaudeLimitContext());

    expect(limits.map((l) => [l.kind, l.scope, l.usedPercent, l.status, l.plan])).toEqual([
      ["five-hour", null, 100, "reached", "pro"],
      ["weekly", "Opus", 50, "ok", "pro"],
    ]);
  });

  test("a row the server marks warning is a warning", () => {
    const reply = usage({
      rate_limits_available: true,
      rate_limits: {
        limits: [{ kind: "session", percent: 91, severity: "warning", resets_at: null }],
      },
    });

    expect(brief(fromUsageResponse(reply, AT, emptyClaudeLimitContext()))).toEqual([
      ["five-hour", null, 91, "warning"],
    ]);
  });

  test("no Plan Limits for an API key, Bedrock or Vertex", () => {
    const reply = usage({
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
    });

    expect(fromUsageResponse(reply, AT, emptyClaudeLimitContext())).toEqual([]);
  });
});

describe("rate_limit_event", () => {
  test("reads every window of a real event, converting fractions to percent", () => {
    const context = emptyClaudeLimitContext();
    context.plan = "max";

    const message = event(JSON.parse(fixture("claude-rate-limit-event.json")));

    expect(fromRateLimitEvent(message, AT, context)).toEqual([
      claude({
        kind: "five-hour",
        scope: null,
        windowMinutes: 300,
        usedPercent: 16,
        resetsAt: "2026-09-29T08:50:00.000Z",
      }),
      claude({
        kind: "weekly",
        scope: null,
        windowMinutes: 10080,
        usedPercent: 4,
        resetsAt: "2026-10-06T03:00:00.000Z",
      }),
    ]);
  });

  test("fractions become whole-looking percentages, not float noise", () => {
    const message = event({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "seven_day",
        unifiedWindows: { seven_day: { utilization: 0.07 }, five_hour: { utilization: 0.1234 } },
      },
    });

    expect(brief(fromRateLimitEvent(message, AT, emptyClaudeLimitContext()))).toEqual([
      ["weekly", null, 7, "ok"],
      ["five-hour", null, 12.34, "ok"],
    ]);
  });

  test("the named window carries the event's status", () => {
    const message = event({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "seven_day",
        utilization: 0.82,
        resetsAt: 1791255600,
      },
    });

    expect(brief(fromRateLimitEvent(message, AT, emptyClaudeLimitContext()))).toEqual([
      ["weekly", null, 82, "warning"],
    ]);
  });

  test("a refusal with no utilization is still `reached`", () => {
    const message = event({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
    });

    expect(brief(fromRateLimitEvent(message, AT, emptyClaudeLimitContext()))).toEqual([
      ["five-hour", null, null, "reached"],
    ]);
  });

  test("the overage-included window takes its Model's name from get_usage, else is dropped", () => {
    const message = event({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "seven_day_overage_included",
        utilization: 0.3,
      },
    });

    const context = emptyClaudeLimitContext();

    expect(fromRateLimitEvent(message, AT, context)).toEqual([]);

    context.overageIncluded = "Fable";

    expect(brief(fromRateLimitEvent(message, AT, context))).toEqual([
      ["weekly", "Fable", 30, "ok"],
    ]);
  });

  test("ignores spend (`overage`)", () => {
    const spend = event({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "overage" },
    });

    expect(fromRateLimitEvent(spend, AT, emptyClaudeLimitContext())).toEqual([]);
  });
});
