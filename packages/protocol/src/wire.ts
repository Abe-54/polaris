/**
 * One framed byte connection (a local Unix socket, or SSH stdio through
 * `polaris bridge`) shared by the Daemon's transport and the Client runtime.
 *
 * JSON frames carry RPC messages; blob frames carry binary side-chunks
 * referenced by BlobId. The writer always drains queued JSON frames before the
 * next blob chunk and round-robins between blobs, so a multi-MB file read or
 * diff never holds up a stream by more than one chunk (BLOB_CHUNK_BYTES).
 *
 * Memory limits: an incoming blob larger than `maxBlobBytes`, or one that would
 * push the connection's buffered blob bytes over `maxBufferedBlobBytes`, fails
 * with `too-large` and its bytes are dropped. Blobs nobody claims expire after
 * `unclaimedBlobTtlMs`; a `take` fails with `timeout` if its blob makes no
 * progress for `blobIdleTimeoutMs`. Outgoing stream-sourced blobs buffer at most
 * a few chunks before their source is paused, and `sendJson` waits while more
 * than `maxQueuedJsonBytes` of JSON is queued.
 */
import {
  Array as Arr,
  Cause,
  Deferred,
  Effect,
  Exit,
  Latch,
  Schema,
  type Scope,
  Stream,
} from "effect";
import {
  BLOB_CHUNK_BYTES,
  encodeBlob,
  encodeBlobFrame,
  encodeJsonFrame,
  type Frame,
  FrameDecoder,
} from "./frame.ts";
import { BlobId } from "./ids.ts";

export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const BlobFailure = Schema.Literals(["too-large", "timeout", "closed", "aborted"]);

export type BlobFailure = typeof BlobFailure.Type;

export class BlobError extends Schema.TaggedError<BlobError>()("BlobError", {
  blobId: Schema.String,
  reason: BlobFailure,
  message: Schema.String,
}) {}

/** A bidirectional byte pipe. Implementations adapt sockets and child-process stdio. */
export interface ByteTransport {
  /** Bytes from the peer; ends when the peer closes its side. */
  readonly incoming: Stream.Stream<Uint8Array, TransportError>;
  /** Completes once the transport accepted the bytes (waits on backpressure). */
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, TransportError>;
  /** Closes the transport. Idempotent. */
  readonly close: Effect.Effect<void>;
}

export interface WireOptions {
  /** Prefix for BlobIds this side allocates, so both directions never collide. */
  readonly blobIdPrefix?: string;
  readonly maxBlobBytes?: number;
  readonly maxBufferedBlobBytes?: number;
  /** Includes pending consumers, completed blobs and failed-blob tombstones. */
  readonly maxIncomingBlobs?: number;
  readonly blobIdleTimeoutMs?: number;
  readonly unclaimedBlobTtlMs?: number;
  readonly maxQueuedJsonBytes?: number;
}

export const WIRE_DEFAULTS = {
  maxBlobBytes: 512 * 1024 * 1024,
  maxBufferedBlobBytes: 1024 * 1024 * 1024,
  maxIncomingBlobs: 1024,
  blobIdleTimeoutMs: 60_000,
  unclaimedBlobTtlMs: 5 * 60_000,
  maxQueuedJsonBytes: 8 * 1024 * 1024,
} as const;

export type BlobSource<E = never> = Uint8Array | Stream.Stream<Uint8Array, E>;

export interface Wire {
  /** Queue one RPC message (already serialized) as a JSON frame. */
  readonly sendJson: (
    text: string,
    options?: { readonly awaitWritten: boolean }
  ) => Effect.Effect<void, TransportError>;
  /** Start sending `source` as a blob; returns its id immediately. */
  readonly offerBlob: <E>(source: BlobSource<E>) => Effect.Effect<BlobId>;
  /** Wait for the whole blob the peer sent (or is sending) under `blobId`. Single consumer. */
  readonly takeBlob: (blobId: string) => Effect.Effect<Uint8Array, BlobError>;
  /**
   * The blob's bytes as they arrive, without collecting them: what arrived
   * before the call first, then each chunk. Ends after the final chunk. Single
   * consumer, like `takeBlob` (a blob is taken one way or the other).
   * Unconsumed chunks count against the connection's buffered bytes.
   */
  readonly takeBlobStream: (
    blobId: string,
    options?: TakeStreamOptions
  ) => Stream.Stream<Uint8Array, BlobError>;
  /** Succeeds when the peer closed cleanly, fails on a transport or framing error. */
  readonly closed: Effect.Effect<void, TransportError>;
  readonly stats: () => {
    readonly bufferedBlobBytes: number;
    readonly incomingBlobs: number;
    readonly outgoingBlobs: number;
    readonly queuedJsonBytes: number;
  };
}

