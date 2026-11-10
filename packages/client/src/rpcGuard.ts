/**
 * The capability guard on a live connection's RPC client (ENG-326): an RPC whose capability
 * the Daemon didn't announce in `hello` fails here and is never sent, since an older Daemon
 * answers an unknown request tag with a connection-level Defect and the Client would reconnect.
 */
import { type Capability, DaemonRpcs, missingRpcCapability, Unsupported } from "@polaris/protocol";
import { Effect, Predicate, Stream } from "effect";
import { RpcSchema } from "effect/rpc";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import type { DaemonClient } from "./rpc.ts";

const refusal = (capability: Capability) =>
  new RpcClientError({
    reason: new RpcClientDefect({
      message: `the Daemon doesn't announce ${capability}`,
      cause: new Unsupported({ capability }),
    }),
  });

/** True when a call failed at the guard, not on the wire: the Daemon lacks its capability. */
export const isCapabilityRefusal = (error: RpcClientError): boolean =>
  Predicate.isTagged(error.reason, "RpcClientDefect") &&
  Predicate.isTagged(error.reason.cause, "Unsupported");

/** `client` with every RPC the Daemon's `announced` capabilities don't cover failing locally. */
export const guardClient = (
  client: DaemonClient,
  announced: ReadonlyArray<Capability>
): DaemonClient => {
  const refused = Object.fromEntries(
    [...DaemonRpcs.requests.values()].flatMap((rpc) => {
      const missing = missingRpcCapability(rpc._tag, announced);

      if (missing === null) return [];

      const fail = RpcSchema.isStreamSchema(rpc.successSchema)
        ? () => Stream.fail(refusal(missing))
        : () => Effect.fail(refusal(missing));

      return [[rpc._tag, fail]];
    })
  );

  return { ...client, ...refused };
};
