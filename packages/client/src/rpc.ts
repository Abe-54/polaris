// Portions adapted from Effect-TS/effect, npm effect@4.0.0-rc.118 (MIT): src/rpc/RpcClient.ts `makeProtocolSocket`
/**
 * Runs an effect/rpc client for `DaemonRpcs` over one framed Wire.
 *
 * The `RpcClient.Protocol` mirrors effect/rpc's socket client protocol
 * (`makeProtocolSocket` in effect@4.0.0-rc.118 `RpcClient.ts`): requests are
 * routed back to the RpcClient that sent them, a lost connection fails every
 * in-flight request with an RpcClientError, and a ping loop detects a dead
 * peer. Unlike it, there is no built-in retry: a Wire is one connection, and
 * HostConnection owns reconnecting. A connection-level `Defect` (sent by
 * Daemons before ADR 0064 when a handler died) also counts as a lost connection.
 *
 * Pings run only while a request is waiting for its reply. Streams (host and
 * session subscriptions, watches) don't count: a Client that is only
 * subscribed sends nothing, so an idle Daemon is never woken. Any JS the
 * Daemon runs, even answering a ping, keeps the Bun runtime waking ~10 times a
 * second for up to ~30 s afterwards, so a 15 s ping would keep it awake for
 * good. While only streams are open, a dead link is noticed by the transport
 * instead: the Unix socket closes, or ssh's own keepalives (answered by sshd,
 * never reaching the Daemon) end the session. A transport with no such
 * keepalive (the Polaris Relay route) asks for `keepAliveStreams` (ADR 0084).
 */
import {
  type BlobError,
  type ByteTransport,
  type BlobId,
  type BlobSource,
  DaemonRpcs,
  makeWire,
  type TakeStreamOptions,
  type Wire,
  type WireOptions,
} from "@polaris/protocol";
import {
  Data,
  Deferred,
  Effect,
  Exit,
  Latch,
  Predicate,
  Schema,
  type Scope,
  type Stream,
} from "effect";
import { withTraceContext } from "./selfTraces/wire.ts";
import { type Rpc, RpcClient, type RpcGroup, RpcSchema, RpcSerialization } from "effect/rpc";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import {
  constPing,
  type FromServerEncoded,
  type ResponseDefectEncoded,
} from "effect/rpc/RpcMessage";

export type DaemonRpc = RpcGroup.Rpcs<typeof DaemonRpcs>;

export type DaemonClient = RpcClient.RpcClient<DaemonRpc, RpcClientError>;

export interface ClientBlobs {
  /** Send bytes to the Daemon; pass the returned id in the RPC that consumes them. */
  readonly offer: <E>(source: BlobSource<E>) => Effect.Effect<BlobId>;
  /** Receive a blob the Daemon referenced in a response (e.g. `files.read`, `git.diff`). */
  readonly take: (blobId: BlobId) => Effect.Effect<Uint8Array, BlobError>;
  /** The same, chunk by chunk as it arrives, without holding the whole blob (e.g. terminal output). */
  readonly takeStream: (
    blobId: BlobId,
    options?: TakeStreamOptions
  ) => Stream.Stream<Uint8Array, BlobError>;
}

export interface RpcConnection<Rpcs extends Rpc.Any = DaemonRpc> {
  readonly client: RpcClient.RpcClient<Rpcs, RpcClientError>;
  readonly blobs: ClientBlobs;
  readonly wire: Wire;
  /** Fails when the connection is gone: closed, broken, or the peer stopped answering pings. */
  readonly lost: Effect.Effect<never, RpcClientError>;
  /** One ping and its pong: the link's round trip in ms (the Daemon answers without other work). */
  readonly roundTrip: Effect.Effect<number>;
  /** Declares the connection lost, as a peer that stopped answering pings is: in-flight calls and streams fail. */
  readonly drop: (reason: string) => Effect.Effect<void>;
}

export interface RpcConnectionOptions {
  readonly wire?: WireOptions;
  /**
   * Ping interval while a request (not a stream) awaits its reply; the
   * connection is declared dead after 3 intervals with no traffic.
   */
  readonly pingIntervalMs?: number;
  /**
   * Also ping while only streams are open, so a link that died without closing
   * (a phone's socket after a network change) is lost rather than silent.
   */
  readonly keepAliveStreams?: boolean;
  /**
   * Whether requests carry W3C trace context now (Self-Traces, ADR 0095): true adds the RPC Span's
   * `traceparent`, false strips all of it. Absent, requests go as the caller built them.
   */
  readonly traceContext?: () => boolean;
}

