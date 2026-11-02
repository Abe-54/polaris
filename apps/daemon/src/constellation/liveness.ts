import type {
  AttemptId,
  ConstellationId,
  ConstellationStreamItem,
  SessionId,
  WorkerLiveness,
} from "@polaris/protocol";
import { Context, Effect, Layer, Stream, type Scope } from "effect";
import type { HarnessEvent } from "../harness/HarnessDriver.ts";
import type { ConstellationRecord } from "../store/constellation.ts";
import type { EventStore } from "../store/EventStore.ts";

type Update = Extract<ConstellationStreamItem, { _tag: "LivenessChanged" }>;

export interface ConstellationLivenessDelegate {
  readonly read: (
    record: ConstellationRecord
  ) => Effect.Effect<ReadonlyMap<AttemptId, WorkerLiveness>>;
  readonly subscribe: (
    id: ConstellationId
  ) => Effect.Effect<Stream.Stream<Update>, never, Scope.Scope>;
  readonly observe: (
    sessionId: SessionId,
    event: HarnessEvent,
    at: number,
    queuedInput?: number
  ) => Effect.Effect<void>;
  readonly queued: (sessionId: SessionId, count: number) => Effect.Effect<void>;
  /** Republish a worker's liveness after a graph fact it reads changed (a declared wait). */
  readonly touch: (sessionId: SessionId) => Effect.Effect<void>;
}

export interface ConstellationLivenessService extends ConstellationLivenessDelegate {
  readonly activate: (service: ConstellationLivenessDelegate) => Effect.Effect<void>;
}

const makeLivenessProxy = (): ConstellationLivenessService => {
  let delegate: ConstellationLivenessDelegate = {
    read: () => Effect.succeed(new Map()),
    subscribe: () => Effect.succeed(Stream.empty),
    observe: () => Effect.void,
    queued: () => Effect.void,
    touch: () => Effect.void,
  };

  return {
    activate: (service) =>
      Effect.sync(() => {
        delegate = service;
      }),
    read: (record) => Effect.suspend(() => delegate.read(record)),
    subscribe: (id) => Effect.suspend(() => delegate.subscribe(id)),
    observe: (id, event, at, queued) =>
      Effect.suspend(() => delegate.observe(id, event, at, queued)),
    queued: (id, count) => Effect.suspend(() => delegate.queued(id, count)),
    touch: (id) => Effect.suspend(() => delegate.touch(id)),
  };
};

/** Stable observation proxy captured by the Engine before Constellation services load. */
export class ConstellationLiveness extends Context.Reference<ConstellationLivenessService>(
  "polaris/daemon/constellation/Liveness",
  { defaultValue: makeLivenessProxy }
) {
  static readonly proxyLayer = Layer.sync(ConstellationLiveness, makeLivenessProxy);
  static readonly layer: Layer.Layer<never, never, EventStore> = Layer.effect(
    ConstellationLiveness,
    Effect.gen(function* () {
      const captured = Context.getOrUndefined(
        yield* Effect.context<never>(),
        ConstellationLiveness
      );

      const proxy = captured ?? makeLivenessProxy();
      const { livenessProvider } = yield* Effect.promise(() => import("./liveness/provider.ts"));

      yield* proxy.activate(yield* livenessProvider);

      return proxy;
    })
  );
}
