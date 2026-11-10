import { availableParallelism } from "node:os";
import { randomUUID } from "node:crypto";
import {
  CommandId,
  DomainEvent,
  HostResource,
  HostResourcesSnapshot,
  ResourceLease,
  ResourceError,
  type SessionId,
} from "@polaris/protocol";
import { Deferred, Effect, Latch, Layer, Option, Predicate, Semaphore, Stream } from "effect";
import { paths } from "../paths.ts";
import { EventStore } from "../store/EventStore.ts";
import { loadHostInfo } from "../transport/hostInfo.ts";
import {
  DEFAULT_HOLD_LIMIT_MS,
  emptyResources,
  firstWaiter,
  holders,
  type LeaseWaiter,
  SCRIPT_RESOURCES,
  WORKERS_RESOURCE,
} from "./model.ts";
import { canGrantResource } from "./decide.ts";
import { processIdentity, ProcessIdentityUnknown } from "./process.ts";

import { HostResources } from "./service.ts";

export { HostResources, type AcquireLease } from "./service.ts";

/** None while `ps` can't answer: nothing is granted, released or canceled on an unknown process. */
const identityOf = (pid: number) =>
  Effect.tryPromise({
    try: () => processIdentity(pid),
    catch: () => new ProcessIdentityUnknown({ pid }),
  }).pipe(
    Effect.map(Option.some),
    Effect.catchTag("ProcessIdentityUnknown", (error) =>
      Effect.as(Effect.logWarning(`ps gave no answer for process ${error.pid}`), Option.none())
    )
  );

