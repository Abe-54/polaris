import { expect, test } from "bun:test";
import { Attempt, CommandId, WorktreeSetup } from "@polaris/protocol";
import { Effect, Exit, Layer, Struct } from "effect";
import { join } from "node:path";
import { CID, WS, draft } from "../engine/constellation.testing.ts";
import { withSessionInput } from "../engine/sessionBoundary.ts";
import { startAttempt } from "../constellation/composition/workers.ts";
import { finish, send, setup, world } from "../constellation/delivery/testing.ts";
import { ConstellationSessionEffects } from "../constellation/delivery/inputs.ts";
import { ConstellationRuntime } from "../constellation/runtime.ts";
import { WorktreeSetupService } from "../constellation/setup/index.ts";
import { tempDir, removeDir } from "../git/testing.ts";
import { EventStore } from "../store/EventStore.ts";

for (const crashBeforeMarker of [false, true])
  test(`failed-startup fence stays cleared after SQLite restart and replacing its setup card; crashBeforeMarker=${crashBeforeMarker}`, async () => {
    const root = tempDir();
    const file = join(root, "state.sqlite");

    const attempt = Attempt.make(
      Struct.assign(draft(), { worktree: root, startupSetup: { command: "exit 7", force: true } })
    );

    const runtime = Layer.succeed(ConstellationRuntime)({
      prepare: () =>
        Effect.succeed({
          attempts: [attempt],
          newLeadSessionId: null,
          recordedChecks: [],
          claimProbe: null,
        }),
      resumeWorking: () => Effect.void,
      afterCommit: () => Effect.void,
    });

    try {
      await world(file, { runtime }).run(
        Effect.gen(function* () {
          yield* setup();
          const store = yield* EventStore;
          const graph = (yield* store.model).constellations.get(CID)!.graph;

          if (crashBeforeMarker) {
            yield* (yield* WorktreeSetupService).run(
              attempt.sessionId,
              attempt.id,
              root,
              WorktreeSetup.cases.Command.make({ command: "exit 7" }),
              CID,
              attempt.taskId,
              WS
            );
          } else
            expect(Exit.isFailure(yield* startAttempt(graph, attempt).pipe(Effect.exit))).toBe(
              true
            );
          const marker = CommandId.make(`${attempt.id}:startup-failed`);
          expect(yield* store.hasCommandReceipt(marker)).toBe(!crashBeforeMarker);

          const events = yield* store
            .readEvents({ after: 0, upTo: (yield* store.model).sequence, sessionId: null })
            .pipe(Effect.orDie);

          expect(events.some((e) => e.commandId === marker)).toBe(!crashBeforeMarker);
        })
      );
      const restarted = world(file);
      await restarted.run(
        Effect.gen(function* () {
          const store = yield* EventStore;

          if (crashBeforeMarker) {
            const graph = (yield* store.model).constellations.get(CID)!.graph;
            expect(Exit.isFailure(yield* startAttempt(graph, attempt).pipe(Effect.exit))).toBe(
              true
            );
            expect(
              yield* store.hasCommandReceipt(CommandId.make(`${attempt.id}:startup-failed`))
            ).toBe(true);
          }

          yield* (yield* WorktreeSetupService).run(
            attempt.sessionId,
            "manual-repair",
            root,
            WorktreeSetup.cases.Command.make({ command: "exit 0" }),
            CID,
            attempt.taskId,
            WS
          );
          expect(
            (yield* store.model).sessions.get(attempt.sessionId)!.session.worktreeSetup?.status
          ).toBe("completed");
          expect(
            yield* withSessionInput(
              store,
              attempt.sessionId,
              Effect.succeed("input reached its decider")
            )
          ).toBe("input reached its decider");
          const graph = (yield* store.model).constellations.get(CID)!.graph;
          expect(Exit.isFailure(yield* startAttempt(graph, attempt).pipe(Effect.exit))).toBe(true);
          expect(restarted.turns).toHaveLength(0);
          expect(yield* store.hasCommandReceipt(CommandId.make(`${attempt.id}:start`))).toBe(false);
        })
      );
    } finally {
      removeDir(root);
    }
  });

test("ineligible startup receipt survives restart without a first-Turn receipt", async () => {
  const root = tempDir();
  const file = join(root, "state.sqlite");

  try {
    await world(file).run(
      Effect.gen(function* () {
        yield* setup();
        const store = yield* EventStore;
        const effects = yield* ConstellationSessionEffects;
        const graph = (yield* store.model).constellations.get(CID)!.graph;
        const attempt = graph.attempts.at(-1)!;
        let eligible = true;

        const stopped = yield* startAttempt(graph, attempt, () => Effect.succeed(eligible)).pipe(
          Effect.provideService(ConstellationSessionEffects, {
            ...effects,
            retire: () =>
              Effect.sync(() => {
                eligible = false;
              }),
          }),
          Effect.exit
        );

        expect(Exit.isFailure(stopped)).toBe(true);

        expect((yield* store.model).constellations.get(CID)!.graph.attempts.at(-1)!.state).toBe(
          "working"
        );
        expect(yield* store.hasCommandReceipt(CommandId.make(`${attempt.id}:startup-failed`))).toBe(
          true
        );
        expect(yield* store.hasCommandReceipt(CommandId.make(`${attempt.id}:start`))).toBe(false);
      })
    );
    const restarted = world(file);
    await restarted.run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        const graph = (yield* store.model).constellations.get(CID)!.graph;
        const attempt = graph.attempts.at(-1)!;
        expect((yield* store.model).sessions.get(attempt.sessionId)!.session.state).toBe("idle");
        expect((yield* store.model).sessions.get(attempt.sessionId)!.session.lastError).toBeNull();
        yield* send(attempt.sessionId, "After startup rejection");
        yield* finish(attempt.sessionId);
        expect((yield* store.model).sessions.get(attempt.sessionId)!.session.state).toBe("idle");
        expect(
          yield* withSessionInput(store, attempt.sessionId, Effect.succeed("input proceeds"))
        ).toBe("input proceeds");
        expect(Exit.isFailure(yield* startAttempt(graph, attempt).pipe(Effect.exit))).toBe(true);
        expect(restarted.turns).toHaveLength(0);
        expect(yield* store.hasCommandReceipt(CommandId.make(`${attempt.id}:start`))).toBe(false);
      })
    );
  } finally {
    removeDir(root);
  }
});
