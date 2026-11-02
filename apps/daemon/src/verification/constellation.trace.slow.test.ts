import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AnswerAction,
  ConstellationQuestion,
  ConstellationSettings,
  DomainEvent,
  MessageTarget,
  PlanOperation,
  ReviewAction,
  SessionId,
  SetConstellationStateAction,
  StallAudit,
  Turn,
  TurnId,
  WorkerPlacement,
  type ConstellationCommand,
} from "@polaris/protocol";
import { decideConstellation } from "../engine/constellation.ts";
import {
  A,
  B,
  C,
  CID,
  G,
  HOST,
  LEAD,
  WS,
  AT,
  ctx,
  draft,
  foldDecision,
  report,
  task,
} from "../engine/constellation.testing.ts";
import type { ConstellationRecord } from "../store/constellation.ts";
import {
  decideConstellationJournal,
  type ConstellationJournalInput,
} from "../constellation/journal.ts";

/** A complete trace exercises metadata absent from the randomized worker command model. */
test("complete committed trace includes questions, send-back, recovery, delivery and handover", () => {
  let record: ConstellationRecord | undefined;

  const batches: Array<{
    hostId: string;
    events: ReadonlyArray<DomainEvent>;
    context?: { offlineSessionIds: ReadonlyArray<string>; commanded: boolean };
  }> = [];

  const commit = (events: ReadonlyArray<DomainEvent>, commanded = true) => {
    record = foldDecision(record, events);
    batches.push({ hostId: HOST, events, context: { offlineSessionIds: [], commanded } });
  };

  const command = (input: ConstellationCommand, context = ctx()) => {
    const decision = decideConstellation(record, input, context);
    expect(decision.rejection).toBeNull();
    commit(decision.events);
  };

  const graph = () => {
    if (record === undefined) throw new Error("no graph");

    return record;
  };

  const journal = (input: ConstellationJournalInput) => {
    const decision = decideConstellationJournal(graph(), input, ctx());
    expect(decision.rejection).toBeNull();
    commit(decision.events, false);
  };

  const accept = () => {
    const attempt = graph().graph.attempts.at(-1)!;
    command(
      C.Review.make({
        constellationId: CID,
        attemptId: attempt.id,
        revision: attempt.revision,
        action: ReviewAction.cases.Accept.make({
          mergedHead: attempt.claim?.head ?? "head",
          receipts: [],
        }),
      })
    );
  };

  const claim = (head = "head") => {
    const attempt = graph().graph.attempts.at(-1)!;
    command(
      C.WorkerClaim.make({
        constellationId: CID,
        attemptId: attempt.id,
        claim: report(attempt.branch, head),
      }),
      ctx({
        binding: { kind: "session", sessionId: attempt.sessionId },
        claimProbe: { dirtyPaths: [], branch: attempt.branch, head },
      })
    );
  };

  command(
    C.Plan.make({
      constellationId: CID,
      start: {
        name: "trace",
        workspaceId: WS,
        leadSessionId: LEAD,
        settings: new ConstellationSettings({}),
      },
      operations: [task(A), task(B, [A]), task(G, [A, B], "gate")].map((t) =>
        PlanOperation.cases.Add.make({ task: t })
      ),
    })
  );
  command(C.Dispatch.make({ constellationId: CID }), ctx({ attempts: [draft()] }));
  command(
    C.WorkerAsk.make({
      constellationId: CID,
      attemptId: draft().id,
      question: new ConstellationQuestion({
        id: "q",
        to: "user",
        text: "Which base?",
        blocking: true,
      }),
    }),
    ctx({ binding: { kind: "session", sessionId: draft().sessionId } })
  );
  command(
    C.Answer.make({
      constellationId: CID,
      action: AnswerAction.cases.Question.make({
        attemptId: draft().id,
        questionId: "q",
        text: "main",
      }),
    })
  );
  const messageId = [...graph().messages.keys()][0]!;
  journal({ type: "messageResolved", id: messageId });

  const nudgeTurn = new Turn({
    id: TurnId.make("nudge"),
    sessionId: draft().sessionId,
    index: 0,
    prompt: "Claim or explain what remains.",
    checkpointBefore: null,
    checkpointAfter: null,
    endedAt: null,
    attachments: [],
    model: null,
    effort: null,
    status: "working",
    startedAt: AT,
  });

  journal({
    type: "nudged",
    attemptId: draft().id,
    turnId: nudgeTurn.id,
    turnEvents: [DomainEvent.cases.TurnStarted.make({ turn: nudgeTurn })],
  });
  claim();
  // The Lead is mid-Turn: this digest is steered into that Turn and starts none.
  journal({
    type: "notified",
    leadSessionId: LEAD,
    turnId: TurnId.make("lead-working"),
    items: graph().graph.pendingNotifications.map((n) => n.id),
    turnEvents: [],
    steered: true,
  });
  const reviewAttempt = () => graph().graph.attempts.at(-1)!;
  command(
    C.Review.make({
      constellationId: CID,
      attemptId: reviewAttempt().id,
      revision: reviewAttempt().revision,
      action: ReviewAction.cases.HandUp.make({ reason: "Choose the design" }),
    }),
    ctx({ binding: { kind: "session", sessionId: LEAD } })
  );
  command(
    C.Review.make({
      constellationId: CID,
      attemptId: reviewAttempt().id,
      revision: reviewAttempt().revision,
      action: ReviewAction.cases.Approve.make({}),
    })
  );
  accept();
  const b = draft(B, "b1", SessionId.make("worker-b"));
  command(C.Dispatch.make({ constellationId: CID }), ctx({ attempts: [b] }));
  claim();
  command(
    C.Review.make({
      constellationId: CID,
      attemptId: b.id,
      revision: graph().graph.attempts.at(-1)!.revision,
      action: ReviewAction.cases.SendBack.make({
        reason: 'Keep "both tests".\nNewline λ feedback.',
        worker: WorkerPlacement.cases.Existing.make({ sessionId: b.sessionId }),
      }),
    }),
    ctx({ attempts: [draft(B, "b2", b.sessionId)] })
  );
  const retry = graph().graph.attempts.at(-1)!;
  const turnId = TurnId.make("recovery");
  commit([
    DomainEvent.cases.AttemptInterrupted.make({
      constellationId: CID,
      revision: graph().graph.revision,
      attemptId: retry.id,
      turnId,
      interruptionId: "interruption",
      eligible: true,
      at: AT,
    }),
  ]);
  journal({
    type: "recoveryContinued",
    attemptId: retry.id,
    turnId,
    interruptionId: "interruption",
    turnEvents: [
      DomainEvent.cases.TurnStarted.make({
        turn: new Turn({
          id: turnId,
          sessionId: retry.sessionId,
          index: 0,
          prompt: "continue",
          attachments: [],
          model: null,
          effort: null,
          status: "working",
          checkpointBefore: null,
          checkpointAfter: null,
          startedAt: AT,
          endedAt: null,
        }),
      }),
    ],
  });
  // The retry fixes the sent-back head; re-claiming it would be refused (E-CLAIM-REJECTED-HEAD).
  claim("head-b2");
  accept();
  command(C.Dispatch.make({ constellationId: CID }), ctx({ attempts: [draft(G, "g1", LEAD)] }));
  claim();
  accept();
  command(
    C.Message.make({
      constellationId: CID,
      target: MessageTarget.cases.Lead.make({}),
      text: "Continue with review",
      authority: "conversation",
    })
  );
  command(
    C.SetState.make({
      constellationId: CID,
      action: SetConstellationStateAction.cases.HandOver.make({
        summary: "all done",
        interrupt: false,
      }),
    }),
    ctx({ newLeadSessionId: SessionId.make("new-lead") })
  );
  const leadSessionId = graph().graph.leadSessionId;
  const digestId = TurnId.make("digest");
  journal({
    type: "notified",
    leadSessionId,
    turnId: digestId,
    audit: new StallAudit({ key: "trace", working: [B], gates: [], lead: false }),
    items: graph().graph.pendingNotifications.map((n) => n.id),
    turnEvents: [
      DomainEvent.cases.TurnStarted.make({
        turn: new Turn({
          id: digestId,
          sessionId: leadSessionId,
          index: 0,
          prompt: "digest",
          attachments: [],
          model: null,
          effort: null,
          status: "working",
          checkpointBefore: null,
          checkpointAfter: null,
          startedAt: AT,
          endedAt: null,
        }),
      }),
    ],
  });
  command(
    C.SetState.make({
      constellationId: CID,
      action: SetConstellationStateAction.cases.Complete.make({}),
    })
  );
  command(
    C.SetState.make({
      constellationId: CID,
      action: SetConstellationStateAction.cases.Archive.make({}),
    })
  );
  expect(graph().graph.state).toBe("archived");
  expect(graph().graph.pendingNotifications).toEqual([]);

  if (process.env.POLARIS_TRACE_DIR !== undefined) {
    mkdirSync(process.env.POLARIS_TRACE_DIR, { recursive: true });
    writeFileSync(
      join(process.env.POLARIS_TRACE_DIR, "constellation-complete.json"),
      JSON.stringify({ version: 1, ownerHostId: HOST, batches })
    );
  }
});
