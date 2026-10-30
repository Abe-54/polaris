/**
 * The Relay route (ADR 0080, 0083): on when the user turned it on for this Host. Then the
 * Daemon keeps one socket to the relay, lists its Linked Devices and open links as peers,
 * and serves a connection with Client power to each device whose handshake proves a key
 * linked here from the address stored with it. Unlinking ends the device's session at once.
 */
import { randomBytes } from "node:crypto";
import {
  decodeLinkRequest,
  encodeLinkString,
  type HostInfo,
  LinkOffer,
  LinkedDevice,
  type LinkedDeviceId,
  NotFound,
  PushRegistrationError,
  RelayRouteError,
  RelayRouteStatus,
} from "@polaris/protocol";
import {
  type LiveActivityRegistration,
  MAX_WAKE_PAYLOAD_CHARS,
  type PushMessage,
  type PushRegistration,
  type RelayAddress,
  relayAddress,
  toBase64Url,
  verifyLiveTicket,
  verifyPushTicket,
  type WakeOutcome,
} from "@polaris/protocol/relay";
import { linkIdentity, linkProof, sameProof } from "@polaris/protocol/relay/party";
import { Context, Deferred, Effect, Layer, Option, Queue, Semaphore, Stream } from "effect";
import { HostSecrets } from "../secrets/index.ts";
import { type HostRelayKeys, loadHostRelayKeys } from "./keys.ts";
import { type Admission, RelayLink } from "./link.ts";
import type { DeviceSession } from "./session.ts";
import { isRelayUrl, readSetting, writeSetting } from "./settings.ts";
import { pushSuite, sealPush } from "../push/seal.ts";
import { LinkedDevices, type LiveTarget, type PushTarget } from "./store.ts";

/** How long a self-unlinking device's session outlives the answer to it. */
const SELF_UNLINK_DROP = "300 millis";

/** How long a link string can be used. */
export const LINK_TTL_MS = 5 * 60 * 1000;

/** For tests: a shorter link lifetime, and a hold on a used link's completion. */
export interface LinkTiming {
  readonly ttlMs?: number;
  /** Runs `completion` (the link's commit) when it chooses; it runs at once by default. */
  readonly completeWith?: (completion: Effect.Effect<void>) => Effect.Effect<void>;
}

