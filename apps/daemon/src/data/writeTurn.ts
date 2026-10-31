/** Turn end cancels the statement; settlement still records a COMMIT already in flight. */
import { DataError, type SessionId, type TurnId } from "@polaris/protocol";
import { Effect, Fiber, Stream } from "effect";
import { EventStore } from "../store/EventStore.ts";
import { workingTurn } from "../store/model.ts";

const ended = () =>
  new DataError({
    code: "E-DATA-DENIED",
    message: "The write's turn ended before it completed.",
    fix: "Inspect the Query Log before requesting the write in another turn.",
  });

export const settleWrite = <A, E>(work: (signal: AbortSignal) => Effect.Effect<A, E>) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const fiber = yield* work(controller.signal).pipe(Effect.uninterruptible, Effect.forkChild);

      return yield* restore(Fiber.join(fiber)).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            controller.abort();
            yield* Fiber.await(fiber);
          })
        )
      );
    })
  );

export const duringWriteTurn = <A, E>(
  store: EventStore["Service"],
  sessionId: SessionId,
  turnId: TurnId,
  work: (signal: AbortSignal) => Effect.Effect<A, E>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const commits = yield* store.subscribe();

      const active = Effect.map(store.model, (model) => {
        const record = model.sessions.get(sessionId);

        return record !== undefined && workingTurn(record)?.id === turnId;
      });

      if (!(yield* active)) return yield* ended();
      const controller = new AbortController();
      yield* commits.pipe(
        Stream.mapEffect(() => active),
        Stream.filter((value) => !value),
        Stream.runHead,
        Effect.tap(() => Effect.sync(() => controller.abort())),
        Effect.forkScoped
      );

      return yield* settleWrite((signal) => work(AbortSignal.any([signal, controller.signal])));
    })
  );
