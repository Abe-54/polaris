import { describe, expect, test } from "bun:test";
import { PlanLimit, SuggestedReplyFallback, SuggestedReplySettings } from "@polaris/protocol";
import { nearPlanLimit, resolveFallback, suggestionDue } from "./rules.ts";
import { agentSession, at, record, report, turn } from "./testing.ts";

describe("suggestionDue", () => {
  test("a completed second Turn in a Codex session is due one", () => {
    expect(suggestionDue(record(agentSession(), [turn(0), turn(1)]))?.id).toBe(turn(1).id);
  });

  test.each([
    ["the first Turn", record(agentSession(), [turn(0)])],
    ["a failed Turn", record(agentSession(), [turn(0), turn(1, "failed")])],
    ["an interrupted Turn", record(agentSession(), [turn(0), turn(1, "interrupted")])],
    ["a Turn still working", record(agentSession(), [turn(0), turn(1, "working")])],
    ["plan mode", record(agentSession({ permissionMode: "plan" }), [turn(0), turn(1)])],
    ["a Limited session", record(agentSession({ state: "limited" }), [turn(0), turn(1)])],
    [
      "a Harness with its own suggestions",
      record(agentSession({ harness: "claude" }), [turn(0), turn(1)]),
    ],
    ["a Reviewer's session", record(agentSession({ origin: "reviewer" }), [turn(0), turn(1)])],
    [
      "an idle compaction",
      record(agentSession(), [turn(0), turn(1, "completed", "/compact", { idleCompaction: true })]),
    ],
    [
      "the user's shell command",
      record(agentSession(), [turn(0), turn(1, "completed", "! ls", { shellCommand: "ls" })]),
    ],
    [
      "a background report after the first Turn",
      record(agentSession(), [turn(0), turn(1, "completed", "", { userTurnNumber: 1 })]),
    ],
  ])("none after %s", (_, given) => {
    expect(suggestionDue(given)).toBeNull();
  });
});

const limit = (harness: "claude" | "codex", status: "ok" | "warning" | "reached") =>
  new PlanLimit({
    harness,
    kind: "five-hour",
    scope: null,
    windowMinutes: 300,
    usedPercent: null,
    status,
    resetsAt: null,
    observedAt: at,
    plan: null,
  });

test("near a Plan Limit means a window of that Harness isn't ok", () => {
  expect(nearPlanLimit("codex", [limit("codex", "warning")])).toBe(true);
  expect(nearPlanLimit("codex", [limit("codex", "reached")])).toBe(true);
  expect(nearPlanLimit("codex", [limit("codex", "ok"), limit("claude", "reached")])).toBe(false);
});

describe("resolveFallback", () => {
  const haiku = SuggestedReplyFallback.make({ harness: "claude", model: "m", effort: null });

  const settings = (fallback: SuggestedReplyFallback | null) =>
    SuggestedReplySettings.make({ enabled: true, fallback });

  test("the Settings choice when its Harness is ready, and nothing when it isn't", () => {
    expect(resolveFallback(settings(haiku), report("claude")).choice).toEqual(haiku);
    expect(resolveFallback(settings(haiku), report("codex")).choice).toBeNull();
  });

  test("unset picks a ready automatic fallback, or nothing", () => {
    expect(resolveFallback(settings(null), report("codex")).choice?.harness).toBe("codex");
    expect(resolveFallback(settings(null), report("claude")).choice?.harness).toBe("claude");
    expect(resolveFallback(settings(null), report("opencode")).choice).toBeNull();
  });

  test("a Harness without an inline runner is never chosen", () => {
    const opencode = SuggestedReplyFallback.make({
      harness: "opencode",
      model: null,
      effort: null,
    });

    expect(resolveFallback(settings(opencode), report("opencode")).choice).toBeNull();
  });
});
