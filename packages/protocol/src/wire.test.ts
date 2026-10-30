import { describe, expect, spyOn, test } from "bun:test";
import { type Cause, Deferred, Effect, Exit, Fiber, Queue, Stream } from "effect";
import { type ByteTransport, makeWire, TransportError } from "./wire.ts";

type Pipe = Queue.Queue<Uint8Array, TransportError | Cause.Done>;

/** Two in-memory transports wired back to back. `aLog` records what side A wrote. */
const makePair = (writeDelayMs = 0) =>
  Effect.gen(function* () {
    const aToB: Pipe = yield* Queue.unbounded<Uint8Array, TransportError | Cause.Done>();
    const bToA: Pipe = yield* Queue.unbounded<Uint8Array, TransportError | Cause.Done>();

    const side = (inbox: Pipe, outbox: Pipe, log: Array<Uint8Array>): ByteTransport => ({
      incoming: Stream.fromQueue(inbox),
      write: (bytes) =>
        Effect.sync(() => {
          log.push(bytes);
          Queue.offerUnsafe(outbox, bytes);
        }).pipe(Effect.delay(writeDelayMs)),
      close: Effect.sync(() => {
        Queue.endUnsafe(outbox);
      }),
    });

    const aLog: Array<Uint8Array> = [];

    return { a: side(bToA, aToB, aLog), b: side(aToB, bToA, []), aLog };
  });

const bytes = (n: number, seed = 0) => Uint8Array.from({ length: n }, (_, i) => (i + seed) % 251);

