import { type ConstellationId, type SessionId, type DomainEvent } from "@polaris/protocol";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { emptyResources } from "../../resources/model.ts";
import { hasWorkerAdmission } from "../../resources/workerAdmission.ts";
import { EventStore } from "../../store/EventStore.ts";
import { UsageIndex } from "../../usage/index.ts";
import { graphEvent } from "../../store/constellation.ts";
import { ConstellationOwner } from "../runtime.ts";
import { ConstellationLiveness } from "../liveness.ts";
import { performHandover } from "../handover/index.ts";
import { digestDelay } from "./format.ts";
import { commitJournal } from "./journal.ts";
import { deliverDigest, deliverLocalInput, nudgeSilentWorker } from "./local.ts";
import { settleFailedWorker } from "./failures.ts";
import { acceptedBlockInput, unblocksAttempt } from "../blocked.ts";
import { pendingInputs } from "./messages.ts";
import { expiredWaits } from "./waits.ts";
import { nextWaitExpiry } from "../stall.ts";
import {
  ConstellationSessionEffects,
  ConstellationRemoteDelivery,
  DeliveryInput,
} from "./inputs.ts";

interface Timer {
  readonly at: number;
  due: boolean;
  fiber?: Fiber.Fiber<void> | undefined;
}

interface Job {
  readonly key: string;
  readonly fiber: Fiber.Fiber<void>;
}

