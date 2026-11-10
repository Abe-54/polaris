import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CommandId, DomainEvent, HostResource, ResourceLease, SessionId } from "@polaris/protocol";
import { Clock, Deferred, Effect, Fiber, Layer, ManagedRuntime, Predicate } from "effect";
import { EventStore } from "../store/EventStore.ts";
import { HostResources } from "./index.ts";
import { recordResourceTrace } from "./trace.testing.ts";
import { processIdentity } from "./process.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

const homes: string[] = [];

const originalHome = process.env.POLARIS_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.POLARIS_HOME;
  else process.env.POLARIS_HOME = originalHome;

  for (const home of homes.splice(0)) removeTempDir(home);
});

const setup = () => {
  const home = newTempDir("polaris-resource-test-");
  homes.push(home);
  process.env.POLARIS_HOME = home;
  const layer = HostResources.layer.pipe(LayerProvide(home));

  return { home, runtime: ManagedRuntime.make(layer) };
};

const LayerProvide = (home: string) =>
  Layer.provideMerge(EventStore.layerSqlite(join(home, "state.sqlite")));

const id = (value: string) => CommandId.make(value);

const eventually = async (predicate: () => Promise<boolean>) => {
  for (let n = 0; n < 200; n++) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }

  throw new Error("resource condition did not become true");
};

