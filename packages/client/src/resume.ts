/**
 * A resumable, cached, multicast view of one Daemon stream (`subscribeHost`
 * or `subscribeSession`).
 *
 * One upstream subscription serves every local subscriber. After a reconnect
 * it resubscribes with `afterSequence` = the last sequence seen and drops any
 * event at or below it, so a replay overlap never duplicates. A subscriber the
 * Daemon drops for falling behind has its stream ended (never skipped), so the
 * feed needs no gap check to stay gapless; `gapless` is only for a stream
 * whose sequences truly have no gaps. The host stream is not one: it leaves
 * out session-only events.
 *
 * Reopens that make no progress back off (`REOPEN_BACKOFF_MS`, doubling up to
 * `MAX_REOPEN_BACKOFF_MS`), so a stream that keeps asking to be reopened at the
 * same point can never loop hot against the Daemon.
 *
 * The feed keeps the last Snapshot and the events after it. A new subscriber
 * first gets that cache (the Desktop App paints from it at once), then live
 * items; if the feed was idle, the upstream restarts from the cached sequence
 * and revalidates. A Snapshot may arrive at any point (e.g. after the cache
 * overflowed and the feed asked for a fresh one), and replaces all prior state.
 *
 * A defect on the upstream (a chunk that fails to decode) ends the feed with
 * that cause for every subscriber, as a non-connection error does; it never
 * resubscribes on its own (ENG-492).
 */
import {
  HostStreamItem,
  type NotFound,
  Sequence,
  type SessionId,
  SessionStreamItem,
} from "@polaris/protocol";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Predicate,
  PubSub,
  Result,
  type Scope,
  Semaphore,
  Stream,
} from "effect";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type { DaemonClient } from "./rpc.ts";

export type SequenceMark =
  | { readonly kind: "snapshot"; readonly sequence: number }
  | { readonly kind: "event"; readonly sequence: number }
  | { readonly kind: "synchronized"; readonly sequence: number }
  | { readonly kind: "ephemeral" };

/** Where a feed gets connections from: the HostConnection. */
export interface LiveSource<C> {
  /** Waits for a live connection whose epoch is at least `minEpoch`. */
  readonly next: (
    minEpoch: number
  ) => Effect.Effect<{ readonly epoch: number; readonly client: C }>;
}

export interface FeedOptions<C, A, E> {
  readonly source: LiveSource<C>;
  readonly open: (client: C, afterSequence: number | null) => Stream.Stream<A, E>;
  readonly mark: (item: A) => SequenceMark;
  /** Errors that mean "the connection went away": resubscribe after reconnecting. */
  readonly isDisconnect: (error: E) => boolean;
  /**
   * Sequences on this stream have no gaps, so a gap means something was missed
   * and the feed reopens. False for both Daemon streams: the host stream leaves
   * out session-only events, and a session stream is a subset of the log.
   */
  readonly gapless: boolean;
  /** Cached events after the Snapshot before the feed asks for a fresh Snapshot. */
  readonly maxCachedEvents?: number;
  /** Pause before reopening a stream the Daemon ended normally. */
  readonly reopenDelayMs?: number;
}

export interface Feed<A, E> {
  /** Cached items first, then live ones, across reconnects. Fails with non-connection errors and upstream defects. */
  readonly stream: Stream.Stream<A, E>;
  readonly lastSequence: () => number | null;
  readonly subscribers: () => number;
}

/** What subscribers receive: an item, or the failure that ended the feed. */
type Message<A, E> = Exit.Exit<A, E>;

class Reopen {
  readonly _tag = "Reopen";
  constructor(readonly fresh: boolean) {}
}

/** Where a pump resumes from: the epoch to wait for, a fresh Snapshot, reopens in a row that stalled. */
interface Resume {
  minEpoch: number;
  fresh: boolean;
  stalled: number;
}

/** The first pause before a reopen that made no progress, doubled each time up to the max. */
export const REOPEN_BACKOFF_MS = 25;

