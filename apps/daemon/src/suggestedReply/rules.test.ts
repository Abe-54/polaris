import { describe, expect, test } from "bun:test";
import {
  type HarnessKind,
  PlanLimit,
  SuggestedReplyFallback,
  SuggestedReplySettings,
} from "@polaris/protocol";
import { atPlanLimit, fallbackCandidates, suggestionDue } from "./rules.ts";
import { agentSession, at, record, report, turn } from "./testing.ts";

describe("suggestionDue", () => {
  test.each([
    ["the first Turn", [turn(0)]],
    ["a second Turn", [turn(0), turn(1)]],
    ["a background report", [turn(0), turn(1, "completed", "", { userTurnNumber: 1 })]],
  ])("a session is due one after %s", (_, turns) => {
    expect(suggestionDue(record(agentSession(), turns))?.id).toBe(turns.at(-1)?.id);
  });

  test.each([
    ["a failed Turn", record(agentSession(), [turn(0), turn(1, "failed")])],
    ["an interrupted Turn", record(agentSession(), [turn(0), turn(1, "interrupted")])],
    ["a Turn still working", record(agentSession(), [turn(0), turn(1, "working")])],
    ["plan mode", record(agentSession({ permissionMode: "plan" }), [turn(0), turn(1)])],
    ["a Limited session", record(agentSession({ state: "limited" }), [turn(0), turn(1)])],
    ["a Reviewer's session", record(agentSession({ origin: "reviewer" }), [turn(0), turn(1)])],
    [
      "an idle compaction",
      record(agentSession(), [turn(0), turn(1, "completed", "/compact", { idleCompaction: true })]),
    ],
    [
      "the user's shell command",
      record(agentSession(), [turn(0), turn(1, "completed", "! ls", { shellCommand: "ls" })]),
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

test("at a Plan Limit means a window of that Harness has reached it, not only warned", () => {
  expect(atPlanLimit("codex", [limit("codex", "reached")])).toBe(true);
  expect(atPlanLimit("codex", [limit("codex", "warning")])).toBe(false);
  expect(atPlanLimit("codex", [limit("codex", "ok"), limit("claude", "reached")])).toBe(false);
});

describe("fallbackCandidates", () => {
  const haiku = SuggestedReplyFallback.make({ harness: "claude", model: "m", effort: null });

  const settings = (fallback: SuggestedReplyFallback | null) =>
    SuggestedReplySettings.make({ enabled: true, fallback });

  const harnesses = (s: SuggestedReplySettings, ...ready: ReadonlyArray<HarnessKind>) =>
    fallbackCandidates(s, report(...ready)).map((c) => c.harness);

  test("the Settings choice first, then the ready automatic picks", () => {
    expect(fallbackCandidates(settings(haiku), report("claude", "codex"))[0]).toEqual({
      harness: "claude",
      model: "m",
      effort: null,
    });
    expect(harnesses(settings(haiku), "claude", "codex")).toEqual(["claude", "codex", "claude"]);
  });

  test("a Settings choice whose Harness isn't ready gives way to one that is", () => {
    expect(harnesses(settings(haiku), "codex")).toEqual(["codex"]);
  });

  test("unset tries every ready automatic pick, and none is nothing", () => {
    expect(harnesses(settings(null), "claude", "codex")).toEqual(["codex", "claude"]);
    expect(harnesses(settings(null), "claude")).toEqual(["claude"]);
    expect(harnesses(settings(null), "opencode")).toEqual([]);
  });

  test("a Harness without an inline runner is never chosen", () => {
    const opencode = SuggestedReplyFallback.make({
      harness: "opencode",
      model: null,
      effort: null,
    });

    expect(harnesses(settings(opencode), "opencode")).toEqual([]);
  });
});

test("a Claude Code session gets the fallback while Claude Code sends none of its own", () => {
  const due = suggestionDue(record(agentSession({ harness: "claude" }), [turn(0), turn(1)]));

  expect(due?.index).toBe(1);
});
