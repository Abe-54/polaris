/**
 * The Simulator stream's bridge (ENG-829): main carries the hub's bytes, on the Host's loopback,
 * to the renderer (whose CSP keeps it off loopback). Only the stream and input routes are
 * reachable; main builds every path itself, so nothing else on the hub is.
 */
import { HostAddressPort, SimulatorId, SimulatorPlatform } from "@polaris/protocol";
import { Schema } from "effect";

const HostKey = Schema.String.check(Schema.isMinLength(1));

/** What `simulator.attach` gave: the hub's port on the Host's loopback and its token. */
const Hub = {
  hostKey: HostKey,
  port: HostAddressPort,
  token: Schema.String.check(Schema.isMinLength(1)),
  id: SimulatorId,
};

/** `avcc` on any Host; `mjpeg` only on a local one (60 times the bandwidth). iOS only. */
export const SimulatorVideoFormat = Schema.Literals(["avcc", "mjpeg"]);

export type SimulatorVideoFormat = typeof SimulatorVideoFormat.Type;

/** One message on the input socket, either way: binary for iOS, text JSON for Android. */
export type SimulatorSocketMessage =
  | { readonly kind: "binary"; readonly data: Uint8Array }
  | { readonly kind: "text"; readonly text: string };

export type SimulatorSocketItem =
  | { readonly kind: "open"; readonly socketId: string }
  | SimulatorSocketMessage
  | { readonly kind: "close"; readonly code: number; readonly reason: string };

export const SimulatorSubscriptionInputs = {
  /** The body of `stream.avcc` or `stream.mjpeg`, as it arrives. */
  "simulator.video": Schema.Struct({ ...Hub, format: SimulatorVideoFormat }),
  /** The input socket: `open` first, then the hub's messages, `close` last. */
  "simulator.socket": Schema.Struct({ ...Hub, platform: SimulatorPlatform }),
};

export interface SimulatorSubscriptionItems {
  "simulator.video": Uint8Array;
  "simulator.socket": SimulatorSocketItem;
}

export const SimulatorRequestInputs = {
  /** Sends on an open `simulator.socket`; a closed one fails with `Closed`. */
  "simulator.send": Schema.Struct({
    socketId: Schema.String,
    message: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("binary"), data: Schema.Uint8Array }),
      Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
    ]),
  }),
};

export interface SimulatorRequestOutputs {
  "simulator.send": null;
}
