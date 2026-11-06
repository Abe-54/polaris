import { expect, test } from "bun:test";
import {
  ConstellationEvent,
  DomainEvent,
  MessageTarget,
  PlanOperation,
  WorkerPlacement,
  ReviewAction,
  SessionId,
  TaskId,
  TaskDefinition,
  TurnId,
} from "@polaris/protocol";
import { Struct } from "effect";
import { decideConstellation } from "../engine/constellation.ts";
import {
  A,
  B,
  G,
  LEAD,
  C,
  CID,
  AT,
  ctx,
  dispatched,
  planned,
  task,
  apply,
  foldDecision,
  draft,
  claimed,
  report,
} from "../engine/constellation.testing.ts";
import { projectTask } from "./projections.ts";
import { decideConstellationJournal } from "./journal.ts";
import { pendingInputs } from "./delivery/messages.ts";
import { newTurn } from "./delivery/turns.ts";
import { session } from "./delivery/testing.ts";
import { digestPrompt, digestDelay } from "./delivery/format.ts";
import { acceptedBlockInput } from "./blocked.ts";
import { statusOutline } from "./status.ts";
import { handoverHeader } from "./handover/header.ts";

const working = () => dispatched(planned([task(A), task(B)]));

const command = (on: TaskId[] = [B]) =>
  C.WorkerBlock.make({
    constellationId: CID,
    attemptId: draft().id,
    on,
    reason: "Waiting for the feed",
  });

const workerContext = () => ctx({ binding: { kind: "session", sessionId: draft().sessionId } });

const blocked = (on: TaskId[] = [B]) => apply(working(), command(on), workerContext());

test("block validates state, each target condition and already accepted targets", () => {
  const code = (record: ReturnType<typeof working>, on: TaskId[]) =>
    decideConstellation(record, command(on), workerContext()).rejection?.findings[0]?.code;

  expect(code(blocked(), [B])).toBe("E-BLOCK-STATE");
  expect(code(claimed(working()), [B])).toBe("E-BLOCK-STATE");

  const settled = foldDecision(working(), [
    ConstellationEvent.cases.AttemptSettled.make({
      constellationId: CID,
      revision: 2,
      attemptId: draft().id,
      attemptRevision: 1,
      outcome: "lost",
      reason: "Stopped",
    }),
  ]);

  expect(code(settled, [B])).toBe("E-BLOCK-STATE");
  expect(code(working(), [A])).toBe("E-BLOCK-TARGET");
  expect(code(working(), [TaskId.make("missing")])).toBe("E-BLOCK-TARGET");

  const canceled = apply(
    working(),
    C.Plan.make({
      constellationId: CID,
      operations: [PlanOperation.cases.Cancel.make({ taskId: B, revision: 0 })],
    })
  );

  expect(code(canceled, [B])).toBe("E-BLOCK-TARGET");
  const record = working();
  const accepted = dispatched(record, draft(B, "b1", SessionId.make("worker-b")));

  const acceptedRecord = foldDecision(accepted, [
    ConstellationEvent.cases.AttemptAccepted.make({
      constellationId: CID,
      revision: accepted.graph.revision + 1,
      attemptId: accepted.graph.attempts[1]!.id,
      attemptRevision: 1,
      mergedHead: "feed-head",
      receipts: [],
      evidence: "asserted",
    }),
  ]);

  expect(code(acceptedRecord, [B])).toBe("E-BLOCK-SATISFIED");
  expect(decideConstellation(working(), command(), ctx()).rejection?.findings[0]?.code).toBe(
    "E-AUTHORITY"
  );
});

test("block persists metadata, projects blockers and queues a Lead digest", () => {
  const record = blocked([B, B]);
  expect(record.graph.attempts[0]).toMatchObject({
    state: "blocked",
    blockedOn: [B],
    blockedReason: "Waiting for the feed",
    blockedAt: AT,
  });
  expect(projectTask(record, record.graph.tasks[0]!)).toMatchObject({
    state: "blocked",
    blockedBy: [B],
  });
  expect(statusOutline(record)).toContain("blocked by B: Waiting for the feed");
  expect(digestPrompt(record)).toContain("A: blocked by B: Waiting for the feed");
  expect(digestDelay(record)).toBe(20000);
  expect(pendingInputs(blocked([]))).toEqual([]);
});

test("block rejects Gate Attempts and direct or transitive dependency deadlocks", () => {
  const middle = TaskId.make("middle");

  for (const tasks of [
    [task(A), task(B, [A])],
    [task(A), task(middle, [A]), task(B, [middle])],
  ]) {
    const record = dispatched(planned(tasks));
    expect(
      decideConstellation(record, command(), workerContext()).rejection?.findings[0]?.code
    ).toBe("E-BLOCK-CYCLE");
  }

  const gate = draft(G, "gate", LEAD);
  const record = dispatched(planned([task(G, [], "gate")]), gate);
  expect(
    decideConstellation(
      record,
      C.WorkerBlock.make({ ...command([]), attemptId: gate.id }),
      ctx({ binding: { kind: "session", sessionId: LEAD } })
    ).rejection?.findings[0]?.code
  ).toBe("E-BLOCK-GATE");
});

