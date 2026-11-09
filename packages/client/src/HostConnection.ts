/**
 * A Client's link to one Host's Daemon, with its Connection State.
 *
 * The Connection State policy (Connected, Reconnecting, Needs Attention,
 * Offline; backoff, which failures wait for the user, the restart grace) is
 * the pure machine in `connection.ts`. This runs it, never prompting: one
 * attempt at a time, each outcome fed to the machine, then the wait it asks
 * for (or `retryNow`).
 */
import { createHash } from "node:crypto";
import {
  type BlobId,
  type Capability,
  type ConnectionState,
  type HostInfo,
  type HostId,
  type LanguageConnectionIdentity,
  type HostStreamItem,
  type NotFound,
  PROTOCOL_VERSION,
  type SessionId,
  type SessionStreamItem,
} from "@polaris/protocol";
import {
  Clock,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Queue,
  Redacted,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import {
  type ConnectionEvent,
  connectionMachine,
  DEFAULT_POLICY,
  initialConnection,
  type ReconnectPolicy,
} from "./connection.ts";
import { ConnectFailure, olderSide } from "./failures.ts";
import { type Feed, openHostFeed, openSessionFeed } from "./resume.ts";
import {
  type ClientBlobs,
  connectRpc,
  type DaemonClient,
  isDaemonDefect,
  type RpcConnectionOptions,
} from "./rpc.ts";
import type { WindowsShell } from "./install/windows/powershell.ts";
import { bridgeCommand } from "./install/windows/scripts.ts";
import { defaultControlDir, ensureControlDir, type SshOptions, sshArgv } from "./ssh.ts";
import { type Connector, socketTransport, spawnTransport } from "./transport.ts";
import { type WslConnectorOptions, wslConnector } from "./wsl/transport.ts";

export type HostTarget = Data.TaggedEnum<{
  Local: {
    readonly socketPath: string;
    /** The home whose `~/.polaris` Daemon this is, so a refusal can say why. */
    readonly installedHome?: string;
  };
  Ssh: {
    readonly alias: string;
    /** Per-Host toggle; off by default. */
    readonly forwardAgent?: boolean;
    /**
     * A Windows Host: the DefaultShell its sshd runs commands through, as the install probe
     * found it. The Client then connects through the relay (`bridgeCommand`), in base64 lines.
     */
    readonly windowsShell?: WindowsShell;
  };
  /** A WSL 2 distro on this Windows machine (experimental; `wsl/`). */
  Wsl: { readonly distro: string };
}>;

export const HostTarget = Data.taggedEnum<HostTarget>();

export interface ClientIdentity {
  readonly name: string;
  readonly version: string;
  /** Shown to other Clients, e.g. "MacBook Pro". */
  readonly deviceLabel: string;
  readonly capabilities: ReadonlyArray<Capability>;
  /** A Pairing's token: the connection acts as that Extension, within its Grant (ENG-398). */
  readonly extensionToken?: Redacted.Redacted<string>;
  /**
   * The Desktop App's user key (ADR 0100): an enrolled one lets this connection approve and
   * make the other user-only requests. Held by the Client only, never in an agent's env.
   */
  readonly userKey?: Redacted.Redacted<string>;
}

export { DEFAULT_POLICY, type ReconnectPolicy } from "./connection.ts";

export { languageTransportFor } from "./languages/connection.ts";

export interface HostConnectionOptions {
  /** Main-private independent proof; never supplied by the renderer. */
  readonly clientIdentity?: {
    readonly proof: Redacted.Redacted<string>;
    readonly expectedHostId?: HostId;
  };
  /** Stable key in the HostRegistry, e.g. "local" or the SSH alias. */
  readonly key: string;
  /** Display name, e.g. "Mac Studio". */
  readonly name: string;
  readonly target: HostTarget;
  readonly identity: ClientIdentity;
  /** Replaces the transport the target implies; tests spawn `polaris bridge` directly. */
  readonly connector?: Connector;
  readonly policy?: Partial<ReconnectPolicy>;
  readonly rpc?: RpcConnectionOptions;
  readonly ssh?: SshOptions;
  readonly wsl?: WslConnectorOptions;
}

export interface ConnectionStatus {
  readonly state: ConnectionState;
  /** The most recent failure; the reason shown for Reconnecting / Needs Attention / Offline. */
  readonly failure: ConnectFailure | null;
  /** Consecutive failed attempts since the last good connection. */
  readonly attempt: number;
  /** When the current state began (ms since epoch). */
  readonly since: number;
  /** When the next automatic attempt is due, or null if none is scheduled. */
  readonly nextAttemptAt: number | null;
  /** The Host as last seen; kept while not connected so the UI can dim it. */
  readonly host: HostInfo | null;
  /** Capabilities both this Client and the Daemon support. */
  readonly capabilities: ReadonlyArray<Capability>;
  /** Increments on every successful connection. */
  readonly epoch: number;
  /**
   * The link's round trip in ms, measured once per connection right after
   * `hello` (one ping; nothing periodic, so an idle Daemon stays asleep). Null until measured.
   */
  readonly latencyMs: number | null;
  /** When the last good connection ended (ms since epoch); null while connected or never. */
  readonly lastSeenAt: number | null;
}

/** One live connection: an RPC client and its blob channel. Invalid once the epoch changes. */
export interface LiveSession {
  readonly epoch: number;
  readonly client: DaemonClient;
  readonly blobs: ClientBlobs;
  readonly host: HostInfo;
  readonly capabilities: ReadonlyArray<Capability>;
  readonly languageIdentity?: LanguageConnectionIdentity | null;
  /** Aborts with this exact scoped connection, including explicit replacement. */
  readonly signal?: AbortSignal;
}

export interface LanguageSessionAuthority {
  readonly identity: LanguageConnectionIdentity;
  readonly signal: AbortSignal;
  readonly epoch: number;
  readonly capabilities: ReadonlyArray<Capability>;
}

interface LanguageSessionBinding {
  readonly authority: LanguageSessionAuthority;
  readonly client: DaemonClient;
  readonly blobs: ClientBlobs;
}

const languageSessions = new WeakMap<LiveSession, LanguageSessionBinding>();

/** Only independently verified sessions carry authority; public identity fields cannot mint it. */
export const languageSessionAuthority = (session: LiveSession): LanguageSessionAuthority | null => {
  const binding = languageSessions.get(session);
  const authority = binding?.authority;

  return authority === undefined ||
    binding?.client !== session.client ||
    binding?.blobs !== session.blobs ||
    authority.signal.aborted ||
    authority.epoch !== session.epoch ||
    authority.identity.hostId !== session.host.hostId ||
    session.languageIdentity !== authority.identity ||
    session.signal !== authority.signal
    ? null
    : authority;
};

export class NotConnected extends Error {
  readonly _tag = "NotConnected";
  constructor(readonly status: ConnectionStatus) {
    super(`not connected (${status.state})`);
  }
}

export interface HostConnection {
  readonly key: string;
  readonly name: string;
  readonly status: SubscriptionRef.SubscriptionRef<ConnectionStatus>;
  /** The current status, then every change. */
  readonly changes: Stream.Stream<ConnectionStatus>;
  /** Main observes actual session publication separately from Connection State publication. */
  readonly sessionChanges?: Stream.Stream<LiveSession | null>;
  /** The live session, or NotConnected right away. */
  readonly session: Effect.Effect<LiveSession, NotConnected>;
  /** Waits until connected. */
  readonly awaitSession: Effect.Effect<LiveSession>;
  /** Resumable host stream; see resume.ts. */
  readonly subscribeHost: Stream.Stream<HostStreamItem>;
  /** Resumable session stream; fails only if the Daemon says the session doesn't exist. */
  readonly subscribeSession: (
    sessionId: SessionId,
    options?: { readonly turnLimit?: number | null }
  ) => Stream.Stream<SessionStreamItem, NotFound>;
  /** Send bytes, then call the RPC that consumes them, on the same connection. */
  readonly withBlob: <A, E>(
    bytes: Uint8Array,
    use: (blobId: BlobId, session: LiveSession) => Effect.Effect<A, E>
  ) => Effect.Effect<A, E | NotConnected>;
  /** Try now, whatever the state (e.g. after the user fixed their ssh config). */
  readonly retryNow: Effect.Effect<void>;
}

/** The transport the target implies, unless `options.connector` replaces it. */
export const connectorFor = (options: HostConnectionOptions): Connector => {
  if (options.connector !== undefined) return options.connector;

  return HostTarget.$match(options.target, {
    Local: (target) => socketTransport(target.socketPath, target.installedHome),
    Ssh: (target) =>
      Effect.suspend(() => {
        const controlDir = options.ssh?.controlDir ?? defaultControlDir();
        ensureControlDir(controlDir, options.ssh?.platform);

        const windows = target.windowsShell;

        const ssh: SshOptions = {
          ...options.ssh,
          controlDir,
          forwardAgent: target.forwardAgent ?? false,
        };

        return spawnTransport(
          // A Windows Host's relay replaces any configured remote command.
          sshArgv(
            target.alias,
            windows === undefined ? ssh : { ...ssh, remoteCommand: [bridgeCommand(windows)] }
          ),
          // A configured sshBinary is still ssh, whatever its name.
          { spawnFailureReason: "ssh-missing", stdinLines: windows !== undefined }
        );
      }),
    Wsl: (target) => {
      const remoteCommand = options.ssh?.remoteCommand;

      return wslConnector(
        target.distro,
        remoteCommand === undefined ? (options.wsl ?? {}) : { ...options.wsl, remoteCommand }
      );
    },
  });
};

export const makeHostConnection = Effect.fnUntraced(function* (
  options: HostConnectionOptions
): Effect.fn.Return<HostConnection, never, Scope.Scope> {
  const policy: ReconnectPolicy = { ...DEFAULT_POLICY, ...options.policy };
  const connector = connectorFor(options);
  let boundHostId = options.clientIdentity?.expectedHostId;

  const startedAt = yield* Clock.currentTimeMillis;
  /** The Connection State machine's snapshot; only the loop's fiber moves it. */
  let machine = initialConnection(policy, startedAt);

  const step = (event: ConnectionEvent) => {
    machine = connectionMachine.transition(machine, event)[0];

    return machine;
  };

  const status = yield* SubscriptionRef.make<ConnectionStatus>({
    state: machine.value,
    failure: null,
    attempt: 0,
    since: startedAt,
    nextAttemptAt: null,
    host: null,
    capabilities: [],
    epoch: 0,
    latencyMs: null,
    lastSeenAt: null,
  });

  const live = yield* SubscriptionRef.make<LiveSession | null>(null);
  const retrySignal = yield* Queue.sliding<void>(1);

  const setStatus = (patch: Partial<ConnectionStatus>) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      SubscriptionRef.update(status, (current) => {
        const next = { ...current, ...patch };

        return next.state === current.state ? next : { ...next, since: now };
      })
    );

  /** One connection attempt; returns only by failing, when the attempt or the connection ends. */
  const connectOnce = (epoch: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* connector;
        const connection = yield* connectRpc(transport, options.rpc);
        const lifetime = new AbortController();
        yield* Effect.addFinalizer(() => Effect.sync(() => lifetime.abort()));

        const identityPayload = {
          clientName: options.identity.name,
          clientVersion: options.identity.version,
          deviceLabel: options.identity.deviceLabel,
          capabilities: options.identity.capabilities,
        };

        const tokenPayload =
          options.identity.extensionToken === undefined
            ? identityPayload
            : { ...identityPayload, extensionToken: options.identity.extensionToken };

        const payload =
          options.identity.userKey === undefined
            ? tokenPayload
            : { ...tokenPayload, userKey: options.identity.userKey };

        const privatePayload =
          options.clientIdentity === undefined
            ? payload
            : { ...payload, languageProof: options.clientIdentity.proof };

        const hello = yield* connection.client.hello(privatePayload).pipe(
          Effect.timeoutOrElse({
            duration: policy.helloTimeoutMs,
            orElse: () =>
              Effect.fail(
                new ConnectFailure({
                  kind: "transient",
                  reason: "timeout",
                  detail: "the Daemon did not answer hello",
                })
              ),
          }),
          Effect.catchTag("LanguageIdentityError", () =>
            Effect.fail(
              new ConnectFailure({
                kind: "needs-attention",
                reason: "protocol-mismatch",
                detail: "Language identity unavailable",
              })
            )
          ),
          Effect.catchTag("ExtensionTokenRejected", (error) =>
            Effect.fail(
              new ConnectFailure({
                kind: "needs-attention",
                reason: "pairing-rejected",
                detail: error.message,
              })
            )
          ),
          Effect.catchTag("ProtocolMismatch", (error) =>
            Effect.fail(
              new ConnectFailure({
                kind: "needs-attention",
                reason: "protocol-mismatch",
                detail: error.message,
                older: error.update === "polaris" ? "daemon" : "client",
              })
            )
          ),
          Effect.catch((error) =>
            error instanceof ConnectFailure ? Effect.fail(error) : Effect.flip(transport.diagnose)
          )
        );

        if (hello.protocolVersion !== PROTOCOL_VERSION) {
          return yield* new ConnectFailure({
            kind: "needs-attention",
            reason: "protocol-mismatch",
            detail: `the Daemon speaks protocol ${hello.protocolVersion}, this Client ${PROTOCOL_VERSION}`,
            older: olderSide(hello.protocolVersion, PROTOCOL_VERSION),
          });
        }

        const capabilities = hello.capabilities.filter((c) =>
          options.identity.capabilities.includes(c)
        );

        let languageIdentity: LanguageConnectionIdentity | null = null;

        if (boundHostId !== undefined && boundHostId !== hello.host.hostId)
          return yield* new ConnectFailure({
            kind: "needs-attention",
            reason: "protocol-mismatch",
            detail: "Language identity unavailable",
          });

        if (options.clientIdentity !== undefined && hello.languageIdentity !== undefined) {
          const expected = createHash("sha256")
            .update(
              JSON.stringify([
                "polaris-language-client-v1",
                hello.host.hostId,
                Redacted.value(options.clientIdentity.proof),
              ])
            )
            .digest("hex");

          if (
            (boundHostId !== undefined && boundHostId !== hello.host.hostId) ||
            hello.languageIdentity.hostId !== hello.host.hostId ||
            hello.languageIdentity.clientId !== `language-${expected}`
          )
            return yield* new ConnectFailure({
              kind: "needs-attention",
              reason: "protocol-mismatch",
              detail: "Language identity unavailable",
            });
          boundHostId = hello.host.hostId;
          languageIdentity = Object.freeze({ ...hello.languageIdentity });
        }

        const session: LiveSession = {
          epoch,
          client: connection.client,
          blobs: connection.blobs,
          host: hello.host,
          capabilities,
          languageIdentity,
          signal: lifetime.signal,
        };

        if (languageIdentity !== null)
          languageSessions.set(
            session,
            Object.freeze({
              client: connection.client,
              blobs: connection.blobs,
              authority: Object.freeze({
                identity: languageIdentity,
                signal: lifetime.signal,
                epoch,
                capabilities: Object.freeze([...capabilities]),
              }),
            })
          );

        yield* Effect.addFinalizer(() =>
          SubscriptionRef.update(live, (current) => (current === session ? null : current))
        );
        const connected = step({ type: "connected", epoch });
        yield* setStatus({
          state: connected.value,
          failure: null,
          attempt: connected.context.attempt,
          nextAttemptAt: null,
          host: hello.host,
          capabilities,
          epoch,
          lastSeenAt: null,
        });
        yield* SubscriptionRef.set(live, session);
        yield* connection.roundTrip.pipe(
          Effect.flatMap((ms) => setStatus({ latencyMs: Math.round(ms) })),
          Effect.timeout(policy.helloTimeoutMs),
          Effect.ignore,
          Effect.forkScoped
        );

        // An older Daemon's defect left the transport open: its diagnosis would wait for an exit.
        return yield* connection.lost.pipe(
          Effect.catch((error) =>
            isDaemonDefect(error)
              ? Effect.fail(
                  new ConnectFailure({
                    kind: "transient",
                    reason: "connection-lost",
                    detail: error.reason.message,
                  })
                )
              : Effect.flip(transport.diagnose)
          )
        );
      })
    );

  /** Waits out the delay; true if the user asked to retry now. */
  const waitForRetry = (delayMs: number | null): Effect.Effect<boolean> =>
    delayMs === null
      ? Effect.as(Queue.take(retrySignal), true)
      : Effect.raceFirst(
          Effect.as(Effect.sleep(delayMs), false),
          Effect.as(Queue.take(retrySignal), true)
        );

  const loop = Effect.gen(function* () {
    while (true) {
      yield* Queue.poll(retrySignal);
      const failure = yield* connectOnce(machine.context.epoch + 1).pipe(Effect.flip);
      const now = yield* Clock.currentTimeMillis;
      const wasConnected = machine.value === "connected";
      const { value, context } = step({ type: "failed", failure, now, jitter: Math.random() });
      const { lastSeenAt } = yield* SubscriptionRef.get(status);
      yield* setStatus({
        lastSeenAt: wasConnected ? now : lastSeenAt,
        state: value,
        failure,
        attempt: context.attempt,
        nextAttemptAt: context.delay === null ? null : now + context.delay,
      });
      const asked = yield* waitForRetry(context.delay);

      if (asked) yield* setStatus({ state: step({ type: "retry" }).value, nextAttemptAt: null });
    }
  });

  yield* Effect.forkScoped(loop);

  const nextLive = (minEpoch: number) =>
    SubscriptionRef.changes(live).pipe(
      Stream.filter((s): s is LiveSession => s !== null && s.epoch >= minEpoch),
      Stream.runHead,
      Effect.map(Option.getOrThrow)
    );

  const source = {
    next: (minEpoch: number) =>
      Effect.map(nextLive(minEpoch), (s) => ({ epoch: s.epoch, client: s.client })),
  };

  const hostFeed = yield* openHostFeed(source);

  const scope = yield* Effect.scope;
  const sessionFeeds = new Map<string, Feed<SessionStreamItem, NotFound | RpcClientError>>();
  const MAX_IDLE_SESSION_FEEDS = 32;

  const sessionFeed = (sessionId: SessionId, turnLimit: number | null) =>
    Effect.gen(function* () {
      const key = `${sessionId}\u0000${turnLimit ?? ""}`;
      const existing = sessionFeeds.get(key);

      if (existing !== undefined) return existing;

      const feed = yield* openSessionFeed(source, sessionId, turnLimit).pipe(Scope.provide(scope));

      sessionFeeds.set(key, feed);
      const idle = [...sessionFeeds].filter(([, f]) => f.subscribers() === 0);

      for (const [k] of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_SESSION_FEEDS)))
        sessionFeeds.delete(k);

      return feed;
    });

  const session = Effect.flatMap(SubscriptionRef.get(live), (s) =>
    s !== null
      ? Effect.succeed(s)
      : Effect.flatMap(SubscriptionRef.get(status), (st) => Effect.fail(new NotConnected(st)))
  );

  return {
    key: options.key,
    name: options.name,
    status,
    changes: SubscriptionRef.changes(status),
    sessionChanges: SubscriptionRef.changes(live),
    session,
    awaitSession: nextLive(0),
    // A feed resubscribes on every RpcClientError, so none ever reaches a subscriber.
    subscribeHost: Stream.orDie(hostFeed.stream),
    subscribeSession: (sessionId, opts) =>
      Stream.unwrap(
        Effect.map(sessionFeed(sessionId, opts?.turnLimit ?? null), (feed) => feed.stream)
      ).pipe(Stream.catchTag("RpcClientError", (error) => Stream.die(error))),
    withBlob: (bytes, use) =>
      Effect.flatMap(session, (s) =>
        Effect.flatMap(s.blobs.offer(bytes), (blobId) => use(blobId, s))
      ),
    retryNow: Effect.asVoid(Queue.offer(retrySignal, undefined)),
  };
});

/** Opens HostConnections; the HostRegistry connects through it, so tests can replace it. */
export class HostConnector extends Context.Service<
  HostConnector,
  {
    readonly connect: (
      options: HostConnectionOptions
    ) => Effect.Effect<HostConnection, never, Scope.Scope>;
  }
>()("polaris/client/HostConnector") {
  static readonly layer = Layer.succeed(HostConnector)(
    HostConnector.of({ connect: makeHostConnection })
  );
}