export interface TakeStreamOptions {
  /**
   * Fail with `timeout` when the blob makes no progress for `blobIdleTimeoutMs`
   * (default true). Turn it off for long-lived blobs that may be quiet for a
   * while, such as a terminal's output.
   */
  readonly idleTimeout?: boolean;
  /**
   * A byte stream's blob (ADR 0093): no idle timeout, and no `maxBlobBytes` on what it has
   * carried in total; its sender's credit window bounds what is unread. Only the connection's
   * `maxBufferedBlobBytes` still applies.
   */
  readonly longLived?: boolean;
  /**
   * The receive window (ADR 0093): the sender may never leave more than this many bytes unread.
   * When set, a sender that ignores its credit and pushes past it aborts the blob before the
   * extra is buffered, so one stream cannot fill the shared blob buffer. Unset means unbounded.
   */
  readonly maxUnread?: number;
  /**
   * Called with the byte count each time the consumer consumes a delivered batch (the window
   * reopens by that much). Credit back to the sender from here, never ahead of this, so a granted
   * byte is always one the receiver has already freed.
   */
  readonly onConsumed?: (bytes: number) => void;
}

/** Frames buffered per outgoing stream-sourced blob before its source is paused. */
const OUT_BLOB_HIGH_WATER = 4;

interface OutBlob {
  readonly id: string;
  ready(): boolean;
  next(): Uint8Array;
  done(): boolean;
}

interface InBlob {
  /** Chunks held for the consumer (all of them, or the unread ones when streamed). */
  parts: Array<Uint8Array>;
  /** Bytes in `parts`. */
  size: number;
  /** Bytes received so far, for `maxBlobBytes`. */
  received: number;
  /** Bytes the consumer has consumed (credited back). `received - credited` is the unread window. */
  credited: number;
  /** Bytes handed to the consumer's last pull, credited once it pulls again. */
  inflight: number;
  status: "receiving" | "complete" | "failed";
  claimed: false | "whole" | "stream";
  /** The consumer stopped reading it (`forget`): only such a tombstone goes at the sender's end. */
  forgotten: boolean;
  /** A stream claim whose Stream was actually run; an unrun claim is swept like an unclaimed blob. */
  started: boolean;
  idleTimeout: boolean;
  longLived: boolean;
  /** The consumer's receive window; the unread bytes (`size`) may not exceed it. Null is unbounded. */
  maxUnread: number | null;
  touched: number;
  failure: BlobError | null;
  /** A streaming consumer waiting for the next chunk. */
  wake: (() => void) | null;
  readonly deferred: Deferred.Deferred<Uint8Array, BlobError>;
}

let blobCounter = 0;

/** Some Bun APIs hand back an ArrayBuffer where a Uint8Array is typed. */
const asBytes = (source: ArrayBufferView | ArrayBuffer): Uint8Array =>
  source instanceof Uint8Array
    ? source
    : source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);

const concat = (parts: ReadonlyArray<Uint8Array>, size: number): Uint8Array => {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(size);
  let offset = 0;

  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }

  return out;
};

/**
 * Runs a Wire over `transport` for the lifetime of the current scope. Every
 * JSON frame received is handed to `onJson`, in order.
 */
