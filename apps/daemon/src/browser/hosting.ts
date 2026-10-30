/**
 * Which connection hosts each Agent Session's Browser (ENG-616, ADR 0092), and the Browser
 * streams the Daemon opens toward it. Connections are `Rpc.ServerClient` ids, as in presence.
 * A stream belongs to the connection it was offered to: no other connection can accept, close
 * or credit it, and it ends with that connection or when the Browser moves (`revoked`).
 */
import {
  type BlobId,
  BrowserHostItem,
  type BrowserStreamPurpose,
  BYTE_STREAM_WINDOW_BYTES,
  type ByteStreamCloseReason,
  type ByteStreamEndpoint,
  ByteStreamId,
  type ByteTransport,
  makeByteStreamEndpoint,
  NoDesktopApp,
  NotFound,
  SessionId,
  TransportError,
  Unsupported,
} from "@polaris/protocol";
import {
  type Cause,
  Context,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Layer,
  Queue,
  type Scope,
  Schema,
  Stream,
} from "effect";
import { Engine } from "../engine/Engine.ts";
import { HostPresence } from "../presence/index.ts";
import { type BlobChannel, ServiceError } from "../services.ts";
import { ByteStreamQuota } from "./quota.ts";

/** A byte-stream's `outgoing` as a blob source: its failure aborts the blob, so the reason is moot. */
const asBlobSource = (stream: Stream.Stream<Uint8Array, TransportError>) =>
  stream.pipe(
    Stream.mapError(
      (error) => new ServiceError({ service: "browser-stream", message: error.message })
    )
  );

/** The hosting Desktop App closed or refused the stream before it carried the session's bytes. */
export class BrowserStreamRefused extends Schema.TaggedError<BrowserStreamRefused>()(
  "BrowserStreamRefused",
  { sessionId: SessionId, reason: Schema.String }
) {}

/** How long the hosting Desktop App has to answer an `Open` before it counts as refused. */
export const BROWSER_STREAM_ACCEPT_TIMEOUT: Duration.Input = "30 seconds";

/** Most Browsers one connection may claim at once: a bound so a bad Client can't grow `claims`. */
export const MAX_CLAIMS_PER_CONNECTION = 256;

/** What the Client answers an `Open` with. */
interface Accepted {
  readonly upstream: BlobId;
  readonly window: number;
}

type StreamState =
  | {
      readonly kind: "pending";
      readonly sessionId: SessionId;
      readonly accepted: Deferred.Deferred<Accepted, BrowserStreamRefused>;
      /** What the offered `downstream` blob carries: the endpoint's bytes, or nothing when refused. */
      readonly outgoing: Deferred.Deferred<Stream.Stream<Uint8Array, TransportError>>;
    }
  | { readonly kind: "open"; readonly sessionId: SessionId; readonly endpoint: ByteStreamEndpoint };

interface Registration {
  readonly connectionId: number;
  readonly blobs: BlobChannel["Service"];
  readonly items: Queue.Queue<BrowserHostItem, Cause.Done>;
  readonly streams: Map<ByteStreamId, StreamState>;
  /** Registration order: the latest wins a tie on presence. */
  readonly order: number;
  closed: boolean;
}

export interface BrowserHostingOptions {
  /** Shorter in tests. */
  readonly acceptTimeout?: Duration.Input;
}

let streamCounter = 0;

const allocateStreamId = () => {
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

  return ByteStreamId.make(`bs${(++streamCounter).toString(36)}-${suffix}`);
};

const notFound = (streamId: ByteStreamId) => new NotFound({ what: "browser stream", id: streamId });

