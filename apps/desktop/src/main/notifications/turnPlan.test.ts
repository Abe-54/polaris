import { describe, expect, test } from "bun:test";
import type {
  NeedsYouReview,
  NeedsYouSession,
  NeedsYouSummary,
  NeedsYouTurn,
} from "../../shared/needsYou.ts";
import {
  emptyTurnState,
  planTurnNotifications,
  SETTLE_MS,
  type TurnNotification,
  type TurnState,
  turnKey,
} from "./turnPlan.ts";

const START = "2026-10-19T09:00:00.000Z";

const REPLY = "The retry test now waits on a fake clock, so it passes every time.";

/** `minutes` after the user's prompt, on the Host's clock. */
const at = (minutes: number) => new Date(Date.parse(START) + minutes * 60_000).toISOString();

interface TurnPatch {
  readonly sessionId?: string;
  readonly minutes?: number;
  readonly tasks?: number;
  /** The user Turn's id; null for one not known (a snapshot from an older Daemon). */
  readonly userTurnId?: string | null;
  readonly reply?: string | null;
  readonly review?: NeedsYouReview;
  readonly reportsPending?: boolean;
}

const turn = (
  state: NeedsYouTurn["state"],
  {
    sessionId = "s1",
    minutes = 0,
    tasks = 0,
    userTurnId = "t1",
    reply = REPLY,
    review,
    reportsPending = false,
  }: TurnPatch = {}
): NeedsYouTurn => {
  const plain: NeedsYouTurn = {
    hostKey: "local",
    hostLabel: "This Mac",
    sessionId,
    title: "Fix the flaky test",
    harness: "Claude Code",
    state,
    reply,
    backgroundTasks: tasks,
    backgroundReportsPending: reportsPending,
    userTurn: userTurnId === null ? null : { id: userTurnId, startedAt: START },
    updatedAt: at(minutes),
  };

  return review === undefined ? plain : { ...plain, review };
};

const waiting = (sessionId = "s1"): NeedsYouSession => ({
  hostKey: "local",
  hostLabel: "This Mac",
  workspace: null,
  sessionId,
  title: "Fix the flaky test",
  harness: "Claude Code",
  requests: [],
});

const summary = (patch: Partial<NeedsYouSummary>): NeedsYouSummary => ({
  count: 0,
  sessions: [],
  focused: null,
  turns: [],
  ...patch,
});

const of = (...turns: ReadonlyArray<NeedsYouTurn>) => summary({ turns });

interface Run {
  readonly windowFocused?: boolean;
  readonly minMinutes?: number;
}

interface Step {
  readonly show: ReadonlyArray<TurnNotification>;
  readonly close: ReadonlyArray<string>;
}

/**
 * Feeds summaries at their times (ms, this Client's clock), planning again when a plan asks
 * (`recheckInMs`) before the next one arrives; what a recheck shows counts for its step.
 */
const timeline = (
  events: ReadonlyArray<readonly [number, NeedsYouSummary]>,
  { windowFocused = false, minMinutes }: Run = {}
): Array<Step> => {
  let state: TurnState = emptyTurnState;
  const steps: Array<{ show: Array<TurnNotification>; close: Array<string> }> = [];
  let due: { at: number; summary: NeedsYouSummary } | null = null;

  const plan = (now: number, s: NeedsYouSummary, into: (typeof steps)[number]) => {
    const p = planTurnNotifications({
      state,
      summary: s,
      windowFocused,
      minDurationMs: minMinutes === undefined ? null : minMinutes * 60_000,
      now,
    });

    state = p.state;
    into.show.push(...p.show);
    into.close.push(...p.close);
    due = p.recheckInMs === null ? null : { at: now + p.recheckInMs, summary: s };
  };

  const fireDue = (before: number) => {
    const last = steps.at(-1);

    while (due !== null && due.at <= before && last !== undefined) plan(due.at, due.summary, last);
  };

  for (const [time, s] of events) {
    fireDue(time);
    steps.push({ show: [], close: [] });
    plan(time, s, steps.at(-1) ?? { show: [], close: [] });
  }

  fireDue(Number.POSITIVE_INFINITY);

  return steps;
};

