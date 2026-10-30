/** Host-address streams on a Host's connection in the Client runtime, failures as proxy statuses. */
import { HostTarget, openHostAddressStream } from "@polaris/client";
import type { HostAddressFailure } from "@polaris/protocol";
import { Effect, Match, Stream, SubscriptionRef } from "effect";
import { HostDirectory } from "../hosts.ts";
import type { ProxyStatus } from "./proxy.ts";
import type { OpenHostAddress } from "./server.ts";

const failureStatus = Match.type<typeof HostAddressFailure.Type>().pipe(
  Match.when("not-host-address", (): ProxyStatus => 403),
  Match.when("timeout", (): ProxyStatus => 504),
  Match.when("too-many-streams", (): ProxyStatus => 503),
  Match.orElse((): ProxyStatus => 502)
);

export const openThroughHost =
  (hostKey: string): OpenHostAddress<HostDirectory> =>
  (target) =>
    HostDirectory.use((directory) => directory.connection(hostKey)).pipe(
      Effect.flatMap((connection) => connection.session),
      Effect.flatMap((session) => openHostAddressStream(session, target)),
      Effect.catchTags({
        UnknownHost: () => Effect.fail<ProxyStatus>(502),
        NotConnected: () => Effect.fail<ProxyStatus>(503),
        HostAddressError: (error) => Effect.fail(failureStatus(error.reason)),
        Unsupported: () => Effect.fail<ProxyStatus>(502),
        RpcClientError: () => Effect.fail<ProxyStatus>(503),
      })
    );

/** The Host's loopback is this machine's: the local Host, or one on a local socket. */
export const isLocalHost = (hostKey: string) =>
  HostDirectory.use((directory) => {
    const entry = directory.entry(hostKey);

    return Effect.succeed(entry !== undefined && HostTarget.$is("Local")(entry.target));
  });

/** Calls `forget` with each Host as it leaves the Host list, so its proxy stops. */
export const whenHostRemoved = (forget: (hostKey: string) => Promise<void>) =>
  HostDirectory.use((directory) => {
    let known = new Set<string>();

    return SubscriptionRef.changes(directory.views).pipe(
      Stream.runForEach((views) => {
        const keys = new Set(views.map((view) => view.key));
        const gone = [...known].filter((key) => !keys.has(key));

        known = keys;

        return Effect.promise(() => Promise.all(gone.map(forget)));
      })
    );
  });
