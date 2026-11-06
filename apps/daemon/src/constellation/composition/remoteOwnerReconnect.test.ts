import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Deferred, Effect, Context, Layer, Stream, Predicate, Option } from "effect";
import { HostRegistry } from "../../../../../packages/client/src/HostRegistry.ts";
import {
  HostConnector,
  HostTarget,
  type LiveSession,
} from "../../../../../packages/client/src/HostConnection.ts";
import { ConstellationRelay } from "../../../../../packages/client/src/constellation/relay.ts";
import { CID, draft } from "../../engine/constellation.testing.ts";
import { EventStore } from "../../store/EventStore.ts";
import { applyWorkerDelivery, ConstellationSessionEffects } from "../delivery/index.ts";
import { finish, signal, wait, WORKER } from "../delivery/testing.ts";
import { fakeHost, testIdentity } from "../transfers/fakeHost.testing.ts";
import { transferError } from "../worktrees.ts";
import { validateRemoteDelivery } from "./remoteDelivery.ts";
import {
  blockedPair,
  acceptFeed,
  startOwnerDelivery,
  type TestHost,
} from "./remoteOwnerReconnect.testing.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const startClient = Effect.fnUntraced(function* (roots: { owner: string; worker: string }) {
  const services = yield* Layer.build(HostRegistry.layer.pipe(Layer.provide(HostConnector.layer)));
  const registry = Context.get(services, HostRegistry);

  const relay = Context.get(
    yield* Layer.build(
      ConstellationRelay.layer.pipe(Layer.provide(Layer.succeedContext(services)))
    ),
    ConstellationRelay
  );

  for (const [key, root] of Object.entries(roots)) {
    const connection = yield* registry.add({
      key,
      name: key,
      target: HostTarget.Local({ socketPath: join(root, "daemon.sock") }),
      identity: testIdentity,
    });

    yield* connection.awaitSession;
  }

  return { registry, relay };
});

const watchAcks = (session: LiveSession, onAck: () => void) => {
  const ack = session.client["constellation.delivery.ack"];

  Object.defineProperty(session.client, "constellation.delivery.ack", {
    value: (input: Parameters<typeof ack>[0]) => {
      onAck();

      return ack(input);
    },
  });
};

const recordTrace = Effect.fnUntraced(function* (owner: TestHost, worker: TestHost) {
  const dir = process.env.POLARIS_TRACE_DIR;

  if (dir === undefined) return;

  const events = yield* owner.store.readConstellationEvents({
    constellationId: CID,
    after: 0,
    upTo: (yield* owner.store.model).sequence,
  });

  const turns = yield* worker.store.readEvents({
    after: 0,
    upTo: (yield* worker.store.model).sequence,
    sessionId: WORKER,
  });

  const batches = [...Map.groupBy(events, (e) => e.commandId ?? "ack").values()];
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "constellation-owner-reconnect.json"),
    JSON.stringify({
      version: 1,
      ownerHostId: owner.host.hostId,
      batches: batches.flatMap((batch) => [
        ...(batch.some((e) => Predicate.isTagged(e.event, "AttemptUnblocked"))
          ? [{ hostId: worker.host.hostId, events: turns.map((e) => e.event) }]
          : []),
        { hostId: owner.host.hostId, events: batch.map((e) => e.event) },
      ]),
    })
  );
});

