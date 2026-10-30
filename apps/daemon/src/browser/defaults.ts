import { Unsupported } from "@polaris/protocol";
import { Effect, Stream } from "effect";

const unsupported = (capability: "host-address" | "browser.host") =>
  new Unsupported({ capability });

/** Placeholders for the byte-stream RPCs until ENG-613 and ENG-616 layer real handlers over them. */
export const browserDefaults = {
  "byteStream.credit": () => Effect.fail(unsupported("host-address")),
  "hostAddress.open": () => Stream.fail(unsupported("host-address")),
  "browser.host": () => Stream.fail(unsupported("browser.host")),
  "browser.claim": () => Effect.fail(unsupported("browser.host")),
  "browser.release": () => Effect.void,
  "browser.acceptStream": () => Effect.fail(unsupported("browser.host")),
  "browser.closeStream": () => Effect.fail(unsupported("browser.host")),
};