/** Tags of the streaming RPCs: long-lived, so waiting on them never needs a ping. */
const streamTags: ReadonlySet<string> = new Set(
  [...DaemonRpcs.requests.values()].flatMap((rpc) =>
    RpcSchema.isStreamSchema(rpc.successSchema) ? [rpc._tag] : []
  )
);

const { ClientProtocolError } = Data.taggedEnum<FromServerEncoded>();

const isPong = Predicate.isTagged("Pong");

const isExit = Predicate.isTagged("Exit");

const isDefect = Predicate.isTagged("Defect");

/**
 * A connection-level `Defect` from a Daemon older than ADR 0064: it dropped every request
 * on the connection, so the Client fails the connection and reconnects.
 */
export class DaemonDefect extends Schema.TaggedError<DaemonDefect>()("DaemonDefect", {
  defect: Schema.Defect(),
}) {}

/** True when the connection was lost to an older Daemon's connection-level `Defect`. */
export const isDaemonDefect = (error: RpcClientError): boolean =>
  Predicate.isTagged(error.reason, "RpcClientDefect") &&
  Predicate.isTagged(error.reason.cause, "DaemonDefect");

const lostError = (message: string, cause?: unknown) =>
  new RpcClientError({ reason: new RpcClientDefect({ message, cause }) });

