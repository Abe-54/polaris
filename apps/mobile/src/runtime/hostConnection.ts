/**
 * The Mobile App's link to one Host's Daemon as a Client: a pluggable byte transport (the dev
 * bridge, later the Polaris Relay), `DaemonRpcs` over it, and `@polaris/client`'s Connection
 * State machine deciding when to try again. Every screen shares one per Host.
 */
import {
  connectionMachine,
  connectionStateOf,
  type ConnectionSnapshot,
  DEFAULT_POLICY,
  initialConnection,
  type ReconnectPolicy,
} from "@polaris/client/connection";
import { ConnectFailure, olderSide } from "@polaris/client/failures";
import { type ClientBlobs, connectRpc, type DaemonClient } from "@polaris/client/rpc";
import {
  type ByteTransport,
  type Capability,
  type ConnectionState,
  type HostInfo,
  PROTOCOL_VERSION,
  type TransportError,
} from "@polaris/protocol";
import { Cause, Effect, Exit, Fiber, type Scope } from "effect";
import { selfTracer } from "../selfTraces/index.ts";
import { MOBILE_CAPABILITIES } from "./capabilities.ts";

/** How the bytes reach the Host: the development bridge, or the Polaris Relay. */
export type HostRoute = "dev-bridge" | "relay";

export interface HostTransport {
  readonly route: HostRoute;
  /** One connection's bytes; a TransportError counts as a transient "unreachable". */
  readonly open: Effect.Effect<ByteTransport, ConnectFailure | TransportError, Scope.Scope>;
}

export interface HostStatus {
  readonly state: ConnectionState;
  readonly failure: ConnectFailure | null;
  /** Consecutive failed attempts since the last good connection. */
  readonly attempt: number;
  /** When the next attempt starts; null while connected or waiting for `retryNow`. */
  readonly nextAttemptAt: number | null;
  /** The Daemon's own description, from the latest hello; null before the first. */
  readonly host: HostInfo | null;
  readonly capabilities: ReadonlyArray<Capability>;
  /** The connection count; each new connection gets the next one. */
  readonly epoch: number;
  /** One ping right after hello, in ms; null until measured. */
  readonly latencyMs: number | null;
  /** When the Host last answered: the latest hello, or the moment the connection dropped. */
  readonly lastSeenAt: number | null;
}

/** A connection that answered hello: its RPC client stays valid until the epoch changes. */
export interface LiveHost {
  readonly epoch: number;
  readonly client: DaemonClient;
  /** Blobs on this connection: ones a response referenced (`git.diff`), and bytes an RPC sends. */
  readonly blobs: ClientBlobs;
  readonly host: HostInfo;
  readonly capabilities: ReadonlyArray<Capability>;
}

export class NotConnected extends Error {
  readonly _tag = "NotConnected";

  constructor(readonly hostId: string) {
    super(`${hostId} is not connected`);
  }
}

export interface HostConnection {
  readonly hostId: string;
  readonly name: string;
  readonly route: HostRoute;
  readonly status: () => HostStatus;
  readonly live: () => LiveHost | null;
  /** Called after every status or live change; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Runs `use` on the live client; rejects with NotConnected when there is none. */
  readonly run: <A, E>(use: (client: DaemonClient) => Effect.Effect<A, E>) => Promise<A>;
  readonly retryNow: () => void;
  /**
   * Asks the live connection for a pong (the app came back to the front); one that
   * doesn't answer in time is dropped and reconnected, and its feeds resume.
   */
  readonly checkAlive: () => void;
  readonly close: () => Promise<void>;
}

export interface HostConnectionOptions {
  readonly hostId: string;
  readonly name: string;
  readonly transport: HostTransport;
  /** Shown to other Clients, e.g. beside an approval this device answered. */
  readonly deviceLabel?: string;
  readonly policy?: Partial<ReconnectPolicy>;
  /** Pings while feeds are open; a link silent for three of these is lost. */
  readonly pingIntervalMs?: number;
  /** How long `checkAlive` waits for the pong. */
  readonly aliveTimeoutMs?: number;
}

/** A phone's link can die without closing (a network change, a suspended app): ping it. */
export const PING_INTERVAL_MS = 15_000;

export const ALIVE_TIMEOUT_MS = 5_000;

const CLIENT_NAME = "Polaris Mobile";

const CLIENT_VERSION = "0.0.0";

const transient = (reason: "unreachable" | "timeout" | "connection-lost", detail: string) =>
  new ConnectFailure({ kind: "transient", reason, detail });

const failureOf = (cause: Cause.Cause<unknown>): ConnectFailure => {
  const error = Cause.squash(cause);

  if (error instanceof ConnectFailure) return error;

  return transient("connection-lost", error instanceof Error ? error.message : String(error));
};

/** Waits `delay` ms, or until `wake` is called; null waits only for `wake`. */
const sleeper = () => {
  let wake = () => {};

  const sleep = (delay: number | null) =>
    new Promise<void>((resolve) => {
      const timer = delay === null ? null : setTimeout(resolve, delay);

      wake = () => {
        if (timer !== null) clearTimeout(timer);
        resolve();
      };
    });

  return { sleep, wake: () => wake() };
};

