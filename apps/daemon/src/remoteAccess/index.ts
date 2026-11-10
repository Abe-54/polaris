/**
 * Remote Access (CONTEXT.md, ADR 0076): the gateway served at
 * `https://<machine>.<tailnet>.ts.net/polaris` by `tailscale serve`. Tailscale keeps the state
 * (`serve --bg` persists), so status is always read back from it.
 */
import { RemoteAccessError, type RemoteAccessReason, RemoteAccessStatus } from "@polaris/protocol";
import { Effect, Match } from "effect";
import type { RemoteAccessOptions } from "./service.ts";
import { GATEWAY_PREFIX, GATEWAY_RPC_PATH, runningGateway, serveTarget } from "./gateway.ts";
import {
  findTailscale,
  readServe,
  servedHandler,
  funnelOn,
  portInUse,
  readStatus,
  serveOff,
  serveOn,
  type TailscaleCli,
  type TailscaleCommandError,
  type TailscaleParseError,
} from "./tailscale.ts";

/** What the user reads for each reason: Polaris's words, never Tailscale's output. */
export const REASON_MESSAGES: Record<RemoteAccessReason, string> = {
  "not-installed": "Tailscale isn't installed on this host.",
  "not-running": "Tailscale isn't running on this host.",
  "not-logged-in": "Tailscale isn't logged in on this host.",
  "port-in-use":
    "Tailscale already uses port 443 on this host for something else. Stop it before turning on remote access.",
  "funnel-on":
    "Tailscale Funnel is on for port 443 on this host. Turning on remote access would turn it off, so Polaris leaves it alone.",
  "https-disabled": "HTTPS certificates aren't enabled for this tailnet.",
  "needs-operator":
    "Tailscale needs `sudo tailscale set --operator=$USER` once before Polaris can serve.",
  "gateway-not-running": "The gateway isn't running on this host.",
  "serving-elsewhere":
    "Tailscale serves /polaris to something other than this host's gateway. Turn remote access off, or on again.",
  failed: "Tailscale didn't answer as expected. Try again.",
};

const reasonOfBackend = (state: string | null): RemoteAccessReason | null =>
  Match.value(state).pipe(
    Match.when("Running", () => null),
    Match.when(null, () => null),
    Match.whenOr("NeedsLogin", "NeedsMachineAuth", "NoState", () => "not-logged-in" as const),
    Match.orElse(() => "not-running" as const)
  );

/** Why Tailscale refused, from a failed command. */
export const reasonOfError = (
  error: TailscaleCommandError | TailscaleParseError,
  os: string = process.platform
): RemoteAccessReason =>
  Match.value(error).pipe(
    Match.tag("TailscaleExitError", ({ diagnostic }) =>
      Match.value(diagnostic).pipe(
        Match.when("not-logged-in", () => "not-logged-in" as const),
        Match.when("not-running", () => "not-running" as const),
        Match.when("https-disabled", () => "https-disabled" as const),
        Match.when("permission-denied", () =>
          os === "linux" ? ("needs-operator" as const) : ("failed" as const)
        ),
        Match.orElse(() => "failed" as const)
      )
    ),
    Match.orElse(() => "failed" as const)
  );

/** Why Remote Access can't be on; `host` once Tailscale named one. */
interface NotReady {
  readonly reason: RemoteAccessReason;
  readonly host: string | null;
}

