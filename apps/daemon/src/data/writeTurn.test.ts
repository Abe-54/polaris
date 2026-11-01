import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Exit } from "effect";
import { DomainEvent } from "@polaris/protocol";
import { duringWriteTurn } from "./writeTurn.ts";
import { approvalLayer, seedDataSession, started } from "./approvals.testing.ts";
import { EventStore, LiveItem } from "../store/EventStore.ts";
import { decideSession } from "../engine/session.ts";

test("an active write does not read the model for Deltas or unrelated events", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedDataSession;
        const store = yield* EventStore;
        const entered = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        let reads = 0;

        const running = yield* duringWriteTurn(
          { ...store, model: Effect.tap(store.model, () => Effect.sync(() => reads++)) },
          started.session.id,
          started.turns[0]!.id,
          () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish)))
        ).pipe(Effect.forkChild);

        yield* Deferred.await(entered);

        for (let n = 0; n < 64; n++)
          yield* store.publishEphemeral(
            LiveItem.Delta({
              sessionId: started.session.id,
              turnId: started.turns[0]!.id,
              itemId: "streaming-message",
              field: "text",
              text: "delta",
              subagentId: null,
            })
          );

        yield* store.commit({
          commandId: null,
          decide: () =>
            Effect.succeed([
              DomainEvent.cases.SessionRenamed.make({
                sessionId: started.session.id,
                title: "Unrelated change",
              }),
            ]),
        });
        yield* Effect.sleep(10);
        const readsAfterNoise = reads;
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(running);
        expect(readsAfterNoise).toBe(1);
      })
    ).pipe(Effect.provide(approvalLayer()))
  ));

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