export const openHostConnection = (options: HostConnectionOptions): HostConnection => {
  const policy = { ...DEFAULT_POLICY, ...options.policy };
  let snapshot: ConnectionSnapshot = initialConnection(policy, Date.now());
  let live: LiveHost | null = null;
  let host: HostInfo | null = null;
  let capabilities: ReadonlyArray<Capability> = [];
  let latencyMs: number | null = null;
  let lastSeenAt: number | null = null;
  let nextAttemptAt: number | null = null;
  let closed = false;
  let current: Fiber.Fiber<never, unknown> | null = null;
  const listeners = new Set<() => void>();
  const waiting = sleeper();
  /** The live connection's pong, timed out into dropping it: `checkAlive`. */
  let alive: Effect.Effect<void> | null = null;

  const statusNow = (): HostStatus => ({
    state: connectionStateOf(snapshot),
    failure: snapshot.context.failure,
    attempt: snapshot.context.attempt,
    nextAttemptAt,
    host,
    capabilities,
    epoch: snapshot.context.epoch,
    latencyMs,
    lastSeenAt,
  });

  let status = statusNow();

  const changed = () => {
    status = statusNow();

    for (const listener of listeners) listener();
  };

  /** Opens the transport and says hello: the `mobile.connect` Span while tracing. */
  const connect = (epoch: number) =>
    Effect.gen(function* () {
      const transport = yield* options.transport.open.pipe(
        Effect.mapError((error) =>
          error instanceof ConnectFailure ? error : transient("unreachable", error.message)
        )
      );

      const connection = yield* connectRpc(transport, {
        keepAliveStreams: true,
        pingIntervalMs: options.pingIntervalMs ?? PING_INTERVAL_MS,
      });

      const lost = connection.lost.pipe(
        Effect.mapError((error) => transient("connection-lost", error.message))
      );
      // A connection that drops before hello is sent never fails the request: race it.

      const hello = yield* connection.client
        .hello({
          clientName: CLIENT_NAME,
          clientVersion: CLIENT_VERSION,
          deviceLabel: options.deviceLabel ?? "iPhone",
          capabilities: MOBILE_CAPABILITIES,
        })
        .pipe(
          Effect.mapError((error) => transient("unreachable", error.message)),
          Effect.raceFirst(lost),
          Effect.timeoutOrElse({
            duration: policy.helloTimeoutMs,
            orElse: () => Effect.fail(transient("timeout", "the Daemon did not answer hello")),
          })
        );

      if (hello.protocolVersion !== PROTOCOL_VERSION)
        return yield* new ConnectFailure({
          kind: "needs-attention",
          reason: "protocol-mismatch",
          detail: `the Daemon speaks protocol ${hello.protocolVersion}, this app ${PROTOCOL_VERSION}`,
          older: olderSide(hello.protocolVersion, PROTOCOL_VERSION),
        });

      return { connection, hello, lost };
    }).pipe((connecting) =>
      selfTracer.traced(
        "mobile.connect",
        { "polaris.host.route": options.transport.route, "polaris.connection.epoch": epoch },
        connecting
      )
    );

  const attempt = (epoch: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { connection, hello, lost } = yield* connect(epoch);

        snapshot = connectionMachine.transition(snapshot, { type: "connected", epoch })[0];
        host = hello.host;
        capabilities = hello.capabilities;
        lastSeenAt = Date.now();
        alive = connection.roundTrip.pipe(
          Effect.timeoutOrElse({
            duration: options.aliveTimeoutMs ?? ALIVE_TIMEOUT_MS,
            orElse: () => connection.drop("the Host stopped answering"),
          }),
          Effect.asVoid
        );
        live = {
          epoch,
          client: connection.client,
          blobs: connection.blobs,
          host: hello.host,
          capabilities,
        };
        changed();

        latencyMs = Math.round(yield* connection.roundTrip.pipe(Effect.raceFirst(lost)));
        changed();

        return yield* lost;
      })
    );

  const failed = (failure: ConnectFailure) => {
    if (live !== null) lastSeenAt = Date.now();
    live = null;
    alive = null;
    snapshot = connectionMachine.transition(snapshot, {
      type: "failed",
      failure,
      now: Date.now(),
      jitter: Math.random(),
    })[0];
    const { delay } = snapshot.context;
    nextAttemptAt = delay === null ? null : Date.now() + delay;
    changed();

    return delay;
  };

  const loop = async () => {
    for (let epoch = 1; !closed; epoch += 1) {
      const fiber = Effect.runFork(attempt(epoch));
      current = fiber;
      const exit = await Effect.runPromise(Fiber.await(fiber));
      current = null;

      if (closed) return;

      const delay = failed(
        Exit.isFailure(exit) ? failureOf(exit.cause) : transient("connection-lost", "closed")
      );

      await waiting.sleep(delay);
      nextAttemptAt = null;
    }
  };

  void loop();

  return {
    hostId: options.hostId,
    name: options.name,
    route: options.transport.route,
    status: () => status,
    live: () => live,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    run: (use) => {
      const now = live;

      return now === null
        ? Promise.reject(new NotConnected(options.hostId))
        : Effect.runPromise(use(now.client));
    },
    checkAlive: () => {
      if (alive !== null) Effect.runFork(alive);
    },
    retryNow: () => {
      if (live !== null) return;
      snapshot = connectionMachine.transition(snapshot, { type: "retry" })[0];
      waiting.wake();
    },
    close: async () => {
      closed = true;
      waiting.wake();
      live = null;

      if (current !== null) await Effect.runPromise(Fiber.interrupt(current));
      listeners.clear();
    },
  };
};
