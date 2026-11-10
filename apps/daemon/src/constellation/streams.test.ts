import { expect, test } from "bun:test";
import {
  ConstellationId,
  ConstellationSettings,
  ConstellationStreamItem,
  PlanOperation,
  Sequence,
  SessionId,
  type ConstellationStreamItem as StreamItem,
} from "@polaris/protocol";
import { Effect, Fiber, Stream } from "effect";
import { B, C, CID, LEAD, WS, ctx, task } from "../engine/constellation.testing.ts";
import { decideConstellation } from "../engine/constellation.ts";
import { EventStore } from "../store/EventStore.ts";
import { subscribeConstellation } from "./streams.ts";

const OTHER = ConstellationId.make("c2");

const OTHER_LEAD = SessionId.make("other-lead");

const start = (id: ConstellationId, lead: SessionId) =>
  decideConstellation(
    undefined,
    C.Plan.make({
      constellationId: id,
      start: {
        name: id,
        workspaceId: WS,
        leadSessionId: lead,
        settings: ConstellationSettings.make({}),
      },
      operations: [PlanOperation.cases.Add.make({ task: task() })],
    }),
    ctx()
  ).events;

/** Commits `id`'s next Plan: a fresh one, or task B added to the one in the store. */
const plan = (id: ConstellationId, lead: SessionId) =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    const record = (yield* store.model).constellations.get(id);

    const events =
      record === undefined
        ? start(id, lead)
        : decideConstellation(
            record,
            C.Plan.make({
              constellationId: id,
              operations: [PlanOperation.cases.Add.make({ task: task(B) })],
            }),
            ctx()
          ).events;

    expect(events.length).toBeGreaterThan(0);
    yield* store.commit({ commandId: null, decide: () => Effect.succeed(events) });
  });

const eventsOf = (items: ReadonlyArray<StreamItem>) =>
  items.flatMap((item) =>
    ConstellationStreamItem.guards.Event(item) ? [item.envelope.event.constellationId] : []
  );

test("a Constellation's stream replays and follows only its own events", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* plan(CID, LEAD);
        yield* plan(OTHER, OTHER_LEAD);
        yield* plan(OTHER, OTHER_LEAD);
        const cut = Sequence.make((yield* store.model).sequence);

        const replayed = yield* subscribeConstellation(
          store,
          { kind: "user" },
          CID,
          Sequence.make(0)
        ).pipe(
          Stream.takeUntil((item) => ConstellationStreamItem.guards.Synchronized(item)),
          Stream.runCollect
        );

        expect(eventsOf(replayed).length).toBeGreaterThan(0);
        expect(new Set(eventsOf(replayed))).toEqual(new Set([CID]));

        const live = yield* subscribeConstellation(store, { kind: "user" }, CID, cut).pipe(
          Stream.filter((item) => ConstellationStreamItem.guards.Event(item)),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped
        );

        yield* Effect.yieldNow;
        yield* plan(ConstellationId.make("c3"), SessionId.make("third-lead"));
        yield* plan(CID, LEAD);

        expect(eventsOf(yield* Fiber.join(live))).toEqual([CID]);
      })
    ).pipe(Effect.provide(EventStore.layerSqlite(":memory:")))
  );
});
