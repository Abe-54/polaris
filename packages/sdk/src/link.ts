/**
 * A Host's link: one connection, opened on first use and shared by every call
 * and feed, dropped when lost and reopened by the next use. Feeds reconnect
 * on their own and resume from the last sequence they applied.
 */
import type { Capability } from "@polaris/protocol";
import { Deferred, Duration, Effect, Exit, Predicate, Scope, Semaphore, Stream } from "effect";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import {
  type ConnectError,
  type ConnectOptions,
  connectHost,
  type ExtensionClient,
  type Live,
} from "./connection.ts";
import { HostUnreachable, type NotFound, type NotGranted } from "./errors.ts";
import type { ParsedPairing } from "./pairing.ts";

export interface HostEntry {
  readonly hostId: string;
  readonly hostName: string;
  /** In the order they are tried. */
  readonly pairings: ReadonlyArray<ParsedPairing>;
}

export interface HostLink {
  readonly entry: HostEntry;
  /** The live connection, opening it when there is none. */
  readonly live: Effect.Effect<Live, ConnectError>;
  /** Runs `use` on the connection; a lost connection fails it with `HostUnreachable`. */
  readonly call: <A, E>(
    use: (client: ExtensionClient) => Effect.Effect<A, E | RpcClientError>
  ) => Effect.Effect<A, Exclude<E, RpcClientError> | ConnectError>;
  readonly close: Effect.Effect<void>;
  /** Completes when the client closes, including while a feed is backing off. */
  readonly closed: Effect.Effect<void>;
  /** True once closed: feeds end instead of reconnecting. */
  readonly isClosed: () => boolean;
}

const isRpcClientError = (error: unknown): error is RpcClientError =>
  Predicate.isTagged(error, "RpcClientError");

export const openLink = Effect.fnUntraced(function* (entry: HostEntry, options: ConnectOptions) {
  const lock = yield* Semaphore.make(1);
  const closing = yield* Deferred.make<void>();
  let current: Live | null = null;
  let closed = false;

  const drop = (live: Live) =>
    Effect.suspend(() => {
      if (current === live) current = null;

      return Scope.close(live.scope, Exit.void);
    });

  const open = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const live = yield* restore(connectHost(entry.pairings, options));

      current = live;
      yield* live.lost.pipe(Effect.ignore, Effect.andThen(drop(live)), Effect.forkIn(live.scope));

      return live;
    })
  );

  const live: Effect.Effect<Live, ConnectError> = lock
    .withPermit(
      Effect.suspend(() => {
        if (closed)
          return Effect.fail(new HostUnreachable({ hostId: entry.hostId, detail: "closed" }));

        return current === null ? open : Effect.succeed(current);
      })
    )
    .pipe(
      Effect.raceFirst(
        Deferred.await(closing).pipe(
          Effect.andThen(
            Effect.fail(new HostUnreachable({ hostId: entry.hostId, detail: "closed" }))
          )
        )
      )
    );

  const call = <A, E>(use: (client: ExtensionClient) => Effect.Effect<A, E | RpcClientError>) =>
    // SAFETY: `catchIf(isRpcClientError)` turns every RpcClientError into a HostUnreachable.
    Effect.flatMap(live, (connection) =>
      use(connection.client).pipe(
        Effect.catchIf(isRpcClientError, (error) =>
          Effect.andThen(
            drop(connection),
            Effect.fail(new HostUnreachable({ hostId: entry.hostId, detail: error.message }))
          )
        )
      )
    ) as Effect.Effect<A, Exclude<E, RpcClientError> | ConnectError>;

  const close = Effect.gen(function* () {
    closed = true;
    yield* Deferred.succeed(closing, undefined);
    yield* lock.withPermit(Effect.suspend(() => (current === null ? Effect.void : drop(current))));
  }).pipe(Effect.uninterruptible);

  return {
    entry,
    live,
    call,
    close,
    closed: Deferred.await(closing),
    isClosed: () => closed,
  } satisfies HostLink;
});

export interface FeedSpec<Item, State, View> {
  readonly initial: State;
  readonly open: (
    client: ExtensionClient,
    state: State
  ) => Stream.Stream<Item, FeedError | RpcClientError>;
  readonly apply: (state: State, item: Item) => State;
  /** The view to emit, or null while there is nothing to show yet; `capabilities` are the Daemon's. */
  readonly view: (
    state: State,
    connected: boolean,
    capabilities: ReadonlyArray<Capability>
  ) => View | null;
}

/** What a feed's RPC itself fails with. */
export type FeedError = NotGranted | NotFound;

export interface Reconnect {
  /** False: a lost connection ends the feed with `HostUnreachable`. */
  readonly enabled: boolean;
  readonly maxDelay: Duration.Duration;
}

const delayFor = (attempt: number, reconnect: Reconnect) =>
  Duration.min(Duration.millis(250 * 2 ** Math.min(attempt, 10)), reconnect.maxDelay);

/**
 * A feed that survives lost connections: it emits the last view marked
 * disconnected, waits, reconnects and resumes. A Host that was never reached
 * fails at once, so a wrong pairing doesn't wait forever.
 */
export const resilientFeed = <Item, State, View>(
  link: HostLink,
  spec: FeedSpec<Item, State, View>,
  reconnect: Reconnect
): Stream.Stream<View, FeedError | ConnectError> =>
  Stream.suspend(() => {
    let state = spec.initial;
    let seen = false;
    let attempt = 0;
    let capabilities: ReadonlyArray<Capability> = [];

    const once = Stream.unwrap(
      Effect.map(link.live, (live) => {
        capabilities = live.capabilities;

        return spec
          .open(live.client, state)
          .pipe(
            Stream.catchTag("RpcClientError", (error) =>
              Stream.fail(new HostUnreachable({ hostId: link.entry.hostId, detail: error.message }))
            )
          );
      })
    ).pipe(
      Stream.map((item: Item) => {
        state = spec.apply(state, item);
        const view = spec.view(state, true, capabilities);

        if (view !== null) {
          seen = true;
          attempt = 0;
        }

        return view;
      }),
      Stream.filter((view): view is View => view !== null)
    );

    const loop = (): Stream.Stream<View, FeedError | ConnectError> =>
      once.pipe(
        Stream.catchTag("HostUnreachable", (error) => {
          if (link.isClosed()) return Stream.empty;

          if (!reconnect.enabled || !seen) return Stream.fail(error);
          const last = spec.view(state, false, capabilities);
          const wait = delayFor(attempt++, reconnect);

          return Stream.concat(
            last === null ? Stream.empty : Stream.make(last),
            Stream.unwrap(Effect.as(Effect.sleep(wait), Stream.suspend(loop)))
          );
        })
      );

    return loop().pipe(Stream.interruptWhen(link.closed));
  });