interface OpenLink {
  readonly id: string;
  readonly secret: Uint8Array;
  /** The throwaway relay address the device dials with while linking. */
  readonly address: RelayAddress;
  readonly expiresAt: number;
  readonly done: Deferred.Deferred<LinkedDevice, NotFound>;
  /** Set when a device proved the secret: a link is used once. */
  used: boolean;
  /** Its address stays a peer until the reply to the device went out. */
  listed: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** A sealed slice for the relay, with what the relay may read of it; `sealed: null` leaves. */
export interface LiveSlice {
  readonly sealed: string | null;
  readonly active: boolean;
  readonly alert: boolean;
}

/** How the server serves a Linked Device's session: a connection acting as that device. */
export class DeviceConnections extends Context.Service<
  DeviceConnections,
  { readonly serve: (session: DeviceSession, device: LinkedDevice) => Effect.Effect<void> }
>()("polaris/daemon/linkedDevices/DeviceConnections") {}

export class RelayRoute extends Context.Service<
  RelayRoute,
  {
    readonly status: Effect.Effect<RelayRouteStatus, RelayRouteError>;
    readonly enable: (url: string) => Effect.Effect<RelayRouteStatus, RelayRouteError>;
    readonly disable: Effect.Effect<RelayRouteStatus, RelayRouteError>;
    readonly startLink: Effect.Effect<LinkOffer, RelayRouteError>;
    /** Ends with NotFound when the link expires or is cancelled; interrupting it cancels it. */
    readonly awaitLink: (linkId: string) => Effect.Effect<LinkedDevice, NotFound>;
    readonly cancelLink: (linkId: string) => Effect.Effect<void>;
    readonly add: (device: {
      readonly name: string;
      readonly relayAddress: RelayAddress;
      readonly noiseKey: string;
    }) => Effect.Effect<LinkedDevice>;
    /** Each device with `connectedSince`: when its open relay session began, or null. */
    readonly list: Effect.Effect<ReadonlyArray<LinkedDevice>>;
    /** `list` now, then again on every link, unlink, and session opened or closed. */
    readonly watch: Stream.Stream<ReadonlyArray<LinkedDevice>>;
    readonly unlink: (id: LinkedDeviceId) => Effect.Effect<LinkedDevice, NotFound>;
    /** Unlinks the device whose own session asks; that session ends once its answer is out. */
    readonly unlinkSelf: (id: LinkedDeviceId) => Effect.Effect<LinkedDevice, NotFound>;
    /** Stores `device`'s push registration once its ticket signs this Host's relay address. */
    readonly registerPush: (
      device: LinkedDevice,
      registration: PushRegistration
    ) => Effect.Effect<void, PushRegistrationError>;
    readonly unregisterPush: (device: LinkedDevice) => Effect.Effect<void>;
    /** Every device registered for push; read synchronously. */
    readonly pushTargets: () => ReadonlyArray<PushTarget>;
    /** Calls `listener` whenever the registrations change; returns the unsubscribe. */
    readonly watchPush: (listener: () => void) => () => void;
    /** This Host, as pushes name it. */
    readonly host: { readonly hostId: string; readonly hostName: string };
    /** Stores `device`'s Live Activity once its ticket signs this Host's relay address. */
    readonly registerLiveActivity: (
      device: LinkedDevice,
      registration: LiveActivityRegistration
    ) => Effect.Effect<void, PushRegistrationError>;
    /** Forgets it and tells the relay to drop this Host's slice of it. */
    readonly unregisterLiveActivity: (device: LinkedDevice) => Effect.Effect<void>;
    /** Every device with a Live Activity registered; read synchronously. */
    readonly liveTargets: () => ReadonlyArray<LiveTarget>;
    /** Calls `listener` when the registrations change and on every relay connect. */
    readonly watchLive: (listener: () => void) => () => void;
    /** Sends this Host's sealed slice (null: none) to the relay; false while it can't. */
    readonly sendLive: (target: LiveTarget, slice: LiveSlice) => boolean;
    /** Seals `message` to the device and wakes it; an `unregistered` token is dropped. */
    readonly wake: (target: PushTarget, message: PushMessage) => Effect.Effect<WakeOutcome>;
  }
>()("polaris/daemon/linkedDevices/RelayRoute") {
  static layer(options: {
    readonly root: string;
    readonly hostInfo: HostInfo;
    readonly links?: LinkTiming | undefined;
  }) {
    return Layer.effect(RelayRoute, makeRelayRoute(options));
  }
}

const failed = (message: string) => new RelayRouteError({ reason: "failed", message });

const makeRelayRoute = Effect.fn("makeRelayRoute")(function* (options: {
  readonly root: string;
  readonly hostInfo: HostInfo;
  readonly links?: LinkTiming | undefined;
}) {
  const store = yield* LinkedDevices;
  const secrets = yield* HostSecrets;
  const connections = yield* DeviceConnections;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const links = new Map<string, OpenLink>();
  // Completing a used link and closing it are one transition each: whichever runs first wins (RX2-2).
  const linkLock = Semaphore.makeUnsafe(1);
  const ttlMs = options.links?.ttlMs ?? LINK_TTL_MS;
  const completeWith = options.links?.completeWith ?? ((completion) => completion);
  let setting = readSetting(options.root);
  let link: RelayLink | null = null;
  let cachedKeys: HostRelayKeys | null = null;
  const pushListeners = new Set<() => void>();
  const pushChanged = () => pushListeners.forEach((listener) => listener());
  const liveListeners = new Set<() => void>();
  const liveChanged = () => liveListeners.forEach((listener) => listener());
  // Each device's open session and when it began; the relay ends sessions, so no timer.
  const connected = new Map<string, { readonly session: DeviceSession; readonly since: string }>();
  const deviceListeners = new Set<() => void>();
  const devicesChanged = () => deviceListeners.forEach((listener) => listener());

  const withPresence = (devices: ReadonlyArray<LinkedDevice>) =>
    devices.map(
      ({ id, name, relayAddress, noiseKey, createdAt, lastUsedAt, unlinkedAt }) =>
        new LinkedDevice({
          id,
          name,
          relayAddress,
          noiseKey,
          createdAt,
          lastUsedAt,
          unlinkedAt,
          connectedSince: connected.get(id)?.since ?? null,
        })
    );

  const list = Effect.map(Effect.orDie(store.list), withPresence);

  const sendLive = ({ device, registration }: LiveTarget, slice: LiveSlice) =>
    link?.live({
      peer: device.relayAddress,
      token: registration.token,
      environment: registration.environment,
      ticket: registration.ticket,
      slice: slice.sealed,
      active: slice.active,
      alert: slice.alert,
    }) ?? false;

  const leave = (target: LiveTarget | undefined) => {
    if (target !== undefined) sendLive(target, { sealed: null, active: false, alert: false });
  };

  const liveOf = (device: LinkedDevice) =>
    store.liveTargets().find((target) => target.device.id === device.id);

  const onLiveGone = ({ token }: { readonly token: string }) => {
    const gone = store.liveTargets().filter((target) => target.registration.token === token);

    if (gone.length === 0) return;
    runFork(
      Effect.forEach(gone, (target) => Effect.ignore(store.clearLive(target.device.id, token)), {
        discard: true,
      }).pipe(Effect.andThen(Effect.sync(liveChanged)))
    );
  };

  const refusePush = (message: string) => new PushRegistrationError({ reason: "failed", message });

  const validPushKey = (pushKey: string) =>
    Effect.tryPromise({
      try: () =>
        pushSuite.kem.deserializePublicKey(new Uint8Array(Buffer.from(pushKey, "base64url"))),
      catch: () => refusePush("The push key is not a P-256 public key"),
    });

  const keys = Effect.suspend(() =>
    cachedKeys === null
      ? loadHostRelayKeys.pipe(
          Effect.provideService(HostSecrets, secrets),
          Effect.tap((loaded) => Effect.sync(() => (cachedKeys = loaded))),
          Effect.mapError((error) =>
            failed(`the Host's relay keys are unavailable: ${error.message}`)
          )
        )
      : Effect.succeed(cachedKeys)
  );

  const peers = (): ReadonlyArray<RelayAddress> => [
    ...new Set([
      ...store.linked().map((device) => device.relayAddress),
      ...[...links.values()].flatMap((open) => (open.listed ? [open.address] : [])),
    ]),
  ];

  const log = (message: string) => runFork(Effect.logInfo(`relay route: ${message}`));

  /** Stores the device only while `open` is still the live link: a cancelled or expired one is inert. */
  const completeLink = (
    open: OpenLink,
    request: { name: string; address: RelayAddress },
    key: Uint8Array
  ) =>
    Effect.suspend(() =>
      links.get(open.id) === open
        ? store
            .add({ name: request.name, relayAddress: request.address, noiseKey: toBase64Url(key) })
            .pipe(
              Effect.flatMap((device) => Deferred.succeed(open.done, device)),
              Effect.tap(() => Effect.sync(devicesChanged))
            )
        : Effect.sync(() => void log("a link ended before its device could be stored"))
    ).pipe(
      (effect) => linkLock.withPermit(effect),
      Effect.tap(() => Effect.sync(() => link?.peersChanged())),
      Effect.catch((error) =>
        Effect.sync(() => log(`a link could not be stored: ${error.message}`))
      )
    );

  const admitLink = (open: OpenLink, deviceKey: Uint8Array, payload: Uint8Array): Admission => {
    const request = Option.getOrNull(decodeLinkRequest(new TextDecoder().decode(payload)));

    if (request === null || open.used) return null;
    const proof = Buffer.from(request.proof, "base64url");

    if (!sameProof(new Uint8Array(proof), linkProof(open.secret, deviceKey, request.address)))
      return null;

    open.used = true;

    return {
      kind: "link",
      complete: () => {
        open.listed = false;
        runFork(completeWith(completeLink(open, request, deviceKey)));
      },
    };
  };

  const admit = (source: RelayAddress, deviceKey: Uint8Array, payload: Uint8Array): Admission => {
    const open = [...links.values()].find((candidate) => candidate.address === source);

    if (open !== undefined) return admitLink(open, deviceKey, payload);
    const noiseKey = toBase64Url(deviceKey);

    // The key must be linked here, and from the relay address stored with it.
    const device = store
      .linked()
      .find((candidate) => candidate.noiseKey === noiseKey && candidate.relayAddress === source);

    return device === undefined ? null : { kind: "device", deviceId: device.id };
  };

  const serve = (session: DeviceSession, deviceId: string) => {
    const device = store.linked().find((candidate) => candidate.id === deviceId);

    if (device === undefined) {
      session.end();

      return;
    }

    connected.set(device.id, { session, since: new Date().toISOString() });
    runFork(
      Effect.ignore(store.touch(device.id)).pipe(
        Effect.tap(() => Effect.sync(devicesChanged)),
        Effect.andThen(connections.serve(session, device))
      )
    );
  };

  const ended = (session: DeviceSession) => {
    for (const [id, open] of connected)
      if (open.session === session) {
        connected.delete(id);
        devicesChanged();
      }
  };

  const start = Effect.gen(function* () {
    link?.stop();
    link = null;

    if (!setting.enabled || setting.url === null) return;
    const loaded = yield* keys;

    link = new RelayLink({
      url: setting.url,
      identity: loaded.identity,
      noise: loaded.noise,
      peers,
      admit,
      serve,
      ended,
      onConnectedChange: (connected) => {
        log(connected ? "connected" : "disconnected");

        // The relay keeps slices in memory only: each connect sends them again (ADR 0088).
        if (connected) liveChanged();
      },
      onLiveGone,
      log,
    });
  });

  const status = Effect.gen(function* () {
    const loaded = yield* keys;

    return new RelayRouteStatus({
      state: setting.enabled ? "on" : "off",
      url: setting.url,
      connected: link?.connected ?? false,
      hostAddress: loaded.address,
      hostNoiseKey: toBase64Url(loaded.noise.publicKey),
    });
  });

  const save = (next: typeof setting) =>
    Effect.try({
      try: () => writeSetting(options.root, next),
      catch: () => failed("the Relay route setting could not be saved"),
    }).pipe(Effect.tap(() => Effect.sync(() => (setting = next))));

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      link?.stop();
      link = null;
      links.forEach((open) => clearTimeout(open.timer));
    })
  );

  // The route stays off, and the keys unread, until the user turns it on.
  if (setting.enabled) yield* Effect.catch(start, (error) => Effect.sync(() => log(error.message)));

  const closeLink = (id: string) =>
    Effect.gen(function* () {
      const open = links.get(id);

      if (open === undefined) return;
      links.delete(id);
      clearTimeout(open.timer);
      yield* Deferred.fail(open.done, new NotFound({ what: "link", id }));
      link?.peersChanged();
    }).pipe((effect) => linkLock.withPermit(effect));

  return RelayRoute.of({
    status,
    enable: (url) =>
      isRelayUrl(url)
        ? save({ enabled: true, url }).pipe(Effect.andThen(start), Effect.andThen(status))
        : Effect.fail(
            new RelayRouteError({
              reason: "invalid-url",
              message: "The relay URL must be wss:// (ws:// only for a relay on this machine)",
            })
          ),
    disable: save({ enabled: false, url: setting.url }).pipe(
      Effect.andThen(start),
      Effect.andThen(status)
    ),
    startLink: Effect.gen(function* () {
      if (!setting.enabled || setting.url === null)
        return yield* new RelayRouteError({
          reason: "route-off",
          message: "Turn on the Relay route to link a device",
        });
      const loaded = yield* keys;
      // A new link replaces any still unused, so a reopened panel leaves one live secret.
      const unused = [...links.values()].filter((open) => !open.used);
      yield* Effect.forEach(unused, (open) => closeLink(open.id), { discard: true });
      const secret = new Uint8Array(randomBytes(32));
      const address = yield* Effect.promise(() => relayAddress(linkIdentity(secret).publicKey));
      const id = `link_${crypto.randomUUID()}`;
      const expiresAt = Date.now() + ttlMs;
      const done = yield* Deferred.make<LinkedDevice, NotFound>();
      const timer = setTimeout(() => runFork(closeLink(id)), ttlMs);
      links.set(id, { id, secret, address, expiresAt, done, used: false, listed: true, timer });
      link?.peersChanged();
      const expires = new Date(expiresAt).toISOString();

      return new LinkOffer({
        linkId: id,
        expiresAt: expires,
        linkString: encodeLinkString({
          hostId: options.hostInfo.hostId,
          hostName: options.hostInfo.hostname,
          relayUrl: setting.url,
          hostAddress: loaded.address,
          hostNoiseKey: toBase64Url(loaded.noise.publicKey),
          secret: toBase64Url(secret),
          expiresAt: expires,
        }),
      });
    }),
    awaitLink: (linkId) => {
      const open = links.get(linkId);

      return open === undefined
        ? Effect.fail(new NotFound({ what: "link", id: linkId }))
        : Deferred.await(open.done).pipe(Effect.onInterrupt(() => closeLink(linkId)));
    },
    cancelLink: closeLink,
    add: (device) =>
      store.add(device).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            link?.peersChanged();
            devicesChanged();
          })
        ),
        Effect.orDie
      ),
    list,
    // Sliding by one: a burst of changes reads the list once more, never once per change.
    watch: Stream.callback<void>(
      (queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listener = () => Queue.offerUnsafe(queue, undefined);

            deviceListeners.add(listener);
            listener();

            return listener;
          }),
          (listener) => Effect.sync(() => deviceListeners.delete(listener))
        ),
      { bufferSize: 1, strategy: "sliding" }
    ).pipe(Stream.mapEffect(() => list)),
    unlink: Effect.fn("RelayRoute.unlink")(function* (id: LinkedDeviceId) {
      const device = yield* Effect.orDie(store.unlink(id));

      if (device === null) return yield* new NotFound({ what: "linked device", id });
      link?.peersChanged();
      link?.drop(device.relayAddress);
      pushChanged();
      liveChanged();
      devicesChanged();

      return device;
    }, Effect.uninterruptible),
    unlinkSelf: Effect.fn("RelayRoute.unlinkSelf")(function* (id: LinkedDeviceId) {
      const device = yield* Effect.orDie(store.unlink(id));

      if (device === null) return yield* new NotFound({ what: "linked device", id });
      pushChanged();
      liveChanged();
      devicesChanged();
      // The key is refused from now; the open session closes after its answer is sent.
      runFork(
        Effect.delay(
          Effect.sync(() => {
            link?.peersChanged();
            link?.drop(device.relayAddress);
          }),
          SELF_UNLINK_DROP
        )
      );

      return device;
    }, Effect.uninterruptible),
    registerPush: Effect.fn("RelayRoute.registerPush")(function* (device, registration) {
      const loaded = yield* Effect.mapError(keys, (error) => refusePush(error.message));
      const { ticket, environment, token } = registration;

      const signed = yield* Effect.promise(() =>
        verifyPushTicket(ticket, device.relayAddress, loaded.address, environment, token)
      );

      if (!signed) return yield* refusePush("The push ticket doesn't sign this Host's address");
      yield* validPushKey(registration.pushKey);
      yield* Effect.mapError(store.setPush(device.id, registration), (error) =>
        refusePush(error.message)
      );
      pushChanged();
    }),
    unregisterPush: (device) =>
      store.clearPush(device.id).pipe(Effect.orDie, Effect.andThen(Effect.sync(pushChanged))),
    registerLiveActivity: Effect.fn("RelayRoute.registerLiveActivity")(
      function* (device, registration) {
        const loaded = yield* Effect.mapError(keys, (error) => refusePush(error.message));
        const { ticket, environment, token } = registration;

        const signed = yield* Effect.promise(() =>
          verifyLiveTicket(ticket, device.relayAddress, loaded.address, environment, token)
        );

        if (!signed) return yield* refusePush("The live ticket doesn't sign this Host's address");
        yield* validPushKey(registration.pushKey);
        const previous = liveOf(device);
        yield* Effect.mapError(store.setLive(device.id, registration), (error) =>
          refusePush(error.message)
        );

        if (previous?.registration.token !== token) leave(previous);
        liveChanged();
      }
    ),
    unregisterLiveActivity: (device) =>
      Effect.suspend(() => {
        const previous = liveOf(device);

        return store.clearLive(device.id).pipe(
          Effect.orDie,
          Effect.andThen(
            Effect.sync(() => {
              leave(previous);
              liveChanged();
            })
          )
        );
      }),
    liveTargets: store.liveTargets,
    watchLive: (listener) => {
      liveListeners.add(listener);

      return () => liveListeners.delete(listener);
    },
    sendLive,
    host: { hostId: options.hostInfo.hostId, hostName: options.hostInfo.hostname },
    pushTargets: store.pushTargets,
    watchPush: (listener) => {
      pushListeners.add(listener);

      return () => pushListeners.delete(listener);
    },
    wake: ({ device, registration }, message) =>
      Effect.gen(function* () {
        const current = link;

        if (current === null) return "unavailable" as const;
        const payload = yield* Effect.promise(() => sealPush(registration.pushKey, message));

        // The relay closes the Host's socket on an oversized wake, ending every session (RV3).
        if (payload.length > MAX_WAKE_PAYLOAD_CHARS) return "refused" as const;
        const { token, environment, ticket } = registration;

        const outcome = yield* Effect.promise(() =>
          current.wake({ peer: device.relayAddress, token, environment, ticket, payload })
        );

        // APNs no longer knows the token; a registration made since then stays (RV4).
        if (outcome === "unregistered")
          yield* store
            .clearPush(device.id, registration)
            .pipe(Effect.ignore, Effect.andThen(Effect.sync(pushChanged)));

        return outcome;
      }),
  });
});
