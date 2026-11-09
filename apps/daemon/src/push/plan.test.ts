import { Schema } from "effect";
import { describe, expect, test } from "bun:test";
import { ApprovalRequest, DomainEvent, type HostStreamItem } from "@polaris/protocol";
import type { PushMessage } from "@polaris/protocol/relay";
import {
  emptyPlan,
  markDigestTurn,
  nextSettle,
  type PlanState,
  planItem,
  planSettled,
  SETTLE_MS,
} from "./plan.ts";
import {
  approval,
  event,
  approvalRequested,
  backgroundTasks,
  notified,
  sessionCreated,
  snapshot,
  synchronized,
  turnEnded,
  turnStarted,
  workerSession,
} from "./push.testing.ts";

const host = { hostId: "host-1", hostName: "studio" };

/** The notifier learned from the store model that this Turn is a digest's. */
interface DigestMark {
  readonly digestTurn: string;
}

/** Feeds items at `now`, collecting what they push; then lets settles run until `until`. */
const run = (
  items: ReadonlyArray<readonly [number, HostStreamItem | DigestMark]>,
  until: number
) => {
  let state: PlanState = emptyPlan;
  const sent: Array<PushMessage & { readonly sentAt: number }> = [];

  const settleUpTo = (now: number) => {
    for (let next = nextSettle(state); next !== null && next <= now; next = nextSettle(state)) {
      const planned = planSettled(state, { ...host, now: next });
      state = planned.state;
      sent.push(...planned.send.map(({ message }) => ({ ...message, sentAt: next })));
    }
  };

  for (const [now, item] of items) {
    settleUpTo(now);

    if ("digestTurn" in item) {
      state = markDigestTurn(state, item.digestTurn);
      continue;
    }

    const planned = planItem(state, item, { ...host, now });
    state = planned.state;
    sent.push(...planned.send.map(({ message }) => ({ ...message, sentAt: now })));
  }

  settleUpTo(until);

  return sent;
};

const start = [
  [0, snapshot()],
  [0, synchronized()],
] as const;

describe("push plan", () => {
  test("a new approval pushes Needs You at once with what it asks, as the Desktop App words it", () => {
    const [push, ...rest] = run([...start, [10, approvalRequested("r1")]], 10_000);

    expect(rest).toEqual([]);
    expect(push).toMatchObject({
      kind: "needs-you",
      hostId: "host-1",
      sessionId: "s1",
      requestId: "r1",
      category: "approval",
      title: "Claude Code needs you",
      subtitle: "studio · Fix the flaky test",
      body: "Run bun test\nbun test apps/daemon",
      sentAt: 10,
    });
  });

  test("a question has the question category: no Approve or Deny buttons", () => {
    expect(run([...start, [10, approvalRequested("q1", "question")]], 0)[0]?.category).toBe(
      "question"
    );
  });

  test("nothing from before Synchronized pushes", () => {
    expect(
      run(
        [
          [0, snapshot()],
          [1, approvalRequested("r0")],
          [2, turnEnded("t0", "x")],
        ],
        10_000
      )
    ).toEqual([]);
  });

  test("a finished Turn pushes once its session stays settled for SETTLE_MS", () => {
    const sent = run([...start, [100, turnEnded("t1", "All green")]], 100_000);

    expect(sent.map((m) => [m.kind, m.title, m.subtitle, m.body, m.sentAt])).toEqual([
      [
        "turn-ended",
        "Claude Code finished a turn",
        "studio · Fix the flaky test",
        "All green",
        100 + SETTLE_MS,
      ],
    ]);
  });

  test("a Turn that starts within the settle (a continuation) cancels it; its own end pushes", () => {
    const sent = run(
      [
        ...start,
        [100, turnEnded("t1", "early")],
        [100 + SETTLE_MS - 1, turnStarted("t2")],
        [5_000, turnEnded("t2", "final")],
      ],
      100_000
    );

    expect(sent.map((m) => [m.body, m.sentAt])).toEqual([["final", 5_000 + SETTLE_MS]]);
  });

  test("with background tasks live the settle waits for the last one to finish", () => {
    const sent = run(
      [
        ...start,
        [50, backgroundTasks(1)],
        [100, turnEnded("t1", "waiting")],
        [20_000, backgroundTasks(0)],
      ],
      100_000
    );

    expect(sent.map((m) => m.sentAt)).toEqual([20_000 + SETTLE_MS]);
  });

  test("an agent's notify pushes at once as a notify, its host and session's title as the subtitle", () => {
    const [push, ...rest] = run([...start, [10, notified("n1", false)]], 10_000);

    expect(rest).toEqual([]);
    expect(push).toMatchObject({
      kind: "notify",
      sessionId: "s1",
      requestId: null,
      category: null,
      title: "Done",
      subtitle: "studio · Fix the flaky test",
      body: "All green",
    });
    expect(push?.constellationId).toBeNull();
  });

  test("an automatic notification is marked so, and names its Constellation for the tap", () => {
    let state: PlanState = emptyPlan;

    for (const item of [snapshot(), synchronized()])
      state = planItem(state, item, { ...host, now: 0 }).state;

    const { send } = planItem(state, notified("n2", true), { ...host, now: 5 });

    expect(send.map((p) => [p.automatic, p.message.kind, p.message.constellationId])).toEqual([
      [true, "notify", "c1"],
    ]);
  });

  test("a Lead Turn Polaris started for a digest ends without a push; the user's next one pushes", () => {
    const sent = run(
      [
        ...start,
        [10, turnStarted("digest")],
        [100, { digestTurn: "digest" }],
        [100, turnEnded("digest", "Dispatched B")],
        [20_000, turnStarted("t2")],
        [21_000, turnEnded("t2", "Merged A")],
      ],
      100_000
    );

    expect(sent.map((m) => m.body)).toEqual(["Merged A"]);
  });

  // The Host stream never carries AttemptStarted: the Snapshot's mark is what the plan sees.
  test("a worker the Snapshot marks pushes only its Needs You: no finished Turn or notify", () => {
    const sent = run(
      [
        [0, snapshot(workerSession)],
        [0, synchronized()],
        [10, turnStarted("t1")],
        [100, turnEnded("t1", "Claimed")],
        [200, notified("n1", false)],
        [300, approvalRequested("r1")],
      ],
      100_000
    );

    expect(sent.map((m) => [m.kind, m.sessionId, m.requestId])).toEqual([
      ["needs-you", "s1", "r1"],
    ]);
  });

  test("a session made as a worker is marked from its SessionCreated", () => {
    const sent = run(
      [
        [0, snapshot()],
        [0, synchronized()],
        [5, sessionCreated(workerSession)],
        [10, turnStarted("t1")],
        [100, turnEnded("t1", "Claimed")],
      ],
      100_000
    );

    expect(sent).toEqual([]);
  });
});

test("P9-10: attach push uses a category without Always here", () => {
  const request = Schema.decodeUnknownSync(ApprovalRequest)({
    ...Schema.encodeSync(ApprovalRequest)(approval("attach")),
    profileAttach: { pid: 42, command: "node app", runtime: "node", seconds: 5 },
  });

  const item = event(DomainEvent.cases.ApprovalRequested.make({ request }));
  expect(run([...start, [10, item]], 10000)[0]?.category).toBe("approval-once");
});
