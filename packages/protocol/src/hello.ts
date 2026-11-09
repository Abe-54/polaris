/**
 * `hello`: the first RPC on every connection. It names the Client, negotiates
 * capabilities, and optionally presents a language proof, an Extension token
 * and the protocol versions the Extension speaks.
 */
import { Schema } from "effect";
import { Rpc } from "effect/rpc";
import { CapabilityList } from "./capabilities.ts";
import { HostInfo } from "./domain.ts";
import { ExtensionTokenRejected } from "./extensions.ts";
import { HostId } from "./ids.ts";

export const LanguageConnectionIdentity = Schema.Struct({
  hostId: HostId,
  clientId: Schema.String,
});

export type LanguageConnectionIdentity = typeof LanguageConnectionIdentity.Type;

export class LanguageIdentityError extends Schema.TaggedError<LanguageIdentityError>()(
  "LanguageIdentityError",
  { message: Schema.Literal("Language identity unavailable") }
) {}

/** The protocol versions an Extension's SDK speaks, oldest to newest, both inclusive. */
export const ProtocolRange = Schema.Struct({ min: Schema.Int, max: Schema.Int });

export type ProtocolRange = typeof ProtocolRange.Type;

/**
 * The Daemon's protocol version is outside the range the Extension declared in
 * `hello`, or the Extension declared none where one is required (ADR 0075).
 * `update` names the side that is behind; `message` says so in words.
 */
export class ProtocolMismatch extends Schema.TaggedError<ProtocolMismatch>()("ProtocolMismatch", {
  daemon: Schema.Int,
  extension: Schema.NullOr(ProtocolRange),
  update: Schema.Literals(["polaris", "extension"]),
}) {
  override get message(): string {
    if (this.extension === null)
      return "The Extension did not say which protocol versions it speaks. Update the Extension.";

    return this.update === "polaris"
      ? `This Polaris speaks protocol ${this.daemon}; the Extension needs ${this.extension.min} or newer. Update Polaris.`
      : `This Polaris speaks protocol ${this.daemon}; the Extension speaks up to ${this.extension.max}. Update the Extension.`;
  }
}

/**
 * Whether `hello` is refused for its protocol range: the Daemon's version must
 * fall inside it. `required` is true on the gateway, where every Extension
 * must declare one; a token-less Client on the socket never sends it.
 */
export const decideProtocol = (
  daemon: number,
  extension: ProtocolRange | undefined,
  required: boolean
): ProtocolMismatch | null => {
  if (extension === undefined)
    return required ? new ProtocolMismatch({ daemon, extension: null, update: "extension" }) : null;

  if (daemon < extension.min) return new ProtocolMismatch({ daemon, extension, update: "polaris" });

  if (daemon > extension.max)
    return new ProtocolMismatch({ daemon, extension, update: "extension" });

  return null;
};

export const Hello = Rpc.make("hello", {
  payload: {
    clientName: Schema.String,
    clientVersion: Schema.String,
    /** Label shown to other Clients, e.g. when this device resolves an approval. */
    deviceLabel: Schema.String,
    capabilities: CapabilityList,
    /** Private bearer proof; malformed values stay redacted until safe handler validation. */
    languageProof: Schema.optionalKey(Schema.RedactedFromValue(Schema.Unknown)),
    /**
     * A Pairing's token (`pol_ext_…`): the connection is then scoped to that Pairing's Grant
     * and acts as the Extension (ADR 0078). Without it the Client keeps full power.
     */
    extensionToken: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
    /**
     * The protocol versions the Extension speaks (ADR 0075). The gateway requires it and
     * refuses a mismatch with `ProtocolMismatch`; a token-less Client omits it.
     */
    protocolVersions: Schema.optionalKey(ProtocolRange),
    /**
     * The Desktop App's user key (ADR 0100): an enrolled key gives the connection user access,
     * which approvals and the other user-only RPCs need (`userAccess.ts`). Never in an agent's env.
     */
    userKey: Schema.optionalKey(Schema.RedactedFromValue(Schema.Unknown)),
  },
  success: Schema.Struct({
    host: HostInfo,
    protocolVersion: Schema.Int,
    capabilities: CapabilityList,
    languageIdentity: Schema.optionalKey(LanguageConnectionIdentity),
    /** Whether this connection holds user access; absent from a Daemon before ENG-700. */
    userAccess: Schema.optionalKey(Schema.Boolean),
  }),
  error: Schema.Union([LanguageIdentityError, ExtensionTokenRejected, ProtocolMismatch]),
});
