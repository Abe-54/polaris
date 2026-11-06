import { expect, test } from "bun:test";
import {
  CommandId,
  ConstellationStreamItem,
  ConstellationSettings,
  PlanOperation,
  Sequence,
  SessionId,
  TurnId,
  TurnItem,
} from "@polaris/protocol";
import { Context, Effect, Layer, Stream } from "effect";
import {
  C,
  CID,
  LEAD,
  WS,
  ctx,
  draft,
  foldDecision,
  task,
} from "../engine/constellation.testing.ts";
import { decideConstellation } from "../engine/constellation.ts";
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import { EventStore } from "../store/EventStore.ts";
import { ConstellationLiveness } from "./liveness.ts";
import { projectTasks, enrichProjections } from "./projections.ts";
import { subscribeConstellation } from "./streams.ts";

const seed = Effect.gen(function* () {
  const store = yield* EventStore;

  const plan = decideConstellation(
    undefined,
    C.Plan.make({
      constellationId: CID,
      start: {
        name: "live",
        workspaceId: WS,
        leadSessionId: LEAD,
        settings: ConstellationSettings.make({}),
      },
      operations: [PlanOperation.cases.Add.make({ task: task() })],
    }),
    ctx()
  );

  const dispatch = decideConstellation(
    foldDecision(undefined, plan.events),
    C.Dispatch.make({ constellationId: CID }),
    ctx({ attempts: [draft()] })
  );

  yield* store.commit({
    commandId: null,
    decide: () => Effect.succeed([...plan.events, ...dispatch.events]),
  });

  return (yield* store.model).constellations.get(CID)!;
});

const layer = ConstellationLiveness.layer.pipe(
  Layer.provideMerge(EventStore.layerSqlite(":memory:"))
);

test("observations and queued input publish live facts without changing revisions or the log", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const record = yield* seed;
        const store = yield* EventStore;
        const feed = yield* ConstellationLiveness;
        const before = (yield* store.model).sequence;
        const updates = yield* feed.subscribe(CID);
        const turnId = TurnId.make("tool-turn");

        const item = TurnItem.cases.CommandExecution.make({
          id: "cmd",
          command: "bun test",
          cwd: "/tmp",
          output: "",
          exitCode: null,
          status: "running",
        });

        yield* feed.observe(draft().sessionId, HarnessEvent.ItemUpdated({ turnId, item }), 1000);
        yield* feed.observe(
          draft().sessionId,
          HarnessEvent.ContextUsed({ usedTokens: 40, windowTokens: 100 }),
          2000
        );
        yield* feed.queued(draft().sessionId, 2);
        const observed = yield* updates.pipe(Stream.take(3), Stream.runCollect);
        expect(observed.at(-1)?.liveness).toMatchObject({
          current: { startedAt: 1000, command: "bun test" },
          contextPercent: 40,
          queuedInput: 2,
          // The Session has no Turn in flight: a running tool fact alone never says "working".
          activeTurn: false,
        });
        expect(projectTasks(record)[0]?.liveness).toBeNull();
        expect(enrichProjections(record, yield* feed.read(record))[0]?.liveness?.queuedInput).toBe(
          2
        );
        yield* feed.observe(
          draft().sessionId,
          HarnessEvent.ItemCompleted({
            turnId,
            item: TurnItem.cases.CommandExecution.make({
              id: "cmd",
              command: "bun test",
              cwd: "/tmp",
              output: "passed",
              exitCode: 0,
              status: "completed",
            }),
          }),
          3000
        );
        expect((yield* feed.read(record)).get(draft().id)?.current).toBeNull();
        expect((yield* store.model).sequence).toBe(before);
        expect((yield* store.model).constellations.get(CID)?.graph.revision).toBe(
          record.graph.revision
        );
      })
    ).pipe(Effect.provide(layer))
  );
});

