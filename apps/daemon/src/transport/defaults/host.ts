import {
  ConstellationFinding,
  ConstellationRejected,
  ConstellationRpcs,
  ConstellationTransferError,
  ConstellationTransferRpcs,
  ExtensionRpcs,
  HostStatsRpcs,
  LinkedDeviceRpcs,
  NotFound,
  PresenceLease,
  PresenceRpcs,
  PushRegistrationError,
  RemoteAccessRpcs,
  ResourceError,
  ResourceRpcs,
  RestartError,
  RestartRpcs,
  SecretRejected,
  SecretRpcs,
  VoiceError,
  VoiceRpcs,
  encodePairingString,
} from "@polaris/protocol";
import { Effect, Layer, Option, Stream } from "effect";
import { revokePairing } from "../../extensions/connection.ts";
import { Pairings } from "../../extensions/pairings.ts";
import { RemoteAccess } from "../../extensions/remoteAccess.ts";
import { deviceOf } from "../../linkedDevices/connection.ts";
import { RelayRoute } from "../../linkedDevices/route.ts";
import { HostPresence } from "../../presence/index.ts";
import { RemoteAccessControl } from "../../remoteAccess/service.ts";
import { type DefaultOptions, notYet, unsupportedFeed } from "./shared.ts";

const notADevice = () =>
  new PushRegistrationError({
    reason: "not-a-device",
    message: "Only a Linked Device registers for push, over the Relay route",
  });

const rejected = () =>
  new ConstellationRejected({
    findings: [
      new ConstellationFinding({
        code: "E-UNAVAILABLE",
        message: "Constellations are not available on this Daemon yet",
        fix: "Connect to a Daemon with the constellation capability",
      }),
    ],
    graph: null,
    revision: 0,
  });

const unavailable = () => Effect.fail(rejected());

const transferError = () =>
  new ConstellationTransferError({
    code: "E-UNAVAILABLE",
    message: "Constellation transfers are not mounted",
    retryable: true,
  });

const transfer = () => Effect.fail(transferError());

const transferFeed = () => Stream.fail(transferError());

const constellationDefaults = ConstellationRpcs.toLayer({
  "constellation.defaults.get": unavailable,
  "constellation.defaults.set": unavailable,
  "constellation.plan": unavailable,
  "constellation.dispatch": unavailable,
  "constellation.review": unavailable,
  "constellation.answer": unavailable,
  "constellation.message": unavailable,
  "constellation.status": unavailable,
  "constellation.stats": unavailable,
  "constellation.connection": unavailable,
  "constellation.set_state": unavailable,
  "constellation.worker.block": unavailable,
  "constellation.worker.claim": unavailable,
  "constellation.worker.ask": unavailable,
  "constellation.worker.progress": unavailable,
  "constellation.worker.propose": unavailable,
  "constellation.worker.message": unavailable,
  "constellation.worker.start": unavailable,
  "constellation.subscribe": () => Stream.fail(rejected()),
});

const transferDefaults = ConstellationTransferRpcs.toLayer({
  "constellation.placements.watch": transferFeed,
  "constellation.placement.resolve": transfer,
  "constellation.repository.prepare": transfer,
  "constellation.worker.prepare": transfer,
  "constellation.delivery.watch": transferFeed,
  "constellation.delivery.apply": transfer,
  "constellation.delivery.ack": transfer,
  "constellation.base.export": transfer,
  "constellation.base.import": transfer,
  "constellation.worktree.prepare": transfer,
  "constellation.bundle.export": transfer,
  "constellation.bundle.import": transfer,
  "constellation.assignment.set": transfer,
  "constellation.assignment.list": transfer,
  "constellation.outbox.watch": transferFeed,
  "constellation.outbox.apply": transfer,
  "constellation.outbox.ack": transfer,
  "constellation.claim.export": transfer,
  "constellation.origin.import": transfer,
});

const resourcesUnavailable = () =>
  Effect.fail(new ResourceError({ message: "Host resources are unavailable" }));

const resourceDefaults = ResourceRpcs.toLayer({
  "host.resources.get": resourcesUnavailable,
  "host.resources.declare": resourcesUnavailable,
  "host.resources.remove": resourcesUnavailable,
  "host.resources.release": resourcesUnavailable,
  "host.workers.setCap": resourcesUnavailable,
  "host.resources.acquire": resourcesUnavailable,
});

// Token-less Clients only (grants.ts): the gate refuses these to Extensions.
const extensionDefaults = (options: DefaultOptions) =>
  ExtensionRpcs.toLayer({
    "extensions.pair": ({ name, grant }) =>
      Effect.gen(function* () {
        const { pairing, token } = yield* Effect.orDie((yield* Pairings).pair(name, grant));
        const url = yield* (yield* RemoteAccess).url;

        const pairingString = encodePairingString({
          hostId: options.hostInfo.hostId,
          hostName: options.hostInfo.hostname,
          url: Option.getOrNull(url),
          token,
          name: pairing.name,
        });

        return { pairing, token, pairingString };
      }),
    "extensions.list": () => Effect.flatMap(Pairings, (pairings) => Effect.orDie(pairings.list)),
    "extensions.revoke": ({ id }) => revokePairing(id),
  });