/** Summaries a minute apart: every settle holds. */
const run = (summaries: ReadonlyArray<NeedsYouSummary>, options: Run = {}) =>
  timeline(
    summaries.map((s, i) => [i * 60_000, s] as const),
    options
  );

const shown = (steps: ReadonlyArray<Step>) => steps.map((p) => p.show.length);

describe("planTurnNotifications", () => {
  test("Working then Idle notifies once, with the Harness, session and the agent's reply", () => {
    const plans = run([of(turn("working")), of(turn("idle")), of(turn("idle"))]);

    expect(shown(plans)).toEqual([0, 1, 0]);
    expect(plans[1]?.show[0]).toMatchObject({
      key: turnKey("local", "s1"),
      title: "Claude Code finished a turn",
      subtitle: "Fix the flaky test · This Mac",
      body: REPLY,
    });
  });

  test("a turn with no reply (or from an older Daemon) says it's ready for the next", () => {
    const plans = run([of(turn("working")), of(turn("idle", { reply: null }))]);

    expect(plans[1]?.show[0]?.body).toBe("Ready for the next turn");
  });

  test("a Lead Turn Polaris started for a digest ends quietly", () => {
    const digest = { ...turn("idle"), digestStarted: true };

    expect(run([of(turn("working")), of(digest)])[1]?.show).toEqual([]);
  });

  test("a session first seen Idle (launch, a new Host) is not news", () => {
    expect(run([of(turn("idle"))])[0]?.show).toEqual([]);
  });

  test("no notification for the session the focused window shows", () => {
    const focused = { hostKey: "local", sessionId: "s1" };

    const plans = run(
      [summary({ focused, turns: [turn("working")] }), summary({ focused, turns: [turn("idle")] })],
      { windowFocused: true }
    );

    expect(plans[1]?.show).toEqual([]);
  });

  test("a Turn that needed you on the way still notifies when it ends", () => {
    const plans = run([
      of(turn("working")),
      summary({ sessions: [waiting()] }),
      of(turn("idle", { minutes: 6 })),
    ]);

    expect(shown(plans)).toEqual([0, 0, 1]);
  });

  test("a failed or archived session drops out without a notification", () => {
    expect(shown(run([of(turn("working")), summary({}), of(turn("idle"))]))).toEqual([0, 0, 0]);
  });

  test("the user's next Turn closes the last one's notification", () => {
    const plans = run([
      of(turn("working")),
      of(turn("idle")),
      of(turn("working", { userTurnId: "t2" })),
    ]);

    expect(plans[2]?.close).toEqual([turnKey("local", "s1")]);
  });

  describe("a settle has to hold", () => {
    test("a Turn the Harness starts right after the last task ends: one banner, at the end", () => {
      const plans = timeline([
        [0, of(turn("working", { reply: null }))],
        [60_000, of(turn("idle", { tasks: 1, reply: "Started the build in the background." }))],
        // The task's end reaches the Host stream just before the continuation's TurnStarted.
        [120_000, of(turn("idle", { reply: "Started the build in the background." }))],
        [120_400, of(turn("working", { reply: "Started the build in the background." }))],
        [180_000, of(turn("idle", { reply: "The build passed." }))],
      ]);

      expect(shown(plans)).toEqual([0, 0, 0, 0, 1]);
      expect(plans[4]?.show[0]?.body).toBe("The build passed.");
    });

    test("it shows once the settle has held, with no newer summary", () => {
      const plans = timeline([
        [0, of(turn("working"))],
        [60_000, of(turn("idle"))],
      ]);

      expect(shown(plans)).toEqual([0, 1]);
    });

    test("reports the Daemon says are pending hold the banner past the settle", () => {
      const plans = timeline([
        [0, of(turn("working"))],
        [60_000, of(turn("idle", { reportsPending: true }))],
        // The continuation starts well after a settle would have held.
        [60_000 + 4 * SETTLE_MS, of(turn("working"))],
        [120_000, of(turn("idle", { reply: "The build passed." }))],
      ]);

      expect(shown(plans)).toEqual([0, 0, 0, 1]);
      expect(plans[3]?.show[0]?.body).toBe("The build passed.");
    });

    test("a continuation that starts after the settle held gets no second banner", () => {
      const plans = timeline([
        [0, of(turn("working"))],
        [60_000, of(turn("idle"))],
        [60_000 + SETTLE_MS + 1, of(turn("working"))],
        [120_000, of(turn("idle"))],
      ]);

      expect(shown(plans)).toEqual([0, 1, 0, 0]);
    });
  });

  describe("after a reconnect", () => {
    test("a continuation of a Turn already notified stays quiet when its session comes back", () => {
      const plans = run([
        of(turn("working")),
        of(turn("idle", { tasks: 1 })),
        of(turn("idle")),
        // Reconnecting: the Host's sessions are gone, then its snapshot names the same user Turn.
        summary({}),
        of(turn("working", { minutes: 8 })),
        of(turn("idle", { minutes: 9 })),
      ]);

      expect(shown(plans)).toEqual([0, 0, 1, 0, 0, 0]);
    });
  });

  describe("background tasks", () => {
    test("Idle with tasks live is waiting, and it notifies once they're done", () => {
      const plans = run([
        of(turn("working")),
        of(turn("idle", { tasks: 2 })),
        of(turn("idle", { tasks: 1 })),
        of(turn("idle")),
      ]);

      expect(shown(plans)).toEqual([0, 0, 0, 1]);
    });

    test("a Turn the Harness started when they reported continues the user's: one banner", () => {
      const plans = run([
        of(turn("working")),
        of(turn("idle", { tasks: 1 })),
        // Its tasks report: the Harness starts a Turn, the user Turn stays t1.
        of(turn("working")),
        of(turn("idle")),
        of(turn("working")),
        of(turn("idle")),
      ]);

      expect(shown(plans)).toEqual([0, 0, 0, 1, 0, 0]);
      expect(plans.flatMap((p) => p.close)).toEqual([]);
    });

    test("the focused session held back at completion stays quiet through a continuation", () => {
      const focused = { hostKey: "local", sessionId: "s1" };

      const plans = run(
        [
          of(turn("working")),
          summary({ focused, turns: [turn("idle")] }),
          of(turn("working")),
          of(turn("idle")),
        ],
        { windowFocused: true }
      );

      expect(shown(plans)).toEqual([0, 0, 0, 0]);
    });
  });

  describe("only turns longer than 5 minutes", () => {
    const ended = (minutes: number, extra: ReadonlyArray<NeedsYouSummary> = []) =>
      shown(
        run([of(turn("working", { minutes: 0 })), ...extra, of(turn("idle", { minutes }))], {
          minMinutes: 5,
        })
      ).at(-1);

    test.each([
      ["under", 4.9, 0],
      ["exactly", 5, 0],
      ["over", 5.1, 1],
    ])("%s: a %d-minute turn", (_, minutes, count) => {
      expect(ended(minutes)).toBe(count);
    });

    test("timed from the user's prompt, not from the continuation the Harness started", () => {
      const plans = run(
        [
          of(turn("working", { minutes: 1 })),
          of(turn("idle", { minutes: 2, tasks: 1 })),
          of(turn("working", { minutes: 5 })),
          of(turn("idle", { minutes: 6 })),
        ],
        { minMinutes: 5 }
      );

      expect(shown(plans)).toEqual([0, 0, 0, 1]);
    });

    test("a turn not seen from its prompt is timed from when it was first seen under way", () => {
      const unknown = (state: NeedsYouTurn["state"], minutes: number) =>
        turn(state, { minutes, userTurnId: null });

      const short = run([of(unknown("working", 3)), of(unknown("idle", 7))], { minMinutes: 5 });
      const long = run([of(unknown("working", 3)), of(unknown("idle", 9))], { minMinutes: 5 });

      expect([shown(short)[1], shown(long)[1]]).toEqual([0, 1]);
    });

    test("the focused session is still held back", () => {
      const focused = { hostKey: "local", sessionId: "s1" };

      const plans = run(
        [
          summary({ focused, turns: [turn("working")] }),
          summary({ focused, turns: [turn("idle", { minutes: 30 })] }),
        ],
        { windowFocused: true, minMinutes: 5 }
      );

      expect(plans[1]?.show).toEqual([]);
    });
  });

  describe("a Reviewer's or walkthrough's run", () => {
    const pull = {
      kind: "pull" as const,
      repo: { owner: "acme", name: "api" },
      number: 12,
      pullId: "PR_12",
    };

    const reviewer = (findings: NeedsYouReview["findings"]): NeedsYouReview => ({
      kind: "reviewer",
      change: "Retry flaky uploads",
      target: pull,
      findings,
    });

    const walkthrough: NeedsYouReview = {
      kind: "walkthrough",
      change: "Retry flaky uploads",
      target: pull,
      findings: null,
    };

    const ran = (review: NeedsYouReview, patch: TurnPatch = {}, options: Run = {}) =>
      run(
        [
          of(turn("working", { review, ...patch })),
          of(turn("idle", { review, minutes: 1, ...patch })),
        ],
        options
      )[1]?.show[0];

    test.each([
      [{ open: 3, critical: 1 }, "3 findings · 1 critical"],
      [{ open: 1, critical: 0 }, "1 finding"],
      [{ open: 0, critical: 0 }, "No open findings"],
      [null, "Claude Code reviewed the change"],
    ])("the Reviewer's says the review is ready: %o", (findings, body) => {
      expect(ran(reviewer(findings))).toMatchObject({
        title: "Review ready",
        subtitle: "Retry flaky uploads · This Mac",
        body,
      });
    });

    test("a walkthrough's leads with its why, from the reply", () => {
      const reply =
        "Why the change Uploads failed on flaky networks; now they retry. Special things to note None";

      expect(ran(walkthrough, { reply })).toMatchObject({
        title: "Walkthrough ready",
        subtitle: "Retry flaky uploads · This Mac",
        body: "Uploads failed on flaky networks; now they retry.",
      });
    });

    test("a walkthrough whose reply isn't its Markdown says what it did", () => {
      expect(ran(walkthrough, { reply: '{ "groups": [] }' })?.body).toBe(
        "Claude Code walked through the change"
      );
    });

    test("notifies however short, with only longer turns asked for", () => {
      expect(ran(reviewer(null), {}, { minMinutes: 5 })?.title).toBe("Review ready");
    });

    test("none while the focused window shows its Review", () => {
      const review = reviewer(null);

      const plans = run(
        [
          summary({ reviewing: pull, turns: [turn("working", { review })] }),
          summary({ reviewing: pull, turns: [turn("idle", { review })] }),
        ],
        { windowFocused: true }
      );

      const other = { ...pull, number: 13 };

      const elsewhere = run(
        [
          summary({ reviewing: other, turns: [turn("working", { review })] }),
          summary({ reviewing: other, turns: [turn("idle", { review })] }),
        ],
        { windowFocused: true }
      );

      expect([shown(plans)[1], shown(elsewhere)[1]]).toEqual([0, 1]);
    });

    test("the Daemon's repair Turn right after the first: one banner, for the run", () => {
      const review = reviewer(null);

      const plans = timeline([
        [0, of(turn("working", { review }))],
        [60_000, of(turn("idle", { review }))],
        [60_050, of(turn("working", { review, userTurnId: "t2" }))],
        [70_000, of(turn("idle", { review, userTurnId: "t2" }))],
      ]);

      expect(shown(plans)).toEqual([0, 0, 0, 1]);
    });
  });
});
