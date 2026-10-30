/**
 * The byte-stream RPCs (ENG-613, ADR 0092, 0093) over a Client's connection: `hostAddress.open`
 * bridges a loopback socket to the stream's blobs and credits; `browser.*` and
 * `byteStream.credit` route to `BrowserHosting` and to the Host-address streams this
 * connection holds. A stream's blobs are long-lived takes, bounded by their credit windows.
 */
import {
  BrowserStackRpcs,
  BYTE_STREAM_WINDOW_BYTES,
  type ByteStreamEndpoint,
  ByteStreamId,
  HostAddressError,
  HostAddressOpen,
  HostAddressStreamItem,
  makeByteStreamEndpoint,
  NotFound,
  pipeTransports,
  Unsupported,
} from "@polaris/protocol";
import { type Cause, Context, Effect, Queue, Stream } from "effect";
import type { Rpc } from "effect/rpc";
import { BrowserHosting, ByteStreamQuota, HostAddressStreams } from "../browser/index.ts";
import { ClientCapabilities } from "../engine/rpc.ts";
import { BlobChannel, ServiceError } from "../services.ts";

type OpenPayload = typeof HostAddressOpen.payloadSchema.Type;

let streamCounter = 0;

const allocateStreamId = () => {
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

  return ByteStreamId.make(`ha${(++streamCounter).toString(36)}-${suffix}`);
};

/**
 * `hostAddress.open` on `connectionId`: the socket, the endpoint and the pumps live for the
 * returned stream, so the Client ending it (or its connection dropping) closes the socket.
 */
const openHostAddress = (
  streams: HostAddressStreams["Service"],
  quota: ByteStreamQuota["Service"],
  held: Map<number, Map<ByteStreamId, ByteStreamEndpoint>>,
  connectionId: number,
  payload: OpenPayload
): Stream.Stream<HostAddressStreamItem, HostAddressError, BlobChannel> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const blobs = yield* BlobChannel;

      if (!quota.acquire(connectionId))
        return yield* new HostAddressError({
          hostname: payload.hostname,
          port: payload.port,
          reason: "too-many-streams",
          message: "this connection has too many byte streams open",
        });
      yield* Effect.addFinalizer(() => Effect.sync(() => quota.release(connectionId)));
      const socket = yield* streams.connect({ hostname: payload.hostname, port: payload.port });
      const items = yield* Queue.unbounded<HostAddressStreamItem, Cause.Done>();

      const endpoint = yield* makeByteStreamEndpoint({
        incoming: (onConsumed) =>
          blobs.takeStream(payload.upstream, {
            longLived: true,
            maxUnread: BYTE_STREAM_WINDOW_BYTES,
            onConsumed,
          }),
        window: BYTE_STREAM_WINDOW_BYTES,
        peerWindow: payload.window,
        grant: (bytes) =>
          Effect.asVoid(Queue.offer(items, HostAddressStreamItem.cases.Credit.make({ bytes }))),
      });

      // Offer our bytes as the downstream blob; a failure aborts it, so the mapped reason is moot.
      const downstream = yield* blobs.offer(
        endpoint.outgoing.pipe(
          Stream.mapError(
            (error) => new ServiceError({ service: "host-address-stream", message: error.message })
          )
        )
      );

      const streamId = allocateStreamId();
      const mine = held.get(connectionId) ?? new Map<ByteStreamId, ByteStreamEndpoint>();
      mine.set(streamId, endpoint);
      held.set(connectionId, mine);

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          endpoint.fail("host-address stream ended");
          mine.delete(streamId);

          if (mine.size === 0 && held.get(connectionId) === mine) held.delete(connectionId);
        })
      );

      // A clean EOF ends the downstream blob; a socket error aborts it, so the Client's read
      // fails rather than reading as a short clean body. Then the items end and the socket closes.
      yield* pipeTransports(socket, endpoint.transport).pipe(
        Effect.flatMap((error) =>
          Effect.sync(() => (error === null ? endpoint.end() : endpoint.fail(error.message)))
        ),
        Effect.andThen(socket.close),
        Effect.andThen(Queue.end(items)),
        Effect.forkScoped
      );

      return Stream.concat(
        Stream.succeed(
          HostAddressStreamItem.cases.Opened.make({
            streamId,
            downstream,
            window: BYTE_STREAM_WINDOW_BYTES,
          })
        ),
        Stream.fromQueue(items)
      );
    })
  );

const announced = (client: Rpc.ServerClient, capability: "browser.host" | "host-address") =>
  (Context.getOrUndefined(client.annotations, ClientCapabilities) ?? []).includes(capability);

/**
 * Serves the byte-stream RPCs. Requires `HostAddressStreams`, `BrowserHosting` and
 * `ByteStreamQuota`; `BlobChannel` per request.
 */
export const ByteStreamRpcsLive = BrowserStackRpcs.toLayer(
  Effect.gen(function* () {
    const streams = yield* HostAddressStreams;
    const hosting = yield* BrowserHosting;
    const quota = yield* ByteStreamQuota;
    /** This Daemon's open Host-address streams, by the connection that opened them. */
    const held = new Map<number, Map<ByteStreamId, ByteStreamEndpoint>>();

    return BrowserStackRpcs.of({
      "hostAddress.open": (payload, { client }) =>
        openHostAddress(streams, quota, held, client.id, payload),
      "byteStream.credit": ({ streamId, bytes }, { client }) =>
        Effect.suspend(() => {
          const endpoint = held.get(client.id)?.get(streamId);

          if (endpoint === undefined) return hosting.credit(client.id, streamId, bytes);

          if (endpoint.credited(bytes)) return Effect.void;
          // Credit for bytes never sent is a protocol violation: the stream ends.
          endpoint.fail("the Client credited more than it was sent");

          return Effect.fail(new NotFound({ what: "host-address stream", id: streamId }));
        }),
      "browser.host": (_, { client }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            if (!announced(client, "browser.host"))
              return yield* new Unsupported({ capability: "browser.host" });
            const blobs = yield* BlobChannel;

            return yield* hosting.register(client.id, blobs);
          })
        ),
      "browser.claim": ({ sessionId }, { client }) =>
        announced(client, "browser.host")
          ? hosting.claim(client.id, sessionId)
          : Effect.fail(new Unsupported({ capability: "browser.host" })),
      "browser.release": ({ sessionId }, { client }) => hosting.release(client.id, sessionId),
      "browser.acceptStream": ({ streamId, upstream, window }, { client }) =>
        hosting.accept(client.id, streamId, upstream, window),
      "browser.closeStream": ({ streamId, reason }, { client }) =>
        hosting.close(client.id, streamId, reason),
    });
  })
);