/** `connectRpc` for a group with the same RPCs, e.g. `ExtensionDaemonRpcs` (the SDK). */
export const connectRpcWith = Effect.fnUntraced(function* <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  transport: ByteTransport,
  options: RpcConnectionOptions = {}
): Effect.fn.Return<RpcConnection<Rpcs>, never, Scope.Scope> {
  const serialization = RpcSerialization.json;
  const parser = serialization.makeUnsafe();
  const decodeDefect = Schema.decodeUnknownSync(serialization.codecFor(Schema.Defect()));
  const lost = yield* Deferred.make<never, RpcClientError>();
  const pingInterval = options.pingIntervalMs ?? 15_000;
  let lastHeard = Date.now();
  /** When the latest ping went out while a reply is due; null before the first. */
  let lastPinged: number | null = null;
  let wire!: Wire;
  let drop: (reason: string) => Effect.Effect<void> = () => Effect.void;
  /** Requests (not streams) sent and not yet answered with an Exit. */
  const awaiting = new Set<string | number>();
  /** With `keepAliveStreams`, streams open and not yet ended; they keep the pings going too. */
  const streaming = new Set<string | number>();
  const keepAliveStreams = options.keepAliveStreams === true;
  const due = () => awaiting.size > 0 || streaming.size > 0;
  /** Open while a reply or a kept-alive stream is due: the ping loop runs only then. */
  const pinging = Latch.makeUnsafe(false);
  /** Waiting for the next pong (`roundTrip`); every pong answers all of them. */
  let pongWaiters: Array<() => void> = [];

  const settled = (requestId: string | number) => {
    awaiting.delete(requestId);
    streaming.delete(requestId);

    if (!due()) pinging.closeUnsafe();
  };

  const protocol = yield* RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse, clientIds) {
      const requestClient = new Map<string | number, number>();
      let currentError: RpcClientError | undefined;

      const broadcast = (response: FromServerEncoded) =>
        Effect.forEach(clientIds, (clientId) => writeResponse(clientId, response), {
          discard: true,
        });

      const fail = (error: RpcClientError) =>
        Effect.suspend(() => {
          if (currentError !== undefined) return Effect.void;
          currentError = error;
          requestClient.clear();
          awaiting.clear();
          streaming.clear();
          pinging.closeUnsafe();

          // Fail in-flight requests first: completing `lost` lets the owner close
          // this scope, which would interrupt us before the broadcast.
          return Effect.andThen(
            broadcast(ClientProtocolError({ error })),
            Deferred.fail(lost, error)
          ).pipe(Effect.uninterruptible);
        });

      drop = (reason) => fail(lostError(reason));

      const failOnDefect = (response: ResponseDefectEncoded) =>
        Effect.suspend(() => {
          if (currentError !== undefined) return Effect.void;

          const defect = decodeDefect(response.defect);
          const message = `the Daemon dropped every request on this connection after a defect (${String(defect)})`;

          return Effect.andThen(
            Effect.logWarning(`${message}; reconnecting`),
            fail(lostError(message, new DaemonDefect({ defect })))
          );
        });

      const onJson = (text: string) =>
        Effect.suspend(() => {
          lastHeard = Date.now();
          let responses: ReadonlyArray<FromServerEncoded>;

          try {
            // SAFETY: as in effect/rpc's own socket protocol, the envelope from the Daemon is
            // trusted; RpcClient decodes each payload against its Rpc schema.
            responses = parser.decode(text) as ReadonlyArray<FromServerEncoded>;
          } catch (cause) {
            return broadcast(
              ClientProtocolError({
                error: lostError("error decoding a message from the Daemon", cause),
              })
            );
          }

          return Effect.forEach(
            responses,
            (response) => {
              if (isPong(response)) {
                const waiters = pongWaiters;

                pongWaiters = [];

                return Effect.sync(() => waiters.forEach((resume) => resume()));
              }

              if (isDefect(response)) return failOnDefect(response);

              if ("requestId" in response) {
                const clientId = requestClient.get(response.requestId);

                if (clientId !== undefined) {
                  if (isExit(response)) {
                    requestClient.delete(response.requestId);
                    settled(response.requestId);
                  }

                  return writeResponse(clientId, response);
                }
              }

              return broadcast(response);
            },
            { discard: true }
          );
        });

      wire = yield* makeWire(transport, onJson, { ...options.wire, blobIdPrefix: "c" });

      yield* wire.closed.pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          fail(
            Exit.isSuccess(exit)
              ? lostError("the Daemon closed the connection")
              : lostError(exit.cause.toString())
          )
        ),
        Effect.forkScoped
      );

      // Keepalive while a reply is due: any traffic counts as liveness, and
      // pings keep a quiet link busy. Parked on the latch (no timer) otherwise.
      yield* Effect.gen(function* () {
        while (true) {
          yield* pinging.await;
          yield* Effect.sleep(pingInterval);

          if (!due()) continue;

          const now = Date.now();
          // A late wake of our own timer (a starved process, a sleeping Mac) isn't the
          // Daemon's silence: it's lost only once a ping has had an interval to be answered.
          const pingUnanswered = lastPinged !== null && now - lastPinged >= pingInterval;

          if (now - lastHeard > pingInterval * 3 && pingUnanswered) {
            yield* fail(lostError("the Daemon stopped answering"));

            return;
          }

          if (lastPinged === null || lastHeard >= lastPinged) lastPinged = now;

          const ping = parser.encode(constPing);

          // The JSON serialization always encodes to a string.
          if (Predicate.isString(ping)) yield* Effect.ignore(wire.sendJson(ping));
        }
      }).pipe(Effect.forkScoped);

      return {
        send: (clientId, request) =>
          Effect.suspend(() => {
            if (currentError !== undefined) return Effect.fail(currentError);

            if (Predicate.isTagged(request, "Request")) {
              requestClient.set(request.id, clientId);

              const stream = streamTags.has(request.tag);

              if (!stream || keepAliveStreams) {
                // The silence clock starts now, not at the last traffic of an idle link.
                if (!due()) {
                  lastHeard = Date.now();
                  lastPinged = null;
                }

                (stream ? streaming : awaiting).add(request.id);
                pinging.openUnsafe();
              }
            } else if (Predicate.isTagged(request, "Interrupt")) {
              settled(request.requestId);
            }

            const traceContext = options.traceContext;

            const encoded = parser.encode(
              traceContext !== undefined && Predicate.isTagged(request, "Request")
                ? withTraceContext(request, traceContext())
                : request
            );

            if (!Predicate.isString(encoded)) return Effect.void;

            return wire
              .sendJson(encoded)
              .pipe(Effect.mapError((error) => lostError(error.message, error)));
          }),
        supportsAck: true,
        supportsTransferables: false,
        codecFor: serialization.codecFor,
      };
    })
  );

  const client = yield* RpcClient.make(group, { spanPrefix: "polaris.rpc" }).pipe(
    Effect.provideService(RpcClient.Protocol, protocol)
  );

  return {
    client,
    wire,
    blobs: {
      offer: wire.offerBlob,
      take: (blobId) => wire.takeBlob(blobId),
      takeStream: (blobId, takeOptions) => wire.takeBlobStream(blobId, takeOptions),
    },
    lost: Deferred.await(lost),
    drop: (reason) => Effect.suspend(() => drop(reason)),
    roundTrip: Effect.gen(function* () {
      const pong = yield* Deferred.make<void>();
      const waiter = () => void Deferred.doneUnsafe(pong, Effect.void);
      const ping = parser.encode(constPing);
      const started = performance.now();

      // Waiting before sending: on a local socket the pong can beat the next line.
      pongWaiters.push(waiter);

      if (Predicate.isString(ping)) yield* Effect.ignore(wire.sendJson(ping));
      yield* Deferred.await(pong).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pongWaiters = pongWaiters.filter((w) => w !== waiter);
          })
        )
      );

      return performance.now() - started;
    }),
  };
});

export const connectRpc = (
  transport: ByteTransport,
  options: RpcConnectionOptions = {}
): Effect.Effect<RpcConnection, never, Scope.Scope> =>
  connectRpcWith(DaemonRpcs, transport, options);
