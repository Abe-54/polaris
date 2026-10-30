/**
 * Linked Devices and the Relay route (CONTEXT.md: Linked Device, Remote Access;
 * ADR 0080, 0082). The Daemon dials out to the Polaris Relay when the route is on;
 * a Linked Device reaches it there with Client power once its Noise key is found here.
 * The link string is what the Desktop App shows as a QR code; the device decodes it here.
 */
import { Option, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { NotFound } from "./errors.ts";
import { HostId, LinkedDeviceId, Timestamp } from "./ids.ts";
import { packEnvelope, unpackEnvelope } from "./linkBody.ts";
import { LiveActivityRegistration } from "./relay/live.ts";
import { PushRegistration } from "./relay/push.ts";
import { RelayAddress } from "./relay/wire.ts";

/** A key or secret as base64url without padding. */
const Key = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));

export class LinkedDevice extends Schema.Class<LinkedDevice>("LinkedDevice")({
  id: LinkedDeviceId,
  /** What the device called itself when it linked, e.g. "Lucas's iPhone". */
  name: Schema.String,
  /** The device's relay address; the Host lists it with the relay while it is linked. */
  relayAddress: RelayAddress,
  /** The device's X25519 Noise static public key, base64url. */
  noiseKey: Key,
  createdAt: Timestamp,
  /** When it last opened a session with this Host; null until it did. */
  lastUsedAt: Schema.NullOr(Timestamp),
  /** Set once unlinked: its key no longer opens a session. */
  unlinkedAt: Schema.NullOr(Timestamp),
  /**
   * When its open relay session with this Host began; null while it has none. Set by
   * `devices.list` and `devices.watch`; absent from Daemons without `linked-devices.presence`.
   */
  connectedSince: Schema.optionalKey(Schema.NullOr(Timestamp)),
}) {}

export class RelayRouteStatus extends Schema.Class<RelayRouteStatus>("RelayRouteStatus")({
  /** Whether the user turned the Relay route on for this Host. Off by default. */
  state: Schema.Literals(["on", "off"]),
  /** The relay the Daemon dials, `wss://<relay>/v1`; null until one was set. */
  url: Schema.NullOr(Schema.String),
  /** On, and the relay accepted the Daemon's key proof on the current socket. */
  connected: Schema.Boolean,
  /** This Host's relay address, which the link string carries to the device. */
  hostAddress: RelayAddress,
  /** This Host's Noise static public key, base64url. */
  hostNoiseKey: Key,
}) {}

export class RelayRouteError extends Schema.TaggedError<RelayRouteError>()("RelayRouteError", {
  /** `invalid-url`: not a ws:// or wss:// URL. `route-off`: linking needs the route on. */
  reason: Schema.Literals(["invalid-url", "route-off", "failed"]),
  message: Schema.String,
}) {}

/** Fails only when the Host's relay keys can't be read or made (`failed`). */
export const GetRelayRoute = Rpc.make("relayRoute.status", {
  success: RelayRouteStatus,
  error: RelayRouteError,
});

/** Turns the route on with `url`; on again replaces the URL and reconnects. */
export const EnableRelayRoute = Rpc.make("relayRoute.enable", {
  payload: { url: Schema.String },
  success: RelayRouteStatus,
  error: RelayRouteError,
});

/** Closes the relay socket and every Linked Device's session on it; off again is fine. */
export const DisableRelayRoute = Rpc.make("relayRoute.disable", {
  success: RelayRouteStatus,
  error: RelayRouteError,
});

export class LinkOffer extends Schema.Class<LinkOffer>("LinkOffer")({
  linkId: Schema.String,
  /** `polaris-link:v1:…`: the QR code's content. Holds a one-time secret; never log it. */
  linkString: Schema.String,
  expiresAt: Timestamp,
}) {}

/** A one-time link for one device, valid for a few minutes. Needs the Relay route on. */
export const StartLink = Rpc.make("devices.link", {
  success: LinkOffer,
  error: RelayRouteError,
});

/** The device that used the link, once it did; NotFound when it expired or was never made. */
export const AwaitLink = Rpc.make("devices.awaitLink", {
  payload: { linkId: Schema.String },
  success: LinkedDevice,
  error: NotFound,
});

/** Ends a link before it's used: its secret no longer opens it (RX1-2). Unknown ids are fine. */
export const CancelLink = Rpc.make("devices.cancelLink", {
  payload: { linkId: Schema.String },
});

/** Links a device another Host already linked: the Desktop App shares it to every Host. */
export const AddLinkedDevice = Rpc.make("devices.add", {
  payload: { name: Schema.String, relayAddress: RelayAddress, noiseKey: Key },
  success: LinkedDevice,
});

export const ListLinkedDevices = Rpc.make("devices.list", {
  success: Schema.Array(LinkedDevice),
});

/**
 * The linked devices now, then again whenever one links, unlinks, or opens or closes its relay
 * session (capability `linked-devices.presence`, ENG-629).
 */
export const WatchLinkedDevices = Rpc.make("devices.watch", {
  success: Schema.Array(LinkedDevice),
  stream: true,
});

/** Unlinks a device and closes its sessions at once; unlinking twice is fine. */
export const UnlinkDevice = Rpc.make("devices.unlink", {
  payload: { id: LinkedDeviceId },
  success: LinkedDevice,
  error: NotFound,
});

/**
 * The calling Linked Device unlinks itself (Unlink on the phone, RX1-3): its key stops
 * working here. NotFound on a connection that isn't a Linked Device's.
 */
