import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  Attempt,
  CommandId,
  Constellation,
  ConstellationId,
  DomainEvent,
  PreparedWorktree,
  TurnId,
  WorkerPlacement,
} from "@polaris/protocol";
import { Effect, Exit, Fiber, Latch, Struct } from "effect";
import { C, CID, HOST, draft } from "../../engine/constellation.testing.ts";
import { EventStore } from "../../store/EventStore.ts";
import { Constellations } from "../service.ts";
import { finish, send, setup, world } from "../delivery/testing.ts";
import { sendbackWorld } from "../../mcp/sendback.testing.ts";
import { restartForRetry } from "../../mcp/sendback.restart.testing.ts";
import { recordSendbackTrace } from "../../mcp/sendback.trace.testing.ts";
import { WorktreeSetupService } from "../setup/index.ts";
import { HarnessRegistry } from "../../services.ts";
import { makeFakeDriver } from "../../engine/testing.ts";
import { prepareSession } from "./prepare.ts";
import { startAttempt, startPendingAttempt } from "./workers.ts";

import { sendBack } from "./sendback.testing.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

test("same-session busy SendBack commits now, skips setup, and delivers once at the boundary", async () => {
  const w = sendbackWorld(":memory:", false);
  await w.run(
    Effect.gen(function* () {
      yield* setup();
      yield* send(draft().sessionId);
      const store = yield* EventStore;
      const graph = (yield* store.model).constellations.get(CID)!.graph;
      const previous = graph.attempts[0]!;

      const prepared = yield* prepareSession(
        {
          key: "busy-prepare",
          graph,
          task: graph.tasks[0]!,
          previous: Attempt.make(Struct.assign(previous, { worktree: "/tmp" })),
          placement: WorkerPlacement.cases.Existing.make({ sessionId: previous.sessionId }),
          worktree: new PreparedWorktree({
            repoPath: "/tmp",
            worktree: "/tmp",
            branch: previous.branch,
            base: previous.base,
            managed: false,
            managedBranch: false,
          }),
        },
        HOST
      ).pipe(
        Effect.provideService(WorktreeSetupService, {
          run: () => Effect.die("setup must not run on a reused worktree"),
          authorize: () => Effect.void,
        }),
        Effect.provideService(HarnessRegistry, {
          get: () => Effect.succeed(makeFakeDriver("codex").driver),
          all: Effect.succeed([]),
        })
      );
      // The fixture's declared worktree is deliberately normalized to the existing Session cwd.

      expect(prepared.sessionId).toBe(previous.sessionId);
      const attempt = yield* sendBack();
      const current = (yield* store.model).constellations.get(CID)!.graph;
      expect(current.attempts[0]!.state).toBe("rejected");
      expect(attempt.state).toBe("working");
      const began = Latch.makeUnsafe(false);

      const startup = yield* Effect.andThen(Latch.open(began), startAttempt(current, attempt)).pipe(
        Effect.forkChild
      );

      yield* began.await;
      yield* Effect.yieldNow;
      expect(w.turns).toHaveLength(0);
      expect(w.retired).toHaveLength(0);
      expect(yield* store.hasCommandReceipt(CommandId.make(`${attempt.id}:start`))).toBe(false);
      yield* finish(attempt.sessionId);
      yield* Fiber.join(startup);
      yield* startPendingAttempt(current, attempt);
      expect(w.turns).toHaveLength(1);
      expect(w.turns[0]!.prompt).toContain("Review feedback from the user:\nFinish the cleanup");
      yield* recordSendbackTrace("busy-boundary");
    })
  );
});

for (const retry of [false, true])
  test(`production Daemon restart delivers pending ${retry ? "SendBack" : "Initial"} over an interrupted prior Turn`, async () => {
    const root = newTempDir("polaris-busy-restart-", { short: true });

    try {
      const w = sendbackWorld(join(root, "state.sqlite"), false);

      const attempt = await w.run(
        Effect.gen(function* () {
          yield* setup();
          const store = yield* EventStore;
          const initial = (yield* store.model).constellations.get(CID)!.graph.attempts[0]!;
          yield* send(initial.sessionId, "Earlier Session work");

          return retry ? yield* sendBack() : initial;
        })
      );

      const turn = await restartForRetry(root, attempt, undefined, true);
      expect(turn.id).toBe(TurnId.make(`${attempt.id}:start`));
      const resumed = sendbackWorld(join(root, "state.sqlite"), false);
      await resumed.run(
        Effect.gen(function* () {
          const store = yield* EventStore;
          expect(yield* store.hasCommandReceipt(CommandId.make(`${attempt.id}:start`))).toBe(true);
          const turns = (yield* store.model).sessions.get(attempt.sessionId)!.turns;
          expect(turns.filter((t) => t.id === `${attempt.id}:start`)).toHaveLength(1);
          expect(turns[0]!.status).toBe("interrupted");
          yield* recordSendbackTrace(`busy-restart-${retry}`);
        })
      );
    } finally {
      removeTempDir(root);
    }
  }, 20000);