const run = <A, E>(effect: Effect.Effect<A, E, import("effect").Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

describe("wire", () => {
  test("blobs transfer in WebViews without crypto.randomUUID", async () => {
    const uuid = spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("randomUUID needs a secure context");
    });

    try {
      const received = await run(
        Effect.gen(function* () {
          const { a, b } = yield* makePair();
          const sender = yield* makeWire(a, () => Effect.void);
          const receiver = yield* makeWire(b, () => Effect.void);
          const id = yield* sender.offerBlob(new Uint8Array([1, 2, 3]));

          return yield* receiver.takeBlob(id);
        })
      );

      expect(received).toEqual(new Uint8Array([1, 2, 3]));
    } finally {
      uuid.mockRestore();
    }
  });

  test("a final JSON reply can wait for its write before the transport closes", async () => {
    await run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { a, b, aLog } = yield* makePair();

        const wire = yield* makeWire(
          {
            ...a,
            write: (bytes) =>
              Effect.andThen(
                Deferred.succeed(entered, undefined),
                Effect.andThen(Deferred.await(release), a.write(bytes))
              ),
          },
          () => Effect.void
        );

        yield* makeWire(b, () => Effect.void);
        let finished = false;

        const send = yield* wire.sendJson("final", { awaitWritten: true }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              finished = true;
            })
          ),
          Effect.forkScoped
        );

        yield* Deferred.await(entered);
        expect(finished).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(send);
        expect(aLog).toHaveLength(1);
        expect(finished).toBe(true);
      })
    );
  });

  test("a write failure settles a JSON write receipt", async () => {
    await run(
      Effect.gen(function* () {
        const { a } = yield* makePair();

        const wire = yield* makeWire(
          { ...a, write: () => Effect.fail(new TransportError({ message: "broken" })) },
          () => Effect.void
        );

        const sent = yield* wire
          .sendJson("final", { awaitWritten: true })
          .pipe(Effect.exit, Effect.timeout("1 second"));

        expect(Exit.isFailure(sent)).toBe(true);
      })
    );
  });

  test("delivers JSON in order and blobs both ways", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { a, b } = yield* makePair();
        const receivedByB: Array<string> = [];
        const wa = yield* makeWire(a, () => Effect.void, { blobIdPrefix: "a" });

        const wb = yield* makeWire(b, (t) => Effect.sync(() => receivedByB.push(t)), {
          blobIdPrefix: "b",
        });

        const big = bytes(3 * 1024 * 1024 + 5);
        const id = yield* wa.offerBlob(big);

        for (let i = 0; i < 5; i++) yield* wa.sendJson(`{"n":${i}}`);
        const got = yield* wb.takeBlob(id);
        const back = yield* wb.offerBlob(Stream.fromIterable([bytes(10, 1), bytes(700_000, 2)]));
        const gotBack = yield* wa.takeBlob(back);

        return { got, big, receivedByB, gotBack, stats: wb.stats() };
      })
    );

    expect(result.got).toEqual(result.big);
    expect(result.receivedByB).toEqual([0, 1, 2, 3, 4].map((n) => `{"n":${n}}`));
    expect(result.gotBack.byteLength).toBe(700_010);
    expect(result.gotBack.subarray(0, 10)).toEqual(bytes(10, 1));
    expect(result.stats.bufferedBlobBytes).toBe(0);
  });

  test("JSON frames are not stuck behind a large blob", async () => {
    const kinds = await run(
      Effect.gen(function* () {
        const { a, b, aLog } = yield* makePair(2);
        const wa = yield* makeWire(a, () => Effect.void);
        yield* makeWire(b, () => Effect.void);
        yield* wa.offerBlob(bytes(4 * 1024 * 1024));
        yield* Effect.yieldNow;
        yield* wa.sendJson("{}");

        // Wait for every frame (16 blob chunks + 1 JSON) rather than a fixed
        // delay: slow CI runners take longer to flush 4 MiB.
        for (let waited = 0; aLog.length < 17 && waited < 5_000; waited += 10) {
          yield* Effect.sleep(10);
        }

        return aLog.map((f) => f[4]);
      })
    );

    const jsonAt = kinds.indexOf(0);
    expect(kinds.length).toBe(17);
    expect(jsonAt).toBeGreaterThanOrEqual(0);
    expect(jsonAt).toBeLessThan(3);
  });

  test("rejects blobs over the limit and aborted streams", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { a, b } = yield* makePair();
        const wa = yield* makeWire(a, () => Effect.void);
        const wb = yield* makeWire(b, () => Effect.void, { maxBlobBytes: 1024 });
        const tooBig = yield* wa.offerBlob(bytes(4096));

        const failing = yield* wa.offerBlob(
          Stream.concat(Stream.succeed(bytes(10)), Stream.fail("boom"))
        );

        const e1 = yield* Effect.flip(wb.takeBlob(tooBig));
        const e2 = yield* Effect.flip(wb.takeBlob(failing));

        return [e1.reason, e2.reason];
      })
    );

    expect(result).toEqual(["too-large", "aborted"]);
  });

  test("a take times out without progress, and fails when the connection closes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { a, b } = yield* makePair();
        const wa = yield* makeWire(a, () => Effect.void);
        const wb = yield* makeWire(b, () => Effect.void, { blobIdleTimeoutMs: 100 });
        const timeout = yield* Effect.flip(wb.takeBlob("never"));
        const pending = yield* Effect.forkChild(Effect.flip(wa.takeBlob("later")));
        yield* b.close;
        const closed = yield* Fiber.join(pending);

        return [timeout.reason, closed.reason];
      })
    );

    expect(result).toEqual(["timeout", "closed"]);
  });

  test("takeBlobStream hands over chunks as they arrive, never the whole blob", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { a, b } = yield* makePair();
        const wa = yield* makeWire(a, () => Effect.void);
        const wb = yield* makeWire(b, () => Effect.void);
        const big = bytes(3 * 1024 * 1024 + 5);
        const id = yield* wa.offerBlob(big);
        // Let some chunks arrive before the stream is taken.
        yield* Effect.sleep(5);
        let peakBuffered = 0;

        const chunks = yield* wb.takeBlobStream(id).pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              peakBuffered = Math.max(peakBuffered, wb.stats().bufferedBlobBytes);
            })
          ),
          Stream.runCollect
        );

        const got = new Uint8Array(big.byteLength);
        let at = 0;

        for (const chunk of chunks) {
          got.set(chunk, at);
          at += chunk.byteLength;
        }

        return { got, big, chunks: chunks.length, stats: wb.stats() };
      })
    );

    expect(result.got).toEqual(result.big);
    expect(result.chunks).toBeGreaterThan(1);
    expect(result.stats.bufferedBlobBytes).toBe(0);
    expect(result.stats.incomingBlobs).toBe(0);
  });

  test("takeBlobStream: a quiet blob can opt out of the idle timeout; stopping early drops the rest", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { a, b } = yield* makePair();
        const wa = yield* makeWire(a, () => Effect.void);
        const wb = yield* makeWire(b, () => Effect.void, { blobIdleTimeoutMs: 100 });

        // A source that sends one chunk, stays quiet past the idle timeout, then ends.
        const quiet = yield* wa.offerBlob(
          Stream.concat(
            Stream.succeed(bytes(10)),
            Stream.fromEffect(Effect.as(Effect.sleep(300), bytes(5)))
          )
        );

        const received = yield* wb.takeBlobStream(quiet, { idleTimeout: false }).pipe(
          Stream.runFold(
            () => 0,
            (n, chunk) => n + chunk.byteLength
          )
        );

        const timedOut = yield* Effect.flip(Stream.runDrain(wb.takeBlobStream("never")));
        // Stop after the first chunk of a large blob: the rest is dropped as it arrives.
        const large = yield* wa.offerBlob(bytes(4 * 1024 * 1024));
        yield* wb.takeBlobStream(large).pipe(Stream.take(1), Stream.runDrain);
        yield* Effect.sleep(50);

        return { received, timedOut: timedOut.reason, stats: wb.stats() };
      })
    );

    expect(result.received).toBe(15);
    expect(result.timedOut).toBe("timeout");
    expect(result.stats.bufferedBlobBytes).toBe(0);
  });

  test("a long-lived blob stream carries more than maxBlobBytes in total and never idles out", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { a, b } = yield* makePair();
        const wa = yield* makeWire(a, () => Effect.void);

        const wb = yield* makeWire(b, () => Effect.void, {
          maxBlobBytes: 1024,
          blobIdleTimeoutMs: 100,
        });

        // 4 KiB in total through a 1 KiB limit, with a pause past the idle timeout in the middle.
        const source = Stream.concat(
          Stream.fromIterable(Array.from({ length: 2 }, () => bytes(1024))),
          Stream.fromEffect(Effect.as(Effect.sleep(300), bytes(2048)))
        );

        const tunnel = yield* wa.offerBlob(source);

        const carried = yield* wb.takeBlobStream(tunnel, { longLived: true }).pipe(
          Stream.runFold(
            () => 0,
            (n, chunk) => n + chunk.byteLength
          )
        );

        // The same source as an ordinary stream take still fails the limit.
        const ordinary = yield* wa.offerBlob(Stream.fromIterable([bytes(1024), bytes(1024)]));
        const limited = yield* Effect.flip(Stream.runDrain(wb.takeBlobStream(ordinary)));

        return { carried, limited: limited.reason };
      })
    );

    expect(result).toEqual({ carried: 4096, limited: "too-large" });
  });

  test("closed fails on malformed input", async () => {
    const err = await run(
      Effect.gen(function* () {
        const t: ByteTransport = {
          incoming: Stream.succeed(Uint8Array.of(0, 0, 0, 1, 9)),
          write: () => Effect.void,
          close: Effect.void,
        };

        const w = yield* makeWire(t, () => Effect.void);

        return yield* Effect.flip(w.closed);
      })
    );

    expect(err._tag).toBe("TransportError");
  });

  test("a windowed take rejects a sender over the window at ingestion, complete or still receiving", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { a, b } = yield* makePair();
        const wa = yield* makeWire(a, () => Effect.void);
        const wb = yield* makeWire(b, () => Effect.void);

        // A whole blob of 200 bytes that fully arrives and completes before the consumer claims,
        // against a 100-byte window: the completed blob must still be rejected.
        const completed = yield* wa.offerBlob(bytes(200));
        yield* Effect.sleep("80 millis");

        const afterComplete = yield* wb
          .takeBlobStream(completed, { longLived: true, maxUnread: 100 })
          .pipe(Stream.runCollect, Effect.flip);

        // A sender that pushes 900 bytes with none consumed, stream still open: rejected as the
        // frame arrives, not only once the buffer limit or the connection cap is hit.
        const flooding = yield* wa.offerBlob(
          Stream.fromIterable([bytes(900)]).pipe(Stream.concat(Stream.never))
        );

        const whileReceiving = yield* wb
          .takeBlobStream(flooding, { longLived: true, maxUnread: 100 })
          .pipe(Stream.runCollect, Effect.flip);

        // A compliant sender inside the window still transfers whole.
        const under = yield* wa.offerBlob(bytes(80, 7));
        yield* Effect.sleep("40 millis");

        const total = yield* wb.takeBlobStream(under, { longLived: true, maxUnread: 100 }).pipe(
          Stream.runFold(
            () => 0,
            (n, chunk) => n + chunk.byteLength
          )
        );

        return { afterComplete, whileReceiving, total };
      })
    );

    expect(result.afterComplete.reason).toBe("too-large");
    expect(result.afterComplete.message).toContain("receive window");
    expect(result.whileReceiving.reason).toBe("too-large");
    expect(result.total).toBe(80);
  });

  test("an eager stream claim whose Stream is never run is swept, not pinned forever", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { a, b } = yield* makePair();
        const wa = yield* makeWire(a, () => Effect.void);

        const wb = yield* makeWire(b, () => Effect.void, {
          blobIdleTimeoutMs: 200,
          unclaimedBlobTtlMs: 150,
        });

        const id = yield* wa.offerBlob(bytes(128));
        yield* Effect.sleep("80 millis");

        // Claim the blob but drop the Stream without ever running it: the eager claim must not
        // keep it buffered past the unclaimed TTL, or a sender can pin entries against the cap.
        const _dropped = wb.takeBlobStream(id);
        const claimed = wb.stats();
        yield* Effect.sleep("300 millis");
        const swept = wb.stats();

        return { claimed, swept };
      })
    );

    expect(result.claimed.incomingBlobs).toBe(1);
    expect(result.swept.incomingBlobs).toBe(0);
    expect(result.swept.bufferedBlobBytes).toBe(0);
  });

  test("the receive window counts bytes pulled but not yet consumed by a stalled consumer", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const { a, b } = yield* makePair();
        const wa = yield* makeWire(a, () => Effect.void);
        const wb = yield* makeWire(b, () => Effect.void);

        const feed = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const id = yield* wa.offerBlob(Stream.fromQueue(feed));

        const firstConsumed = yield* Deferred.make<void>();
        const unstall = yield* Deferred.make<void>();
        let first = true;

        const reader = yield* Effect.forkChild(
          wb.takeBlobStream(id, { longLived: true, maxUnread: 100 }).pipe(
            Stream.runForEach(() =>
              Effect.gen(function* () {
                if (first) {
                  first = false;
                  yield* Deferred.succeed(firstConsumed, undefined);

                  return;
                }

                // Hold the large second batch without pulling again: it stays uncredited.
                yield* Deferred.await(unstall);
              })
            ),
            Effect.as("ok"),
            Effect.catch((error) => Effect.succeed(error.reason))
          )
        );

        // A small chunk the consumer consumes and credits, then a 90-byte batch it holds unread.
        yield* Queue.offer(feed, bytes(10, 1));
        yield* Deferred.await(firstConsumed);
        yield* Queue.offer(feed, bytes(90, 2));
        yield* Effect.sleep("50 millis");

        // 100 more against a 100-byte window while 90 sit uncredited: only 10 fit, the rest must be
        // rejected at arrival. The buggy accounting forgot the delivered 90 and accepted all of it.
        for (let i = 0; i < 10; i++) yield* Queue.offer(feed, bytes(10, 3));
        yield* Effect.sleep("50 millis");
        yield* Effect.sync(() => Queue.endUnsafe(feed));
        yield* Effect.sleep("50 millis");

        yield* Deferred.succeed(unstall, undefined);

        return yield* Fiber.join(reader);
      })
    );

    expect(outcome).toBe("too-large");
  });
});
