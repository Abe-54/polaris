import { expect, test } from "bun:test";
import { join } from "node:path";
import { CommandId, DomainEvent, SessionId, UsageReport } from "@polaris/protocol";
import { Effect, Layer, ManagedRuntime, Predicate, Stream } from "effect";
import { CID } from "../../engine/constellation.testing.ts";
import { EventStore } from "../../store/EventStore.ts";
import { UsageIndex } from "../../usage/index.ts";
import { ConstellationStatsService } from "./index.ts";
import { statsFixture } from "./stats.testing.ts";
import { seedStats } from "./store.testing.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

test("views reuse history, refresh Usage independently, enforce authority, and write no events or subscriptions", async () => {
  const home = newTempDir("polaris-stats-service-", { short: true });
  const fixture = statsFixture();
  let responses = fixture.responses;
  let graphReads = 0;
  let filteredReads = 0;
  let usageReads = 0;

  const observedStore = Layer.effect(
    EventStore,
    Effect.gen(function* () {
      const store = yield* EventStore;

      return EventStore.of({
        ...store,
        readConstellationEvents: (q) => {
          graphReads++;

          return store.readConstellationEvents(q);
        },
        readEvents: (q) => {
          filteredReads++;
          expect(q.eventTypes).toBeDefined();

          return store.readEvents(q);
        },
      });
    })
  ).pipe(Layer.provide(EventStore.layerSqlite(join(home, "state.sqlite"))));

  const usage = Layer.succeed(UsageIndex)(
    UsageIndex.of({
      refresh: () => Effect.void,
      query: () =>
        Effect.succeed(UsageReport.make({ buckets: [], indexedAt: null, indexing: false })),
      responses: () =>
        Effect.sync(() => {
          usageReads++;

          return responses;
        }),
      changes: Stream.empty,
      planLimits: Effect.succeed([]),
    })
  );

  const layer = ConstellationStatsService.layer.pipe(
    Layer.provideMerge(observedStore),
    Layer.provide(usage)
  );

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const stats = yield* ConstellationStatsService;
        const store = yield* EventStore;
        expect(graphReads + filteredReads + usageReads).toBe(0);
        yield* seedStats;
        const before = (yield* store.model).sequence;
        const subscribers = yield* store.subscriberCount;
        const first = yield* stats.get({ kind: "user" }, CID);
        expect(graphReads).toBe(1);
        expect(filteredReads).toBe(4);
        const second = yield* stats.get({ kind: "user" }, CID);
        expect(second.usage).toEqual(first.usage);
        expect(graphReads).toBe(1);
        expect(filteredReads).toBe(4);
        responses = { ...responses, responses: responses.responses.slice(0, 1) };
        const updated = yield* stats.get({ kind: "user" }, CID);
        expect(updated.usage.total.tokens.input).toBe(100);
        expect(graphReads).toBe(1);

        const denied = yield* stats
          .get({ kind: "session", sessionId: SessionId.make("outsider") }, CID)
          .pipe(Effect.catchTag("ConstellationRejected", (e) => Effect.succeed(e)));

        expect(Predicate.isTagged(denied, "ConstellationRejected")).toBe(true);
        expect(usageReads).toBe(3);
        expect((yield* store.model).sequence).toBe(before);
        expect(yield* store.subscriberCount).toBe(subscribers);
        yield* store.commit({
          commandId: CommandId.make("stats-state"),
          decide: () =>
            Effect.succeed([
              DomainEvent.cases.ConstellationStateChanged.make({
                constellationId: CID,
                revision: 2,
                state: "paused",
              }),
            ]),
        });
        yield* stats.get({ kind: "user" }, CID);
        expect(graphReads).toBe(2);
        expect(filteredReads).toBe(8);
        const record = (yield* store.model).constellations.get(CID)!;
        const attempt = record.graph.attempts[1]!;
        const at = new Date(Date.now() - 2000).toISOString();
        yield* store.commit({
          commandId: CommandId.make("stats-stale"),
          decide: () =>
            Effect.succeed([
              DomainEvent.cases.AttemptStale.make({
                constellationId: CID,
                revision: record.graph.revision,
                attemptId: attempt.id,
                hostId: attempt.hostId,
                at,
              }),
            ]),
        });
        const stale = yield* stats.get({ kind: "user" }, CID);
        expect(stale.revision).toBe(record.graph.revision);
        expect(stale.workers.attempts[1]?.times.staleMs).toBe(
          Date.parse(stale.asOf) - Date.parse(at)
        );
        expect(graphReads).toBe(3);
        const freshAt = new Date().toISOString();
        yield* store.commit({
          commandId: CommandId.make("stats-fresh"),
          decide: () =>
            Effect.succeed([
              DomainEvent.cases.AttemptFresh.make({
                constellationId: CID,
                revision: record.graph.revision,
                attemptId: attempt.id,
                at: freshAt,
              }),
            ]),
        });
        const fresh = yield* stats.get({ kind: "user" }, CID);
        expect(fresh.revision).toBe(record.graph.revision);
        expect(fresh.workers.attempts[1]?.times.staleMs).toBe(Date.parse(freshAt) - Date.parse(at));
        expect(graphReads).toBe(4);
      }).pipe(Effect.provide(layer))
    );
  } finally {
    removeTempDir(home);
  }
});

