import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Exit } from "effect";
import { duringWriteTurn } from "./writeTurn.ts";
import { approvalLayer, seedDataSession, started } from "./approvals.testing.ts";
import { EventStore } from "../store/EventStore.ts";
import { decideSession } from "../engine/session.ts";

test("Turn end interrupts an active write and awaits its rollback finalizer", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedDataSession;
        const store = yield* EventStore;
        const entered = yield* Deferred.make<void>();
        let rolledBack = false;

        const work = (signal: AbortSignal) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Effect.callback<void, Error>((resume) => {
              signal.addEventListener("abort", () => resume(Effect.fail(new Error("cancelled"))), {
                once: true,
              });
            });
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                rolledBack = true;
              })
            )
          );

        const running = yield* duringWriteTurn(
          store,
          started.session.id,
          started.turns[0]!.id,
          work
        ).pipe(Effect.forkChild);

        yield* Deferred.await(entered);
        yield* store.commit({
          commandId: null,
          decide: (model) =>
            Effect.succeed(
              decideSession(model.sessions.get(started.session.id), {
                type: "harness.turnEnded",
                turnId: started.turns[0]!.id,
                status: "completed",
                error: null,
                checkpoint: null,
                at: started.session.createdAt,
              }).events
            ),
        });
        const outcome = yield* Fiber.await(running);
        expect(Exit.isFailure(outcome)).toBe(true);
        expect(rolledBack).toBe(true);
      })
    ).pipe(Effect.provide(approvalLayer()))
  ));
