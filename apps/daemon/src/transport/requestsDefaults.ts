import { RequestsRpcs, Unsupported } from "@polaris/protocol";
import { Effect, Stream } from "effect";

const request = () => Effect.fail(new Unsupported({ capability: "requests" }));

const feed = () => Stream.fail(new Unsupported({ capability: "requests" }));

/** The tags these stubs serve, which `defaultHandlers` leaves to this layer. */
export const REQUESTS_DEFAULT_TAGS = [
  "requests.watch",
  "requests.save",
  "requests.send",
  "requests.variables",
  "requests.sendLog.page",
  "requests.sendLog.watch",
  "requests.send.get",
  "requests.curl.parse",
  "requests.curl.format",
] as const;

/** Fallbacks for a server without `lazyRequestHandlers` (tests); `polaris serve` mounts the real ones. */
export const requestsDefaults = RequestsRpcs.toLayer({
  "requests.watch": feed,
  "requests.save": request,
  "requests.send": request,
  "requests.variables": request,
  "requests.sendLog.page": request,
  "requests.sendLog.watch": feed,
  "requests.send.get": request,
  "requests.curl.parse": request,
  "requests.curl.format": request,
});
