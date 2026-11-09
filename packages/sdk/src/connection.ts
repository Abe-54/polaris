/**
 * One connection to a Host: a transport for one of its Pairings, the RPC
 * client on `ExtensionClientRpcs`, and `hello` with the Pairing's token and
 * this SDK's protocol range. A Host with several Pairings tries each in turn.
 */
import { type ClientBlobs, connectRpcWith } from "@polaris/client/rpc";
import {
  type ByteTransport,
  type Capability,
  type ExtensionTokenRejected,
  decideProtocol,
  ExtensionClientRpcs,
  type HostInfo,
  type ProtocolMismatch,
} from "@polaris/protocol";
import { Duration, Effect, Exit, Option, Predicate, Redacted, Scope } from "effect";
import type { RpcClient, RpcGroup } from "effect/rpc";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import { HostUnreachable } from "./errors.ts";
import type { ParsedPairing } from "./pairing.ts";
import { SUPPORTED_PROTOCOL } from "./version.ts";

export type ExtensionRpc = RpcGroup.Rpcs<typeof ExtensionClientRpcs>;

export type ExtensionClient = RpcClient.RpcClient<ExtensionRpc, RpcClientError>;

/** Opens the byte transport a Pairing names; injectable for tests and other runtimes. */
export type OpenTransport = (
  pairing: ParsedPairing
) => Effect.Effect<ByteTransport, HostUnreachable, Scope.Scope>;

/** Why a Host could not be connected to. */
export type ConnectError = HostUnreachable | ExtensionTokenRejected | ProtocolMismatch;

export interface ConnectOptions {
  readonly clientName: string;
  readonly clientVersion: string;
  readonly openTransport: OpenTransport;
  readonly helloTimeout?: Duration.Input;
}

/** A connected Host. Closing `scope` closes the connection. */
export interface Live {
  readonly client: ExtensionClient;
  /** Offers audio to `voice.transcribe`. */
  readonly blobs: ClientBlobs;
  readonly host: HostInfo;
  readonly capabilities: ReadonlyArray<Capability>;
  /** Fails when the connection is gone. */
  readonly lost: Effect.Effect<never, RpcClientError>;
  readonly scope: Scope.Closeable;
}

/** What the SDK understands beyond the base protocol. */
export const SDK_CAPABILITIES: ReadonlyArray<Capability> = [
  "host.any-platform",
  "session.limited",
  "session.plan-mode",
  "session.user-turns",
];

const unreachable = (hostId: string) => (error: RpcClientError) =>
  new HostUnreachable({ hostId, detail: error.message });

/** The Daemon's protocol against this SDK's range, or null when it is supported. */
export const protocolMismatch = (daemon: number): ProtocolMismatch | null =>
  decideProtocol(daemon, SUPPORTED_PROTOCOL, true);

const helloOn = Effect.fnUntraced(function* (
  pairing: ParsedPairing,
  options: ConnectOptions,
  scope: Scope.Scope
) {
  const transport = yield* Scope.provide(options.openTransport(pairing), scope);
  const connection = yield* Scope.provide(connectRpcWith(ExtensionClientRpcs, transport), scope);

  const hello = yield* connection.client
    .hello({
      clientName: options.clientName,
      clientVersion: options.clientVersion,
      deviceLabel: pairing.name,
      capabilities: SDK_CAPABILITIES,
      extensionToken: Redacted.make(pairing.token),
      protocolVersions: SUPPORTED_PROTOCOL,
    })
    .pipe(
      Effect.catchTags({
        RpcClientError: (error) => Effect.fail(unreachable(pairing.hostId)(error)),
        // hello is open to every connection, and this one sends no language proof.
        NotGranted: Effect.die,
        LanguageIdentityError: Effect.die,
      })
    );

  const mismatch = protocolMismatch(hello.protocolVersion);

  if (mismatch !== null) return yield* mismatch;

  if (hello.host.hostId !== pairing.hostId)
    return yield* new HostUnreachable({
      hostId: pairing.hostId,
      detail: `the Daemon there is Host ${hello.host.hostId}`,
    });

  return {
    client: connection.client,
    blobs: connection.blobs,
    host: hello.host,
    capabilities: hello.capabilities,
    lost: connection.lost,
  };
});

/** Connects through one Pairing; the connection lives until the returned `scope` closes. */
export const connectPairing = Effect.fnUntraced(function* (
  pairing: ParsedPairing,
  options: ConnectOptions
): Effect.fn.Return<Live, ConnectError> {
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();

      const exit = yield* restore(
        helloOn(pairing, options, scope).pipe(
          Effect.timeoutOrElse({
            duration: options.helloTimeout ?? Duration.seconds(10),
            orElse: () =>
              Effect.fail(
                new HostUnreachable({ hostId: pairing.hostId, detail: "no answer to hello" })
              ),
          })
        )
      ).pipe(Effect.exit);

      if (Exit.isFailure(exit)) {
        yield* Scope.close(scope, exit);

        return yield* Effect.failCause(exit.cause);
      }

      return { ...exit.value, scope } satisfies Live;
    })
  );
});

/**
 * Tries a Host's Pairings in order. When all fail, a refusal (a rejected token,
 * a protocol mismatch) wins over unreachability, since retrying won't fix it.
 */
export const connectHost = Effect.fnUntraced(function* (
  pairings: ReadonlyArray<ParsedPairing>,
  options: ConnectOptions
): Effect.fn.Return<Live, ConnectError> {
  let failure: ConnectError | null = null;

  for (const pairing of pairings) {
    const exit = yield* Effect.exit(connectPairing(pairing, options));

    if (Exit.isSuccess(exit)) return exit.value;
    const error = Exit.findErrorOption(exit);

    // A defect or an interruption ends the attempt; only failures move on to the next Pairing.
    if (Option.isNone(error)) return yield* Effect.failCause(exit.cause);

    if (failure === null || Predicate.isTagged(failure, "HostUnreachable")) failure = error.value;
  }

  return yield* (
    failure ?? new HostUnreachable({ hostId: pairings[0]?.hostId ?? "", detail: "no pairings" })
  );
});