export const MAX_REOPEN_BACKOFF_MS = 5_000;

/** How long to wait before the `stalled`-th reopen in a row that made no progress. */
export const reopenBackoff = (stalled: number): number =>
  stalled <= 0 ? 0 : Math.min(MAX_REOPEN_BACKOFF_MS, REOPEN_BACKOFF_MS * 2 ** (stalled - 1));

export const openFeed = Effect.fnUntraced(function* <C, A, E>(
  options: FeedOptions<C, A, E>
): Effect.fn.Return<Feed<A, E>, never, Scope.Scope> {
  const scope = yield* Effect.scope;
  const pubsub = yield* PubSub.unbounded<Message<A, E>>();
  const lock = Semaphore.makeUnsafe(1);
  const maxCached = options.maxCachedEvents ?? 10_000;

  let lastSequence: number | null = null;
  let snapshot: A | null = null;
  let events: Array<A> = [];
  let synchronized: A | null = null;
  let failure: { readonly cause: Cause.Cause<E> } | null = null;
  let refCount = 0;
  let upstream: Fiber.Fiber<void> | null = null;

  const publish = (message: Message<A, E>) => PubSub.publish(pubsub, message);

  const handle = (item: A): Effect.Effect<void, Reopen> =>
    lock.withPermit(
      Effect.suspend(() => {
        const mark = options.mark(item);

        switch (mark.kind) {
          case "snapshot":
            lastSequence = mark.sequence;
            snapshot = item;
            events = [];
            synchronized = null;
            break;
          case "event": {
            if (lastSequence !== null && mark.sequence <= lastSequence) return Effect.void;

            if (options.gapless && lastSequence !== null && mark.sequence !== lastSequence + 1)
              return Effect.fail(new Reopen(false));
            lastSequence = mark.sequence;

            if (snapshot !== null) {
              events.push(item);

              if (events.length > maxCached) {
                snapshot = null;
                events = [];
                synchronized = null;

                return Effect.andThen(publish(Exit.succeed(item)), Effect.fail(new Reopen(true)));
              }
            }

            break;
          }

          case "synchronized":
            synchronized = item;
            break;
          case "ephemeral":
            break;
        }

        return Effect.asVoid(publish(Exit.succeed(item)));
      })
    );

  /** Ends the feed: every subscriber, and any that joins before it restarts, fails with `cause`. */
  const end = (cause: Cause.Cause<E>) =>
    lock.withPermit(
      Effect.suspend(() => {
        failure = { cause };

        return Effect.asVoid(publish(Exit.failCause(cause)));
      })
    );

  /** After the upstream failed with `error`: null to resume, or the error that ends the feed. */
  const resumes = (at: Resume, error: E | Reopen, epoch: number, before: number | null) =>
    Effect.gen(function* () {
      if (error instanceof Reopen) {
        at.minEpoch = epoch;
        at.fresh = error.fresh;
        at.stalled = lastSequence !== before ? 0 : at.stalled + 1;

        if (at.stalled > 0) yield* Effect.sleep(reopenBackoff(at.stalled));

        return null;
      }

      if (options.isDisconnect(error)) {
        at.minEpoch = epoch + 1;

        return null;
      }

      return { error };
    });

  const run = Effect.gen(function* () {
    const at: Resume = { minEpoch: 0, fresh: false, stalled: 0 };

    while (true) {
      const live = yield* options.source.next(at.minEpoch);
      const after: number | null = at.fresh ? null : lastSequence;
      const before = lastSequence;
      at.fresh = false;

      const exit: Exit.Exit<void, E | Reopen> = yield* options
        .open(live.client, after)
        .pipe(Stream.runForEach(handle), Effect.exit);

      if (Exit.isSuccess(exit)) {
        at.minEpoch = live.epoch;
        yield* Effect.sleep(options.reopenDelayMs ?? 1000);
        continue;
      }

      const found: Result.Result<E | Reopen, Cause.Cause<never>> = Cause.findError(exit.cause);

      // A defect or an interruption from the upstream: no typed error to retry on.
      if (Result.isFailure(found)) return yield* end(found.failure);
      const fatal = yield* resumes(at, found.success, live.epoch, before);

      if (fatal !== null) return yield* end(Cause.fail(fatal.error));
    }
  });

  const retain = Effect.suspend(() => {
    refCount++;

    if (upstream === null) {
      if (failure !== null) {
        failure = null;
        lastSequence = null;
        snapshot = null;
        events = [];
        synchronized = null;
      }

      return Effect.map(Effect.forkIn(run, scope), (fiber) => {
        upstream = fiber;
        fiber.addObserver(() => {
          if (upstream === fiber) upstream = null;
        });
      });
    }

    return Effect.void;
  });

  const release = Effect.suspend(() => {
    refCount--;

    if (refCount === 0 && upstream !== null) {
      const fiber = upstream;
      upstream = null;

      return Fiber.interrupt(fiber);
    }

    return Effect.void;
  });

  const stream: Stream.Stream<A, E> = Stream.unwrap(
    Effect.gen(function* () {
      const { subscription, replay, failed } = yield* lock.withPermit(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(pubsub);
          const replay: Array<A> = [];

          if (snapshot !== null) replay.push(snapshot, ...events);

          if (synchronized !== null) replay.push(synchronized);

          return { subscription, replay, failed: upstream === null ? null : failure };
        })
      );

      yield* Effect.acquireRelease(retain, () => release);

      const live = Stream.fromSubscription(subscription).pipe(
        Stream.mapEffect((message) => message)
      );

      if (failed !== null) return Stream.failCause(failed.cause);

      return Stream.concat(Stream.fromIterable(replay), live);
    })
  );

  return {
    stream,
    lastSequence: () => lastSequence,
    subscribers: () => refCount,
  };
});