export const makeRemoteAccess = (options: RemoteAccessOptions) => {
  const os = options.os ?? process.platform;
  const findCli = options.findCli ?? (() => findTailscale());

  const notReady = (reason: RemoteAccessReason, host: string | null = null): NotReady => ({
    reason,
    host,
  });

  const fromCommand = (error: TailscaleCommandError | TailscaleParseError) =>
    notReady(reasonOfError(error, os));

  /** The CLI and the MagicDNS name of a Tailscale that can serve HTTPS. */
  const ready = Effect.gen(function* () {
    const cli = findCli();

    if (cli === null) return yield* Effect.fail(notReady("not-installed"));
    const status = yield* readStatus(cli).pipe(Effect.mapError(fromCommand));
    const backend = reasonOfBackend(status.backendState);
    const host = status.magicDnsName;

    if (backend !== null) return yield* Effect.fail(notReady(backend, host));

    if (host === null || status.httpsEnabled === false)
      return yield* Effect.fail(notReady("https-disabled", host));

    return { cli, host };
  });

  /** The proven gateway's port, or why there is none to serve. */
  const gateway = (host: string) =>
    Effect.flatMap(runningGateway(options.root), (record) =>
      record === null
        ? Effect.fail(notReady("gateway-not-running", host))
        : Effect.succeed(record.port)
    );

  /**
   * What Tailscale serves at `/polaris`, as it is: a path proxying anywhere but the proven
   * gateway (`port` null when none) is still exposed, so it reads as on, with no URL and why.
   */
  const statusOf = (cli: TailscaleCli, host: string, port: number | null) =>
    readServe(cli).pipe(
      Effect.mapError(fromCommand),
      Effect.map((serve) => {
        const handler = servedHandler(serve, host, GATEWAY_PREFIX);
        const funnel = funnelOn(serve, host);
        const ours = !funnel && port !== null && handler?.Proxy === serveTarget(port);
        const conflict = !funnel && !ours && portInUse(serve);
        const missing = port === null ? ("gateway-not-running" as const) : null;

        return new RemoteAccessStatus({
          state: conflict ? "unavailable" : handler === null ? "off" : "on",
          url: ours ? `wss://${host}${GATEWAY_RPC_PATH}` : null,
          hostName: host,
          reason: funnel
            ? "funnel-on"
            : conflict
              ? "port-in-use"
              : handler === null || ours
                ? missing
                : (missing ?? "serving-elsewhere"),
        });
      })
    );

  const unavailable = ({ reason, host }: NotReady) =>
    new RemoteAccessStatus({ state: "unavailable", url: null, hostName: host, reason });

  const fail = ({ reason }: NotReady) =>
    new RemoteAccessError({ reason, message: REASON_MESSAGES[reason] });

  const status: Effect.Effect<RemoteAccessStatus> = ready.pipe(
    Effect.flatMap(({ cli, host }) =>
      gateway(host).pipe(
        Effect.orElseSucceed(() => null),
        Effect.flatMap((port) => statusOf(cli, host, port))
      )
    ),
    Effect.catch((why) => Effect.succeed(unavailable(why)))
  );

  const enable = Effect.gen(function* () {
    const { cli, host } = yield* ready;
    const serve = yield* readServe(cli).pipe(Effect.mapError(fromCommand));

    // Serve changes Funnel for the whole listener; never disrupt the user's other paths.
    if (funnelOn(serve, host)) return yield* Effect.fail(notReady("funnel-on", host));

    if (portInUse(serve)) return yield* Effect.fail(notReady("port-in-use", host));
    const port = yield* gateway(host);

    yield* serveOn(cli, GATEWAY_PREFIX, serveTarget(port)).pipe(Effect.mapError(fromCommand));

    return yield* statusOf(cli, host, port);
  }).pipe(Effect.mapError(fail));

  const disable = Effect.gen(function* () {
    const cli = findCli();

    // Nothing is served without Tailscale.
    if (cli !== null) {
      const serve = yield* readServe(cli).pipe(Effect.mapError(fromCommand));

      if (portInUse(serve)) return yield* Effect.fail(notReady("port-in-use"));
      yield* serveOff(cli, GATEWAY_PREFIX).pipe(Effect.mapError(fromCommand));
      yield* serveOff(cli, `${GATEWAY_PREFIX}/`).pipe(Effect.mapError(fromCommand));
    }

    return yield* status;
  }).pipe(Effect.mapError(fail));

  return { status, enable, disable };
};

export { RemoteAccessControl, type RemoteAccessOptions } from "./service.ts";