test("canceling targets notifies the Lead, drops blockers and leaves a reason-only block", () => {
  const other = TaskId.make("other");
  let record = dispatched(planned([task(A), task(B), task(other)]));
  record = apply(record, command([B, other]), workerContext());
  record = apply(
    record,
    C.Plan.make({
      constellationId: CID,
      operations: [PlanOperation.cases.Cancel.make({ taskId: B, revision: 0 })],
    })
  );
  expect(record.graph.attempts[0]!.blockedOn).toEqual([other]);
  expect(projectTask(record, record.graph.tasks[0]!).blockedBy).toEqual([other]);
  expect(digestPrompt(record)).toContain("B was canceled");
  record = apply(
    record,
    C.Plan.make({
      constellationId: CID,
      operations: [PlanOperation.cases.Cancel.make({ taskId: other, revision: 0 })],
    })
  );
  expect(record.graph.attempts[0]!.state).toBe("blocked");
  expect(record.graph.attempts[0]!.blockedOn).toEqual([]);
  expect(pendingInputs(record)).toEqual([]);
  expect(statusOutline(record)).toContain("blocked awaiting the Lead");
});

test("claim rejection identifies the blocked state", () => {
  const decision = decideConstellation(
    blocked(),
    C.WorkerClaim.make({ constellationId: CID, attemptId: draft().id, claim: report() }),
    ctx({
      ...workerContext(),
      claimProbe: { branch: draft().branch, head: "head", dirtyPaths: [] },
    })
  );

  expect(decision.rejection?.findings.find((f) => f.code === "E-CLAIM-STATE")?.message).toBe(
    `Attempt ${draft().id} is blocked`
  );
});

test("Lead unblock requires a Turn, clears metadata and is idempotent after replay", () => {
  const record = apply(
    blocked([]),
    C.Message.make({
      constellationId: CID,
      target: MessageTarget.cases.Worker.make({ attemptId: draft().id }),
      text: "Use the existing feed",
    })
  );

  const input = pendingInputs(record)[0]!;

  const delivered = {
    type: "inputDelivered" as const,
    id: input.id,
    sessionId: input.sessionId,
    turnEvents: Array<DomainEvent>(),
  };

  expect(decideConstellationJournal(record, delivered, ctx()).rejection?.findings[0]?.code).toBe(
    "E-UNBLOCK-TURN"
  );
  const turn = newTurn(session(input.sessionId), input.text, AT, "resume");

  const decision = decideConstellationJournal(
    record,
    { ...delivered, turnEvents: [DomainEvent.cases.TurnStarted.make({ turn })] },
    ctx()
  );

  expect(decision.rejection).toBeNull();
  expect(decision.events.map((e) => e._tag)).toEqual([
    "TurnStarted",
    "AttemptUnblocked",
    "WorkerInputDelivered",
    "OperatorMessageResolved",
  ]);
  const resumed = foldDecision(record, decision.events);
  expect(resumed.graph.attempts[0]).toMatchObject({
    state: "working",
    blockedOn: [],
    blockedReason: null,
    blockedAt: null,
  });
  expect(decideConstellationJournal(resumed, delivered, ctx()).events).toEqual([]);
});

test("blocked Attempts allow Lead Stop and SendBack and reject nudging", () => {
  const record = blocked();

  const base = {
    constellationId: CID,
    attemptId: draft().id,
    revision: record.graph.attempts[0]!.revision,
  };

  const stopped = apply(
    record,
    C.Review.make({
      ...base,
      action: ReviewAction.cases.Stop.make({ reason: "Canceled approach" }),
    })
  );

  expect(stopped.graph.attempts[0]!.state).toBe("lost");
  const replacement = draft(A, "retry", SessionId.make("new-worker"));

  const sentBack = apply(
    record,
    C.Review.make({
      ...base,
      action: ReviewAction.cases.SendBack.make({
        reason: "Use another approach",
        worker: WorkerPlacement.cases.Existing.make({ sessionId: replacement.sessionId }),
      }),
    }),
    ctx({ attempts: [replacement] })
  );

  expect(sentBack.graph.attempts.map((a) => a.state)).toEqual(["rejected", "working"]);
  expect(
    decideConstellationJournal(
      record,
      { type: "nudged", attemptId: draft().id, turnId: TurnId.make("nudge"), turnEvents: [] },
      ctx()
    ).rejection?.findings[0]?.code
  ).toBe("E-NUDGE-TURN");
});

