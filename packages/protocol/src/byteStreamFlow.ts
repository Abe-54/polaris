/**
 * One end of a byte stream (ADR 0093, `byteStreams.ts`) as a ByteTransport, shared by the
 * Daemon and the Client runtime. Our bytes leave as `outgoing`, the blob the peer reads, split
 * to fit the peer's credit; the peer's blob arrives as `transport.incoming`, and each chunk is
 * granted back once the consumer has taken it. Neither side's buffer can grow past its window.
 */
import { Cause, Deferred, Effect, Exit, Queue, type Scope, Stream } from "effect";
import { type ByteTransport, TransportError } from "./wire.ts";

/** The peer's allowance: `reserve` takes what credit is free; `grant` returns what the peer consumed. */
export interface CreditWindow {
  /**
   * Reserves up to `bytes` of the allowance and answers how many it took (1..min(bytes, window)).
   * Waits only when none is free, so a write larger than the window never deadlocks on it.
   */
  readonly reserve: (bytes: number) => Effect.Effect<number, TransportError>;
  /** The peer consumed `bytes`. False when that is more than was outstanding, or not a count. */
  readonly grant: (bytes: number) => boolean;
  /** Fails every waiting and future `reserve`. */
  readonly fail: (error: TransportError) => void;
  /** Bytes sent and not yet credited. */
  readonly outstanding: () => number;
}

interface Waiter {
  readonly want: number;
  readonly resume: (effect: Effect.Effect<number, TransportError>) => void;
}

export const makeCreditWindow = (window: number): CreditWindow => {
  let available = window;
  let failure: TransportError | null = null;
  let waiters: Array<Waiter> = [];

  const settle = () => {
    while (waiters.length > 0) {
      const head = waiters[0]!;

      if (failure !== null) {
        waiters.shift();
        head.resume(Effect.fail(failure));
        continue;
      }

      if (available <= 0) return;
      const take = Math.min(head.want, available);
      available -= take;
      waiters.shift();
      head.resume(Effect.succeed(take));
    }
  };

  return {
    reserve: (bytes) =>
      Effect.callback<number, TransportError>((resume) => {
        if (failure !== null) {
          resume(Effect.fail(failure));

          return;
        }

        if (bytes < 1) {
          resume(Effect.succeed(0));

          return;
        }

        if (waiters.length === 0 && available > 0) {
          const take = Math.min(bytes, available);
          available -= take;
          resume(Effect.succeed(take));

          return;
        }

        const waiter: Waiter = { want: bytes, resume };
        waiters.push(waiter);

        return Effect.sync(() => {
          waiters = waiters.filter((w) => w !== waiter);
        });
      }),
    grant: (bytes) => {
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > window - available) return false;
      available += bytes;
      settle();

      return true;
    },
    fail: (error) => {
      failure ??= error;
      settle();
    },
    outstanding: () => window - available,
  };
};

export interface ByteStreamEndpointOptions<E extends { readonly message: string }> {
  /**
   * The peer's blob toward us, taken long-lived from the Wire; its failure carries a message.
   * A factory given an `onConsumed` hook: wire it into the take so the Wire reports each consumed
   * batch here, which is where we credit the peer — never from chunk emission, which runs ahead.
   */
  readonly incoming: (onConsumed: (bytes: number) => void) => Stream.Stream<Uint8Array, E>;
  /** The window we announced: what we buffer of `incoming` unread. Credits go back by the quarter. */
  readonly window: number;
  /** The peer's window: what we may send of `outgoing` before it grants credit. */
  readonly peerWindow: number;
  /** Tells the peer we consumed `bytes` more of its blob. */
  readonly grant: (bytes: number) => Effect.Effect<void>;
}

export interface ByteStreamEndpoint {
  readonly transport: ByteTransport;
  /**
   * Our bytes toward the peer: offer it as the blob the peer reads. A clean close ends it; a
   * failure fails it, which aborts that blob so the peer's `incoming` fails rather than ends.
   */
  readonly outgoing: Stream.Stream<Uint8Array, TransportError>;
  /** The peer consumed `bytes` of `outgoing`. False when that exceeds what was outstanding: fail the stream. */
  readonly credited: (bytes: number) => boolean;
  /** The peer closed the stream cleanly: `incoming` ends, `outgoing` ends, writes fail. */
  readonly end: () => void;
  /** Ends the stream from outside (the peer refused it, the connection dropped): reads and writes fail. */
  readonly fail: (message: string) => void;
  /** Settles once the transport has closed, by either side. */
  readonly closed: Effect.Effect<void>;
}