// Token-less Clients only, like the Pairings: Tailscale's own state, read back each time.
const remoteAccessDefaults = RemoteAccessRpcs.toLayer({
  "remoteAccess.status": () => Effect.flatMap(RemoteAccessControl, (control) => control.status),
  "remoteAccess.enable": () => Effect.flatMap(RemoteAccessControl, (control) => control.enable),
  "remoteAccess.disable": () => Effect.flatMap(RemoteAccessControl, (control) => control.disable),
});

const restartDefaults = RestartRpcs.toLayer({
  "host.restartPreview": () => Effect.fail(new RestartError({ message: notYet("Restart") })),
  "host.prepareRestart": () => Effect.fail(new RestartError({ message: notYet("Restart") })),
});

// Token-less Clients only: the Relay route and Linked Devices (ADR 0083).
const linkedDeviceDefaults = LinkedDeviceRpcs.toLayer({
  "relayRoute.status": () => Effect.flatMap(RelayRoute, (route) => route.status),
  "relayRoute.enable": ({ url }) => Effect.flatMap(RelayRoute, (route) => route.enable(url)),
  "relayRoute.disable": () => Effect.flatMap(RelayRoute, (route) => route.disable),
  "devices.link": () => Effect.flatMap(RelayRoute, (route) => route.startLink),
  "devices.awaitLink": ({ linkId }) =>
    Effect.flatMap(RelayRoute, (route) => route.awaitLink(linkId)),
  "devices.cancelLink": ({ linkId }) =>
    Effect.flatMap(RelayRoute, (route) => route.cancelLink(linkId)),
  "devices.add": (device) => Effect.flatMap(RelayRoute, (route) => route.add(device)),
  "devices.list": () => Effect.flatMap(RelayRoute, (route) => route.list),
  "devices.watch": () => Stream.unwrap(Effect.map(RelayRoute, (route) => route.watch)),
  "devices.unlink": ({ id }) => Effect.flatMap(RelayRoute, (route) => route.unlink(id)),
  "devices.unlinkSelf": (_, { client }) => {
    const device = deviceOf(client);

    return device === null
      ? Effect.fail(new NotFound({ what: "linked device", id: "this connection" }))
      : Effect.flatMap(RelayRoute, (route) => route.unlinkSelf(device.id));
  },
  // A Linked Device's own connection only: the device registers itself (ADR 0083).
  "devices.registerPush": (registration, { client }) => {
    const device = deviceOf(client);

    return device === null
      ? Effect.fail(notADevice())
      : Effect.flatMap(RelayRoute, (route) => route.registerPush(device, registration));
  },
  "devices.unregisterPush": (_, { client }) => {
    const device = deviceOf(client);

    return device === null
      ? Effect.fail(notADevice())
      : Effect.flatMap(RelayRoute, (route) => route.unregisterPush(device));
  },
  "devices.registerLiveActivity": (registration, { client }) => {
    const device = deviceOf(client);

    return device === null
      ? Effect.fail(notADevice())
      : Effect.flatMap(RelayRoute, (route) => route.registerLiveActivity(device, registration));
  },
  "devices.unregisterLiveActivity": (_, { client }) => {
    const device = deviceOf(client);

    return device === null
      ? Effect.fail(notADevice())
      : Effect.flatMap(RelayRoute, (route) => route.unregisterLiveActivity(device));
  },
});

// The Desktop App's connections only (DEVICE_RPCS, RPC_GRANTS): a lease per connection.
const presenceDefaults = PresenceRpcs.toLayer({
  "presence.report": ({ presence }, { client }) =>
    Effect.map(
      HostPresence,
      (host) => new PresenceLease({ leaseMs: host.report(client.id, presence) })
    ),
});

const voiceUnavailable = () =>
  new VoiceError({ reason: "provider-failed", message: notYet("Voice") });

const voiceDefaults = VoiceRpcs.toLayer({
  "voice.transcribe": () => Stream.fail(voiceUnavailable()),
  "voice.settings": () => Effect.fail(voiceUnavailable()),
  "voice.setKey": () => Effect.fail(voiceUnavailable()),
});

const secretDefaults = SecretRpcs.toLayer({
  "secret.provide": () =>
    Effect.fail(new SecretRejected({ reason: "storage", message: notYet("Secret Requests") })),
});

/** Constellations, Host resources, Pairings, remote access, Linked Devices, presence, voice, secrets. */
export const hostDefaults = (options: DefaultOptions) =>
  Layer.mergeAll(
    constellationDefaults,
    transferDefaults,
    resourceDefaults,
    extensionDefaults(options),
    remoteAccessDefaults,
    restartDefaults,
    linkedDeviceDefaults,
    presenceDefaults,
    HostStatsRpcs.toLayer({ "host.stats.watch": unsupportedFeed("host.stats") }),
    voiceDefaults,
    secretDefaults
  );
