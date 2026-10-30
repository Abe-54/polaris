/**
 * Byte streams over a Host's connection for a Client (ENG-613, ADR 0092, 0093). Host-address
 * streams: the Desktop App's SOCKS side opens one per Browser connection to a Host address
 * and gets a ByteTransport to the Host's loopback. Browser hosting: the Desktop App keeps
 * `browser.host` open, claims the sessions whose Browser it shows, and accepts the Browser
 * streams the Daemon opens toward it. Credits flow in both directions behind the transports.
 */
import {
  type BrowserHostItem,
  type BrowserStreamPurpose,
  BYTE_STREAM_WINDOW_BYTES,
  type ByteStreamCloseReason,
  type ByteStreamEndpoint,
  type ByteStreamId,
  type ByteTransport,
  type Capability,
  type HostAddressError,
  type HostAddressStreamItem,
  makeByteStreamEndpoint,
  type NotFound,
  type SessionId,
  TransportError,
  Unsupported,
} from "@polaris/protocol";
import {
  type Cause as CauseType,
  Deferred,
  Effect,
  Exit,
  Predicate,
  Queue,
  type Scope,
  Stream,
} from "effect";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type { ClientBlobs, DaemonClient } from "./rpc.ts";

/** What the helpers need of a live connection (`LiveSession`, or `hello`'s answer with its RPC client). */
export interface ByteStreamSession {
  readonly client: DaemonClient;
  readonly blobs: ClientBlobs;
  readonly capabilities: ReadonlyArray<Capability>;
}

export interface HostAddressTarget {
  readonly hostname: string;
  readonly port: number;
}

/** Grants credit without waiting on the reply; the Daemon's `NotFound` after a close is nothing to do. */
const creditFor =
  (session: ByteStreamSession, streamId: ByteStreamId) =>
  (bytes: number): Effect.Effect<void> =>
    session.client["byteStream.credit"]({ streamId, bytes }).pipe(
      Effect.ignore,
      Effect.forkChild,
      Effect.asVoid
    );

/**
 * Opens a byte stream to `target` on the Host's loopback and answers it as a ByteTransport:
 * `incoming` is the Host's bytes, `write` sends ours, `close` (or the scope's end) closes the
 * Daemon's socket. Fails `Unsupported` when the Daemon has no `host-address` capability, and
 * `HostAddressError` when the name is not a Host address or the loopback connect failed.
 */
export const openHostAddressStream = Effect.fnUntraced(function* (
  session: ByteStreamSession,
  target: HostAddressTarget
): Effect.fn.Return<ByteTransport, HostAddressError | Unsupported | RpcClientError, Scope.Scope> {
  if (!session.capabilities.includes("host-address"))
    return yield* new Unsupported({ capability: "host-address" });

  const outgoing = yield* Deferred.make<Stream.Stream<Uint8Array, TransportError>>();
  const upstream = yield* session.blobs.offer(Stream.unwrap(Deferred.await(outgoing)));

  const opened = yield* Deferred.make<
    ByteStreamEndpoint,
    HostAddressError | Unsupported | RpcClientError
  >();

  let endpoint: ByteStreamEndpoint | null = null;

  const items = session.client["hostAddress.open"]({
    hostname: target.hostname,
    port: target.port,
    upstream,
    window: BYTE_STREAM_WINDOW_BYTES,
  });

  const onItem = (item: HostAddressStreamItem) =>
    Effect.gen(function* () {
      if (Predicate.isTagged(item, "Opened")) {
        endpoint = yield* makeByteStreamEndpoint({
          incoming: (onConsumed) =>
            session.blobs.takeStream(item.downstream, {
              longLived: true,
              maxUnread: BYTE_STREAM_WINDOW_BYTES,
              onConsumed,
            }),
          window: BYTE_STREAM_WINDOW_BYTES,
          peerWindow: item.window,
          grant: creditFor(session, item.streamId),
        });

        yield* Deferred.succeed(outgoing, endpoint.outgoing);
        yield* Deferred.succeed(opened, endpoint);
      } else if (endpoint !== null && !endpoint.credited(item.bytes)) {
        endpoint.fail("the Daemon credited more than it was sent");
      }
    });

  // The item stream lives with the scope: ending it is how the Daemon learns to close the socket.
  yield* items.pipe(
    Stream.runForEach(onItem),
    Effect.exit,
    Effect.flatMap((exit) =>
      Effect.sync(() => {
        Deferred.doneUnsafe(outgoing, Effect.succeed(Stream.empty));

        // A failure before `Opened` is the open's failure (its typed error); a clean end that
        // never opened is a defect. Either way an opened endpoint ends here.
        Deferred.doneUnsafe(
          opened,
          Exit.isFailure(exit)
            ? Exit.failCause(exit.cause)
            : Exit.die("the Host-address stream ended before it opened")
        );

        if (Exit.isFailure(exit)) endpoint?.fail("the Host-address stream ended");
        else endpoint?.end();
      })
    ),
    Effect.forkScoped
  );

  const transport = yield* Deferred.await(opened);
  yield* Effect.addFinalizer(() => Effect.sync(transport.end));

  return transport.transport;
});

/** A Browser stream the Daemon asks this connection to carry. Answer with `accept` or `refuse`. */
export interface BrowserStreamOffer {
  readonly streamId: ByteStreamId;
  readonly sessionId: SessionId;
  readonly purpose: BrowserStreamPurpose;
  /**
   * Opens the stream: `incoming` is the Daemon's bytes, `write` sends ours, `close` (or the
   * scope's end) closes it for both. `NotFound`: the Daemon withdrew the offer meanwhile.
   */
  readonly accept: Effect.Effect<
    ByteTransport,
    NotFound | Unsupported | RpcClientError,
    Scope.Scope
  >;
  readonly refuse: Effect.Effect<void>;
}