/** Builds the endpoint; `transport.close` ends `outgoing` (the peer sees its blob end). */
export const makeByteStreamEndpoint = Effect.fnUntraced(function* <
  E extends { readonly message: string },
>(options: ByteStreamEndpointOptions<E>): Effect.fn.Return<ByteStreamEndpoint, never, Scope.Scope> {
  const queue = yield* Queue.unbounded<Uint8Array, TransportError | Cause.Done>();
  const closed = yield* Deferred.make<void>();
  /** Only ever fails, and only on `fail`: a clean close lets `incoming` drain to its blob's end. */
  const failed = yield* Deferred.make<never, TransportError>();
  const peerCredit = makeCreditWindow(options.peerWindow);
  const grantThreshold = Math.max(1, Math.floor(options.window / 4));
  const toGrant = yield* Queue.unbounded<number, Cause.Done>();
  let ungranted = 0;
  let isClosed = false;

  // The Wire calls this exactly when it credits a consumed batch; batch by the quarter-window and
  // send from a fiber, so a grant to the peer never precedes the receive-window credit behind it.
  const onConsumed = (bytes: number) => {
    ungranted += bytes;

    if (ungranted < grantThreshold || isClosed) return;
    Queue.offerUnsafe(toGrant, ungranted);
    ungranted = 0;
  };

  yield* Stream.fromQueue(toGrant).pipe(Stream.runForEach(options.grant), Effect.forkScoped);

  const finish = (error: TransportError | null) => {
    if (isClosed) return;
    isClosed = true;
    Queue.endUnsafe(toGrant);

    // A failure aborts `outgoing` (failing the peer's blob) and interrupts `incoming`; a clean
    // close ends `outgoing` and lets `incoming` drain, its interrupt never firing.
    if (error !== null) {
      Deferred.doneUnsafe(failed, Exit.fail(error));
      Queue.failCauseUnsafe(queue, Cause.fail(error));
    } else {
      Queue.endUnsafe(queue);
    }

    peerCredit.fail(error ?? new TransportError({ message: "byte stream closed" }));
    Deferred.doneUnsafe(closed, Effect.void);
  };

  const write = (bytes: Uint8Array): Effect.Effect<void, TransportError> =>
    Effect.gen(function* () {
      let offset = 0;

      while (offset < bytes.byteLength) {
        if (isClosed) return yield* new TransportError({ message: "byte stream closed" });
        // Send what credit is free now (the Wire re-splits into frames); wait only when none is.
        const took = yield* peerCredit.reserve(bytes.byteLength - offset);
        yield* Queue.offer(queue, bytes.subarray(offset, offset + took));
        offset += took;
      }
    });

  const end = () => finish(null);

  return {
    transport: {
      incoming: options.incoming(onConsumed).pipe(
        Stream.mapError((error) => new TransportError({ message: error.message })),
        Stream.interruptWhen(Deferred.await(failed))
      ),
      write,
      close: Effect.sync(end),
    },
    outgoing: Stream.fromQueue(queue),
    credited: peerCredit.grant,
    end,
    fail: (message) => finish(new TransportError({ message })),
    closed: Deferred.await(closed),
  };
});

/**
 * Copies bytes both ways between two transports until either side's incoming ends or fails, and
 * answers the error that ended it, if any. It closes nothing: the caller decides, so a failure
 * can abort (not cleanly end) the streams and never reads as a truncated-but-clean EOF.
 */
export const pipeTransports = (
  a: ByteTransport,
  b: ByteTransport
): Effect.Effect<TransportError | null> => {
  const copy = (from: ByteTransport, to: ByteTransport) =>
    from.incoming.pipe(Stream.runForEach(to.write));

  return Effect.raceFirst(copy(a, b), copy(b, a)).pipe(
    Effect.match({ onFailure: (error) => error, onSuccess: () => null })
  );
};