test("status only labels the silent end after a nudge, and never a resumed or claimed Attempt", () => {
  const record = working();
  const attempt = record.graph.attempts[0]!;

  const nudged = foldDecision(record, [
    ConstellationEvent.cases.AttemptNudged.make({
      constellationId: CID,
      revision: record.graph.revision + 1,
      attemptId: attempt.id,
      attemptRevision: 1,
      at: AT,
    }),
  ]);

  const s = session(attempt.sessionId);

  const created = foldSession(
    s.id,
    undefined,
    [DomainEvent.cases.SessionCreated.make({ session: s })],
    AT
  )!;

  const stopped = foldSession(
    s.id,
    created,
    [DomainEvent.cases.SessionStateChanged.make({ sessionId: s.id, state: "idle", reason: null })],
    "2026-10-02T00:00:00.000Z"
  )!;

  expect(statusOutline(nudged, new Map([[s.id, stopped]]))).toContain("Stopped without claiming");
  expect(
    handoverHeader(nudged, SessionId.make("incoming"), "", new Map([[s.id, stopped]]))
  ).toContain("Stopped without claiming · nudged once");

  const resumed = foldSession(
    s.id,
    stopped,
    [
      DomainEvent.cases.SessionStateChanged.make({
        sessionId: s.id,
        state: "working",
        reason: null,
      }),
    ],
    "2026-10-02T00:00:01.000Z"
  )!;

  expect(statusOutline(nudged, new Map([[s.id, resumed]]))).not.toContain(
    "Stopped without claiming"
  );
  expect(statusOutline(claimed(nudged), new Map([[s.id, stopped]]))).not.toContain(
    "Stopped without claiming"
  );
  const waiting = apply(nudged, command(), workerContext());
  expect(statusOutline(waiting, new Map([[s.id, stopped]]))).not.toContain(
    "Stopped without claiming"
  );
});

test("a broadcast remains queued for a blocked worker and cannot acknowledge an unblock", () => {
  const record = apply(
    blocked([]),
    C.Message.make({
      constellationId: CID,
      target: MessageTarget.cases.All.make({}),
      text: "General update",
    })
  );

  const input = pendingInputs(record).find((i) => i.sessionId === draft().sessionId)!;
  const turn = newTurn(session(input.sessionId), input.text, AT, "broadcast");

  const decision = decideConstellationJournal(
    record,
    {
      type: "inputDelivered",
      id: input.id,
      sessionId: input.sessionId,
      turnEvents: [DomainEvent.cases.TurnStarted.make({ turn })],
    },
    ctx()
  );

  expect(decision.rejection?.findings[0]?.code).toBe("E-UNBLOCK-INPUT");
  expect(decision.events).toEqual([]);
});

import { foldSession } from "../store/model.ts";

test("blocking detects inherited prerequisites and parent completion edges", () => {
  const parent = TaskId.make("P");
  const child = (deps: TaskId[]) => new TaskDefinition(Struct.assign(task(B, deps), { parent }));

  for (const tasks of [
    [task(A), task(parent, [A]), child([])],
    [task(A), task(parent), child([A])],
  ]) {
    const record = dispatched(planned(tasks));
    const target = tasks[1]!.deps.length === 0 ? parent : B;
    expect(
      decideConstellation(record, command([target]), workerContext()).rejection?.findings[0]?.code
    ).toBe("E-BLOCK-CYCLE");
  }
});

test("accepted parent block targets expand leaf heads and subtree cancellation notifies the Lead", () => {
  const parent = TaskId.make("P");
  const child = new TaskDefinition(Struct.assign(task(B), { parent }));

  const record = apply(
    dispatched(planned([task(A), task(parent), child])),
    command([parent]),
    workerContext()
  );

  const feed = draft(B, "feed", SessionId.make("feed"));
  const started = dispatched(record, feed);

  const accepted = foldDecision(started, [
    ConstellationEvent.cases.AttemptAccepted.make({
      constellationId: CID,
      revision: started.graph.revision + 1,
      attemptId: feed.id,
      attemptRevision: 1,
      mergedHead: "feed-head",
      receipts: [],
      evidence: "asserted",
    }),
  ]);

  expect(acceptedBlockInput(accepted, accepted.graph.attempts[0]!)?.text).toBe(
    "B accepted at feed-head. Merge it into your branch and continue A; call claim when finished, or block again."
  );

  const waiting = apply(
    dispatched(planned([task(A), task(parent), child])),
    command([parent, B]),
    workerContext()
  );

  const canceled = apply(
    waiting,
    C.Plan.make({
      constellationId: CID,
      operations: [PlanOperation.cases.Cancel.make({ taskId: parent, revision: 0 })],
    })
  );

  expect(canceled.graph.attempts[0]!.blockedOn).toEqual([]);
  expect(projectTask(canceled, canceled.graph.tasks[0]!).blockedBy).toEqual([]);
  expect(digestPrompt(canceled)).toContain("P was canceled");
  expect(digestPrompt(canceled)).toContain("B was canceled");
});