const make = Effect.gen(function* () {
  const store = yield* EventStore;
  const owner = yield* ConstellationOwner;
  const remote = yield* ConstellationRemoteDelivery;
  const liveness = yield* ConstellationLiveness;
  const usage = yield* Effect.serviceOption(UsageIndex);
  const queued = new Map<SessionId, number>();
  const scope = yield* Scope.Scope;

  const dependencies = yield* Effect.context<
    EventStore | ConstellationOwner | ConstellationSessionEffects
  >();

  const gate = yield* Semaphore.make(1);
  const timers = new Map<ConstellationId, Timer>();
  /** One wake per Constellation, when its next held wait runs out (ENG-742). */
  const waitTimers = new Map<ConstellationId, Timer>();
  /** Expired waits already handed to the nudge, by `[attemptId, turnId]`. */
  const expired = new Set<string>();
  const handovers = new Map<ConstellationId, Job>();
  const inputs = new Set<string>();
  let running = false;
  let sequence = 0;

  const cancelTimer = Effect.fnUntraced(function* (id: ConstellationId) {
    const timer = timers.get(id);
    timers.delete(id);

    if (timer?.fiber !== undefined) yield* Fiber.interrupt(timer.fiber);
  });

  const acknowledge = Effect.fn("ConstellationDelivery.acknowledge")(function* (
    id: string,
    sessionId: SessionId
  ) {
    for (const graph of (yield* store.model).constellations.values()) {
      if (graph.graph.hostId !== owner) continue;

      const source = [
        ...graph.sentMessages.keys(),
        ...graph.peers.keys(),
        ...graph.graph.attempts.flatMap((a) => {
          const input = acceptedBlockInput(graph, a);

          return input === null ? [] : [input.id];
        }),
      ].find((sourceId) => sourceId === id || JSON.stringify([sourceId, sessionId]) === id);

      if (source !== undefined)
        yield* commitJournal(graph.graph.id, {
          type: "inputDelivered",
          id: source,
          sessionId,
          turnEvents: [],
        });
    }
  });

  const sendInputs = Effect.fnUntraced(function* (id: ConstellationId) {
    const model = yield* store.model;
    const record = model.constellations.get(id);

    if (record === undefined || record.graph.hostId !== owner || record.graph.state === "archived")
      return;

    for (const input of pendingInputs(record)) {
      const attempt = record.graph.attempts.findLast((a) => a.sessionId === input.sessionId);

      if (attempt?.state === "blocked" && !unblocksAttempt(record, attempt, input.id)) continue;

      const key = JSON.stringify([input.id, input.sessionId]);

      if (inputs.has(key) || (attempt !== undefined && record.stale.has(attempt.id))) continue;
      inputs.add(key);

      if (attempt === undefined || attempt.hostId === owner) {
        if (!hasWorkerAdmission(store, input.sessionId)) {
          inputs.delete(key);
          yield* deliverLocalInput(id, input);
          continue;
        }

        yield* deliverLocalInput(id, input).pipe(
          Effect.provide(dependencies),
          Effect.catchCause((cause) =>
            Effect.logError("Local Constellation input remains queued", cause)
          ),
          Effect.ensuring(Effect.sync(() => inputs.delete(key))),
          Effect.forkIn(scope)
        );
        continue;
      }

      yield* remote
        .send({
          id: key,
          ownerHostId: owner,
          workerHostId: attempt.hostId,
          constellationId: id,
          attemptId: attempt.id,
          sessionId: input.sessionId,
          input: DeliveryInput.Turn({
            text: input.text,
            cause: attempt.state === "blocked" ? "unblock" : "message",
          }),
        })
        .pipe(
          Effect.andThen(acknowledge(input.id, input.sessionId)),
          Effect.catchCause((cause) =>
            Effect.logError("Remote Constellation input remains queued", cause)
          ),
          Effect.ensuring(Effect.sync(() => inputs.delete(key))),
          Effect.forkIn(scope)
        );
    }
  });

  /** A wait that ran out with no Turn after it gets the silent-end nudge, or its Stopped. */
  const nudgeExpired = Effect.fnUntraced(function* (id: ConstellationId, now: number) {
    const model = yield* store.model;
    const record = model.constellations.get(id);

    if (record === undefined || record.graph.state !== "running") return;

    for (const wait of expiredWaits(record, model.sessions, owner, now)) {
      const key = JSON.stringify([wait.attemptId, wait.turnId]);

      if (expired.has(key)) continue;
      expired.add(key);
      yield* nudgeSilentWorker(id, wait.sessionId, wait.turnId).pipe(
        Effect.provide(dependencies),
        Effect.catchCause((cause) => Effect.logError("Expired wait nudge failed", cause)),
        Effect.forkIn(scope)
      );
    }
  });

  const armWait = Effect.fnUntraced(function* (
    id: ConstellationId,
    at: number | null,
    now: number
  ) {
    const existing = waitTimers.get(id);

    if (existing?.at === at) return;
    waitTimers.delete(id);

    if (existing?.fiber !== undefined) yield* Fiber.interrupt(existing.fiber);

    if (at === null) return;
    const timer: Timer = { at, due: false };
    waitTimers.set(id, timer);
    timer.fiber = yield* Effect.sleep(Math.max(0, at - now)).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          if (waitTimers.get(id) !== timer) return;
          waitTimers.delete(id);
          yield* gate.withPermits(1)(refresh(id));
        })
      ),
      Effect.catchCause((cause) => Effect.logError("Constellation wait wake failed", cause)),
      Effect.forkIn(scope)
    );
  });

  const refreshHandover = Effect.fnUntraced(function* (id: ConstellationId) {
    const request = (yield* store.model).constellations.get(id)?.handoverRequest;
    const job = handovers.get(id);

    if (job?.key === request?.requestId) return;

    if (job !== undefined) {
      handovers.delete(id);
      yield* Fiber.interrupt(job.fiber);
    }

    if (request === undefined || request === null) return;

    const fiber = yield* performHandover(id, request.requestId).pipe(
      Effect.catchCause((cause) => Effect.logError("Lead handover needs attention", cause)),
      Effect.forkIn(scope)
    );

    handovers.set(id, { key: request.requestId, fiber });
  });

  const refresh = Effect.fnUntraced(function* (
    id: ConstellationId
  ): Effect.fn.Return<
    void,
    import("@polaris/protocol").ConstellationRejected | import("../../services.ts").ServiceError,
    never
  > {
    const record = (yield* store.model).constellations.get(id);

    if (record === undefined || record.graph.hostId !== owner) return;
    const pending = pendingInputs(record);

    for (const sessionId of new Set(record.graph.attempts.map((a) => a.sessionId))) {
      const count = pending.filter((i) => i.sessionId === sessionId).length;

      if (queued.get(sessionId) === count) continue;
      queued.set(sessionId, count);
      yield* liveness.queued(sessionId, count);
    }

    yield* refreshHandover(id).pipe(Effect.provide(dependencies));
    yield* sendInputs(id).pipe(Effect.provide(dependencies));
    const model = yield* store.model;
    const now = yield* Clock.currentTimeMillis;
    const source = { hostId: owner, resources: model.hostResources ?? emptyResources(), now };
    yield* nudgeExpired(id, now);

    yield* armWait(
      id,
      record.graph.state === "running" ? nextWaitExpiry(record, model.sessions, source) : null,
      now
    );
    const delay = digestDelay(record, model.sessions, source);

    if (delay === null || record.graph.state !== "running" || record.handoverRequest !== null) {
      yield* cancelTimer(id);

      return;
    }

    const existing = timers.get(id);

    // A delivered window ends; what arrives next coalesces afresh instead of riding the old timer.
    if (existing?.due) {
      if (yield* deliverDigest(id).pipe(Effect.provide(dependencies))) timers.delete(id);

      return;
    }

    const at = now + delay;

    if (existing !== undefined && existing.at <= at) return;
    yield* cancelTimer(id);
    const timer: Timer = { at, due: false };
    timers.set(id, timer);
    timer.fiber = yield* Effect.sleep(delay).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          if (timers.get(id) !== timer) return;
          timer.due = true;
          timer.fiber = undefined;
          yield* gate.withPermits(1)(refresh(id));
        })
      ),
      Effect.catchCause((cause) => Effect.logError("Lead digest remains queued", cause)),
      Effect.forkIn(scope)
    );
  });

  const flush = Effect.fn("ConstellationDelivery.flush")(function* () {
    for (const record of (yield* store.model).constellations.values())
      yield* refresh(record.graph.id);
  }, gate.withPermits(1));

  /** A declared wait changes what the worker's row shows before any Harness event does. */
  const touchWaiting = Effect.fnUntraced(function* (event: DomainEvent) {
    if (!Predicate.isTagged(event, "AttemptProgressed") || event.waiting == null) return;
    const record = (yield* store.model).constellations.get(event.constellationId);
    const attempt = record?.graph.attempts.find((a) => a.id === event.attemptId);

    if (attempt !== undefined) yield* liveness.touch(attempt.sessionId);
  });

  const committed = Effect.fnUntraced(function* (event: DomainEvent) {
    yield* touchWaiting(event);

    if (Predicate.isTagged(event, "TurnEnded") && event.turn.status === "completed") {
      for (const record of (yield* store.model).constellations.values())
        if (
          record.graph.attempts.some(
            (a) => a.sessionId === event.turn.sessionId && a.state === "working"
          )
        )
          yield* nudgeSilentWorker(record.graph.id, event.turn.sessionId, event.turn.id).pipe(
            Effect.provide(dependencies)
          );
    }

    if (Predicate.isTagged(event, "TurnEnded") && event.turn.status === "failed")
      for (const record of (yield* store.model).constellations.values())
        yield* settleFailedWorker(
          record.graph.id,
          event.turn.sessionId,
          event.turn.id,
          Option.isSome(usage) ? usage.value.planLimits : Effect.succeed([])
        ).pipe(Effect.provide(dependencies));

    yield* flush();
  });

  const start = Effect.fn("ConstellationDelivery.start")(function* () {
    if (running) return;
    running = true;
    const ready = yield* Deferred.make<void>();

    const observe = Effect.scoped(
      Effect.gen(function* () {
        const feed = yield* store.subscribe({
          filter: (i) =>
            Predicate.isTagged(i, "Event") &&
            (graphEvent(i.envelope.event) !== null ||
              Predicate.isTagged(i.envelope.event, "SessionStateChanged") ||
              // A worker slot granted with no Turn arms the stall wake (`nextSlotStall`).
              Predicate.isTagged(i.envelope.event, "ResourceLeased") ||
              // Background work ending starts a waiting worker's grace (`waiting.ts`).
              Predicate.isTagged(i.envelope.event, "SessionBackgroundTasksChanged") ||
              Predicate.isTagged(i.envelope.event, "TurnEnded")),
        });

        const cut = (yield* store.model).sequence;
        const suffix = yield* store.readEvents({ after: sequence, upTo: cut, sessionId: null });

        // Restart re-derives work from the snapshot; old TurnEnded events must not re-trigger nudges.
        if (sequence !== 0) for (const e of suffix) yield* committed(e.event);
        sequence = cut;
        yield* flush();
        yield* Deferred.succeed(ready, undefined);
        yield* feed.pipe(
          Stream.runForEach(
            Effect.fnUntraced(function* (i) {
              if (!Predicate.isTagged(i, "Event") || i.envelope.sequence <= sequence) return;
              yield* committed(i.envelope.event);
              sequence = i.envelope.sequence;
            })
          )
        );
      })
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.andThen(
          Effect.logError("Constellation delivery observer reopening", cause),
          Effect.sleep("1 second")
        )
      )
    );

    yield* observe.pipe(Effect.forever, Effect.forkIn(scope));
    yield* Deferred.await(ready);
  });

  return {
    start,
    flush,
    acknowledge: (id: string, sessionId: SessionId) =>
      acknowledge(id, sessionId).pipe(Effect.provide(dependencies), Effect.andThen(flush)),
    pendingTimers: Effect.sync(() => timers.size + waitTimers.size),
  };
});

export class ConstellationDelivery extends Context.Service<
  ConstellationDelivery,
  Effect.Success<typeof make>
>()("polaris/daemon/constellation/Delivery") {
  static readonly layer = Layer.effect(ConstellationDelivery, make);
}

export {
  ConstellationSessionEffects,
  ConstellationRemoteDelivery,
  DeliveryInput,
  type DeliveryPacket,
  type RecoveryCandidate,
} from "./inputs.ts";

export { applyWorkerDelivery } from "./turns.ts";

export { digestPrompt, digestDelay } from "./format.ts";