export const UnlinkSelf = Rpc.make("devices.unlinkSelf", {
  success: LinkedDevice,
  error: NotFound,
});

export class PushRegistrationError extends Schema.TaggedError<PushRegistrationError>()(
  "PushRegistrationError",
  {
    /** `not-a-device`: only a Linked Device's own connection registers for push. */
    reason: Schema.Literals(["not-a-device", "failed"]),
    message: Schema.String,
  }
) {}

/**
 * The calling Linked Device's APNs token, environment and push key; a new registration
 * replaces the last. Needs Needs You and finished-Turn pushes sealed to `pushKey`.
 */
export const RegisterPush = Rpc.make("devices.registerPush", {
  payload: PushRegistration,
  error: PushRegistrationError,
});

/** Stops pushes to the calling Linked Device; unlinking a device also drops its registration. */
export const UnregisterPush = Rpc.make("devices.unregisterPush", {
  error: PushRegistrationError,
});

/**
 * The calling Linked Device's Live Activity (ADR 0088): its update token, environment, push
 * key and this Host's ticket. A new registration replaces the last; the Host sends its slice.
 */
export const RegisterLiveActivity = Rpc.make("devices.registerLiveActivity", {
  payload: LiveActivityRegistration,
  error: PushRegistrationError,
});

/** Stops this Host's slices to the calling device's activity, and drops its slice at the relay. */
export const UnregisterLiveActivity = Rpc.make("devices.unregisterLiveActivity", {
  error: PushRegistrationError,
});

export class LinkedDeviceRpcs extends RpcGroup.make(
  GetRelayRoute,
  EnableRelayRoute,
  DisableRelayRoute,
  StartLink,
  AwaitLink,
  CancelLink,
  AddLinkedDevice,
  ListLinkedDevices,
  UnlinkDevice,
  UnlinkSelf,
  RegisterPush,
  UnregisterPush,
  RegisterLiveActivity,
  UnregisterLiveActivity,
  WatchLinkedDevices
) {}

export const LINK_STRING_PREFIX = "polaris-link:v1:";

/** v2 adds the other Hosts the Desktop App shares the device to; the phone links once (Q16). */
export const LINK_STRING_V2_PREFIX = "polaris-link:v2:";

export const LinkPayload = Schema.Struct({
  hostId: HostId,
  hostName: Schema.String,
  /** The relay to dial, `wss://<relay>/v1`. */
  relayUrl: Schema.String,
  hostAddress: RelayAddress,
  hostNoiseKey: Key,
  /** 32 random bytes, base64url: the device derives its link identity and proof from it. */
  secret: Key,
  expiresAt: Timestamp,
});

export type LinkPayload = typeof LinkPayload.Type;

/** Another Host the device is shared to once it linked: public facts only, no secret. */
export const SharedHost = Schema.Struct({
  hostId: HostId,
  hostName: Schema.String,
  relayUrl: Schema.String,
  hostAddress: RelayAddress,
  hostNoiseKey: Key,
});

export type SharedHost = typeof SharedHost.Type;

/**
 * What a link string carries: the link for the Host the device links through, and the
 * other Hosts it may dial once that Host's `devices.awaitLink` returned (never the link's).
 */
export const LinkEnvelope = Schema.Struct({
  link: LinkPayload,
  hosts: Schema.Array(SharedHost),
});

export type LinkEnvelope = typeof LinkEnvelope.Type;

const Body = Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(LinkPayload)));

const encodeBody = Schema.encodeSync(Body);

const decodeBody = Schema.decodeUnknownOption(Body);

const decodeEnvelope = Schema.decodeUnknownOption(LinkEnvelope);

/** A v1 string: one Host. The Daemon makes these; the Desktop App wraps them in v2. */
export const encodeLinkString = (payload: LinkPayload): string =>
  `${LINK_STRING_PREFIX}${encodeBody(payload)}`;

/** Packed (`linkBody.ts`): about 900 characters for six Hosts, against 1,900 as JSON. */
export const encodeLinkEnvelope = (envelope: LinkEnvelope): string =>
  `${LINK_STRING_V2_PREFIX}${packEnvelope(envelope)}`;

/**
 * The envelope, or none when the text is not a link string; a v1 string decodes with no
 * other Hosts. Surrounding whitespace is ignored.
 */
export const decodeLinkString = (text: string): Option.Option<LinkEnvelope> => {
  const trimmed = text.trim();

  if (trimmed.startsWith(LINK_STRING_V2_PREFIX))
    return Option.flatMap(
      unpackEnvelope(trimmed.slice(LINK_STRING_V2_PREFIX.length)),
      decodeEnvelope
    );

  return trimmed.startsWith(LINK_STRING_PREFIX)
    ? Option.map(decodeBody(trimmed.slice(LINK_STRING_PREFIX.length)), (link) => ({
        link,
        hosts: [],
      }))
    : Option.none();
};

/**
 * What a linking device sends inside its Noise handshake init (encrypted to the Host):
 * its own relay address and name, and a proof that it holds the link's secret.
 */
export const LinkRequest = Schema.Struct({
  v: Schema.Literal(1),
  address: RelayAddress,
  name: Schema.String.check(Schema.isMaxLength(100)),
  /** `linkProof(secret, deviceNoiseKey, address)`, base64url. */
  proof: Key,
});

export type LinkRequest = typeof LinkRequest.Type;

export const encodeLinkRequest = Schema.encodeSync(Schema.fromJsonString(LinkRequest));

export const decodeLinkRequest = Schema.decodeUnknownOption(Schema.fromJsonString(LinkRequest));
