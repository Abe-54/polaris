/**
 * The Remote Access URL a pairing string carries (ENG-400, ENG-401's contract):
 * `wss://<machine>.<tailnet>.ts.net/polaris/rpc` while Remote Access is on, else none.
 */
import { Context, Effect, Layer, Option } from "effect";
import { RemoteAccessControl } from "../remoteAccess/service.ts";

export class RemoteAccess extends Context.Service<
  RemoteAccess,
  {
    /** `wss://<host>.<tailnet>.ts.net/polaris/rpc` while Remote Access is on; none otherwise. */
    readonly url: Effect.Effect<Option.Option<string>>;
  }
>()("polaris/daemon/extensions/RemoteAccess") {}

/** No Remote Access: pairing strings carry no URL. */
export const RemoteAccessNone = Layer.succeed(RemoteAccess)({ url: Effect.succeed(Option.none()) });

/** The URL as Tailscale reports it now, read on each call. */
export const RemoteAccessLive = Layer.effect(
  RemoteAccess,
  Effect.gen(function* () {
    const control = yield* RemoteAccessControl;

    return { url: Effect.map(control.status, (status) => Option.fromNullishOr(status.url)) };
  })
);