export class BrowserHosting extends Context.Service<
  BrowserHosting,
  {
    /**
     * `browser.host`: `connectionId` can host Browsers until the scope closes, which also
     * releases its claims and ends its streams. Answers the items to send that connection.
     * `blobs` is the connection's channel, where the streams' blobs travel.
     */
    readonly register: (
      connectionId: number,
      blobs: BlobChannel["Service"]
    ) => Effect.Effect<Stream.Stream<BrowserHostItem>, never, Scope.Scope>;
    /** `browser.claim`: `Unsupported` unless `connectionId` is registered. Moves the session's streams off the previous holder. */
    readonly claim: (
      connectionId: number,
      sessionId: SessionId
    ) => Effect.Effect<void, NotFound | Unsupported>;
    /** `browser.release`. A no-op for a claim the connection doesn't hold. */
    readonly release: (connectionId: number, sessionId: SessionId) => Effect.Effect<void>;
    /** Claims for `connectionId` still waiting on its `browser.host`; 0 once cleaned up. */
    readonly awaitingClaims: (connectionId: number) => number;
    /** The connection hosting `sessionId`'s Browser: the last to claim it, else the most recently present one. */
    readonly current: (sessionId: SessionId) => Effect.Effect<number, NoDesktopApp>;
    /** Opens a Browser stream toward the hosting connection; the scope's close ends it. */
    readonly open: (
      sessionId: SessionId,
      purpose: BrowserStreamPurpose
    ) => Effect.Effect<ByteTransport, NoDesktopApp | BrowserStreamRefused, Scope.Scope>;
    /** `browser.acceptStream`: `upstream` is the Client's blob on its connection, `window` its buffer. */
    readonly accept: (
      connectionId: number,
      streamId: ByteStreamId,
      upstream: BlobId,
      window: number
    ) => Effect.Effect<void, NotFound>;
    /** `browser.closeStream`. */
    readonly close: (
      connectionId: number,
      streamId: ByteStreamId,
      reason: ByteStreamCloseReason
    ) => Effect.Effect<void, NotFound>;
    /** `byteStream.credit` for a Browser stream: the Client consumed `bytes` of `downstream`. */
    readonly credit: (
      connectionId: number,
      streamId: ByteStreamId,
      bytes: number
    ) => Effect.Effect<void, NotFound>;
  }