export interface BrowserHost {
  /** Each stream the Daemon opens toward this connection, until the hosting ends. */
  readonly offers: Stream.Stream<BrowserStreamOffer>;
  /** This connection shows `sessionId`'s Browser: its streams come here. */
  readonly claim: (
    sessionId: SessionId
  ) => Effect.Effect<void, NotFound | Unsupported | RpcClientError>;
  readonly release: (sessionId: SessionId) => Effect.Effect<void, RpcClientError>;
  /** Settles when the Daemon ended the hosting (the connection dropped); fails with why. */
  readonly ended: Effect.Effect<void, RpcClientError | Unsupported>;
}

interface CarriedEntry {
  endpoint: ByteStreamEndpoint | null;
  closed: boolean;
}

/**
 * Registers this connection as a Browser host for as long as the scope lives: the Daemon may
 * route any session's Browser streams here. Fails `Unsupported` when either side lacks
 * `browser.host`. Ending the scope releases every claim and closes every stream.
 */
export const hostBrowsers = Effect.fnUntraced(function* (
  session: ByteStreamSession
): Effect.fn.Return<BrowserHost, Unsupported | RpcClientError, Scope.Scope> {
  if (!session.capabilities.includes("browser.host"))
    return yield* new Unsupported({ capability: "browser.host" });
  const offers = yield* Queue.unbounded<BrowserStreamOffer, CauseType.Done>();
  const ended = yield* Deferred.make<void, RpcClientError | Unsupported>();
  /** Streams offered and not yet closed; `accept` fills the endpoint in. */
  const carried = new Map<ByteStreamId, CarriedEntry>();

  const closeStream = (streamId: ByteStreamId, reason: ByteStreamCloseReason) =>
    session.client["browser.closeStream"]({ streamId, reason }).pipe(Effect.ignore);

  const offerOf = (
    item: Extract<BrowserHostItem, { readonly _tag: "Open" }>
  ): BrowserStreamOffer => {
    const entry: CarriedEntry = { endpoint: null, closed: false };
    carried.set(item.streamId, entry);

    const accept = Effect.gen(function* () {
      if (entry.closed) return yield* new Unsupported({ capability: "browser.host" });
      const outgoing = yield* Deferred.make<Stream.Stream<Uint8Array, TransportError>>();
      const upstream = yield* session.blobs.offer(Stream.unwrap(Deferred.await(outgoing)));

      const endpoint = yield* makeByteStreamEndpoint({
        incoming: (onConsumed) =>
          session.blobs.takeStream(item.downstream, {
            longLived: true,
            maxUnread: BYTE_STREAM_WINDOW_BYTES,
            onConsumed,
          }),
        window: BYTE_STREAM_WINDOW_BYTES,
        peerWindow: item.window,
        grant: creditFor(session, item.streamId),
      });

      entry.endpoint = endpoint;
      yield* Deferred.succeed(outgoing, endpoint.outgoing);

      yield* session.client["browser.acceptStream"]({
        streamId: item.streamId,
        upstream,
        window: BYTE_STREAM_WINDOW_BYTES,
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            carried.delete(item.streamId);
            endpoint.fail("the Daemon refused the accept");
          })
        )
      );

      // Our side ending tells the Daemon, unless the Daemon closed it first.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          endpoint.end();

          if (carried.delete(item.streamId) && !entry.closed)
            yield* closeStream(item.streamId, "closed");
        })
      );

      return {
        ...endpoint.transport,
        close: Effect.gen(function* () {
          endpoint.end();

          if (carried.delete(item.streamId) && !entry.closed)
            yield* closeStream(item.streamId, "closed");
        }),
      } satisfies ByteTransport;
    });

    return {
      streamId: item.streamId,
      sessionId: item.sessionId,
      purpose: item.purpose,
      accept,
      refuse: Effect.suspend(() => {
        entry.closed = true;
        carried.delete(item.streamId);

        return closeStream(item.streamId, "refused");
      }),
    };
  };

  const onItem = (item: BrowserHostItem) =>
    Effect.suspend(() => {
      if (Predicate.isTagged(item, "Open")) return Queue.offer(offers, offerOf(item));
      const entry = carried.get(item.streamId);

      if (entry === undefined) return Effect.void;

      if (Predicate.isTagged(item, "Credit")) {
        if (entry.endpoint !== null && !entry.endpoint.credited(item.bytes))
          entry.endpoint.fail("the Daemon credited more than it was sent");

        return Effect.void;
      }

      entry.closed = true;
      carried.delete(item.streamId);

      if (entry.endpoint !== null) {
        if (item.reason === "closed") entry.endpoint.end();
        else entry.endpoint.fail(`browser stream ${item.reason}`);
      }

      return Effect.void;
    });

  yield* session.client["browser.host"]({}).pipe(
    Stream.runForEach(onItem),
    Effect.exit,
    Effect.flatMap((exit) =>
      Effect.sync(() => {
        for (const entry of carried.values()) {
          entry.closed = true;
          entry.endpoint?.fail("browser hosting ended");
        }

        carried.clear();
        Queue.endUnsafe(offers);
        Deferred.doneUnsafe(ended, Exit.isFailure(exit) ? Exit.failCause(exit.cause) : Effect.void);
      })
    ),
    Effect.forkScoped
  );

  return {
    offers: Stream.fromQueue(offers),
    claim: (sessionId) => session.client["browser.claim"]({ sessionId }),
    release: (sessionId) => session.client["browser.release"]({ sessionId }),
    ended: Deferred.await(ended),
  };
});
