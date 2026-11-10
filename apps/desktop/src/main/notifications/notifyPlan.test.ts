import { describe, expect, test } from "bun:test";
import type { NeedsYouNotification, NeedsYouSummary } from "../../shared/needsYou.ts";
import {
  agentKey,
  bannerOn,
  clickAction,
  emptyNotifyState,
  type NotifyState,
  planAgentNotifications,
} from "./notifyPlan.ts";

const note = (id: string, sessionId = "s1"): NeedsYouNotification => ({
  hostKey: "local",
  hostLabel: "This Mac",
  sessionId,
  sessionTitle: "Fix the flaky test",
  id,
  title: "Tests pass",
  body: "Ready for review",
});

const summary = (
  notifications: ReadonlyArray<NeedsYouNotification>,
  focused: NeedsYouSummary["focused"] = null
): NeedsYouSummary => ({ count: 0, sessions: [], focused, notifications });

const run = (summaries: ReadonlyArray<NeedsYouSummary>, windowFocused = false) => {
  let state: NotifyState = emptyNotifyState;

  return summaries.map((s) => {
    const plan = planAgentNotifications({ state, summary: s, windowFocused });

    state = plan.state;

    return plan.show.map((n) => n.notification.id);
  });
};

describe("planAgentNotifications", () => {
  test("shows each new notification once, with the agent's words and the session", () => {
    const { state } = planAgentNotifications({
      state: emptyNotifyState,
      summary: summary([]),
      windowFocused: false,
    });

    const plan = planAgentNotifications({
      state,
      summary: summary([note("n1")]),
      windowFocused: false,
    });

    expect(plan.show).toEqual([
      {
        key: agentKey("local", "s1"),
        notification: note("n1"),
        title: "Tests pass",
        subtitle: "Fix the flaky test · This Mac",
        body: "Ready for review",
      },
    ]);
    expect(
      run([summary([]), summary([note("n1")]), summary([note("n1")]), summary([note("n2")])])
    ).toEqual([[], ["n1"], [], ["n2"]]);
  });

  test("what the first summary holds is history, not news", () => {
    expect(run([summary([note("n1")]), summary([note("n1")])])).toEqual([[], []]);
  });

  test("not for the session the focused window shows; still for others", () => {
    const focused = { hostKey: "local", sessionId: "s1" };

    expect(
      run([summary([], focused), summary([note("n1"), note("n2", "s2")], focused)], true)
    ).toEqual([[], ["n2"]]);
    expect(run([summary([], focused), summary([note("n1")], focused)], false)).toEqual([
      [],
      ["n1"],
    ]);
  });

  test("a notification held for the focused session is recorded as held, once", () => {
    const focused = { hostKey: "local", sessionId: "s1" };

    const first = planAgentNotifications({
      state: emptyNotifyState,
      summary: summary([], focused),
      windowFocused: true,
    });

    const next = summary([note("n1"), note("n2", "s2")], focused);

    const plan = planAgentNotifications({ state: first.state, summary: next, windowFocused: true });

    expect(plan.held.map((n) => n.id)).toEqual(["n1"]);
    expect(
      planAgentNotifications({ state: plan.state, summary: next, windowFocused: true }).held
    ).toEqual([]);
  });
});

describe("bannerOn", () => {
  test.each([
    [false, false, true],
    [false, true, true],
    [true, true, true],
    [true, false, false],
  ])("automatic %p with the constellation setting %p shows: %p", (automatic, on, shown) => {
    expect(bannerOn({ ...note("n1"), automatic }, on)).toBe(shown);
  });
});

describe("clickAction", () => {
  test("a notification about a Constellation opens its view; any other opens the session", () => {
    expect(clickAction({ ...note("n1"), automatic: true, constellationId: "graph" })).toEqual({
      action: "open-constellation",
      hostKey: "local",
      sessionId: "s1",
    });
    expect(clickAction({ ...note("n2"), constellationId: null })).toEqual({
      action: "open",
      hostKey: "local",
      sessionId: "s1",
    });
  });
});
