// Portions adapted from Effect-TS/effect, npm effect@4.0.0-rc.118 (MIT): src/rpc/RpcServer.ts `makeSocketProtocol`
/**
 * The Daemon's RPC server: `ServerRpcs` over the Unix socket, one framed Wire
 * per Client connection.
 *
 * The `RpcServer.Protocol` below mirrors effect/rpc's socket server protocol
 * (`makeSocketProtocol` in effect@4.0.0-rc.118 `RpcServer.ts`), with the
 * socket's byte stream replaced by a Wire: each RPC message is one JSON frame
 * (serialized with `RpcSerialization.json`), and blobs travel beside them as
 * binary chunks. Handler layers are composed here, in one place: the defaults
 * from `handlers.ts` first, then whatever the caller passes, which wins.
 */
import {
  type BlobError,
  type ByteTransport,
  type Capability,
  GrantGate,
  type HostInfo,
  type LinkedDevice,
  makeWire,
  type Wire,
  type WireOptions,
} from "@polaris/protocol";
import {
  Cause,
  Context,
  Effect,
  Latch,
  Layer,
  Predicate,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect";
import { RpcSerialization, RpcServer, type Rpc } from "effect/rpc";
import { type FromClientEncoded, ResponseDefectEncoded } from "effect/rpc/RpcMessage";
import { join } from "node:path";
import { ExtensionConnections, grantGateFor } from "../extensions/connection.ts";
import { type RunningGateway, startGateway } from "../gateway/index.ts";
import { gatewayLogText } from "../gateway/log.ts";
import { GATEWAY_WIRE_LIMITS } from "../gateway/limits.ts";
import { connectionRejected, rejectConnection } from "../extensions/admission.ts";
import { Pairings } from "../extensions/pairings.ts";
import { RemoteAccessLive } from "../extensions/remoteAccess.ts";
import { RemoteAccessControl } from "../remoteAccess/index.ts";
import { ConnectionDevice, deviceOf } from "../linkedDevices/connection.ts";
import { DeviceConnections, type LinkTiming, RelayRoute } from "../linkedDevices/route.ts";
import { HostPresence, type PresenceOptions } from "../presence/index.ts";
import type { DeviceSession } from "../linkedDevices/session.ts";
import { LinkedDevices } from "../linkedDevices/store.ts";
import { HostSecrets } from "../secrets/index.ts";
import { paths } from "../paths.ts";
import { CommandRunner } from "../service/CommandRunner.ts";
import { takeStopRecord } from "../service/daemonStop.ts";
import { adoptListener, serveUpgrades } from "../service/upgrade.ts";
import { BlobChannel, ServiceError } from "../services.ts";
import { ClientCapabilities } from "../engine/rpc.ts";
import { logDefects } from "./defects.ts";
import { rpcAdmissionBudget } from "./rpcAdmission.ts";
import { defaultHandlers } from "./handlers.ts";
import { loadHostInfo } from "./hostInfo.ts";
import { acquireLock, type DaemonAlreadyRunning, LockError } from "./lock.ts";
import { ConnectionBlobs, ServerRpcs } from "./rpcs.ts";
import { listen, prepareSocketPath } from "./socket.ts";
import { languageIdentityFor, revokeLanguageIdentity } from "./languageIdentity.ts";
import {
  HostLanguageEnvironment,
  currentLanguagePlatform,
} from "../languages/composition/environment.ts";
import { CurrentLanguageConnection } from "./currentLanguageConnection.ts";
import {
  ConnectionLanguageLifetime,
  LanguageConnectionLifetime,
} from "./languageConnectionLifetime.ts";

/** Capabilities the transport itself provides. Handler modules add theirs via `capabilities`. */
export const TRANSPORT_CAPABILITIES: ReadonlyArray<Capability> = ["blobs"];

export interface ServeOptions<ROut, E, RIn> {
  /** Real handlers; any RPC they don't cover falls back to the placeholders. */
  readonly handlers?: Layer.Layer<ROut, E, RIn>;
  /** Extra capabilities announced in `hello`, on top of TRANSPORT_CAPABILITIES. */
  readonly capabilities?: ReadonlyArray<Capability>;
  /** Overrides for tests; default to `paths()`. */
  readonly socketPath?: string;
  readonly lockPath?: string;
  readonly root?: string;
  readonly wire?: WireOptions;
  /** Require a token on the socket too (tests); gateway connections always do. */
  readonly extensionTokenRequired?: boolean;
  /**
   * Serve `ServerRpcs` over WebSocket on 127.0.0.1 as well (`gateway/`, ENG-399); every
   * connection there must present an Extension token. Omitted, there is no gateway.
   */
  readonly gateway?: { readonly port: number };
  /**
   * Take over a listener handed across an execve upgrade and serve
   * `polaris upgrade` requests (service/upgrade.ts). `polaris serve` sets it;
   * in-process tests leave it off.
   */
  readonly upgrades?: boolean;
  /** Told each startup step as it begins, so a stuck startup can say where (`deadline.ts`). */
  readonly onPhase?: (phase: string) => void;
  /** Where the Host's relay keys live; defaults to `HostSecrets.layer` (tests use memory). */
  readonly secrets?: Layer.Layer<HostSecrets>;
  /** For tests: link lifetime and a hold on link completion (`RelayRoute`). */
  readonly relayLinks?: LinkTiming | undefined;
  /** For tests: a shorter presence lease (`HostPresence`). */
  readonly presence?: PresenceOptions;
}

export interface RunningServer {
  readonly socketPath: string;
  readonly hostInfo: HostInfo;
  /** The gateway, when asked for and its port could be bound. */
  readonly gateway: Pick<RunningGateway, "port" | "url" | "secret"> | null;
  /** Number of Clients connected right now. */
  readonly connections: () => number;
}

const blobError = (error: BlobError) =>
  new ServiceError({
    service: "transport",
    message: `blob ${error.blobId}: ${error.reason}: ${error.message}`,
  });

const tokenHello = Schema.is(Schema.Struct({ extensionToken: Schema.String }));

const requestId = Schema.is(Schema.Union([Schema.String, Schema.Number]));

const blobChannelFor = (wire: Wire): BlobChannel["Service"] =>
  BlobChannel.of({
    offer: (bytes) => wire.offerBlob(bytes),
    take: (blobId) => wire.takeBlob(blobId).pipe(Effect.mapError(blobError)),
    takeStream: (blobId, options) =>
      wire.takeBlobStream(blobId, options).pipe(Stream.mapError(blobError)),
  });

/**
 * Satisfies a handler layer's `BlobChannel` requirement at build time. Every
 * request gets its connection's real channel from the `ConnectionBlobs`
 * middleware, which overrides this; using it outside a request is a bug.
 */
const BlobChannelOutsideRequest = Layer.succeed(BlobChannel)(
  BlobChannel.of({
    offer: () => Effect.die(new Error("BlobChannel used outside an RPC request")),
    take: () => Effect.die(new Error("BlobChannel used outside an RPC request")),
    takeStream: () => Stream.die(new Error("BlobChannel used outside an RPC request")),
  })
);

/**
 * Starts the Daemon's server for the lifetime of the scope: takes the lock,
 * clears a stale socket, listens, and serves every Client that connects.
 */
export const startServer = <ROut = never, E = never, RIn = never>(
  options: ServeOptions<ROut, E, RIn> = {}
): Effect.Effect<
  RunningServer,
  DaemonAlreadyRunning | LockError | ServiceError | E,
  | Scope.Scope
  | Exclude<
      RIn,
      | BlobChannel
      | CurrentLanguageConnection
      | HostLanguageEnvironment
      | LanguageConnectionLifetime
      | RelayRoute
      | LinkedDevices
      | HostSecrets
      | DeviceConnections
      | HostPresence
    >
> =>
  Effect.gen(function* () {
    const defaults = paths();
    const socketPath = options.socketPath ?? defaults.socket;
    const lockPath = options.lockPath ?? defaults.lock;
    const phase = (name: string) => Effect.sync(() => options.onPhase?.(name));

    // After an execve upgrade this process inherits the lock (same pid) and a listener.
    const adopted =
      options.upgrades === true
        ? yield* adoptListener().pipe(
            Effect.catch((error) =>
              Effect.as(Effect.logWarning("ignoring a broken upgrade hand-off", error), null)
            )
          )
        : null;

    yield* phase("taking the Daemon lock");
    yield* acquireLock(lockPath);
    yield* phase("preparing the socket and Host info");

    // The inherited socket still accepts (queued in the old listener), so don't probe it.
    if (adopted === null) yield* prepareSocketPath(socketPath);
    const root = options.root ?? defaults.root;
    const hostInfo = yield* loadHostInfo(root, takeStopRecord(root));
    const capabilities = [...new Set([...TRANSPORT_CAPABILITIES, ...(options.capabilities ?? [])])];

    const serialization = RpcSerialization.json;
    const encoder = serialization.makeUnsafe();
    const encodeDefect = Schema.encodeSync(serialization.codecFor(Schema.Defect()));
    const rpcAdmission = rpcAdmissionBudget();

    const connections = new Map<
      number,
      {
        readonly wire: Wire;
        readonly blobs: BlobChannel["Service"];
        readonly clients: Set<Rpc.ServerClient>;
        readonly lifetimes: Map<Rpc.ServerClient, ConnectionLanguageLifetime>;
        /** Ends the connection: a revoked Pairing's Extensions are cut off this way. */
        readonly close: Effect.Effect<void>;
        /** A gateway connection: `hello` must carry a token and a protocol range. */
        readonly tokenRequired: boolean;
        /** Over the Relay route: the Linked Device it acts as (ADR 0083). */
        readonly device: LinkedDevice | null;
        readonly authenticated: () => void;
        rpcLimited: boolean;
        closing: boolean;
      }
    >();

    // Which connections act as which Pairing, and the Pairings themselves (ENG-398).
    const extensionConnections = ExtensionConnections.make((clientId) =>
      Effect.suspend(() => {
        const connection = connections.get(clientId);

        if (connection === undefined) return Effect.void;
        connection.clients.forEach((client) => rejectConnection(client, "revoked"));

        return connection.close;
      })
    );

    // Every connection's presence; a closed connection's ends with it (ENG-495).
    const presence = HostPresence.make(options.presence);

    // Set once `serveConnection` exists: a device's session that arrives sooner is ended.
    let serveDevice:
      | ((session: DeviceSession, device: LinkedDevice) => Effect.Effect<void>)
      | null = null;

    const deviceServices = RelayRoute.layer({ root, hostInfo, links: options.relayLinks }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          LinkedDevices.layer(join(root, "linked-devices.sqlite")).pipe(
            Layer.catchTag("LinkedDeviceStoreError", (error) =>
              Layer.effect(
                LinkedDevices,
                Effect.fail(new ServiceError({ service: "transport", message: error.message }))
              )
            )
          ),
          options.secrets ?? HostSecrets.layer,
          Layer.succeed(HostPresence)(presence),
          Layer.succeed(DeviceConnections)({
            serve: (session, device) =>
              serveDevice === null ? session.close : serveDevice(session, device),
          })
        )
      )
    );

    const extensionServices = Layer.mergeAll(
      deviceServices,
      RemoteAccessLive.pipe(Layer.provideMerge(RemoteAccessControl.layer({ root }))),
      Pairings.layer(join(root, "extensions.sqlite")).pipe(
        Layer.catchTag("PairingStoreError", (error) =>
          Layer.effect(
            Pairings,
            Effect.fail(new ServiceError({ service: "transport", message: error.message }))
          )
        )
      ),
      Layer.succeed(ExtensionConnections)(extensionConnections)
    );

    const disconnects = yield* Queue.unbounded<number>();
    let writeRequest!: Parameters<Parameters<typeof RpcServer.Protocol.make>[0]>[0];

    const protocol = yield* RpcServer.Protocol.make((write) => {
      writeRequest = write;

      return Effect.succeed({
        disconnects,
        send: (clientId, response) => {
          if (Predicate.isTagged(response, "Exit"))
            rpcAdmission.terminal(clientId, response.requestId);
          const connection = connections.get(clientId);

          if (connection === undefined) return Effect.void;
          let text: string | Uint8Array | undefined;

          try {
            text = encoder.encode(response);
          } catch (cause) {
            text = encoder.encode(ResponseDefectEncoded(encodeDefect(cause)));
          }

          // The JSON serialization always encodes to a string.
          if (!Predicate.isString(text)) return Effect.void;

          if (![...connection.clients].some(connectionRejected))
            return Effect.ignore(connection.wire.sendJson(text));

          // Flush the typed hello error before closing, bounded even if the peer stopped reading.
          return connection.wire
            .sendJson(text, { awaitWritten: true })
            .pipe(Effect.timeout("1 second"), Effect.ignore, Effect.ensuring(connection.close));
        },
        end: () => Effect.void,
        clientIds: Effect.sync(() => new Set(connections.keys())),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: true,
        supportsNotifications: true,
        codecFor: serialization.codecFor,
      });
    });

    const connectionMiddleware = ConnectionBlobs.of((effect, { client, rpc }) => {
      const connection = connections.get(client.id);

      if (connection === undefined || connection.closing) {
        revokeLanguageIdentity(client);

        return Effect.die(new Error(`no connection for client ${client.id}`));
      }

      connection.clients.add(client);

      if (connection.device !== null && deviceOf(client) === null)
        client.annotate(ConnectionDevice, connection.device);

      const current = () =>
        !connection.closing &&
        connections.get(client.id) === connection &&
        connection.clients.has(client)
          ? languageIdentityFor(client, hostInfo.hostId)
          : null;

      let lifetime = connection.lifetimes.get(client);

      if (lifetime === undefined) {
        lifetime = new ConnectionLanguageLifetime(current);
        connection.lifetimes.set(client, lifetime);
      }

      return effect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (Predicate.isTagged(rpc, "hello")) connection.authenticated();
          })
        ),
        Effect.provideService(BlobChannel, connection.blobs),
        Effect.provideService(LanguageConnectionLifetime, { attach: lifetime.attach }),
        Effect.provideService(CurrentLanguageConnection, {
          current,
          supports: (capability) =>
            current() !== null &&
            capabilities.includes(capability) &&
            (Context.getOrUndefined(client.annotations, ClientCapabilities) ?? []).includes(
              capability
            ),
        })
      );
    });

    const blobsMiddleware = ConnectionBlobs.of((effect, options) => {
      if (!connections.get(options.client.id)?.rpcLimited)
        return logDefects(options.rpc._tag, connectionMiddleware(effect, options));

      return Effect.suspend(() => {
        rpcAdmission.start(options.client.id, options.requestId);

        return logDefects(options.rpc._tag, connectionMiddleware(effect, options)).pipe(
          // Close handler-owned resources before returning the reservation or sending its Exit.
          Effect.scoped,
          Effect.ensuring(
            Effect.sync(() => rpcAdmission.finish(options.client.id, options.requestId))
          )
        );
      });
    });

    yield* phase("starting the Daemon's services (event store, Engine, Constellations)");

    const handlers = yield* Layer.build(
      Layer.merge(
        defaultHandlers({ hostInfo, capabilities }).pipe(Layer.provide(extensionServices)),
        // SAFETY: `handlers` is omitted only when ROut, E and RIn keep their `never` defaults.
        ((options.handlers ?? Layer.empty) as Layer.Layer<ROut, E, RIn>).pipe(
          Layer.provide(
            Layer.merge(
              BlobChannelOutsideRequest,
              Layer.mergeAll(
                // The same layer as the transport's, so both share one Relay route (one build).
                deviceServices,
                Layer.succeed(HostLanguageEnvironment)({
                  hostId: hostInfo.hostId,
                  root: options.root ?? defaults.root,
                  platform: currentLanguagePlatform(),
                }),
                LanguageConnectionLifetime.unavailableLayer,
                Layer.succeed(CurrentLanguageConnection)({ current: () => null })
              )
            )
          )
        )
      )
    );

    // A defect fails only its own request (ADR 0064).
    yield* RpcServer.make(ServerRpcs, {
      spanPrefix: "polaris.rpc",
      disableFatalDefects: true,
    }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provideService(ConnectionBlobs, blobsMiddleware),
      Effect.provideService(
        GrantGate,
        grantGateFor({
          tokenRequired: (client) =>
            connections.get(client.id)?.tokenRequired ?? options.extensionTokenRequired ?? false,
          deviceOf: (client) => connections.get(client.id)?.device ?? null,
        })
      ),
      Effect.provideContext(handlers),
      Effect.forkScoped
    );

    let nextClientId = 0;

    const serveConnection = (
      transport: ByteTransport,
      tokenRequired: boolean,
      authenticated = () => {},
      device: LinkedDevice | null = null
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const clientId = nextClientId++;
          const ready = Latch.makeUnsafe(false);
          const decoder = serialization.makeUnsafe();

          const onJson = (text: string) =>
            Effect.andThen(
              ready.await,
              Effect.suspend(() => {
                let messages: ReadonlyArray<FromClientEncoded>;

                try {
                  // SAFETY: as in Effect's own RpcServer protocols, the envelope is trusted and
                  // RpcServer decodes each payload against its Rpc schema.
                  messages = decoder.decode(text) as ReadonlyArray<FromClientEncoded>;
                } catch {
                  return Effect.logWarning("dropping an undecodable message");
                }

                return Effect.forEach(
                  messages,
                  (message) =>
                    Effect.suspend(() => {
                      const connection = connections.get(clientId);

                      if (connection === undefined || connection.closing) return Effect.void;

                      if (Predicate.isTagged(message, "Request")) {
                        connection.rpcLimited ||=
                          message.tag === "hello" && tokenHello(message.payload);

                        if (
                          connection.rpcLimited &&
                          (!requestId(message.id) || !rpcAdmission.acquire(clientId, message.id))
                        ) {
                          connection.closing = true;

                          return connection.close;
                        }
                      }

                      return writeRequest(clientId, message);
                    }),
                  {
                    discard: true,
                  }
                );
              })
            );

          const wireOptions = tokenRequired
            ? { ...options.wire, ...GATEWAY_WIRE_LIMITS }
            : options.wire;

          const wire = yield* makeWire(transport, onJson, {
            ...wireOptions,
            blobIdPrefix: "d",
          });

          const clients = new Set<Rpc.ServerClient>();

          const lifetimes = new Map<Rpc.ServerClient, ConnectionLanguageLifetime>();

          const connection = {
            wire,
            blobs: blobChannelFor(wire),
            clients,
            lifetimes,
            close: transport.close,
            authenticated,
            device,
            tokenRequired: tokenRequired || (options.extensionTokenRequired ?? false),
            rpcLimited: tokenRequired || (options.extensionTokenRequired ?? false),
            closing: false,
          };

          connections.set(clientId, connection);
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                connection.closing = true;
                rpcAdmission.disconnect(clientId);
                extensionConnections.unbind(clientId);
                presence.disconnect(clientId);
                lifetimes.forEach((lifetime) => lifetime.seal());
                clients.forEach(revokeLanguageIdentity);
                clients.forEach((client) => rejectConnection(client));
                clients.clear();
              });
              yield* Effect.forEach(lifetimes.values(), (lifetime) => lifetime.close(), {
                discard: true,
              });
              lifetimes.clear();

              if (connections.get(clientId) === connection) connections.delete(clientId);
              yield* Queue.offer(disconnects, clientId);
            })
          );
          ready.openUnsafe();
          yield* wire.closed.pipe(
            Effect.tapCause((cause) =>
              tokenRequired
                ? Effect.logInfo(
                    `a gateway connection's Wire failed: ${gatewayLogText(Cause.pretty(cause))}`
                  )
                : Effect.void
            ),
            Effect.ignore
          );
        })
      );

    const scope = yield* Effect.scope;

    serveDevice = (session, device) =>
      Effect.asVoid(
        Effect.forkIn(
          serveConnection(session, false, () => {}, device).pipe(
            Effect.ensuring(Effect.sync(() => session.end()))
          ),
          scope
        )
      );
    yield* phase(`listening on ${socketPath}`);
    const listener = yield* listen(socketPath);
    yield* listener.connections.pipe(
      Stream.runForEach((transport) => Effect.forkIn(serveConnection(transport, false), scope)),
      Effect.forkScoped
    );

    let gateway: RunningGateway | null = null;

    if (options.gateway !== undefined) {
      yield* phase(`listening on the gateway (127.0.0.1:${options.gateway.port})`);
      // Made before the gateway: on stop, the gateway closes its sockets (1001) before
      // the connections' own finalizers would (1000).
      const gatewayConnections = yield* Scope.fork(scope);

      gateway = yield* startGateway({
        port: options.gateway.port,
        recordPath: join(root, "gateway.json"),
      });

      if (gateway !== null)
        yield* gateway.connections.pipe(
          Stream.runForEach((transport) =>
            Effect.forkIn(
              serveConnection(transport, true, transport.authenticated).pipe(
                Effect.ensuring(
                  Effect.suspend(() =>
                    Effect.logInfo(`gateway connection closed: ${transport.summary()}`)
                  )
                )
              ),
              gatewayConnections
            )
          ),
          Effect.forkIn(gatewayConnections)
        );
    }

    if (adopted !== null) {
      const drained = yield* listener
        .adopt(adopted)
        .pipe(
          Effect.catch((error) =>
            Effect.as(Effect.logWarning("draining the old listener", error), 0)
          )
        );

      yield* Effect.logInfo(
        `took over from ${adopted.fromVersion}; ${drained} queued connection(s)`
      );
    }

    if (options.upgrades === true) {
      yield* serveUpgrades({ listenerFd: listener.fd, args: ["serve"] }).pipe(
        Effect.provide(CommandRunner.layer),
        Effect.mapError((error) => new LockError({ path: socketPath, message: error.message }))
      );
    }

    return {
      socketPath,
      hostInfo,
      gateway:
        gateway === null ? null : { port: gateway.port, url: gateway.url, secret: gateway.secret },
      connections: () => connections.size,
    };
  });
