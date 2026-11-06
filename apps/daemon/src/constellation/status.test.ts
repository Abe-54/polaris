import { expect, test } from "bun:test";
import {
  Attempt,
  Constellation,
  DomainEvent,
  EventEnvelope,
  Sequence,
  TaskDefinition,
  TaskId,
  Turn,
  ConstellationNotification,
  ConstellationQuestion,
  NotificationItem,
  ReviewAction,
  SessionId,
  WorkerPlacement,
} from "@polaris/protocol";
import { Predicate, Struct } from "effect";
import {
  A,
  C,
  CID,
  LEAD,
  apply,
  claimed,
  ctx,
  dispatched,
  draft,
  report,
} from "../engine/constellation.testing.ts";
import { reviewFeedback } from "./composition/feedback.ts";
import { assignment } from "../harness/constellation/testing.ts";
import { workerBrief } from "../harness/constellation/worker.ts";
import { stampKey } from "../store/constellation.ts";
import { graphResult } from "./service.ts";
import { notificationLine } from "./delivery/format.ts";
import { statusOutline, statusSince } from "./status.ts";
import { newTurn } from "./delivery/turns.ts";
import { session } from "./delivery/testing.ts";
import type { SessionRecord } from "../store/model.ts";

test("status keeps only the latest rejected Claim with three indented feedback lines", () => {
  const record = claimed();

  const old = Attempt.make(
    Struct.assign(draft(A, "old"), {
      state: "rejected" as const,
      claim: report("branch", "old-head"),
      rejectionReason: "Old feedback",
    })
  );

  const latest = Attempt.make(
    Struct.assign(draft(A, "latest"), {
      state: "rejected" as const,
      claim: report("branch", "latest-head"),
      rejectionReason: "one\ntwo\nthree\nfour\nfive",
    })
  );

  const graph = Constellation.make(
    Struct.assign(record.graph, { attempts: [old, latest, draft(A, "current")] })
  );

  const text = statusOutline({ ...record, graph });

  expect(text).toContain("Claim latest-head");
  expect(text).toContain("  Review feedback:\n    one\n    two\n    three\n    …");
  expect(text).not.toContain("old-head");
  expect(text).not.toContain("four");
});

test("proposal details are available in status, digest and structured JSON", () => {
  const record = claimed();

  const proposed = TaskDefinition.make({
    id: TaskId.make("cleanup"),
    title: "Cleanup",
    brief: "Remove stale entries\nRetain active ones",
    deps: [A],
    area: ["apps/daemon/src/constellation/**"],
    criteria: ["No stale entries", "Active entries retained"],
    kind: "task",
  });

  const proposalId = "proposal-1";

  const enriched = {
    ...record,
    proposals: new Map([[proposalId, { by: draft().id, task: proposed }]]),
    stamps: new Map([[stampKey("proposal", proposalId), "2026-10-01T00:00:00.000Z"]]),
  };

  const n = ConstellationNotification.make({
    id: "note",
    queuedAt: record.graph.updatedAt,
    item: NotificationItem.cases.Proposal.make({ attemptId: draft().id, proposalId }),
  });

  const outline = statusOutline(enriched);
  const digest = notificationLine(enriched, n);

  for (const text of [outline, digest]) {
    expect(text).toContain("Remove stale entries");
    expect(text).toContain("Retain active ones");
    expect(text).toContain("Dependencies: A");
    expect(text).toContain("apps/daemon/src/constellation/**");
    expect(text).toContain("Active entries retained");
  }

  const result = graphResult(enriched, null, true);
  expect(result.proposals[0]?.task).toEqual(proposed);
  expect(result.proposals[0]?.at).toBe("2026-10-01T00:00:00.000Z");
  expect(JSON.stringify(result)).toContain(JSON.stringify(proposed));

  const sentBack = ConstellationNotification.make({
    id: n.id,
    queuedAt: n.queuedAt,
    item: NotificationItem.cases.Settled.make({ attemptId: draft().id, state: "rejected" }),
  });

  expect(notificationLine(enriched, sentBack)).toBe("A: sent back.");
});

