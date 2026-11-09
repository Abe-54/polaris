/**
 * Push notifications to a Linked Device (apps/relay/README.md: Push). The Daemon seals a
 * `PushMessage` to the device's push key with HPKE (RFC 9180, base mode) and sends it in a
 * `wake`; the relay and the push service carry it opaquely; the app's Notification Service
 * Extension opens it. Schemas and constants only: sealing lives in the Daemon, opening in Swift.
 */
import { Option, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { ApnsToken, MAX_WAKE_PAYLOAD_CHARS, PushEnvironment, PushTicket } from "./wire.ts";

/** HPKE suite: DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM (CryptoKit's `P256_SHA256_AES_GCM_256`). */
export const PUSH_HPKE_SUITE = { kem: 0x0010, kdf: 0x0001, aead: 0x0002 } as const;

/** HPKE `info`, binding a sealed payload to this use and version. */
export const PUSH_HPKE_INFO = "polaris-push/1";

/** A P-256 public key, uncompressed (65 bytes), base64url without padding. */
export const PushKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{87}$/));

/** The sealed payload is base64url of `enc` (65 bytes) ‖ ciphertext; its AAD is empty. */
export const PUSH_ENC_BYTES = 65;

/** How the app offers a notification: Approve / Always here / Deny, an answer, or none. */
export const PushCategory = Schema.Literals(["approval", "approval-once", "question"]);

export type PushCategory = typeof PushCategory.Type;

/** The plaintext inside a sealed push: what the notification shows and what its buttons answer. */
export const PushMessage = Schema.Struct({
  v: Schema.Literal(1),
  /** `notify`: an agent's `notify`, or Polaris's when a Constellation needs the user. */
  kind: Schema.Literals(["needs-you", "turn-ended", "notify"]),
  hostId: Schema.String,
  hostName: Schema.String,
  sessionId: Schema.String,
  /** The pending approval or question a Needs You push answers; null for a finished Turn. */
  requestId: Schema.NullOr(Schema.String),
  category: Schema.NullOr(PushCategory),
  title: Schema.String.check(Schema.isMaxLength(120)),
  subtitle: Schema.String.check(Schema.isMaxLength(160)),
  body: Schema.String.check(Schema.isMaxLength(600)),
  /** When the Host decided to send it (ISO 8601). */
  at: Schema.String,
  /** The Constellation a `notify` is about, so a tap opens it; null or absent otherwise. */
  constellationId: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export type PushMessage = typeof PushMessage.Type;

export const encodePushMessage = Schema.encodeSync(Schema.fromJsonString(PushMessage));

export const decodePushMessage = Schema.decodeUnknownOption(Schema.fromJsonString(PushMessage));

/** What a device registers with each Host it links, over its end-to-end session. */
export const PushRegistration = Schema.Struct({
  token: ApnsToken,
  environment: PushEnvironment,
  pushKey: PushKey,
  /** Signed for this Host's relay address; the Host sends it with every wake. */
  ticket: PushTicket,
  /** This device's setting for automatic notifications (Constellations); absent means on. */
  automatic: Schema.optionalKey(Schema.Boolean),
  /** This device's switch for this Host: false and it sends no pushes at all; absent means on. */
  notifications: Schema.optionalKey(Schema.Boolean),
});

export type PushRegistration = typeof PushRegistration.Type;

/** The push service's route, which the relay signs requests to. */
export const PUSH_SERVICE_PATH = "/api/push";

/** How far a signed request's timestamp may be from the service's clock. */
export const PUSH_CLOCK_SKEW_S = 60;

/** Headers of a signed relay → push service request. */
export const PushHeaders = {
  timestamp: "x-polaris-timestamp",
  nonce: "x-polaris-nonce",
  signature: "x-polaris-signature",
} as const;

/** What the relay asks the push service to deliver. No relay address, no content. */
export const PushRequest = Schema.Struct({
  token: ApnsToken,
  environment: PushEnvironment,
  payload: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9_-]+$/),
    Schema.isMaxLength(MAX_WAKE_PAYLOAD_CHARS)
  ),
});

export type PushRequest = typeof PushRequest.Type;

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export interface SignedRequestParts {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly body: string;
}

/** The bytes the relay signs: method, path, timestamp, nonce and the body's SHA-256. */
export const pushSigningInput = async (
  parts: SignedRequestParts
): Promise<Uint8Array<ArrayBuffer>> => {
  const bodyHash = hex(await crypto.subtle.digest("SHA-256", encoder.encode(parts.body)));

  return encoder.encode(
    ["polaris-push/1", parts.method, parts.path, parts.timestamp, parts.nonce, bodyHash].join("\n")
  );
};

const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

/** HMAC-SHA256 of the signing input under the shared secret, base64url. */
export const signPushRequest = async (
  secret: string,
  parts: SignedRequestParts
): Promise<string> => {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    await pushSigningInput(parts)
  );

  return Base64Url.encode(new Uint8Array(mac));
};

/** Whether `signature` is the request's HMAC; WebCrypto's verify compares in constant time. */
export const verifyPushRequest = async (
  secret: string,
  parts: SignedRequestParts,
  signature: string
): Promise<boolean> => {
  const mac = Option.getOrNull(Option.getSuccess(Base64Url.decode(signature)));

  if (mac === null || mac.byteLength !== 32) return false;

  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    new Uint8Array(mac),
    await pushSigningInput(parts)
  );
};