export const resourcesLayer = Layer.effect(
  HostResources,
  Effect.gen(function* () {
    const store = yield* EventStore;
    const { hostId } = yield* loadHostInfo(paths().root);
    let model = emptyResources();

    const refresh = Effect.gen(function* () {
      const current = (yield* store.model).hostResources ?? emptyResources();
      model = {
        resources: new Map(current.resources),
        leases: new Map(current.leases),
        waiting: new Map(current.waiting),
      };
    });

    yield* refresh;
    const lock = yield* Semaphore.make(1);

    const hasProcesses = () =>
      [...model.leases.values(), ...model.waiting.values()].some(
        (lease) => lease.resource !== WORKERS_RESOURCE
      );

    const active = Latch.makeUnsafe(hasProcesses());
    const pending = new Map<string, Deferred.Deferred<ResourceLease, ResourceError>>();
    const workers = new Set<SessionId>();
    const workerWaiters = new Map<SessionId, Deferred.Deferred<void, ResourceError>>();
    const workerRequests = new Map<SessionId, string>();
    const warned = new Set<string>();
    const defaultCap = Math.max(1, Math.floor(availableParallelism() / 3));
    const workerCap = () => model.resources.get(WORKERS_RESOURCE)?.capacity ?? defaultCap;

    const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      lock.withPermits(1)(Effect.andThen(refresh, effect));

    const snapshot = () =>
      HostResourcesSnapshot.make({
        resources: [...model.resources.values()].filter((r) => r.name !== WORKERS_RESOURCE),
        resourceLeases: [...model.leases.values()].filter((l) => l.resource !== WORKERS_RESOURCE),
        waiting: [...model.waiting.values()].flatMap((w) =>
          w.resource === WORKERS_RESOURCE
            ? []
            : [
                {
                  resource: w.resource,
                  requestId: w.requestId,
                },
              ]
        ),
        overdueLeaseIds: [...model.leases.values()].flatMap((lease) =>
          lease.resource !== WORKERS_RESOURCE &&
          Date.now() - Date.parse(lease.acquiredAt) >=
            (model.resources.get(lease.resource)?.holdLimitMs ?? DEFAULT_HOLD_LIMIT_MS)
            ? [lease.id]
            : []
        ),
        workerCap: {
          cap: workerCap(),
          default: defaultCap,
          working: workers.size,
          waiting: workerWaiters.size,
        },
      });

    const write = Effect.fn("HostResources.write")(function* (
      commandId: CommandId | null,
      decided: ReadonlyArray<DomainEvent>
    ) {
      const result = yield* store
        .commit({
          commandId,
          decide: (current) =>
            Effect.succeed(
              decided.filter(
                (event) =>
                  !Predicate.isTagged(event, "ResourceLeased") ||
                  canGrantResource(current.hostResources ?? emptyResources(), event.lease)
              )
            ),
        })
        .pipe(Effect.mapError((error) => new ResourceError({ message: error.message })));

      yield* refresh;

      if (hasProcesses()) active.openUnsafe();
      else active.closeUnsafe();

      return !Predicate.isTagged(result, "Committed") || result.envelopes.length === decided.length;
    });

    const pumpWorkers = Effect.fn("HostResources.pumpWorkers")(function* () {
      for (const [sessionId, deferred] of workerWaiters) {
        if (workers.size >= workerCap()) break;
        const requestId = workerRequests.get(sessionId);

        if (
          requestId === undefined ||
          firstWaiter(model, WORKERS_RESOURCE)?.requestId !== requestId
        )
          break;
        const current = yield* store.model;

        const attempt = [...current.constellations.values()]
          .flatMap((r) => r.graph.attempts)
          .findLast(
            (a) => a.sessionId === sessionId && (a.state === "working" || a.state === "blocked")
          );

        const granted = yield* write(null, [
          DomainEvent.cases.ResourceLeased.make({
            lease: ResourceLease.make({
              id: requestId,
              hostId,
              resource: WORKERS_RESOURCE,
              sessionId,
              attemptId: attempt?.id ?? null,
              command: ["worker"],
              processId: process.pid,
              acquiredAt: new Date().toISOString(),
            }),
          }),
        ]);

        if (!granted) break;
        workerWaiters.delete(sessionId);
        workers.add(sessionId);
        Deferred.doneUnsafe(deferred, Effect.void);
      }
    });

    const releaseEvent = (leaseId: string, resource: string, reason: string) =>
      model.waiting.has(leaseId)
        ? DomainEvent.cases.ResourceLeaseCanceled.make({
            hostId,
            requestId: leaseId,
            resource,
            reason,
          })
        : DomainEvent.cases.ResourceReleased.make({ hostId, leaseId, resource, reason });

    const grant = Effect.fn("HostResources.grant")(function* (waiter: LeaseWaiter) {
      if (waiter.processId === undefined || waiter.processIdentity === undefined) {
        yield* write(null, [
          releaseEvent(waiter.requestId, waiter.resource, "unrecoverable waiter"),
        ]);
        const deferred = pending.get(waiter.requestId);

        if (deferred !== undefined)
          Deferred.doneUnsafe(
            deferred,
            Effect.fail(new ResourceError({ message: "Unrecoverable waiter" }))
          );

        return true;
      }

      const known = yield* identityOf(waiter.processId);

      // Unknown: the waiter stays queued and the next check asks again.
      if (Option.isNone(known)) return false;
      const identity = known.value;

      if (identity !== waiter.processIdentity) {
        yield* write(null, [releaseEvent(waiter.requestId, waiter.resource, "process exited")]);
        const deferred = pending.get(waiter.requestId);

        if (deferred !== undefined)
          Deferred.doneUnsafe(
            deferred,
            Effect.fail(new ResourceError({ message: "Process exited" }))
          );

        return true;
      }

      const lease = ResourceLease.make({
        id: waiter.requestId,
        hostId,
        resource: waiter.resource,
        sessionId: waiter.sessionId,
        attemptId: waiter.attemptId,
        command: waiter.command ?? [],
        processId: waiter.processId,
        processIdentity: identity,
        acquiredAt: new Date().toISOString(),
      });

      const granted = yield* write(null, [DomainEvent.cases.ResourceLeased.make({ lease })]);

      if (!granted) return false;
      const deferred = pending.get(lease.id);

      if (deferred !== undefined) Deferred.doneUnsafe(deferred, Effect.succeed(lease));

      return true;
    });

    const pump = Effect.fn("HostResources.pump")(function* () {
      for (const resource of model.resources.values()) {
        if (resource.name === WORKERS_RESOURCE) continue;
        let waiter = firstWaiter(model, resource.name);

        while (
          waiter !== undefined &&
          holders(model, resource.name).length < (model.resources.get(resource.name)?.capacity ?? 0)
        ) {
          if (!(yield* grant(waiter))) break;
          waiter = firstWaiter(model, resource.name);
        }
      }
    });

    const release = Effect.fn("HostResources.release")(function* (
      commandId: CommandId | null,
      leaseId: string
    ) {
      const resource = model.leases.get(leaseId)?.resource ?? model.waiting.get(leaseId)?.resource;

      if (resource !== undefined) {
        if (resource === WORKERS_RESOURCE)
          return yield* new ResourceError({
            message: "Worker slots release with their Attempt scope",
          });
        warned.delete(leaseId);
        yield* write(commandId, [releaseEvent(leaseId, resource, "released")]);
        const deferred = pending.get(leaseId);

        if (deferred !== undefined)
          Deferred.doneUnsafe(
            deferred,
            Effect.fail(new ResourceError({ message: "Lease released" }))
          );
        yield* pump();
      }

      return snapshot();
    });

    const checkLease = Effect.fn("HostResources.checkLease")(function* (lease: ResourceLease) {
      const known = yield* identityOf(lease.processId);

      if (Option.isNone(known)) return;

      if (known.value === null || known.value !== lease.processIdentity) {
        warned.delete(lease.id);
        yield* write(null, [releaseEvent(lease.id, lease.resource, "process exited")]);

        return;
      }

      if (snapshot().overdueLeaseIds.includes(lease.id) && !warned.has(lease.id)) {
        warned.add(lease.id);
        yield* Effect.logWarning(
          `Lease ${lease.resource} held past its limit; Release is available`,
          { leaseId: lease.id }
        );
      }
    });

    const checkWaiter = Effect.fn("HostResources.checkWaiter")(function* (waiter: LeaseWaiter) {
      const known =
        waiter.processId === undefined ? Option.some(null) : yield* identityOf(waiter.processId);

      if (Option.isNone(known)) return;

      if (known.value === null || known.value !== waiter.processIdentity)
        yield* release(null, waiter.requestId);
    });

    const check = Effect.fn("HostResources.check")(function* () {
      for (const lease of model.leases.values())
        if (lease.resource !== WORKERS_RESOURCE) yield* checkLease(lease);

      for (const waiter of model.waiting.values())
        if (waiter.resource !== WORKERS_RESOURCE) yield* checkWaiter(waiter);

      yield* pump();
    });

    const subscription = yield* store.subscribe({
      filter: (item) =>
        Predicate.isTagged(item, "Event") && item.envelope.event._tag.startsWith("Resource"),
    });

    yield* Stream.runForEach(subscription, () =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            yield* refresh;
            yield* pumpWorkers();
            yield* pump();

            if (hasProcesses()) active.openUnsafe();
            else active.closeUnsafe();
          })
        )
        .pipe(Effect.orDie)
    ).pipe(Effect.forkScoped);
    yield* serialized(
      Effect.gen(function* () {
        const abandoned = [...model.leases.values(), ...model.waiting.values()].flatMap((lease) =>
          lease.resource !== WORKERS_RESOURCE
            ? []
            : [
                releaseEvent(
                  "id" in lease ? lease.id : lease.requestId,
                  WORKERS_RESOURCE,
                  "Daemon restarted"
                ),
              ]
        );

        const scripts = SCRIPT_RESOURCES.filter((name) => !model.resources.has(name)).map((name) =>
          DomainEvent.cases.ResourceDeclared.make({
            resource: HostResource.make({
              hostId,
              name,
              capacity: 1,
              holdLimitMs: DEFAULT_HOLD_LIMIT_MS,
            }),
          })
        );

        if (abandoned.length + scripts.length > 0) yield* write(null, [...abandoned, ...scripts]);
        yield* check();
      })
    ).pipe(Effect.orDie);
    yield* Effect.gen(function* () {
      while (true) {
        yield* active.await;
        yield* Effect.sleep(1000);
        yield* serialized(check()).pipe(Effect.catch((error) => Effect.logWarning(error.message)));
      }
    }).pipe(Effect.forkScoped);

    const declare = Effect.fn("HostResources.declare")(function* (
      commandId: CommandId,
      name: string,
      capacity: number,
      holdLimitMs?: number
    ) {
      if (holders(model, name).length > capacity)
        return yield* new ResourceError({ message: "Release holders before reducing capacity" });

      const resource = HostResource.make({
        hostId,
        name,
        capacity,
        holdLimitMs: holdLimitMs ?? DEFAULT_HOLD_LIMIT_MS,
      });

      yield* write(commandId, [DomainEvent.cases.ResourceDeclared.make({ resource })]);
      yield* pumpWorkers();
      yield* pump();

      return snapshot();
    });

    return HostResources.of({
      get: lock.withPermits(1)(Effect.andThen(refresh, Effect.sync(snapshot))),
      declare: (id, name, capacity, limit) =>
        name === WORKERS_RESOURCE
          ? Effect.fail(new ResourceError({ message: "Reserved resource name" }))
          : serialized(declare(id, name, capacity, limit)).pipe(Effect.uninterruptible),
      remove: (id, name) =>
        serialized(
          Effect.gen(function* () {
            if (
              name === WORKERS_RESOURCE ||
              holders(model, name).length > 0 ||
              firstWaiter(model, name) !== undefined
            )
              return yield* new ResourceError({
                message: "Release holders and waiters before removing a resource",
              });
            yield* write(id, [DomainEvent.cases.ResourceRemoved.make({ hostId, resource: name })]);

            return snapshot();
          })
        ).pipe(Effect.uninterruptible),
      release: (id, leaseId) => serialized(release(id, leaseId)).pipe(Effect.uninterruptible),
      setWorkerCap: (id, cap) =>
        serialized(
          Effect.gen(function* () {
            if ((cap ?? defaultCap) < workers.size)
              return yield* new ResourceError({
                message: "Wait for working workers to release their slots before reducing the cap",
              });

            return yield* declare(id, WORKERS_RESOURCE, cap ?? defaultCap);
          })
        ).pipe(Effect.uninterruptible),
      acquire: (request) =>
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<ResourceLease, ResourceError>();
          yield* serialized(
            Effect.gen(function* () {
              if (!model.resources.has(request.name) || request.name === WORKERS_RESOURCE)
                return yield* new ResourceError({
                  message: `Unknown resource ${request.name}; declare it on this Host first`,
                });
              const held = model.leases.get(request.requestId);

              if (held !== undefined) {
                if (
                  held.processId !== request.processId ||
                  held.processIdentity !== request.processIdentity ||
                  held.resource !== request.name
                )
                  return yield* new ResourceError({
                    message: "Lease request belongs to another process",
                  });
                Deferred.doneUnsafe(deferred, Effect.succeed(held));

                return;
              }

              const queued = model.waiting.get(request.requestId);

              if (queued !== undefined) {
                if (
                  queued.processId !== request.processId ||
                  queued.processIdentity !== request.processIdentity ||
                  queued.resource !== request.name
                )
                  return yield* new ResourceError({
                    message: "Lease request belongs to another process",
                  });
                pending.set(request.requestId, deferred);
                yield* pump();

                return;
              }

              pending.set(request.requestId, deferred);
              yield* write(null, [
                DomainEvent.cases.ResourceLeaseQueued.make({
                  hostId,
                  resource: request.name,
                  requestId: request.requestId,
                  sessionId: request.sessionId,
                  processId: request.processId,
                  processIdentity: request.processIdentity,
                  command: request.command,
                }),
              ]);
              yield* pump();
            })
          ).pipe(Effect.uninterruptible);

          return yield* Deferred.await(deferred);
        }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(request.requestId)))),
      acquireWorker: (sessionId) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const deferred = yield* Deferred.make<void, ResourceError>();
            const requestId = randomUUID();
            yield* Effect.addFinalizer(() =>
              serialized(
                Effect.gen(function* () {
                  if (workerRequests.get(sessionId) !== requestId) return;
                  workerWaiters.delete(sessionId);
                  workers.delete(sessionId);
                  workerRequests.delete(sessionId);

                  if (model.leases.has(requestId) || model.waiting.has(requestId))
                    yield* write(null, [
                      releaseEvent(requestId, WORKERS_RESOURCE, "Attempt scope closed"),
                    ]);
                  yield* pumpWorkers();
                })
              ).pipe(Effect.orDie)
            );
            yield* serialized(
              Effect.gen(function* () {
                if (workers.has(sessionId) || workerWaiters.has(sessionId))
                  return yield* new ResourceError({
                    message: "Worker already holds or awaits a slot",
                  });

                if (!model.resources.has(WORKERS_RESOURCE))
                  yield* declare(CommandId.make(randomUUID()), WORKERS_RESOURCE, defaultCap);
                workerRequests.set(sessionId, requestId);
                workerWaiters.set(sessionId, deferred);
                yield* write(null, [
                  DomainEvent.cases.ResourceLeaseQueued.make({
                    hostId,
                    resource: WORKERS_RESOURCE,
                    requestId,
                    sessionId,
                  }),
                ]);
                yield* pumpWorkers();
              })
            );
            yield* restore(Deferred.await(deferred));
          })
        ),
    });
  })
);