describe("Host resource leases", () => {
  test("held and queued worker slots schedule no monitor sleeps", async () => {
    const home = newTempDir("polaris-worker-idle-");
    homes.push(home);
    process.env.POLARIS_HOME = home;
    const clock = await Effect.runPromise(Clock.Clock);
    let sleeps = 0;

    const clockLayer = Layer.succeed(Clock.Clock)({
      currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
      currentTimeMillis: clock.currentTimeMillis,
      currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
      currentTimeNanos: clock.currentTimeNanos,
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: clock.monotonicTimeNanos,
      sleep: () =>
        Effect.andThen(
          Effect.sync(() => {
            sleeps++;
          }),
          Effect.never
        ),
    });

    const runtime = ManagedRuntime.make(
      HostResources.layer.pipe(LayerProvide(home), Layer.provide(clockLayer))
    );

    try {
      const resources = await runtime.runPromise(HostResources);
      await runtime.runPromise(resources.setWorkerCap(id("idle-cap"), 1));
      const granted = await runtime.runPromise(Deferred.make<void>());

      const holder = runtime.runFork(
        Effect.scoped(
          Effect.andThen(
            resources.acquireWorker(SessionId.make("held")),
            Effect.andThen(Deferred.succeed(granted, undefined), Effect.never)
          )
        )
      );

      await runtime.runPromise(Deferred.await(granted));

      const waiter = runtime.runFork(
        Effect.scoped(
          Effect.andThen(resources.acquireWorker(SessionId.make("queued")), Effect.never)
        )
      );

      await eventually(
        async () => (await runtime.runPromise(resources.get)).workerCap.waiting === 1
      );
      await Bun.sleep(20);
      expect(sleeps).toBe(0);
      await runtime.runPromise(Fiber.interrupt(waiter));
      await runtime.runPromise(Fiber.interrupt(holder));
      expect(sleeps).toBe(0);
      const identity = await processIdentity(process.pid);
      expect(identity).not.toBeNull();
      await runtime.runPromise(resources.declare(id("idle-process-resource"), "bench", 1));
      await runtime.runPromise(
        resources.acquire({
          requestId: "process",
          name: "bench",
          sessionId: null,
          processId: process.pid,
          processIdentity: identity!,
          command: [],
        })
      );
      await eventually(async () => sleeps > 0);
      expect(sleeps).toBe(1);
      await runtime.runPromise(resources.release(null, "process"));
    } finally {
      await runtime.dispose();
    }
  });
  test("a concurrent Lead capacity edit is honored at the grant commit boundary", async () => {
    const home = newTempDir("polaris-resource-race-");
    homes.push(home);
    process.env.POLARIS_HOME = home;
    const storage = ManagedRuntime.make(EventStore.layerSqlite(join(home, "state.sqlite")));
    const store = await storage.runPromise(EventStore);
    let shrinkBeforeGrant = false;

    const intercepted = EventStore.of({
      ...store,
      commit: (options) =>
        Effect.gen(function* () {
          const model = yield* store.model;
          const events = yield* options.decide(model);

          if (
            shrinkBeforeGrant &&
            events.some((event) => Predicate.isTagged(event, "ResourceLeased"))
          ) {
            shrinkBeforeGrant = false;
            const current = model.hostResources!.resources.get("bench")!;
            yield* store.commit({
              commandId: id("lead-shrink"),
              decide: () =>
                Effect.succeed([
                  DomainEvent.cases.ResourceDeclared.make({
                    resource: HostResource.make({
                      hostId: current.hostId,
                      name: "bench",
                      capacity: 1,
                    }),
                  }),
                ]),
            });
          }

          return yield* store.commit(options);
        }),
    });

    const runtime = ManagedRuntime.make(
      HostResources.layer.pipe(Layer.provide(Layer.succeed(EventStore)(intercepted)))
    );

    try {
      const resources = await runtime.runPromise(HostResources);
      const identity = await processIdentity(process.pid);
      await runtime.runPromise(resources.declare(id("capacity"), "bench", 2));

      const acquire = (requestId: string) =>
        resources.acquire({
          requestId,
          name: "bench",
          processId: process.pid,
          processIdentity: identity!,
          command: [],
          sessionId: null,
        });

      await runtime.runPromise(acquire("first"));
      shrinkBeforeGrant = true;
      const second = runtime.runFork(acquire("second"));
      await eventually(
        async () =>
          (await runtime.runPromise(resources.get)).resources.find((r) => r.name === "bench")
            ?.capacity === 1
      );
      const snapshot = await runtime.runPromise(resources.get);
      expect(snapshot.resourceLeases.map((lease) => lease.id)).toEqual(["first"]);
      expect(snapshot.waiting.map((waiter) => waiter.requestId)).toEqual(["second"]);
      await runtime.runPromise(resources.release(id("free-slot"), "first"));
      expect((await runtime.runPromise(Fiber.join(second))).id).toBe("second");
    } finally {
      await runtime.dispose();
      await storage.dispose();
    }
  });

  test("FIFO, capacity, canceled waiter, hold warning and Release without killing", async () => {
    const { runtime } = setup();
    // The first holder is a real child, so Release can be seen not to kill it.
    const holder = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30_000)"]);

    try {
      const resources = await runtime.runPromise(HostResources);
      const identity = await processIdentity(process.pid);
      const holderIdentity = await processIdentity(holder.pid);
      expect(holderIdentity).not.toBeNull();
      await runtime.runPromise(resources.declare(id("declare"), "bench", 1, 1));

      const request = (requestId: string, processId = process.pid) =>
        resources.acquire({
          requestId,
          name: "bench",
          processId,
          processIdentity: (processId === holder.pid ? holderIdentity : identity)!,
          command: ["fixture"],
          sessionId: null,
        });

      const first = await runtime.runPromise(request("first", holder.pid));
      const second = runtime.runFork(request("second"));
      const canceled = runtime.runFork(request("canceled"));
      const third = runtime.runFork(request("third"));
      await eventually(async () => (await runtime.runPromise(resources.get)).waiting.length === 3);
      await runtime.runPromise(Fiber.interrupt(canceled));
      await runtime.runPromise(resources.release(id("cancel-waiter"), "canceled"));
      expect((await runtime.runPromise(resources.get)).waiting.map((w) => w.requestId)).toEqual([
        "second",
        "third",
      ]);
      await Promise.resolve(
        expect(runtime.runPromise(resources.remove(id("remove-busy"), "bench"))).rejects.toThrow()
      );
      await Promise.resolve(
        expect(
          runtime.runPromise(resources.declare(id("reserved"), "__workers", 1))
        ).rejects.toThrow()
      );
      await Bun.sleep(5);
      expect((await runtime.runPromise(resources.get)).overdueLeaseIds).toContain(first.id);
      await runtime.runPromise(resources.release(id("release-first"), first.id));
      expect((await runtime.runPromise(Fiber.join(second))).id).toBe("second");
      expect((await runtime.runPromise(resources.get)).resourceLeases).toHaveLength(1);
      expect(holder.exitCode).toBeNull();
      expect(await processIdentity(holder.pid)).toBe(holderIdentity);
      await runtime.runPromise(resources.release(id("release-second"), "second"));
      expect((await runtime.runPromise(Fiber.join(third))).id).toBe("third");
      await runtime.runPromise(resources.release(id("release-third"), "third"));
      await runtime.runPromise(resources.remove(id("remove"), "bench"));
      expect((await runtime.runPromise(resources.get)).resources.map((r) => r.name)).toEqual([
        "smoke",
      ]);
      const store = await runtime.runPromise(EventStore);
      const cut = (await runtime.runPromise(store.model)).sequence;

      const events = await runtime.runPromise(
        store.readEvents({ after: 0, upTo: cut, sessionId: null })
      );

      expect(events.map((e) => e.event._tag)).toContain("ResourceLeaseCanceled");
      await runtime.runPromise(recordResourceTrace);
    } finally {
      holder.kill();
      await runtime.dispose();
    }
  });

  test("restart retains live holders and rejects a reused PID", async () => {
    const { home, runtime } = setup();
    const identity = await processIdentity(process.pid);
    const resources = await runtime.runPromise(HostResources);
    await runtime.runPromise(resources.declare(id("declare"), "bench", 2));
    await runtime.runPromise(
      resources.acquire({
        requestId: "live",
        name: "bench",
        processId: process.pid,
        processIdentity: identity!,
        command: [],
        sessionId: null,
      })
    );
    const store = await runtime.runPromise(EventStore);
    const live = (await runtime.runPromise(resources.get)).resourceLeases[0]!;
    await runtime.runPromise(
      store.commit({
        commandId: null,
        decide: () =>
          Effect.succeed([
            DomainEvent.cases.ResourceLeased.make({
              lease: ResourceLease.make({
                id: "reused",
                hostId: live.hostId,
                resource: live.resource,
                sessionId: live.sessionId,
                attemptId: live.attemptId,
                command: live.command,
                processId: live.processId,
                acquiredAt: live.acquiredAt,
                processIdentity: "older process",
              }),
            }),
          ]),
      })
    );
    await runtime.dispose();
    const restarted = ManagedRuntime.make(HostResources.layer.pipe(LayerProvide(home)));

    try {
      const restored = await restarted.runPromise(HostResources);
      const snapshot = await restarted.runPromise(restored.get);
      expect(snapshot.resourceLeases.map((lease) => lease.id)).toEqual(["live"]);
    } finally {
      await restarted.dispose();
    }
  });

  test("working-worker slots are FIFO, cancellable, and settings reset to the automatic cap", async () => {
    const { runtime } = setup();

    try {
      const resources = await runtime.runPromise(HostResources);
      await runtime.runPromise(resources.setWorkerCap(id("cap"), 1));
      const started: string[] = [];

      const worker = (name: string) =>
        runtime.runFork(
          Effect.scoped(
            Effect.gen(function* () {
              yield* resources.acquireWorker(SessionId.make(name));
              started.push(name);
              yield* Effect.never;
            })
          )
        );

      const first = worker("one");
      const canceled = worker("canceled");
      const second = worker("two");
      await eventually(
        async () => (await runtime.runPromise(resources.get)).workerCap.waiting === 2
      );
      expect(started).toEqual(["one"]);
      await runtime.runPromise(Fiber.interrupt(canceled));
      await runtime.runPromise(Fiber.interrupt(first));
      await eventually(async () => started.length === 2);
      expect(started).toEqual(["one", "two"]);
      await runtime.runPromise(Fiber.interrupt(second));
      const reset = await runtime.runPromise(resources.setWorkerCap(id("reset"), null));
      expect(reset.workerCap.cap).toBe(reset.workerCap.default);
      expect(reset.workerCap.working).toBe(0);
      expect(reset.workerCap.waiting).toBe(0);
      const store = await runtime.runPromise(EventStore);

      const events = await runtime.runPromise(
        store.readEvents({
          after: 0,
          upTo: (await runtime.runPromise(store.model)).sequence,
          sessionId: null,
        })
      );

      const queued = events.flatMap(({ event }) =>
        Predicate.isTagged(event, "ResourceLeaseQueued") && event.resource === "__workers"
          ? [event]
          : []
      );

      const grants = events.flatMap(({ event }) =>
        Predicate.isTagged(event, "ResourceLeased") && event.lease.resource === "__workers"
          ? [event.lease]
          : []
      );

      expect(queued.map((q) => q.sessionId)).toEqual(
        ["one", "canceled", "two"].map((name) => SessionId.make(name))
      );
      expect(grants.map((g) => g.id)).toEqual(
        queued.flatMap((q, index) => (index === 1 ? [] : [q.requestId]))
      );
      expect(
        events.filter(
          ({ event }) =>
            Predicate.isTagged(event, "ResourceLeaseCanceled") && event.resource === "__workers"
        )
      ).toHaveLength(1);
      expect(
        events.filter(
          ({ event }) =>
            Predicate.isTagged(event, "ResourceReleased") && event.resource === "__workers"
        )
      ).toHaveLength(2);
      await runtime.runPromise(recordResourceTrace);
    } finally {
      await runtime.dispose();
    }
  });

  test("restart reclaims durable worker holders and waiters before fresh scopes acquire", async () => {
    const { home, runtime } = setup();
    const resources = await runtime.runPromise(HostResources);
    await runtime.runPromise(resources.setWorkerCap(id("worker-cap"), 1));
    const store = await runtime.runPromise(EventStore);

    const hostId = (await runtime.runPromise(store.model)).hostResources!.resources.get(
      "__workers"
    )!.hostId;

    const queued = (requestId: string) =>
      DomainEvent.cases.ResourceLeaseQueued.make({
        hostId,
        resource: "__workers",
        requestId,
        sessionId: SessionId.make(requestId),
      });

    await runtime.runPromise(
      store.commit({
        commandId: null,
        decide: () =>
          Effect.succeed([
            queued("old-holder"),
            DomainEvent.cases.ResourceLeased.make({
              lease: ResourceLease.make({
                id: "old-holder",
                hostId,
                resource: "__workers",
                sessionId: SessionId.make("old-holder"),
                attemptId: null,
                processId: process.pid,
                command: ["worker"],
                acquiredAt: new Date().toISOString(),
              }),
            }),
            queued("old-waiter"),
          ]),
      })
    );
    await runtime.dispose();
    const restarted = ManagedRuntime.make(HostResources.layer.pipe(LayerProvide(home)));

    try {
      const restored = await restarted.runPromise(HostResources);
      const recoveredStore = await restarted.runPromise(EventStore);
      const recovered = (await restarted.runPromise(recoveredStore.model)).hostResources!;
      expect(recovered.leases.size).toBe(0);
      expect(recovered.waiting.size).toBe(0);
      await restarted.runPromise(Effect.scoped(restored.acquireWorker(SessionId.make("fresh"))));
      const snapshot = await restarted.runPromise(restored.get);
      expect(snapshot.workerCap).toMatchObject({ working: 0, waiting: 0 });

      const history = await restarted.runPromise(
        recoveredStore.readEvents({
          after: 0,
          upTo: (await restarted.runPromise(recoveredStore.model)).sequence,
          sessionId: null,
        })
      );

      expect(
        history.filter(
          ({ event }) =>
            Predicate.isTagged(event, "ResourceReleased") && event.reason === "Daemon restarted"
        )
      ).toHaveLength(1);
      expect(
        history.filter(
          ({ event }) =>
            Predicate.isTagged(event, "ResourceLeaseCanceled") &&
            event.reason === "Daemon restarted"
        )
      ).toHaveLength(1);
      await restarted.runPromise(recordResourceTrace);
    } finally {
      await restarted.dispose();
    }
  });

  test("Lead plan resource declarations are observed from committed Host events", async () => {
    const { runtime } = setup();

    try {
      const resources = await runtime.runPromise(HostResources);
      const store = await runtime.runPromise(EventStore);

      const hostId = (await runtime.runPromise(resources.declare(id("seed"), "seed", 1)))
        .resources[0]!.hostId;

      await runtime.runPromise(
        store.commit({
          commandId: id("plan"),
          decide: () =>
            Effect.succeed([
              DomainEvent.cases.ResourceDeclared.make({
                resource: HostResource.make({ hostId, name: "planned", capacity: 2 }),
              }),
            ]),
        })
      );
      expect((await runtime.runPromise(resources.get)).resources.map((r) => r.name)).toContain(
        "planned"
      );
    } finally {
      await runtime.dispose();
    }
  });

  test("a fresh Host declares the script leases, and a restart keeps their edited capacity", async () => {
    const { home, runtime } = setup();
    const identity = await processIdentity(process.pid);

    try {
      const resources = await runtime.runPromise(HostResources);
      const fresh = await runtime.runPromise(resources.get);
      expect(fresh.resources.map((r) => [r.name, r.capacity])).toEqual([
        ["bench", 1],
        ["smoke", 1],
      ]);

      const lease = await runtime.runPromise(
        resources.acquire({
          requestId: "smoke-run",
          name: "smoke",
          sessionId: null,
          processId: process.pid,
          processIdentity: identity!,
          command: [],
        })
      );

      expect(lease.resource).toBe("smoke");
      await runtime.runPromise(resources.release(null, "smoke-run"));
      await runtime.runPromise(resources.declare(id("wider-bench"), "bench", 3));
    } finally {
      await runtime.dispose();
    }

    const restarted = ManagedRuntime.make(HostResources.layer.pipe(LayerProvide(home)));

    try {
      const resources = await restarted.runPromise(HostResources);
      const snapshot = await restarted.runPromise(resources.get);
      expect(snapshot.resources.map((r) => [r.name, r.capacity])).toEqual([
        ["bench", 3],
        ["smoke", 1],
      ]);
    } finally {
      await restarted.dispose();
    }
  });
});
