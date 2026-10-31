/** Restart a best-effort live subscriber after overflow, without adding an idle timer. */
import { Effect, Predicate, Stream } from "effect";
import type { EventStore } from "../store/EventStore.ts";
import type { DataQueries, DataSources } from "./index.ts";
import { recordOutsideCommand } from "./outside.ts";

export const watchOutsideCommands = (
  store: Pick<EventStore["Service"], "subscribe">,
  sources: Pick<DataSources["Service"], "list" | "resolve">,
  queries: Pick<DataQueries["Service"], "recordOutside">
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const completed = yield* store.subscribe({
        filter: (item) =>
          Predicate.isTagged(item, "Event") &&
          Predicate.isTagged(item.envelope.event, "TurnItemCompleted") &&
          Predicate.isTagged(item.envelope.event.item, "CommandExecution"),
      });

      yield* completed.pipe(
        Stream.runForEach((item) =>
          Predicate.isTagged(item, "Event") &&
          Predicate.isTagged(item.envelope.event, "TurnItemCompleted")
            ? recordOutsideCommand(item.envelope.event, sources, queries).pipe(
                Effect.catch(() => Effect.logWarning("Couldn't record an outside Polaris command"))
              )
            : Effect.void
        )
      );
      yield* Effect.logWarning(
        "Outside Polaris command subscriber fell behind; resubscribing (some commands may be missing)"
      );
    })
  ).pipe(Effect.forever);
