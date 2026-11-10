import { expect, test } from "bun:test";
import { join } from "node:path";
import { DomainEvent, SuggestedReplySettings, type Turn } from "@polaris/protocol";
import { Effect, Layer, Stream, SubscriptionRef } from "effect";
import { Availability } from "../harness/availability/Availability.ts";
import { tempDir } from "../platform/tempDir.testing.ts";
import { EventStore } from "../store/EventStore.ts";
import type { ReplyBackend } from "./backend.ts";
import { lazySuggestedRepliesWith } from "./lazy.ts";
import { agentSession, report, turn, workspace } from "./testing.ts";

const settings = (enabled: boolean) => SuggestedReplySettings.make({ enabled, fallback: null });

const commitAll = (events: ReadonlyArray<DomainEvent>) =>
  Effect.flatMap(EventStore, (store) =>
    store.commit({ commandId: null, decide: () => Effect.succeed(events) })
  );

const finished = (t: Turn) => [
  DomainEvent.cases.TurnStarted.make({ turn: turn(t.index, "working") }),
  DomainEvent.cases.TurnEnded.make({ turn: t }),
];

test("the fallback starts when the preference is turned on after start-up", async () => {
  const asked: Array<string> = [];
  const offered: Array<string> = [];

  const backend: ReplyBackend = (harness) =>
    Effect.sync(() => {
      asked.push(harness);

      return { reply: "Go ahead." };
    });

  const program = Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make(settings(false));

    const lazy = lazySuggestedRepliesWith(
      {
        changes: SubscriptionRef.changes(ref),
        settings: SubscriptionRef.get(ref),
        offer: (_, turnId) => Effect.sync(() => void offered.push(turnId)),
      },
      { backend }
    );

    const store = EventStore.layerSqlite(join(tempDir("polaris-lazy-"), "state.sqlite"));

    const availability = Layer.succeed(Availability)(
      Availability.of({ get: () => Effect.succeed(report("codex")), changes: Stream.empty })
    );

    const layer = lazy.pipe(Layer.provideMerge(store), Layer.provide(availability));

    yield* Effect.scoped(
      Effect.gen(function* () {
        const built = yield* Layer.build(layer);

        const commit = (events: ReadonlyArray<DomainEvent>) =>
          commitAll(events).pipe(Effect.provideContext(built));

        yield* commit([
          DomainEvent.cases.WorkspaceRegistered.make({ workspace }),
          DomainEvent.cases.SessionCreated.make({ session: agentSession() }),
          ...finished(turn(0)),
          ...finished(turn(1)),
        ]);

        yield* SubscriptionRef.set(ref, settings(true));

        // The writer loads in the background: Turns that end before it follows the log are missed.
        for (let next = 2; next < 200 && offered.length === 0; next++) {
          yield* commit(finished(turn(next)));
          yield* Effect.sleep("10 millis");
        }
      })
    );
  });

  await Effect.runPromise(program);

  expect(asked).toEqual(["codex"]);
  expect(offered).toHaveLength(1);
});
