/**
 * The fallback writer, loaded the first time the Host preference is on (ENG-886): a Daemon
 * with Suggested Replies off never loads `service.ts` or its runners, nor follows the log.
 */
import type { SuggestedReplySettings } from "@polaris/protocol";
import { Context, Effect, Layer, Option, Stream } from "effect";
import { Engine } from "../engine/Engine.ts";
import { Availability } from "../harness/availability/Availability.ts";
import { EventStore } from "../store/EventStore.ts";
import { UsageIndex } from "../usage/service.ts";
import type { SuggestedRepliesOptions, SuggestedReplySeams } from "./service.ts";

/** What starts the writer: the preference's changes, and the seams it then runs on. */
export interface LazySeams extends SuggestedReplySeams {
  readonly changes: Stream.Stream<SuggestedReplySettings>;
}

/** Starts the writer on `seams` once `changes` first says it's on. */
export const lazySuggestedRepliesWith = (seams: LazySeams, options: SuggestedRepliesOptions = {}) =>
  Layer.fromBuild((memoMap, scope) =>
    Effect.gen(function* () {
      const needed = yield* Effect.context<EventStore | Availability>();
      const usage = yield* Effect.serviceOption(UsageIndex);

      const start = Effect.gen(function* () {
        const { SuggestedReplies } = yield* Effect.promise(() => import("./service.ts"));
        const layer = SuggestedReplies.layerWith({ ...options, ...seams });

        yield* Layer.buildWithMemoMap(layer, memoMap, scope).pipe(
          Effect.provideContext(needed),
          Option.isSome(usage) ? Effect.provideService(UsageIndex, usage.value) : (e) => e
        );
      });

      yield* seams.changes.pipe(
        Stream.filter((settings) => settings.enabled),
        Stream.take(1),
        Stream.runForEach(() => start),
        Effect.catchCause((cause) => Effect.logWarning("suggested replies didn't start", cause)),
        Effect.forkIn(scope)
      );

      return Context.empty();
    })
  );

/** The Daemon's: on the Engine's preference and its offer of a Suggested Reply. */
export const lazySuggestedReplies = Layer.unwrap(
  Effect.map(Engine, (engine) =>
    lazySuggestedRepliesWith({
      changes: engine.suggestedReplies.changes,
      settings: engine.suggestedReplies.current,
      offer: engine.offerSuggestedReply,
    })
  )
);
