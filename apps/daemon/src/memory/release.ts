/**
 * Hands memory back once the Daemon goes quiet after work. Streaming Turns
 * leave JavaScriptCore's allocator holding the pages of its peak (a heap of
 * 20 MiB live kept ~100 MiB dirty in the `sessions` bench), and file reads
 * leave garbage no collection may come for; a full collection and a shrink
 * return them. See docs/adr/0010-release-memory-when-quiet.md.
 */
import { Duration, Effect, Layer, Predicate, Stream } from "effect";
import { EventStore } from "../store/EventStore.ts";
import type { LiveItem } from "../store/hub.ts";
import { workingTurn } from "../store/model.ts";
import { clearFileReads, fileReadBursts } from "./fileReads.ts";

/** How long after the last Turn end or read burst, with no Turn in flight, the Daemon counts as quiet. */
export const QUIET_AFTER = Duration.seconds(2);

/** A full collection, then JavaScriptCore's shrink (it returns freed pages to the system). */
export const releaseMemory = Effect.sync(() => {
  Bun.gc(true);
  // bun-types marks it deprecated, with no replacement; the ADR says what to watch.
  Bun.shrink();
});

const isTurnEnd = (item: LiveItem) =>
  Predicate.isTagged(item, "Event") && Predicate.isTagged(item.envelope.event, "TurnEnded");

export interface ReleaseOptions {
  readonly quietAfter?: Duration.Input;
  readonly release?: Effect.Effect<void>;
}

/**
 * Runs `release` once per quiet spell: `quietAfter` after the last Turn end or
 * burst of file reads, if no Turn is in flight then. An idle Daemon never wakes for it.
 */
export const releaseWhenQuiet = (options: ReleaseOptions = {}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* EventStore;
      const release = Effect.andThen(Effect.sync(clearFileReads), options.release ?? releaseMemory);

      const quiet = Effect.map(store.model, (model) =>
        [...model.sessions.values()].every((record) => workingTurn(record) === undefined)
      );

      const follow = Stream.unwrap(store.subscribe({ filter: isTurnEnd })).pipe(
        Stream.merge(fileReadBursts, { haltStrategy: "left" }),
        Stream.debounce(options.quietAfter ?? QUIET_AFTER),
        Stream.runForEach(() => Effect.flatMap(quiet, (idle) => (idle ? release : Effect.void)))
      );

      // A subscription that fell behind ends; subscribe again.
      yield* Effect.forkScoped(Effect.forever(follow));
    })
  );