export const makeWire = Effect.fnUntraced(function* (
  transport: ByteTransport,
  onJson: (text: string) => Effect.Effect<void>,
  options: WireOptions = {}
): Effect.fn.Return<Wire, never, Scope.Scope> {
  const prefix = options.blobIdPrefix ?? "b";
  const maxBlobBytes = options.maxBlobBytes ?? WIRE_DEFAULTS.maxBlobBytes;
  const maxBuffered = options.maxBufferedBlobBytes ?? WIRE_DEFAULTS.maxBufferedBlobBytes;
  const maxIncomingBlobs = options.maxIncomingBlobs ?? WIRE_DEFAULTS.maxIncomingBlobs;
  const idleTimeout = options.blobIdleTimeoutMs ?? WIRE_DEFAULTS.blobIdleTimeoutMs;
  const unclaimedTtl = options.unclaimedBlobTtlMs ?? WIRE_DEFAULTS.unclaimedBlobTtlMs;
  const maxQueuedJson = options.maxQueuedJsonBytes ?? WIRE_DEFAULTS.maxQueuedJsonBytes;

  const closed = yield* Deferred.make<void, TransportError>();
  let isClosed = false;

  // ── Outgoing ──────────────────────────────────────────────────────────────
  const wake = Latch.makeUnsafe(false);
  const jsonSpace = Latch.makeUnsafe(true);
  const jsonQueue: Array<Uint8Array> = [];
  const jsonReceipts = new Map<Uint8Array, Deferred.Deferred<void, TransportError>>();
  let queuedJsonBytes = 0;
  const outBlobs: Array<OutBlob> = [];
  let roundRobin = 0;

  const nextBlobFrame = (): Uint8Array | undefined => {
    for (let i = 0; i < outBlobs.length; i++) {
      const index = (roundRobin + i) % outBlobs.length;
      const blob = outBlobs[index]!;

      if (!blob.ready()) continue;
      const frame = blob.next();

      if (blob.done()) {
        outBlobs.splice(index, 1);
        roundRobin = outBlobs.length === 0 ? 0 : index % outBlobs.length;
      } else {
        roundRobin = (index + 1) % outBlobs.length;
      }

      return frame;
    }

    return undefined;
  };

  const writer = Effect.gen(function* () {
    while (true) {
      wake.closeUnsafe();
      const json = jsonQueue.shift();

      if (json !== undefined) {
        queuedJsonBytes -= json.byteLength;

        if (queuedJsonBytes <= maxQueuedJson / 2) jsonSpace.openUnsafe();
        yield* transport.write(json);
        const receipt = jsonReceipts.get(json);

        if (receipt !== undefined) {
          jsonReceipts.delete(json);
          yield* Deferred.succeed(receipt, undefined);
        }

        continue;
      }

      const frame = nextBlobFrame();

      if (frame !== undefined) {
        yield* transport.write(frame);
        continue;
      }

      yield* wake.await;
    }
  });

  const sendJson: Wire["sendJson"] = (text, options) =>
    Effect.suspend(() => {
      if (isClosed) return Effect.fail(new TransportError({ message: "connection closed" }));
      const frame = encodeJsonFrame(text);

      const receipt =
        options?.awaitWritten === true ? Deferred.makeUnsafe<void, TransportError>() : null;

      if (receipt !== null) jsonReceipts.set(frame, receipt);
      jsonQueue.push(frame);
      queuedJsonBytes += frame.byteLength;
      wake.openUnsafe();

      if (receipt !== null) return Deferred.await(receipt);

      if (queuedJsonBytes > maxQueuedJson) {
        jsonSpace.closeUnsafe();

        return jsonSpace.await;
      }

      return Effect.void;
    });

  const scope = yield* Effect.scope;

  const offerBlob = <E>(source: BlobSource<E>): Effect.Effect<BlobId> =>
    Effect.suspend(() => {
      const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");

      const id = BlobId.make(`${prefix}${(++blobCounter).toString(36)}-${suffix}`);

      if (!Stream.isStream(source)) {
        const frames = encodeBlob(id, asBytes(source));
        let pending = frames.next();
        outBlobs.push({
          id,
          ready: () => !pending.done,
          next: () => {
            const frame = pending;

            if (frame.done === true) throw new Error(`blob ${id} has no frame ready`);
            pending = frames.next();

            return frame.value;
          },
          done: () => pending.done === true,
        });
        wake.openUnsafe();

        return Effect.succeed(id);
      }

      const buffered: Array<Uint8Array> = [];
      const space = Latch.makeUnsafe(true);
      let finished = false;

      const push = (frame: Uint8Array) => {
        buffered.push(frame);
        wake.openUnsafe();
      };

      outBlobs.push({
        id,
        ready: () => buffered.length > 0,
        next: () => {
          const frame = buffered.shift()!;

          if (buffered.length < OUT_BLOB_HIGH_WATER) space.openUnsafe();

          return frame;
        },
        done: () => finished && buffered.length === 0,
      });

      const produce = Stream.runForEach(source, (chunk) =>
        Effect.gen(function* () {
          for (let offset = 0; offset < chunk.byteLength; offset += BLOB_CHUNK_BYTES) {
            push(encodeBlobFrame(id, chunk.subarray(offset, offset + BLOB_CHUNK_BYTES), false));
            space.closeUnsafe();

            if (buffered.length >= OUT_BLOB_HIGH_WATER) yield* space.await;
          }
        })
      ).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            finished = true;
            push(encodeBlobFrame(id, new Uint8Array(), true, Exit.isFailure(exit)));
          })
        )
      );

      return Effect.as(Effect.forkIn(produce, scope), id);
    });

  // ── Incoming ──────────────────────────────────────────────────────────────
  const inBlobs = new Map<string, InBlob>();
  let bufferedBytes = 0;

  const inBlob = (blobId: string): InBlob | undefined => {
    let blob = inBlobs.get(blobId);

    if (blob === undefined) {
      if (isClosed || inBlobs.size >= maxIncomingBlobs) return undefined;
      blob = {
        parts: [],
        size: 0,
        received: 0,
        status: "receiving",
        credited: 0,
        inflight: 0,
        claimed: false,
        forgotten: false,
        started: false,
        idleTimeout: true,
        longLived: false,
        maxUnread: null,
        touched: Date.now(),
        failure: null,
        wake: null,
        deferred: Deferred.makeUnsafe<Uint8Array, BlobError>(),
      };
      inBlobs.set(blobId, blob);
      armSweep();
    }

    return blob;
  };

  const release = (blob: InBlob) => {
    bufferedBytes -= blob.size;
    blob.size = 0;
    blob.parts = [];
  };

  const failBlob = (blobId: string, blob: InBlob, reason: BlobFailure, message: string) => {
    // Abort a blob still arriving or fully buffered-but-unread; a failure is idempotent. A blob
    // past its window must be rejected even once complete, so the consumer never reads it.
    if (blob.status === "failed") return;
    release(blob);
    blob.status = "failed";
    blob.touched = Date.now();
    blob.failure = new BlobError({ blobId, reason, message });
    Deferred.doneUnsafe(blob.deferred, Exit.fail(blob.failure));
    blob.wake?.();
  };

  /** Which blob or buffer limit `length` more bytes would breach, as a message, or null. */
  const sizeBreach = (blob: InBlob, length: number): string | null => {
    if (!blob.longLived && blob.received + length > maxBlobBytes)
      return `blob exceeds ${maxBlobBytes} bytes`;

    if (bufferedBytes + length > maxBuffered) return "connection blob buffer is full";

    if (blob.maxUnread !== null && blob.received - blob.credited + length > blob.maxUnread)
      return "the sender exceeded the stream's receive window";

    return null;
  };

  const onBlobFrame = (frame: Extract<Frame, { kind: "blob" }>) => {
    const blob = inBlob(frame.blobId);

    if (blob === undefined)
      return Effect.fail(new TransportError({ message: "incoming blob count limit exceeded" }));

    if (blob.status !== "receiving") {
      // A tombstone the consumer left (`forget`) goes at the sender's last frame; any other
      // failure (too large, aborted) stays for a later take to report, until the sweep.
      if (frame.final && blob.forgotten && inBlobs.get(frame.blobId) === blob)
        inBlobs.delete(frame.blobId);

      return;
    }

    blob.touched = Date.now();

    if (frame.aborted)
      return failBlob(frame.blobId, blob, "aborted", "the sender aborted the blob");
    const length = frame.bytes.byteLength;

    if (length > 0) {
      const breach = sizeBreach(blob, length);

      if (breach !== null) return failBlob(frame.blobId, blob, "too-large", breach);
      // A view into a much larger read buffer would keep all of it alive; copy those.
      const bytes = frame.bytes.buffer.byteLength > 2 * length ? frame.bytes.slice() : frame.bytes;
      blob.parts.push(bytes);
      blob.size += length;
      blob.received += length;
      bufferedBytes += length;
    }

    if (frame.final) {
      blob.status = "complete";

      if (blob.claimed === "whole") resolveWhole(blob);
    }

    blob.wake?.();

    return Effect.void;
  };

  const unavailableBlob = (blobId: string) =>
    new BlobError({
      blobId,
      reason: isClosed ? "closed" : "too-large",
      message: isClosed ? "connection closed" : "incoming blob count limit exceeded",
    });

  /** Hands a complete blob to its `takeBlob`, in one piece. */
  const resolveWhole = (blob: InBlob) => {
    const bytes = concat(blob.parts, blob.size);
    blob.parts = [bytes];
    Deferred.doneUnsafe(blob.deferred, Exit.succeed(bytes));
  };

  const takeBlob = (blobId: string): Effect.Effect<Uint8Array, BlobError> =>
    Effect.suspend(() => {
      const blob = inBlob(blobId);

      if (blob === undefined) return Effect.fail(unavailableBlob(blobId));

      if (blob.claimed)
        return Effect.fail(
          new BlobError({ blobId, reason: "closed", message: "blob already taken" })
        );

      if (isClosed && blob.status === "receiving")
        failBlob(blobId, blob, "closed", "connection closed before the blob arrived");
      blob.claimed = "whole";
      blob.touched = Date.now();

      if (blob.status === "complete") resolveWhole(blob);

      return Deferred.await(blob.deferred).pipe(Effect.ensuring(forget(blobId, blob)));
    });

  const forget = (blobId: string, blob: InBlob) =>
    Effect.sync(() => {
      blob.wake = null;

      if (blob.status === "receiving") {
        // The consumer gave up midway: drop the rest of the blob as it arrives,
        // and let the sweep forget the entry once the sender has moved on.
        failBlob(blobId, blob, "closed", "the consumer stopped reading");
        blob.claimed = false;
        blob.forgotten = true;

        return;
      }

      if (inBlobs.get(blobId) === blob) {
        inBlobs.delete(blobId);
        release(blob);
      }
    });

  const takeBlobStream = (
    blobId: string,
    takeOptions: TakeStreamOptions = {}
  ): Stream.Stream<Uint8Array, BlobError> => {
    const blob = inBlob(blobId);

    if (blob === undefined) return Stream.fail(unavailableBlob(blobId));

    if (blob.claimed)
      return Stream.fail(
        new BlobError({ blobId, reason: "closed", message: "blob already taken" })
      );

    if (isClosed && blob.status === "receiving")
      failBlob(blobId, blob, "closed", "connection closed before the blob arrived");
    // Claim now, not at first pull: the window is installed from announcement, so frames
    // arriving before the consumer reads are enforced at ingestion (`onBlobFrame`).
    blob.claimed = "stream";
    blob.longLived = takeOptions.longLived ?? false;
    blob.idleTimeout = !blob.longLived && (takeOptions.idleTimeout ?? true);
    blob.maxUnread = takeOptions.maxUnread ?? null;
    blob.touched = Date.now();

    // Anything already received past the window is rejected, complete or still receiving.
    if (blob.maxUnread !== null && blob.received - blob.credited > blob.maxUnread)
      failBlob(blobId, blob, "too-large", "the sender exceeded the stream's receive window");

    return Stream.suspend(() => {
      blob.started = true;

      const pull = Effect.callback<
        readonly [Uint8Array, ...Array<Uint8Array>],
        BlobError | Cause.Done
      >((resume) => {
        // A fresh pull means the previous batch is consumed: credit it so the window reopens, and
        // tell the consumer exactly here, so credit back to the sender never outruns the window.
        if (blob.inflight > 0) {
          blob.credited += blob.inflight;
          const consumed = blob.inflight;
          blob.inflight = 0;
          takeOptions.onConsumed?.(consumed);
        }

        const settle = (): boolean => {
          const parts = blob.parts;

          if (Arr.isArrayNonEmpty(parts)) {
            blob.parts = [];
            bufferedBytes -= blob.size;
            blob.inflight += blob.size;
            blob.size = 0;
            resume(Effect.succeed(parts));

            return true;
          }

          if (blob.status === "failed") {
            resume(Effect.fail(blob.failure!));

            return true;
          }

          if (blob.status === "complete") {
            resume(Effect.fail(Cause.Done()));

            return true;
          }

          return false;
        };

        if (settle()) return;

        // Cleared before settling: resuming can start the next pull synchronously.
        const waiter = () => {
          blob.wake = null;

          if (!settle()) blob.wake = waiter;
        };

        blob.wake = waiter;

        return Effect.sync(() => {
          blob.wake = null;
        });
      });

      return Stream.fromPull(Effect.succeed(pull)).pipe(Stream.ensuring(forget(blobId, blob)));
    });
  };

  // Expiry is swept by a timer that only runs while incoming blobs exist, so an
  // idle connection never wakes the process.
  const sweepEveryMs = Math.max(50, Math.min(1000, idleTimeout / 4));
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;

  const armSweep = () => {
    if (sweepTimer !== undefined || isClosed || inBlobs.size === 0) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = undefined;
      sweep();
      armSweep();
    }, sweepEveryMs);
  };

  const sweep = () => {
    const now = Date.now();

    for (const [blobId, blob] of inBlobs) {
      if (blob.status === "receiving" && blob.idleTimeout && now - blob.touched > idleTimeout) {
        failBlob(blobId, blob, "timeout", `no progress for ${idleTimeout}ms`);
      } else if (
        (!blob.claimed || (blob.claimed === "stream" && !blob.started)) &&
        blob.status !== "receiving" &&
        now - blob.touched > unclaimedTtl
      ) {
        // Unclaimed, or a stream claim whose Stream was never run: an eager claim must not pin it.
        inBlobs.delete(blobId);
        release(blob);
      }
    }
  };

  const decoder = new FrameDecoder();

  const reader = transport.incoming.pipe(
    Stream.runForEach((chunk) =>
      Effect.suspend(() => {
        let frames: Array<Frame>;

        try {
          frames = decoder.push(chunk);
        } catch (cause) {
          return Effect.fail(new TransportError({ message: "malformed frame", cause }));
        }

        let i = 0;

        return Effect.whileLoop({
          while: () => i < frames.length,
          body: () => {
            const frame = frames[i++]!;

            if (frame.kind === "json") return onJson(frame.text);

            return onBlobFrame(frame) ?? Effect.void;
          },
          step: () => {},
        });
      })
    )
  );

  const shutdown = (exit: Exit.Exit<void, TransportError>) =>
    Effect.suspend(() => {
      if (isClosed) return Effect.void;
      isClosed = true;
      clearTimeout(sweepTimer);
      sweepTimer = undefined;

      for (const [blobId, blob] of inBlobs) failBlob(blobId, blob, "closed", "connection closed");

      for (const blob of inBlobs.values()) release(blob);
      inBlobs.clear();
      jsonSpace.openUnsafe();

      for (const receipt of jsonReceipts.values()) {
        Deferred.doneUnsafe(
          receipt,
          Exit.fail(new TransportError({ message: "connection closed" }))
        );
      }

      jsonReceipts.clear();

      return transport.close.pipe(Effect.ensuring(Deferred.done(closed, exit)));
    });

  yield* Effect.addFinalizer(() => shutdown(Exit.void));
  yield* reader.pipe(Effect.exit, Effect.flatMap(shutdown), Effect.forkScoped);
  yield* writer.pipe(Effect.exit, Effect.flatMap(shutdown), Effect.forkScoped);

  return {
    sendJson,
    offerBlob,
    takeBlob,
    takeBlobStream,
    closed: Deferred.await(closed),
    stats: () => ({
      bufferedBlobBytes: bufferedBytes,
      incomingBlobs: inBlobs.size,
      outgoingBlobs: outBlobs.length,
      queuedJsonBytes,
    }),
  } satisfies Wire;
});