>()("polaris/daemon/browser/BrowserHosting") {
  static make(
    presence: HostPresence["Service"],
    quota: ByteStreamQuota["Service"],
    options: BrowserHostingOptions = {},
    /** Whether a session may be hosted; the Daemon backs this with the Engine, tests with a fake. */
    isHostable: (sessionId: SessionId) => Effect.Effect<boolean> = () => Effect.succeed(true)
  ): BrowserHosting["Service"] {
    const acceptTimeout = options.acceptTimeout ?? BROWSER_STREAM_ACCEPT_TIMEOUT;
    const registrations = new Map<number, Registration>();
    /** `claim`s that raced ahead of their `browser.host`: each resolves when the connection registers. */
    const awaitingRegistration = new Map<number, Set<Deferred.Deferred<Registration>>>();
    /** The connection that last claimed each session's Browser. */
    const claims = new Map<SessionId, number>();
    let registrationCounter = 0;

    /** Forgets the stream; tells the connection when the Daemon's side ended it. */
    const endStream = (
      registration: Registration,
      streamId: ByteStreamId,
      reason: ByteStreamCloseReason,
      notify: boolean
    ) => {
      const state = registration.streams.get(streamId);

      if (state === undefined) return;
      registration.streams.delete(streamId);
      quota.release(registration.connectionId);

      if (state.kind === "pending") {
        Deferred.doneUnsafe(
          state.accepted,
          Effect.fail(new BrowserStreamRefused({ sessionId: state.sessionId, reason }))
        );
        Deferred.doneUnsafe(state.outgoing, Effect.succeed(Stream.empty));
      } else if (reason === "closed") {
        state.endpoint.end();
      } else {
        state.endpoint.fail(`browser stream ${reason}`);
      }

      if (notify && !registration.closed)
        Queue.offerUnsafe(
          registration.items,
          BrowserHostItem.cases.Close.make({ streamId, reason })
        );
    };

    const revokeSession = (registration: Registration, sessionId: SessionId) => {
      for (const [streamId, state] of registration.streams)
        if (state.sessionId === sessionId) endStream(registration, streamId, "revoked", true);
    };

    /** Every connection but `keep` loses `sessionId`: a hosting move revokes the old recipient's streams. */
    const revokeOthers = (sessionId: SessionId, keep: number | null) => {
      for (const registration of registrations.values())
        if (registration.connectionId !== keep) revokeSession(registration, sessionId);
    };

    const claimCount = (connectionId: number) => {
      let count = 0;

      for (const holder of claims.values()) if (holder === connectionId) count++;

      return count;
    };

    const unregister = (registration: Registration) => {
      if (registration.closed) return;
      registration.closed = true;

      const openStreamIds = [...registration.streams.keys()];

      for (const streamId of openStreamIds) endStream(registration, streamId, "failed", false);

      for (const [sessionId, holder] of claims)
        if (holder === registration.connectionId) claims.delete(sessionId);

      if (registrations.get(registration.connectionId) === registration)
        registrations.delete(registration.connectionId);
      Queue.endUnsafe(registration.items);
      // Losing this connection can hand its unclaimed sessions to a new fallback.
      reconcile();
    };

    const hostOf = (sessionId: SessionId): Registration | null => {
      const claimed = claims.get(sessionId);
      const claimedBy = claimed === undefined ? undefined : registrations.get(claimed);

      if (claimedBy !== undefined) return claimedBy;
      let best: Registration | null = null;
      let bestAt = -1;

      for (const registration of registrations.values()) {
        const at = presence.lastPresentAt(registration.connectionId) ?? -1;

        if (best === null || at > bestAt || (at === bestAt && registration.order > best.order)) {
          best = registration;
          bestAt = at;
        }
      }

      return best;
    };

    const current = (sessionId: SessionId) =>
      Effect.suspend(() => {
        const host = hostOf(sessionId);

        return host === null
          ? Effect.fail(new NoDesktopApp({ sessionId }))
          : Effect.succeed(host.connectionId);
      });

    // Recompute the host for every session with streams and revoke any whose recipient is no
    // longer it. Presence only steers new opens, so this runs on claim, release and (un)register.
    const reconcile = () => {
      const sessions = new Set<SessionId>();

      for (const registration of registrations.values())
        for (const state of registration.streams.values()) sessions.add(state.sessionId);

      for (const sessionId of sessions)
        revokeOthers(sessionId, hostOf(sessionId)?.connectionId ?? null);
    };

    const register = Effect.fn("BrowserHosting.register")(function* (
      connectionId: number,
      blobs: BlobChannel["Service"]
    ) {
      // A second `browser.host` on one connection replaces the first, which ends.
      const previous = registrations.get(connectionId);

      if (previous !== undefined) unregister(previous);

      const registration: Registration = {
        connectionId,
        blobs,
        items: yield* Queue.unbounded<BrowserHostItem, Cause.Done>(),
        streams: new Map(),
        order: ++registrationCounter,
        closed: false,
      };

      registrations.set(connectionId, registration);
      const waiters = awaitingRegistration.get(connectionId);

      if (waiters !== undefined) {
        awaitingRegistration.delete(connectionId);

        for (const waiter of waiters) Deferred.doneUnsafe(waiter, Effect.succeed(registration));
      }

      // A new registration can become the fallback host, so reroute existing streams.
      reconcile();
      yield* Effect.addFinalizer(() => Effect.sync(() => unregister(registration)));

      return Stream.fromQueue(registration.items);
    });

    const open = Effect.fn("BrowserHosting.open")(function* (
      sessionId: SessionId,
      purpose: BrowserStreamPurpose
    ) {
      const host = hostOf(sessionId);

      if (host === null) return yield* new NoDesktopApp({ sessionId });

      if (!quota.acquire(host.connectionId))
        return yield* new BrowserStreamRefused({
          sessionId,
          reason: "the hosting Desktop App has too many byte streams open",
        });

      const streamId = allocateStreamId();
      const accepted = yield* Deferred.make<Accepted, BrowserStreamRefused>();
      const outgoing = yield* Deferred.make<Stream.Stream<Uint8Array, TransportError>>();
      host.streams.set(streamId, { kind: "pending", sessionId, accepted, outgoing });
      // Ending our side (the scope closed, or `close`) tells the Desktop App; a refusal already has.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => endStream(host, streamId, "closed", true))
      );

      const downstream = yield* host.blobs.offer(
        asBlobSource(Stream.unwrap(Deferred.await(outgoing)))
      );

      yield* Queue.offer(
        host.items,
        BrowserHostItem.cases.Open.make({
          streamId,
          sessionId,
          purpose,
          downstream,
          window: BYTE_STREAM_WINDOW_BYTES,
        })
      );

      // A failed or interrupted open frees its quota, entry and downstream blob at once, rather
      // than holding them until the caller's scope closes.
      return yield* Effect.gen(function* () {
        const answer = yield* Deferred.await(accepted).pipe(
          Effect.timeoutOrElse({
            duration: acceptTimeout,
            orElse: () =>
              Effect.fail(
                new BrowserStreamRefused({
                  sessionId,
                  reason: "the hosting Desktop App did not answer in time",
                })
              ),
          })
        );

        const endpoint = yield* makeByteStreamEndpoint({
          incoming: (onConsumed) =>
            host.blobs.takeStream(answer.upstream, {
              longLived: true,
              maxUnread: BYTE_STREAM_WINDOW_BYTES,
              onConsumed,
            }),
          window: BYTE_STREAM_WINDOW_BYTES,
          peerWindow: answer.window,
          grant: (bytes) =>
            Effect.asVoid(
              Queue.offer(host.items, BrowserHostItem.cases.Credit.make({ streamId, bytes }))
            ),
        });

        // Refused or revoked while the open was waiting: the entry is gone already.
        if (host.streams.get(streamId)?.kind !== "pending") {
          endpoint.fail("browser stream revoked");

          return yield* new BrowserStreamRefused({ sessionId, reason: "revoked" });
        }

        host.streams.set(streamId, { kind: "open", sessionId, endpoint });
        yield* Deferred.succeed(outgoing, endpoint.outgoing);

        return {
          ...endpoint.transport,
          close: Effect.sync(() => endStream(host, streamId, "closed", true)),
        } satisfies ByteTransport;
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.sync(() => endStream(host, streamId, "refused", true))
        )
      );
    });

    /** The stream `connectionId` was offered, or `NotFound`: another connection's is invisible. */
    const owned = (connectionId: number, streamId: ByteStreamId) =>
      Effect.suspend(() => {
        const registration = registrations.get(connectionId);
        const state = registration?.streams.get(streamId);

        return registration === undefined || state === undefined
          ? Effect.fail(notFound(streamId))
          : Effect.succeed({ registration, state });
      });

    /** Waits out the gap between a connection's `browser.host` arriving and its handler registering. */
    const awaitRegistered = Effect.fn("BrowserHosting.awaitRegistered")(function* (
      connectionId: number
    ) {
      const waiter = yield* Deferred.make<Registration>();
      const waiters = awaitingRegistration.get(connectionId) ?? new Set();
      waiters.add(waiter);
      awaitingRegistration.set(connectionId, waiters);

      // Drop only this claim's waiter, so interrupting one claim cannot strand another.
      const forget = Effect.sync(() => {
        const set = awaitingRegistration.get(connectionId);

        if (set === undefined) return;
        set.delete(waiter);

        if (set.size === 0) awaitingRegistration.delete(connectionId);
      });

      return yield* Deferred.await(waiter).pipe(
        Effect.timeoutOrElse({
          duration: acceptTimeout,
          orElse: () => Effect.andThen(forget, new Unsupported({ capability: "browser.host" })),
        }),
        // A Client that claimed without registering, then cancelled or dropped, must not leak its waiter.
        Effect.onInterrupt(() => forget)
      );
    });

    return BrowserHosting.of({
      register,
      claim: Effect.fn("BrowserHosting.claim")(function* (connectionId, sessionId) {
        // Reject a claim for a session the Daemon does not know, or has archived.
        if (!(yield* isHostable(sessionId)))
          return yield* new NotFound({ what: "session", id: sessionId });

        yield* registrations.get(connectionId) === undefined
          ? awaitRegistered(connectionId)
          : Effect.void;

        // The session can be archived while the registration wait is in flight; re-check it.
        if (!(yield* isHostable(sessionId)))
          return yield* new NotFound({ what: "session", id: sessionId });

        // Bound a connection's claims so a Client cannot grow `claims` without limit.
        if (
          claims.get(sessionId) !== connectionId &&
          claimCount(connectionId) >= MAX_CLAIMS_PER_CONNECTION
        )
          return yield* new NotFound({ what: "browser claim slot", id: sessionId });

        claims.set(sessionId, connectionId);
        // The claim changes effective hosting: whoever held it before loses its streams.
        reconcile();
      }),
      awaitingClaims: (connectionId) => awaitingRegistration.get(connectionId)?.size ?? 0,
      release: (connectionId, sessionId) =>
        Effect.sync(() => {
          if (claims.get(sessionId) !== connectionId) return;
          claims.delete(sessionId);
          // Hosting reroutes to the fallback; the releaser (and anyone not the new host) loses it.
          reconcile();
        }),
      current,
      open,
      accept: Effect.fn("BrowserHosting.accept")(
        function* (connectionId, streamId, upstream, window) {
          const { state } = yield* owned(connectionId, streamId);

          // Accepting twice, or after the stream opened, is not an accept. The `succeed` result
          // is the atomic guard: a second accept that races the first loses and is refused.
          if (state.kind !== "pending") return yield* notFound(streamId);
          const won = yield* Deferred.succeed(state.accepted, { upstream, window });

          if (!won) return yield* notFound(streamId);
        }
      ),
      close: Effect.fn("BrowserHosting.close")(function* (connectionId, streamId, reason) {
        const { registration } = yield* owned(connectionId, streamId);
        endStream(registration, streamId, reason, false);
      }),
      credit: Effect.fn("BrowserHosting.credit")(function* (connectionId, streamId, bytes) {
        const { registration, state } = yield* owned(connectionId, streamId);

        if (state.kind !== "open") return yield* notFound(streamId);

        // Credit for bytes never sent is a protocol violation: the stream ends.
        if (!state.endpoint.credited(bytes)) {
          endStream(registration, streamId, "failed", true);

          return yield* notFound(streamId);
        }
      }),
    });
  }

  /** For tests and Daemons with no Engine: every session is hostable. */
  static layer(options?: BrowserHostingOptions) {
    return Layer.effect(
      BrowserHosting,
      Effect.gen(function* () {
        return BrowserHosting.make(yield* HostPresence, yield* ByteStreamQuota, options);
      })
    );
  }

  /** The Daemon's wiring: the Engine says which sessions exist and are not archived. */
  static layerLive(options?: BrowserHostingOptions) {
    return Layer.effect(
      BrowserHosting,
      Effect.gen(function* () {
        const engine = yield* Engine;

        return BrowserHosting.make(
          yield* HostPresence,
          yield* ByteStreamQuota,
          options,
          engine.hostableSession
        );
      })
    );
  }

  /**
   * Placeholder for Daemons that mount no byte-stream handlers: no connection can register,
   * so `current` and `open` fail `NoDesktopApp`; the stream operations die.
   */
  static readonly layerStub = Layer.succeed(BrowserHosting)(
    BrowserHosting.of({
      register: Effect.fn("BrowserHosting.register")(function* () {
        return yield* Effect.die(new Error("browser.host is not implemented"));
      }),
      claim: Effect.fn("BrowserHosting.claim")(function* () {
        return yield* new Unsupported({ capability: "browser.host" });
      }),
      release: Effect.fn("BrowserHosting.release")(function* () {}),
      awaitingClaims: () => 0,
      current: Effect.fn("BrowserHosting.current")(function* (sessionId: SessionId) {
        return yield* new NoDesktopApp({ sessionId });
      }),
      open: Effect.fn("BrowserHosting.open")(function* (sessionId: SessionId) {
        return yield* new NoDesktopApp({ sessionId });
      }),
      accept: Effect.fn("BrowserHosting.accept")(function* () {
        return yield* Effect.die(new Error("browser.acceptStream is not implemented"));
      }),
      close: Effect.fn("BrowserHosting.close")(function* () {
        return yield* Effect.die(new Error("browser.closeStream is not implemented"));
      }),
      credit: Effect.fn("BrowserHosting.credit")(function* () {
        return yield* Effect.die(new Error("byteStream.credit is not implemented"));
      }),
    })
  );
}
