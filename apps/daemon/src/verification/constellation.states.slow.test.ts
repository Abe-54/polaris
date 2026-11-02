import { expect, test } from "bun:test";
import { Match, Struct } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CheckReceipt,
  Claim,
  PlanOperation,
  ReviewAction,
  ToolCallReference,
  TurnId,
  TurnItem,
  WorkerPlacement,
  type ConstellationCommand,
  type DomainEvent,
  type EvidenceTier,
} from "@polaris/protocol";
import { decideConstellation } from "../engine/constellation.ts";
import {
  A,
  B,
  C,
  CID,
  HOST,
  LEAD,
  WS,
  ctx,
  draft,
  foldDecision,
  report,
  task,
} from "../engine/constellation.testing.ts";
import type { ConstellationContext } from "../engine/constellation.inputs.ts";
import { graphEvent, foldConstellation, type ConstellationRecord } from "../store/constellation.ts";
import { projectTasks } from "../constellation/projections.ts";
import {
  emptyReference,
  foldReference,
  referenceState,
} from "./constellation.reference.testing.ts";

const check = new ToolCallReference({
  hostId: HOST,
  sessionId: LEAD,
  turnId: TurnId.make("check"),
  itemId: "check",
});

const checked = TurnItem.cases.CommandExecution.make({
  id: "check",
  command: "bun test",
  cwd: "/tmp",
  output: "passed",
  exitCode: 0,
  status: "completed",
});

for (const tier of ["verified", "reported", "asserted"] satisfies ReadonlyArray<EvidenceTier>) {
  test(`unstarted Tasks become ready after accepted ${tier} evidence; restart preserves the model`, () => {
    const reference = emptyReference();

    let record: ConstellationRecord | undefined;

    const batches: Array<{ hostId: string; events: ReadonlyArray<DomainEvent> }> = [];

    const run = (command: ConstellationCommand, context: ConstellationContext = ctx()) => {
      const decision = decideConstellation(record, command, context);

      expect(decision.rejection).toBeNull();
      record = foldDecision(record, decision.events);
      foldReference(reference, decision.events);
      batches.push({ hostId: HOST, events: decision.events });

      for (const p of projectTasks(record))
        expect(p.state).toBe(referenceState(reference, p.taskId));

      return record;
    };

    const initial = run(
      C.Plan.make({
        constellationId: CID,
        start: { name: "states", workspaceId: WS, leadSessionId: LEAD, settings: ctx().defaults },
        operations: [task(A), task(B, [A])].map((t) => PlanOperation.cases.Add.make({ task: t })),
      })
    );

    expect(projectTasks(initial).map((p) => p.state)).toEqual(["ready", "waiting"]);

    const attempt = draft();
    run(
      C.Dispatch.make({
        constellationId: CID,
        tasks: [
          {
            taskId: A,
            worker: WorkerPlacement.cases.Existing.make({ sessionId: attempt.sessionId }),
          },
        ],
      }),
      ctx({ attempts: [attempt] })
    );

    const receipts = Match.value(tier).pipe(
      Match.when("verified", () => [
        CheckReceipt.cases.Verified.make({ label: "test", item: check }),
      ]),
      Match.when("reported", () => [
        CheckReceipt.cases.Reported.make({ label: "test", text: "Passed" }),
      ]),
      Match.when("asserted", () => []),
      Match.exhaustive
    );

    const claim = new Claim({ ...Struct.omit(report(), []), receipts });

    const reviewed = run(
      C.WorkerClaim.make({ constellationId: CID, attemptId: attempt.id, claim }),
      ctx({
        binding: { kind: "session", sessionId: attempt.sessionId },
        claimProbe: { branch: claim.branch, head: claim.head, dirtyPaths: [] },
      })
    );

    expect(projectTasks(reviewed).map((p) => p.state)).toEqual(["review", "waiting"]);

    const accepted = run(
      C.Review.make({
        constellationId: CID,
        attemptId: attempt.id,
        revision: reviewed.graph.attempts[0]!.revision,
        action: ReviewAction.cases.Accept.make({ mergedHead: claim.head, receipts: [] }),
      }),
      ctx({ recordedChecks: [{ reference: check, item: checked }] })
    );

    expect(accepted.graph.attempts[0]).toMatchObject({ state: "accepted", evidence: tier });

    expect(projectTasks(accepted).map((p) => p.state)).toEqual(["done", "ready"]);

    let restored: ConstellationRecord | undefined;

    for (const batch of batches)
      for (const event of batch.events) {
        const graph = graphEvent(event);

        if (graph !== null) restored = foldConstellation(restored, graph, accepted.graph.updatedAt);
      }

    expect(projectTasks(restored!)).toEqual(projectTasks(accepted));

    if (process.env.POLARIS_TRACE_DIR !== undefined) {
      mkdirSync(process.env.POLARIS_TRACE_DIR, { recursive: true });
      writeFileSync(
        join(process.env.POLARIS_TRACE_DIR, `states-${tier}.json`),
        JSON.stringify({ version: 1, ownerHostId: HOST, batches })
      );
    }
  });
}