test("SQL event-type filtering preserves sequence cuts and empty selection reads nothing", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seedStats;
      const store = yield* EventStore;
      const model = yield* store.model;

      const selected = yield* store.readEvents({
        sessionId: null,
        after: 0,
        upTo: model.sequence,
        eventTypes: ["ResourceLeaseQueued"],
      });

      expect(selected).toHaveLength(4);
      expect(selected.every((e) => Predicate.isTagged(e.event, "ResourceLeaseQueued"))).toBe(true);
      const boundary = selected[1]!;
      expect(
        yield* store.readEvents({
          sessionId: null,
          after: selected[0]!.sequence,
          upTo: boundary.sequence,
          eventTypes: ["ResourceLeaseQueued"],
        })
      ).toEqual([boundary]);
      expect(
        yield* store.readEvents({ sessionId: null, after: 0, upTo: model.sequence, eventTypes: [] })
      ).toEqual([]);
    }).pipe(Effect.provide(EventStore.layerSqlite(":memory:")))
  );
});

test("a fresh Stats service after restart reconstructs the open owner stale interval", async () => {
  const home = newTempDir("polaris-stats-stale-restart-", { short: true });

  const layer = ConstellationStatsService.layer.pipe(
    Layer.provideMerge(EventStore.layerSqlite(join(home, "state.sqlite"))),
    Layer.provide(
      Layer.succeed(UsageIndex)(
        UsageIndex.of({
          refresh: () => Effect.void,
          query: () =>
            Effect.succeed(UsageReport.make({ buckets: [], indexedAt: null, indexing: false })),
          responses: () => Effect.succeed({ responses: [], indexedAt: null, indexing: false }),
          changes: Stream.empty,
          planLimits: Effect.succeed([]),
        })
      )
    )
  );

  let runtime = ManagedRuntime.make(layer);
  const at = new Date(Date.now() - 1000).toISOString();

  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* seedStats;
        const store = yield* EventStore;
        const record = (yield* store.model).constellations.get(CID)!;
        const attempt = record.graph.attempts[1]!;
        yield* store.commit({
          commandId: CommandId.make("restart-stale"),
          decide: () =>
            Effect.succeed([
              DomainEvent.cases.AttemptStale.make({
                constellationId: CID,
                revision: record.graph.revision,
                attemptId: attempt.id,
                hostId: attempt.hostId,
                at,
              }),
            ]),
        });
      })
    );

    const before = await runtime.runPromise(
      Effect.flatMap(ConstellationStatsService, (stats) => stats.get({ kind: "user" }, CID))
    );

    await runtime.dispose();
    runtime = ManagedRuntime.make(layer);

    const after = await runtime.runPromise(
      Effect.flatMap(ConstellationStatsService, (stats) => stats.get({ kind: "user" }, CID))
    );

    expect(after.revision).toBe(before.revision);
    expect(after.workers.attempts[1]?.times.staleMs).toBe(Date.parse(after.asOf) - Date.parse(at));
    expect(after.workers.attempts[1]?.times.staleMs).toBeGreaterThanOrEqual(
      before.workers.attempts[1]!.times.staleMs!
    );
  } finally {
    await runtime.dispose();
    removeTempDir(home);
  }
});