for (const [failure, name] of [
  [
    "owner-reconnect",
    "an owner reconnect during a busy Turn acknowledges on the new session, never the stale one",
  ],
  ["assignment", "a retryable E-ASSIGNMENT refusal is retried until one Turn is delivered"],
  [
    "persistent",
    "a persistent E-ASSIGNMENT refusal stops after two applies per relay pass and stays blocked until relay.retry",
  ],
] as const) {
  test(
    name,
    async () => {
      const roots = {
        owner: newTempDir("block-cycles-owner-", { short: true }),
        worker: newTempDir("block-cycles-worker-", { short: true }),
      };

      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const arrived = yield* Deferred.make<void>();
              let applications = 0;
              let turns = 0;
              let staleAcks = 0;
              let currentAcks = 0;

              const effects = ConstellationSessionEffects.of({
                canSteer: () => Effect.succeed(true),
                runTurn: (turn) =>
                  Effect.gen(function* () {
                    turns++;
                    yield* signal(turn.sessionId, { type: "harness.opened" }).pipe(
                      Effect.provideService(EventStore, worker.store),
                      Effect.orDie
                    );
                  }),
                steer: () => Effect.void,
                interrupt: () => Effect.void,
                retire: () => Effect.void,
              });

              const worker: TestHost = yield* fakeHost(roots.worker, {
                delivery: {
                  apply: (packet) =>
                    Effect.gen(function* () {
                      applications++;

                      if (
                        failure === "persistent" ||
                        (failure === "assignment" && applications === 1)
                      )
                        return yield* transferError(
                          "E-ASSIGNMENT",
                          "Assignment mirror is not ready",
                          true
                        );
                      yield* applyWorkerDelivery(packet, (p, model) =>
                        Effect.gen(function* () {
                          yield* validateRemoteDelivery(
                            p,
                            model,
                            yield* worker.storage.assignments.pipe(Effect.orDie)
                          );
                          yield* Deferred.succeed(arrived, undefined);
                        })
                      ).pipe(
                        Effect.provideService(EventStore, worker.store),
                        Effect.provideService(ConstellationSessionEffects, effects),
                        Effect.mapError((error) => transferError("E-DELIVERY", error.message))
                      );
                    }),
                },
              });

              const owner = yield* fakeHost(roots.owner);
              yield* blockedPair(owner, worker);
              const delivery = yield* startOwnerDelivery(owner);
              yield* acceptFeed(owner);
              const { registry, relay } = yield* startClient(roots);

              if (failure === "persistent") {
                yield* wait(() => Effect.succeed(applications === 2));
                yield* Effect.promise(() => Bun.sleep(30));
                expect(applications).toBe(2);
                yield* relay.retry;
                yield* wait(() => Effect.succeed(applications === 4));
                yield* Effect.promise(() => Bun.sleep(30));
                expect(applications).toBe(4);
                expect(
                  (yield* owner.store.model).constellations.get(CID)!.graph.attempts[0]!.state
                ).toBe("blocked");

                return;
              }

              yield* Deferred.await(arrived).pipe(Effect.timeout(3000));
              expect(
                (yield* owner.store.model).constellations.get(CID)!.graph.attempts[0]!.state
              ).toBe("blocked");

              if (failure === "owner-reconnect") {
                const old = Option.getOrThrow(yield* registry.get("owner"));
                const prior = yield* old.awaitSession;
                watchAcks(prior, () => staleAcks++);
                yield* registry.remove("owner");

                const next = yield* registry.add({
                  key: "owner",
                  name: "owner",
                  target: HostTarget.Local({ socketPath: join(roots.owner, "daemon.sock") }),
                  identity: testIdentity,
                });

                const current = yield* next.awaitSession;
                expect(current).not.toBe(prior);
                watchAcks(current, () => currentAcks++);
                yield* Effect.yieldNow;
              }

              yield* finish(WORKER).pipe(Effect.provideService(EventStore, worker.store));
              yield* wait(() =>
                Effect.map(
                  owner.store.model,
                  (m) => m.constellations.get(CID)!.graph.attempts[0]!.state === "working"
                )
              );
              expect(turns).toBe(1);

              if (failure === "owner-reconnect") {
                expect(staleAcks).toBe(0);
                expect(currentAcks).toBe(1);
              }

              const events = yield* owner.store.readConstellationEvents({
                constellationId: CID,
                after: 0,
                upTo: (yield* owner.store.model).sequence,
              });

              expect(
                events.filter((e) => Predicate.isTagged(e.event, "AttemptUnblocked"))
              ).toHaveLength(1);
              expect(
                events.filter((e) => Predicate.isTagged(e.event, "WorkerInputDelivered"))
              ).toHaveLength(1);
              expect(
                (yield* owner.deliveries.watch.pipe(Stream.take(1), Stream.runCollect))[0]
              ).toEqual([]);

              if (failure === "assignment") expect(applications).toBeGreaterThanOrEqual(2);
              yield* delivery.flush();
              expect(turns).toBe(1);
              expect(
                (yield* owner.store.model).constellations
                  .get(CID)!
                  .graph.attempts.find((a) => a.id === draft().id)!.blockedOn
              ).toEqual([]);

              if (failure === "owner-reconnect") yield* recordTrace(owner, worker);
            })
          )
        );
      } finally {
        removeTempDir(roots.owner);
        removeTempDir(roots.worker);
      }
    },
    15_000
  );
}
