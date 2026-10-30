/**
 * `BrowserHosting` for a service built before the transport (ENG-616). The relay sits under
 * the Engine, while the hosting the byte-stream handlers use needs `HostPresence`, which only
 * the transport provides: the slot's layer delegates each call to the hosting bound later.
 */
import { Deferred, Effect, Layer } from "effect";
import { BrowserHosting } from "./hosting.ts";

export interface BrowserHostingSlot {
  /** `BrowserHosting` whose calls wait for `bind`, then go to the bound hosting. */
  readonly layer: Layer.Layer<BrowserHosting>;
  /** Binds the `BrowserHosting` in context; compose it next to the handlers that use it. */
  readonly bind: Layer.Layer<never, never, BrowserHosting>;
}

export const browserHostingSlot = (): BrowserHostingSlot => {
  const slot = Deferred.makeUnsafe<BrowserHosting["Service"]>();
  let bound: BrowserHosting["Service"] | null = null;
  const hosting = Deferred.await(slot);

  return {
    layer: Layer.succeed(BrowserHosting)(
      BrowserHosting.of({
        register: (connectionId, blobs) =>
          Effect.flatMap(hosting, (bound) => bound.register(connectionId, blobs)),
        claim: (connectionId, sessionId) =>
          Effect.flatMap(hosting, (bound) => bound.claim(connectionId, sessionId)),
        release: (connectionId, sessionId) =>
          Effect.flatMap(hosting, (bound) => bound.release(connectionId, sessionId)),
        awaitingClaims: (connectionId) => bound?.awaitingClaims(connectionId) ?? 0,
        current: (sessionId) => Effect.flatMap(hosting, (bound) => bound.current(sessionId)),
        open: (sessionId, purpose) =>
          Effect.flatMap(hosting, (bound) => bound.open(sessionId, purpose)),
        accept: (connectionId, streamId, upstream, window) =>
          Effect.flatMap(hosting, (bound) =>
            bound.accept(connectionId, streamId, upstream, window)
          ),
        close: (connectionId, streamId, reason) =>
          Effect.flatMap(hosting, (bound) => bound.close(connectionId, streamId, reason)),
        credit: (connectionId, streamId, bytes) =>
          Effect.flatMap(hosting, (bound) => bound.credit(connectionId, streamId, bytes)),
      })
    ),
    bind: Layer.effectDiscard(
      Effect.flatMap(BrowserHosting, (service) =>
        Effect.sync(() => {
          bound = service;
          Deferred.doneUnsafe(slot, Effect.succeed(service));
        })
      )
    ),
  };
};