const isDisconnect = Predicate.isTagged("RpcClientError");

const afterSequenceOf = (sequence: number | null) =>
  sequence === null ? null : Sequence.make(sequence);

const markHost = HostStreamItem.match<SequenceMark>({
  Snapshot: (item) => ({ kind: "snapshot", sequence: item.sequence }),
  Event: (item) => ({ kind: "event", sequence: item.envelope.sequence }),
  Synchronized: (item) => ({ kind: "synchronized", sequence: item.sequence }),
});

const markSession = SessionStreamItem.match<SequenceMark>({
  Snapshot: (item) => ({ kind: "snapshot", sequence: item.sequence }),
  Event: (item) => ({ kind: "event", sequence: item.envelope.sequence }),
  Synchronized: (item) => ({ kind: "synchronized", sequence: item.sequence }),
  Delta: () => ({ kind: "ephemeral" }),
  ItemProgress: () => ({ kind: "ephemeral" }),
});

/** A Daemon's host stream as a Feed. */
export const openHostFeed = (source: LiveSource<DaemonClient>) =>
  openFeed<DaemonClient, HostStreamItem, RpcClientError>({
    source,
    open: (client, afterSequence) =>
      client.subscribeHost({ afterSequence: afterSequenceOf(afterSequence) }),
    mark: markHost,
    isDisconnect,
    // The host stream leaves out session-only events (TurnItemCompleted, CheckpointRecorded),
    // so its sequences have gaps; the sequence dedupe keeps the feed exact (ENG-209 finding 1).
    gapless: false,
  });

/** A Daemon's stream of one Agent Session as a Feed. */
export const openSessionFeed = (
  source: LiveSource<DaemonClient>,
  sessionId: SessionId,
  turnLimit: number | null
) =>
  openFeed<DaemonClient, SessionStreamItem, NotFound | RpcClientError>({
    source,
    open: (client, afterSequence) =>
      client.subscribeSession({
        sessionId,
        afterSequence: afterSequenceOf(afterSequence),
        turnLimit,
      }),
    mark: markSession,
    isDisconnect,
    gapless: false,
  });

export const makeFeed = openFeed;
