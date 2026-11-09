import { describe, expect, test } from "bun:test";
import {
  AttemptCause,
  AnswerAction,
  CheckReceipt,
  ConstellationQuestion,
  HostId,
  MessageTarget,
  PlanOperation,
  ReviewAction,
  SessionId,
  SetConstellationStateAction,
  ToolCallReference,
  TurnId,
  TurnItem,
  WorkerPlacement,
} from "@polaris/protocol";
import { Predicate } from "effect";
import { decideConstellation } from "./constellation.ts";
import {
  A,
  B,
  C,
  CID,
  G,
  HOST,
  LEAD,
  apply,
  claimed,
  ctx,
  dispatched,
  draft,
  planned,
  report,
  task,
  WS,
} from "./constellation.testing.ts";
import { projectTask } from "../constellation/projections.ts";
import { digestDelay, digestPrompt } from "../constellation/delivery/format.ts";

const review = (record: ReturnType<typeof claimed>, action: typeof ReviewAction.Type) =>
  C.Review.make({
    constellationId: CID,
    attemptId: record.graph.attempts.at(-1)!.id,
    revision: record.graph.attempts.at(-1)!.revision,
    action,
  });

test("a user's approval tells the Lead once to merge and accept", () => {
  const record = claimed();
  const approved = apply(record, review(record, ReviewAction.cases.Approve.make({})), ctx());
  const pending = approved.graph.pendingNotifications;
  const attempt = approved.graph.attempts[0]!;

  expect(pending.filter((n) => Predicate.isTagged(n.item, "Approved"))).toHaveLength(1);
  expect(digestDelay(approved)).not.toBeNull();
  expect(digestPrompt(approved)).toContain(
    `${attempt.taskId}: approved by the user. Accept it with mergedHead ${attempt.claim?.head}; Polaris merges ${attempt.branch} into your branch.`
  );

  const again = apply(approved, review(approved, ReviewAction.cases.Approve.make({})), ctx());

  expect(again.graph.pendingNotifications).toHaveLength(pending.length);
});

test("user approval and Lead hand-up remain review metadata with revision and role guards", () => {
  const record = claimed();
  const approve = review(record, ReviewAction.cases.Approve.make({}));
  expect(
    decideConstellation(record, approve, ctx({ binding: { kind: "session", sessionId: LEAD } }))
      .events
  ).toEqual([]);
  const approved = apply(record, approve, ctx());
  expect(approved.graph.attempts[0]?.state).toBe("review");
  expect(approved.graph.attempts[0]?.approvedByUserAt).toBe(ctx().now);
  // The approval left the Claim alone: approving it again as seen is a no-op, not stale.
  expect(decideConstellation(approved, approve, ctx())).toMatchObject({
    rejection: null,
    events: [],
  });
  expect(
    decideConstellation(
      approved,
      C.Review.make({ ...approve, revision: approve.revision - 1 }),
      ctx()
    ).rejection?.findings[0]?.code
  ).toBe("E-REVISION");
  const handUp = review(approved, ReviewAction.cases.HandUp.make({ reason: "Choose the design" }));
  expect(decideConstellation(approved, handUp, ctx()).events).toEqual([]);
  const handed = apply(approved, handUp, ctx({ binding: { kind: "session", sessionId: LEAD } }));
  expect(handed.graph.attempts[0]?.handedUpReason).toBe("Choose the design");
  expect(handed.graph.attempts[0]?.state).toBe("review");

  const accepted = apply(
    handed,
    review(handed, ReviewAction.cases.Accept.make({ mergedHead: "head", receipts: [] })),
    ctx()
  );

  expect(accepted.graph.attempts[0]?.state).toBe("accepted");
});

const accepted = (record = claimed()) =>
  apply(
    record,
    review(record, ReviewAction.cases.Accept.make({ mergedHead: "head", receipts: [] }))
  );

