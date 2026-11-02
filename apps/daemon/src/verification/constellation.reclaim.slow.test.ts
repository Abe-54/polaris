import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  Attempt,
  Claim,
  CommandId,
  ConstellationQuestion,
  MessageTarget,
  ReviewAction,
} from "@polaris/protocol";
import { Effect, Layer, Predicate, Result, Struct } from "effect";
import { C, CID, draft, report } from "../engine/constellation.testing.ts";
import { gitText } from "../git/git.ts";
import { commitAll, makeRepo, removeDir, write } from "../git/testing.ts";
import { EventStore } from "../store/EventStore.ts";
import { Constellations } from "../constellation/service.ts";
import { ConstellationRuntime } from "../constellation/runtime.ts";
import { ConstellationWorktrees } from "../constellation/worktrees.ts";
import { TransferStorage } from "../constellation/transfers/storage.ts";
import { setup, world } from "../constellation/delivery/testing.ts";
import { recordSendbackTrace } from "../mcp/sendback.trace.testing.ts";

const gitRuntime = (root: string) =>
  Layer.effect(
    ConstellationRuntime,
    Effect.gen(function* () {
      const trees = yield* ConstellationWorktrees;

      return ConstellationRuntime.of({
        prepare: Effect.fnUntraced(function* (_binding, command, model) {
          const attempt = model.constellations.get(CID)?.graph.attempts.at(-1);

          const probe =
            Predicate.isTagged(command, "WorkerClaim") && attempt !== undefined
              ? yield* trees.probeClaim(attempt).pipe(Effect.orDie)
              : null;

          return {
            attempts: [Attempt.make(Struct.assign(draft(), { worktree: root }))],
            newLeadSessionId: null,
            recordedChecks: [],
            claimProbe: probe,
          };
        }),
        resumeWorking: () => Effect.void,
        afterCommit: () => Effect.void,
      });
    })
  ).pipe(
    Layer.provide(
      ConstellationWorktrees.layer.pipe(
        Layer.provide(TransferStorage.layer(":memory:").pipe(Layer.orDie))
      )
    )
  );

test("real Git re-claim after a Lead message persists both Claims across SQLite restart", async () => {
  const root = await makeRepo({ "README.md": "first\n", ".gitignore": "*.sqlite*\n" });

  try {
    await gitText(root, ["checkout", "-qb", draft().branch]);
    const file = join(root, "state.sqlite");
    const runtime = gitRuntime(root);
    const w = world(file, { runtime });
    let oldHead = "";
    let newHead = "";
    let previousRevision = 0;

    const question = ConstellationQuestion.make({
      id: "review-decision",
      to: "lead",
      text: "Choose the cleanup",
      blocking: true,
    });

    const withQuestion = (head: string) =>
      Claim.make(Struct.assign(report(draft().branch, head), { questions: [question] }));

    await w.run(
      Effect.gen(function* () {
        yield* setup();
        const graphs = yield* Constellations;
        const store = yield* EventStore;
        const binding = { kind: "session" as const, sessionId: draft().sessionId };
        oldHead = yield* Effect.promise(() => gitText(root, ["rev-parse", "HEAD"]));
        yield* graphs.command(
          binding,
          CommandId.make("claim-first"),
          C.WorkerClaim.make({
            constellationId: CID,
            attemptId: draft().id,
            claim: withQuestion(oldHead),
          })
        );
        yield* graphs.command(
          { kind: "user" },
          CommandId.make("approve"),
          C.Review.make({
            constellationId: CID,
            attemptId: draft().id,
            revision: (yield* store.model).constellations.get(CID)!.graph.attempts[0]!.revision,
            action: ReviewAction.cases.Approve.make({}),
          })
        );
        previousRevision = (yield* store.model).constellations.get(CID)!.graph.attempts[0]!
          .revision;
        yield* graphs.command(
          { kind: "user" },
          CommandId.make("steer"),
          C.Message.make({
            constellationId: CID,
            target: MessageTarget.cases.Worker.make({ attemptId: draft().id }),
            text: "Make the cleanup change",
          })
        );
        yield* Effect.promise(async () => {
          write(root, "README.md", "cleanup applied\n");
          newHead = await commitAll(root, "cleanup");
        });
        yield* graphs.command(
          binding,
          CommandId.make("claim-revised"),
          C.WorkerClaim.make({
            constellationId: CID,
            attemptId: draft().id,
            claim: withQuestion(newHead),
          })
        );
        expect((yield* store.model).constellations.get(CID)!.graph.attempts).toHaveLength(1);
        yield* recordSendbackTrace("reclaim-git");
      })
    );

    await world(file, { runtime }).run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        const model = yield* store.model;
        const attempt = model.constellations.get(CID)!.graph.attempts[0]!;
        expect(attempt.claim?.head).toBe(newHead);
        expect(attempt.approvedByUserAt).toBeNull();
        const questions = [...model.constellations.get(CID)!.questions.values()];
        expect(questions).toHaveLength(1);
        expect(questions[0]).toMatchObject({ question, answer: null });
        expect(attempt.revision).toBe(previousRevision + 1);

        const events = yield* store.readConstellationEvents({
          constellationId: CID,
          after: 0,
          upTo: model.sequence,
        });

        expect(
          events.flatMap(({ event }) =>
            Predicate.isTagged(event, "AttemptClaimed") ? [event.claim.head] : []
          )
        ).toEqual([oldHead, newHead]);

        expect(
          events.filter(
            ({ event }) =>
              Predicate.isTagged(event, "NotificationQueued") &&
              Predicate.isTagged(event.notification.item, "Question")
          )
        ).toHaveLength(1);

        const rejected = yield* Effect.result(
          (yield* Constellations).command(
            { kind: "user" },
            CommandId.make("old-accept"),
            C.Review.make({
              constellationId: CID,
              attemptId: attempt.id,
              revision: previousRevision,
              action: ReviewAction.cases.Accept.make({ mergedHead: oldHead, receipts: [] }),
            })
          )
        );

        expect(Result.isFailure(rejected)).toBe(true);

        if (Result.isFailure(rejected))
          expect(rejected.failure.findings[0]?.code).toBe("E-REVISION");
        yield* recordSendbackTrace("reclaim-git-restart");
      })
    );
  } finally {
    removeDir(root);
  }
});