test("status separates a working Attempt from a Turn in flight and names a failed settle's kind", () => {
  const record = dispatched();
  const attempt = record.graph.attempts[0]!;
  const worker = session(attempt.sessionId);

  const withTurns = (turns: ReadonlyArray<Turn>): SessionRecord => ({
    session: worker,
    titleLocked: false,
    turns,
    pending: new Map(),
    subagents: new Map(),
  });

  const sessions = (turns: ReadonlyArray<Turn>) => new Map([[attempt.sessionId, withTurns(turns)]]);

  expect(statusOutline(record, sessions([]))).toContain("  Worker: starting\n");
  const brief = newTurn(worker, "Build", attempt.startedAt, `${attempt.id}:start`);

  const ended = Turn.make(
    Struct.assign(brief, {
      status: "completed" as const,
      endedAt: "2026-10-01T01:00:00.000Z",
    })
  );

  expect(statusOutline(record, sessions([ended]))).toContain(
    "  Worker: idle · last Turn completed at 2026-10-01T01:00:00.000Z\n"
  );
  expect(statusOutline(record, sessions([brief]))).toContain("  Worker: Turn running\n");

  const failed = Constellation.make(
    Struct.assign(record.graph, {
      attempts: [
        Attempt.make(
          Struct.assign(attempt, {
            state: "failed" as const,
            failureKind: "capacity" as const,
            settleReason: "Selected model is at capacity.",
          })
        ),
      ],
    })
  );

  expect(statusOutline({ ...record, graph: failed })).toContain(
    "  capacity-blocked (reset time unknown): Selected model is at capacity. · not redispatched automatically"
  );
});

test("status since a revision lists only later graph events, one line each, then where things stand", () => {
  const record = claimed();
  const attempt = record.graph.attempts[0]!;

  const events = [
    DomainEvent.cases.ConstellationStateChanged.make({
      constellationId: record.graph.id,
      revision: 1,
      state: "running",
    }),
    DomainEvent.cases.AttemptClaimed.make({
      constellationId: record.graph.id,
      revision: 5,
      attemptId: attempt.id,
      attemptRevision: attempt.revision,
      claim: report(),
    }),
  ].map(
    (event, i) =>
      new EventEnvelope({
        sequence: Sequence.make(i + 1),
        occurredAt: `2026-10-01T00:0${i}:00.000Z`,
        commandId: null,
        event,
      })
  );

  const text = statusSince(record, events, 4);
  expect(text).toContain("changes since revision 4: 1");
  expect(text).toContain("5 · 2026-10-01T00:01:00.000Z · A: claimed head · Implemented the task.");
  expect(text).not.toContain("Constellation running.");
  expect(text).toContain("In review: A");
  expect(statusSince(record, events, 99)).toContain("Nothing changed.");
});

test("a send-back names the user when the user sent it, in status, the Lead update and the next brief", () => {
  const reason = "Use the existing release script.\nKeep the DMG name.";

  const cases = [
    [{ kind: "user" as const }, " by the user", "Review feedback from the user:"],
    [{ kind: "session" as const, sessionId: LEAD }, "", "Review feedback:"],
  ] as const;

  for (const [binding, by, heading] of cases) {
    const record = claimed();
    const attempt = record.graph.attempts[0]!;
    const retry = draft(A, "a2", SessionId.make("worker-2"));

    const sent = apply(
      record,
      C.Review.make({
        constellationId: CID,
        attemptId: attempt.id,
        revision: attempt.revision,
        action: ReviewAction.cases.SendBack.make({
          reason,
          worker: WorkerPlacement.cases.Existing.make({ sessionId: retry.sessionId }),
        }),
      }),
      ctx({ binding, attempts: [retry] })
    );

    const settled = sent.graph.pendingNotifications.find(
      (n) => Predicate.isTagged(n.item, "Settled") && n.item.state === "rejected"
    )!;

    expect(statusOutline(sent)).toContain(`  Sent back attempt a1${by} · Claim head`);
    expect(notificationLine(sent, settled)).toBe(
      `A: sent back${by}: Use the existing release script. Keep the DMG name.`
    );
    const retried = sent.graph.attempts.at(-1)!;

    expect(
      workerBrief({ ...assignment(), attempt: retried, ...reviewFeedback(sent.graph, retried) })
    ).toContain(`\n\n${heading}\n${reason}\n\n`);
  }
});

test("a Lead update quotes a worker question with the id answer needs", () => {
  const record = claimed();

  const n = ConstellationNotification.make({
    id: "q",
    queuedAt: record.graph.updatedAt,
    item: NotificationItem.cases.Question.make({
      attemptId: record.graph.attempts[0]!.id,
      question: new ConstellationQuestion({
        id: "q-dmg",
        to: "lead",
        text: "Sign with the team identity?",
        blocking: true,
      }),
    }),
  });

  expect(notificationLine(record, n)).toBe(
    "A asks lead (questionId q-dmg, blocking): Sign with the team identity?"
  );
});