test("resume seeds current liveness after Synchronized, and a subscriber with no cursor gets Snapshot, Synchronized, then liveness", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const record = yield* seed;
        const store = yield* EventStore;
        const feed = yield* ConstellationLiveness;
        yield* feed.queued(draft().sessionId, 3);
        const after = Sequence.make((yield* store.model).sequence);

        const current = yield* subscribeConstellation(
          store,
          { kind: "user" },
          CID,
          after,
          feed
        ).pipe(Stream.take(2), Stream.runCollect);

        expect(ConstellationStreamItem.isAnyOf(["Synchronized"])(current[0]!)).toBe(true);
        expect(ConstellationStreamItem.isAnyOf(["LivenessChanged"])(current[1]!)).toBe(true);
        expect(current[1]).toMatchObject({
          attemptId: draft().id,
          liveness: { queuedInput: 3 },
        });

        const older = yield* subscribeConstellation(store, { kind: "user" }, CID, null, feed).pipe(
          Stream.take(3),
          Stream.runCollect
        );

        expect(older.map((item) => item._tag)).toEqual([
          "Snapshot",
          "Synchronized",
          "LivenessChanged",
        ]);
        expect(enrichProjections(record, new Map())[0]?.liveness).toBeNull();
      })
    ).pipe(Effect.provide(layer))
  );
});

test("a Session that never ran an Attempt is observed without reading the model; a worker still publishes", async () => {
  let modelReads = 0;

  const counting = Layer.effect(
    EventStore,
    Effect.gen(function* () {
      const store = yield* EventStore;

      return EventStore.of({
        ...store,
        model: Effect.suspend(() => {
          modelReads++;

          return store.model;
        }),
      });
    })
  ).pipe(Layer.provide(EventStore.layerSqlite(":memory:")));

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed;
        const feed = yield* ConstellationLiveness;
        const updates = yield* feed.subscribe(CID);
        const turnId = TurnId.make("delta-turn");
        const delta = HarnessEvent.ItemDelta({ turnId, itemId: "m", field: "text", text: "hi" });
        modelReads = 0;

        for (let at = 0; at < 100; at++) yield* feed.observe(SessionId.make("plain"), delta, at);
        yield* feed.queued(SessionId.make("plain"), 1);
        expect(modelReads).toBe(0);

        yield* feed.observe(draft().sessionId, delta, 500);
        expect(modelReads).toBeGreaterThan(0);
        const [update] = yield* updates.pipe(Stream.take(1), Stream.runCollect);
        expect(update).toMatchObject({ attemptId: draft().id, liveness: { lastOutputAt: 500 } });
      })
    ).pipe(Effect.provide(ConstellationLiveness.layer.pipe(Layer.provideMerge(counting))))
  );
});

test("a producer captured before lazy activation uses the activated per-Daemon liveness service", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          ConstellationLiveness.proxyLayer.pipe(
            Layer.provideMerge(EventStore.layerSqlite(":memory:"))
          )
        );

        yield* Effect.gen(function* () {
          const captured = yield* ConstellationLiveness;
          const record = yield* seed;
          const queuedBeforeActivation = captured.queued(draft().sessionId, 3);
          expect((yield* captured.read(record)).size).toBe(0);
          const active = yield* Layer.build(ConstellationLiveness.layer);
          const live = Context.get(active, ConstellationLiveness);
          expect(live).toBe(captured);
          yield* queuedBeforeActivation;
          expect((yield* captured.read(record)).get(draft().id)?.queuedInput).toBe(3);
        }).pipe(Effect.provide(context));
      })
    )
  );
});

test("liveness says whether the Attempt's first Turn has started, from its startup receipt", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const record = yield* seed;
        const store = yield* EventStore;
        const feed = yield* ConstellationLiveness;
        expect((yield* feed.read(record)).get(draft().id)).toMatchObject({
          activeTurn: false,
          firstTurn: false,
        });
        yield* store.commit({
          commandId: CommandId.make(`${draft().id}:start`),
          decide: () => Effect.succeed([]),
        });
        expect((yield* feed.read(record)).get(draft().id)?.firstTurn).toBe(true);
      })
    ).pipe(Effect.provide(layer))
  );
});