for (const local of [false, true])
  test(`blocked startup writes no empty receipt and starts after unblock: local=${local}`, async () => {
    const w = world();
    await w.run(
      Effect.gen(function* () {
        yield* setup();
        const store = yield* EventStore;
        const graph = (yield* store.model).constellations.get(CID)!.graph;
        const attempt = graph.attempts[0]!;

        const blocked = Constellation.make(
          Struct.assign(graph, {
            attempts: [Attempt.make(Struct.assign(attempt, { state: "blocked" as const }))],
          })
        );

        if (local)
          yield* (yield* Constellations).command(
            { kind: "session", sessionId: attempt.sessionId },
            CommandId.make("block"),
            C.WorkerBlock.make({
              constellationId: CID,
              attemptId: attempt.id,
              on: [],
              reason: "Wait",
            })
          );
        else
          yield* store.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([
                DomainEvent.cases.ConstellationStateChanged.make({
                  constellationId: CID,
                  revision: graph.revision + 1,
                  state: "archived",
                }),
              ]),
          });
        // A worker Host has no local owner graph; use a distinct graph id to exercise the assignment guard.

        const supplied = local
          ? blocked
          : Constellation.make(Struct.assign(blocked, { id: ConstellationId.make("remote") }));

        yield* startPendingAttempt(supplied, supplied.attempts[0]!);
        expect(yield* store.hasCommandReceipt(CommandId.make(`${attempt.id}:start`))).toBe(false);
        expect(w.turns).toHaveLength(0);
        const working = Constellation.make(Struct.assign(supplied, { attempts: [attempt] }));

        if (local)
          yield* store.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([
                DomainEvent.cases.AttemptUnblocked.make({
                  constellationId: CID,
                  revision: graph.revision + 2,
                  attemptId: attempt.id,
                  attemptRevision: attempt.revision + 2,
                  cause: "Lead",
                  at: new Date().toISOString(),
                }),
              ]),
          });
        yield* startPendingAttempt(working, attempt);
        expect(w.turns).toHaveLength(1);
        expect(yield* store.hasCommandReceipt(CommandId.make(`${attempt.id}:start`))).toBe(true);
      })
    );
  });

test("startup rechecks remote assignment eligibility at the boundary without a success receipt", async () => {
  const w = world();
  await w.run(
    Effect.gen(function* () {
      yield* setup();
      const store = yield* EventStore;
      const graph = (yield* store.model).constellations.get(CID)!.graph;
      const attempt = graph.attempts[0]!;
      yield* send(attempt.sessionId);
      let eligible = true;
      const entered = Latch.makeUnsafe(false);

      const startup = yield* startAttempt(graph, attempt, () =>
        Effect.sync(() => {
          entered.openUnsafe();

          return eligible;
        })
      ).pipe(Effect.forkChild);

      yield* entered.await;
      eligible = false;
      yield* finish(attempt.sessionId);
      yield* Fiber.join(startup);
      expect(yield* store.hasCommandReceipt(CommandId.make(`${attempt.id}:start`))).toBe(false);
      expect(w.turns).toHaveLength(0);
      expect(w.retired).toHaveLength(0);
    })
  );
});

test("assignment invalidated during startup commit cannot create an empty successful receipt", async () => {
  const w = world();

  await w.run(
    Effect.gen(function* () {
      yield* setup();
      const store = yield* EventStore;
      const graph = (yield* store.model).constellations.get(CID)!.graph;
      const attempt = graph.attempts[0]!;
      let probes = 0;

      const result = yield* startAttempt(graph, attempt, () =>
        Effect.sync(() => ++probes < 3)
      ).pipe(Effect.exit);

      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* store.hasCommandReceipt(CommandId.make(`${attempt.id}:startup-failed`))).toBe(
        true
      );
      expect(probes).toBe(3);
      expect(yield* store.hasCommandReceipt(CommandId.make(`${attempt.id}:start`))).toBe(false);
      expect(w.turns).toHaveLength(0);
    })
  );
});
