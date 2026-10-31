/** Subscribe before checking the Turn so a stop interrupts the active transaction and awaits rollback. */
import { DataError, type SessionId, type TurnId } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import { EventStore } from "../store/EventStore.ts";
import { workingTurn } from "../store/model.ts";

const ended = () =>
  new DataError({
    code: "E-DATA-DENIED",
    message: "The write's turn ended before it completed.",
    fix: "Inspect the Query Log before requesting the write in another turn.",
  });

export const duringWriteTurn = <A, E>(
  store: EventStore["Service"],
  sessionId: SessionId,
  turnId: TurnId,
  work: Effect.Effect<A, E>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const commits = yield* store.subscribe();

      const active = Effect.map(store.model, (model) => {
        const record = model.sessions.get(sessionId);

        return record !== undefined && workingTurn(record)?.id === turnId;
      });

      if (!(yield* active)) return yield* ended();

      const stopped = commits.pipe(
        Stream.mapEffect(() => active),
        Stream.filter((value) => !value),
        Stream.runHead,
        Effect.flatMap(() => Effect.fail(ended()))
      );

      return yield* Effect.raceFirst(work, stopped);
    })
  );
