/**
 * The Daemon's side of `hostAddress.open` (ENG-613, ADR 0093): a socket to its own loopback
 * per Host-address stream. The handler bridges it to the stream's blobs and credits.
 */
import { type ByteTransport, HostAddressError, loopbackAddressesOf } from "@polaris/protocol";
import { Context, Effect, Layer, Result, type Scope } from "effect";
import { connectTcp, type LoopbackConnectError } from "../transport/bunSocket.ts";

/** Where a Host-address stream goes: `hostname` as the Client sent it, unresolved. */
export interface HostAddressTarget {
  readonly hostname: string;
  readonly port: number;
}

/** Opens the socket once the target is known to be loopback; `connectTcp` in life, a fake in tests. */
export type LoopbackConnector = (
  address: string,
  port: number
) => Effect.Effect<ByteTransport, LoopbackConnectError, Scope.Scope>;

const hostAddressError = (
  target: HostAddressTarget,
  reason: HostAddressError["reason"],
  message: string
) => new HostAddressError({ hostname: target.hostname, port: target.port, reason, message });

export class HostAddressStreams extends Context.Service<
  HostAddressStreams,
  {
    /**
     * Connects to `target` on the Host's loopback, closed with the scope. Fails with
     * `not-host-address` before connecting when `hostname` is not a Host address.
     */
    readonly connect: (
      target: HostAddressTarget
    ) => Effect.Effect<ByteTransport, HostAddressError, Scope.Scope>;
  }
>()("polaris/daemon/browser/HostAddressStreams") {
  /**
   * The hostname decides the loopback addresses (`loopbackAddressesOf`); the socket goes to
   * those literals and nowhere else, so no name is ever resolved. A name tries IPv4 first and
   * falls through to IPv6 when nothing listens there; a literal tries itself alone.
   */
  static make(connector: LoopbackConnector = connectTcp): HostAddressStreams["Service"] {
    return HostAddressStreams.of({
      connect: Effect.fn("HostAddressStreams.connect")(function* (target: HostAddressTarget) {
        const addresses = loopbackAddressesOf(target.hostname);

        if (addresses === null)
          return yield* hostAddressError(
            target,
            "not-host-address",
            `${target.hostname} is not a Host address: only localhost, *.localhost and loopback IPs are`
          );

        let failure: HostAddressError | null = null;

        for (const address of addresses) {
          const attempt = yield* connector(address, target.port).pipe(
            Effect.mapError((error) =>
              hostAddressError(
                target,
                error.kind,
                `${target.hostname}:${target.port} (${address}): ${error.message}`
              )
            ),
            Effect.result
          );

          if (Result.isSuccess(attempt)) return attempt.success;
          failure = attempt.failure;

          if (failure.reason !== "refused") break;
        }

        return yield* failure!;
      }),
    });
  }

  static readonly layer = Layer.sync(HostAddressStreams)(() => HostAddressStreams.make());

  /** Placeholder for Daemons that mount no byte-stream handlers: every connect dies. */
  static readonly layerStub = Layer.succeed(HostAddressStreams)(
    HostAddressStreams.of({
      connect: Effect.fn("HostAddressStreams.connect")(function* (target: HostAddressTarget) {
        return yield* Effect.die(
          new Error(`hostAddress.open to ${target.hostname}:${target.port} is not implemented`)
        );
      }),
    })
  );
}
