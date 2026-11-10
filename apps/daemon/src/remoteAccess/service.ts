/**
 * The Remote Access service, apart from its Tailscale implementation (`index.ts`), so the Daemon
 * can start without loading it: `layer` loads that on the first status, enable or disable.
 */
import type { RemoteAccessError, RemoteAccessStatus } from "@polaris/protocol";
import { Context, Effect, Layer } from "effect";
import type { TailscaleCli } from "./tailscale.ts";

export interface RemoteAccessOptions {
  /** The Polaris home holding `gateway.json`. */
  readonly root: string;
  /** Overrides for tests. */
  readonly findCli?: () => TailscaleCli | null;
  readonly os?: string;
}

export class RemoteAccessControl extends Context.Service<
  RemoteAccessControl,
  {
    readonly status: Effect.Effect<RemoteAccessStatus>;
    readonly enable: Effect.Effect<RemoteAccessStatus, RemoteAccessError>;
    readonly disable: Effect.Effect<RemoteAccessStatus, RemoteAccessError>;
  }
>()("polaris/daemon/remoteAccess/RemoteAccessControl") {
  static layer(options: RemoteAccessOptions) {
    return Layer.effect(
      RemoteAccessControl,
      Effect.gen(function* () {
        const load = yield* Effect.cached(
          Effect.promise(() => import("./index.ts")).pipe(
            Effect.map((module) => module.makeRemoteAccess(options))
          )
        );

        return RemoteAccessControl.of({
          status: Effect.flatMap(load, (access) => access.status),
          enable: Effect.flatMap(load, (access) => access.enable),
          disable: Effect.flatMap(load, (access) => access.disable),
        });
      })
    );
  }
}