describe("Constellation decider", () => {
  test("batch validation collects cycle, unknown dependency, cancel dependent and stale revision findings without events", () => {
    const record = planned();

    const command = C.Plan.make({
      constellationId: CID,
      operations: [
        PlanOperation.cases.Edit.make({ taskId: A, revision: 0, task: task(A, [B, G]) }),
        PlanOperation.cases.Add.make({ task: task(importId("X"), [importId("unknown")]) }),
        PlanOperation.cases.Cancel.make({ taskId: G, revision: 0 }),
        PlanOperation.cases.Cancel.make({ taskId: B, revision: 99 }),
      ],
    });

    const result = decideConstellation(record, command, ctx());
    expect(result.events).toEqual([]);
    const codes = result.rejection?.findings.map((f) => f.code) ?? [];

    for (const code of ["E-DEP-CYCLE", "E-DEP-UNKNOWN", "E-CANCEL-DEPENDENTS", "E-REVISION"])
      expect(codes).toContain(code);
    expect(result.rejection?.revision).toBe(record.graph.revision);
  });
  test("forward declarations and removing dependencies before cancel are atomic", () => {
    const record = planned([task(B, [A]), task(A)]);

    const next = apply(
      record,
      C.Plan.make({
        constellationId: CID,
        operations: [
          PlanOperation.cases.Cancel.make({ taskId: A, revision: 0 }),
          PlanOperation.cases.Edit.make({ taskId: B, revision: 0, task: task(B) }),
        ],
      })
    );

    expect(next.graph.tasks.find((t) => t.id === A)?.canceled).toBe(true);
  });
  test("Claim checks git state and moves only to review; acceptance requires the exact head", () => {
    const working = dispatched();
    const worker = working.graph.attempts[0]!;

    const refused = decideConstellation(
      working,
      C.WorkerClaim.make({ constellationId: CID, attemptId: worker.id, claim: report() }),
      ctx({
        binding: { kind: "session", sessionId: worker.sessionId },
        claimProbe: { dirtyPaths: ["dirty"], branch: "wrong", head: "wrong" },
      })
    );

    expect(refused.rejection?.findings.map((f) => f.code)).toEqual([
      "E-CLAIM-DIRTY",
      "E-CLAIM-HEAD",
    ]);
    const record = claimed(working);
    expect(record.graph.attempts[0]?.state).toBe("review");
    expect(record.promoted.has(G)).toBe(false);
    expect(
      decideConstellation(
        record,
        review(record, ReviewAction.cases.Accept.make({ mergedHead: "other", receipts: [] })),
        ctx()
      ).rejection?.findings[0]?.code
    ).toBe("E-MERGED-HEAD");
    expect(accepted(record).graph.attempts[0]?.evidence).toBe("asserted");
  });
  test("verified evidence requires a referenced persisted completed successful command", () => {
    const ref = new ToolCallReference({
      hostId: HOST,
      sessionId: LEAD,
      turnId: TurnId.make("check"),
      itemId: "check",
    });

    const receipts = [CheckReceipt.cases.Verified.make({ label: "tests", item: ref })];
    const record = claimed();

    const command = review(
      record,
      ReviewAction.cases.Accept.make({ mergedHead: "head", receipts })
    );

    expect(decideConstellation(record, command, ctx()).rejection?.findings[0]?.code).toBe(
      "E-RECEIPT-UNKNOWN"
    );

    const item = TurnItem.cases.CommandExecution.make({
      id: "check",
      command: "bun test",
      cwd: "/tmp",
      output: "3 pass",
      exitCode: 0,
      status: "completed",
    });

    expect(
      apply(record, command, ctx({ recordedChecks: [{ reference: ref, item }] })).graph.attempts[0]
        ?.evidence
    ).toBe("verified");
    const text = CheckReceipt.cases.Reported.make({ label: "tests", text: "passed" });
    expect(
      apply(
        record,
        review(record, ReviewAction.cases.Accept.make({ mergedHead: "head", receipts: [text] }))
      ).graph.attempts[0]?.evidence
    ).toBe("reported");
  });
  test("send back links a fresh Attempt and rejects stale or settled commands", () => {
    const record = claimed();

    const next = apply(
      record,
      review(
        record,
        ReviewAction.cases.SendBack.make({
          reason: "fix",
          worker: WorkerPlacement.cases.Existing.make({ sessionId: SessionId.make("worker") }),
          mergeConflictBase: "main",
        })
      ),
      ctx({ attempts: [draft(A, "a2")] })
    );

    expect(next.graph.attempts.map((a) => a.state)).toEqual(["rejected", "working"]);
    expect(next.graph.attempts[1]?.cause).toEqual(
      AttemptCause.cases.MergeConflict.make({ ref: next.graph.attempts[0]!.id, base: "main" })
    );
    expect(
      decideConstellation(
        next,
        review(record, ReviewAction.cases.Stop.make({ reason: "stop" })),
        ctx()
      ).rejection?.findings[0]?.code
    ).toBe("E-SETTLED");

    const stale = C.Review.make({
      constellationId: CID,
      attemptId: next.graph.attempts[1]!.id,
      revision: 99,
      action: ReviewAction.cases.Stop.make({ reason: "stop" }),
    });

    expect(decideConstellation(next, stale, ctx()).rejection?.findings[0]?.code).toBe("E-REVISION");
  });
  test("one active Attempt per session; owner and worker authority are checked", () => {
    const record = planned([task(A), task(B)]);
    const command = C.Dispatch.make({ constellationId: CID });
    expect(
      decideConstellation(record, command, ctx({ attempts: [draft(A), draft(B, "b1")] })).rejection
        ?.findings[0]?.code
    ).toBe("E-SESSION-ACTIVE");
    expect(
      decideConstellation(record, command, ctx({ hostId: HostId.make("remote") })).rejection
        ?.findings[0]?.code
    ).toBe("E-OWNER");
    const working = dispatched(record);
    expect(
      decideConstellation(
        working,
        C.WorkerProgress.make({
          constellationId: CID,
          attemptId: working.graph.attempts[0]!.id,
          note: "hi",
        }),
        ctx()
      ).rejection?.findings[0]?.code
    ).toBe("E-AUTHORITY");
  });
  test("Gate promotion counts only accepted deps and happens once", () => {
    let record = accepted();
    record = dispatched(record, draft(B, "b1", SessionId.make("worker-b")));
    record = claimed(record, report("polaris/B"));
    expect(record.promoted.has(G)).toBe(false);

    const decision = decideConstellation(
      record,
      review(record, ReviewAction.cases.Accept.make({ mergedHead: "head", receipts: [] })),
      ctx()
    );

    expect(decision.events.filter((e) => Predicate.isTagged(e, "GatePromoted"))).toHaveLength(1);
    record = apply(
      record,
      review(record, ReviewAction.cases.Accept.make({ mergedHead: "head", receipts: [] }))
    );

    const noRepeat = decideConstellation(
      record,
      C.Plan.make({ constellationId: CID, operations: [] }),
      ctx()
    );

    expect(noRepeat.events).toEqual([]);
    expect(
      projectTask(
        record,
        record.graph.tasks.find((t) => t.id === G)!
      ).state
    ).toBe("ready");
  });
  test("only the user answers user questions or grants message authority", () => {
    const record = dispatched();
    const attempt = record.graph.attempts[0]!;

    const asked = apply(
      record,
      C.WorkerAsk.make({
        constellationId: CID,
        attemptId: attempt.id,
        question: new ConstellationQuestion({
          id: "q",
          to: "user",
          text: "Choose?",
          blocking: true,
        }),
      }),
      ctx({ binding: { kind: "session", sessionId: attempt.sessionId } })
    );

    const answer = C.Answer.make({
      constellationId: CID,
      action: AnswerAction.cases.Question.make({
        attemptId: attempt.id,
        questionId: "q",
        text: "yes",
      }),
    });

    expect(
      decideConstellation(asked, answer, ctx({ binding: { kind: "session", sessionId: LEAD } }))
        .rejection?.findings[0]?.code
    ).toBe("E-AUTHORITY");

    const message = C.Message.make({
      constellationId: CID,
      target: MessageTarget.cases.Lead.make({}),
      text: "decide",
      authority: "may_decide_and_continue",
    });

    expect(
      decideConstellation(record, message, ctx({ binding: { kind: "session", sessionId: LEAD } }))
        .rejection?.findings[0]?.code
    ).toBe("E-AUTHORITY");
  });
  test("handover keeps pending updates and revokes old Lead command authority", () => {
    const record = claimed();

    const next = apply(
      record,
      C.SetState.make({
        constellationId: CID,
        action: SetConstellationStateAction.cases.HandOver.make({
          summary: "continue",
          interrupt: false,
        }),
      }),
      ctx({ newLeadSessionId: SessionId.make("new-lead") })
    );

    expect(next.graph.pendingNotifications).toEqual(record.graph.pendingNotifications);
    expect(
      decideConstellation(
        next,
        C.Plan.make({ constellationId: CID, operations: [] }),
        ctx({ binding: { kind: "session", sessionId: LEAD } })
      ).rejection?.findings[0]?.code
    ).toBe("E-AUTHORITY");
  });
});

test("start records the Lead checkout's branch as the lead branch, and later Plans keep it", () => {
  const started = apply(
    undefined,
    C.Plan.make({
      constellationId: CID,
      start: { name: "Build", workspaceId: WS, leadSessionId: LEAD },
      operations: [PlanOperation.cases.Add.make({ task: task(A) })],
    }),
    ctx({ leadBranch: "integration" })
  );

  expect(started.graph.leadBranch).toBe("integration");

  const later = apply(
    started,
    C.Plan.make({
      constellationId: CID,
      operations: [PlanOperation.cases.Add.make({ task: task(B) })],
    }),
    ctx({ leadBranch: "someone-else" })
  );

  expect(later.graph.leadBranch).toBe("integration");
});

import { TaskId } from "@polaris/protocol";

const importId = (id: string) => TaskId.make(id);
