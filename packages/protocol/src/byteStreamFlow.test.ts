/**
 * The credit loop between two real endpoints (ENG-613): credit back to the sender must never run
 * ahead of the receiver's own window credit, or a well-behaved sender feeding a slow consumer is
 * wrongly told it exceeded the receive window. A sender that ignores credit is still rejected
 * (that case lives in wire.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { type Cause, Effect, Exit, Queue, Stream } from "effect";
import { makeByteStreamEndpoint } from "./byteStreamFlow.ts";
import { BlobError, type ByteTransport, makeWire, TransportError } from "./wire.ts";

type Pipe = Queue.Queue<Uint8Array, TransportError | Cause.Done>;

/** Two in-memory transports wired back to back. */
const makePair = () =>
  Effect.gen(function* () {
    const aToB: Pipe = yield* Queue.unbounded<Uint8Array, TransportError | Cause.Done>();
    const bToA: Pipe = yield* Queue.unbounded<Uint8Array, TransportError | Cause.Done>();

    const side = (inbox: Pipe, outbox: Pipe): ByteTransport => ({
      incoming: Stream.fromQueue(inbox),
      write: (chunk) => Effect.sync(() => Queue.offerUnsafe(outbox, chunk)),
      close: Effect.sync(() => Queue.endUnsafe(outbox)),
    });

    return { a: side(bToA, aToB), b: side(aToB, bToA) };
  });

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) % 251);

const run = <A, E>(effect: Effect.Effect<A, E, import("effect").Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

describe("byte-stream credit loop", () => {
  test("credit back to the sender never runs ahead of the receiver's own window credit", async () => {
    const window = 4 * 256;
    const chunk = 256;
    const payload = bytes(16 * 1024);

    const result = await run(
      Effect.gen(function* () {
        const { a, b } = yield* makePair();
        const wireS = yield* makeWire(a, () => Effect.void);
        const wireR = yield* makeWire(b, () => Effect.void);

        // The receiver's own window credit: what the Wire has reported consumed back to us.
        let consumed = 0;
        // What we have granted the sender. It must never lead `consumed`, or a well-behaved sender
        // honouring its window overshoots the receiver's and is wrongly failed at ingestion.
        let granted = 0;
        let grantAheadOfCredit = false;

        const sender = yield* makeByteStreamEndpoint<TransportError>({
          incoming: () => Stream.never,
          window,
          peerWindow: window,
          grant: () => Effect.void,
        });

        const blobId = yield* wireS.offerBlob(sender.outgoing);

        const receiver = yield* makeByteStreamEndpoint<BlobError>({
          incoming: (onConsumed) =>
            wireR.takeBlobStream(blobId, {
              longLived: true,
              maxUnread: window,
              onConsumed: (count) => {
                consumed += count;
                onConsumed(count);
              },
            }),
          window,
          peerWindow: window,
          grant: (count) =>
            Effect.sync(() => {
              granted += count;

              if (granted > consumed) grantAheadOfCredit = true;
              sender.credited(count);
            }),
        });

        // Small writes, so a slow consumer accumulates several frames into one delivered batch.
        const slices = [];

        for (let offset = 0; offset < payload.byteLength; offset += chunk)
          slices.push(payload.subarray(offset, offset + chunk));

        yield* Effect.forkChild(
          Effect.forEach(slices, (slice) => sender.transport.write(slice), { discard: true }).pipe(
            Effect.andThen(sender.transport.close),
            Effect.ignore
          )
        );

        // A slow consumer: it sleeps per chunk, so frames pile into multi-chunk delivered batches
        // whose credit lands only on the following pull.
        const parts: Array<Uint8Array> = [];

        const exit = yield* receiver.transport.incoming.pipe(
          Stream.runForEach((part) =>
            Effect.sync(() => void parts.push(part)).pipe(Effect.andThen(Effect.sleep("1 milli")))
          ),
          Effect.timeout("10 seconds"),
          Effect.exit
        );

        const received = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
        let offset = 0;

        for (const part of parts) {
          received.set(part, offset);
          offset += part.byteLength;
        }

        return {
          streamFailed: Exit.isFailure(exit),
          grantAheadOfCredit,
          length: received.byteLength,
          inOrder: received.every((byte, i) => byte === payload[i]),
        };
      })
    );

    // The invariant the fix guarantees: a grant to the peer never precedes the credit behind it.
    expect(result.grantAheadOfCredit).toBe(false);
    // The well-behaved sender's bytes all arrive, in order, and the stream never fails.
    expect(result.streamFailed).toBe(false);
    expect(result.length).toBe(payload.byteLength);
    expect(result.inOrder).toBe(true);
  }, 15_000);
});
