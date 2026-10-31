/** Desktop Traces calls (ADR 0094): only on a Host whose Daemon has the `traces` capability. */
import type { LiveSession } from "@polaris/client";
import {
  type Capability,
  TRACES_CAPABILITY,
  TRACES_SETTINGS_CAPABILITY,
  TraceError,
  TraceSettingsError,
  Unsupported,
} from "@polaris/protocol";
import { Effect, Schema, Stream } from "effect";
import type { IpcError } from "../../shared/api.ts";
import type { RequestInput, SubscriptionInput } from "../../shared/contract.ts";
import { HostDirectory, toIpcError } from "../hosts.ts";

type Tagged = { readonly _tag: string; readonly message: string };

/** A TraceError keeps its E-TRACE code and fix; an older Daemon names the upgrade. */
export const toTracesIpcError = (error: Tagged): IpcError => {
  if (Schema.is(TraceError)(error) || Schema.is(TraceSettingsError)(error))
    return { code: error.code, message: error.message, fix: error.fix };

  if (Schema.is(Unsupported)(error))
    return {
      code: "Unsupported",
      message:
        error.capability === TRACES_SETTINGS_CAPABILITY
          ? "Traces settings need a newer daemon on this host"
          : "Traces need a newer daemon on this host",
    };

  return toIpcError(error);
};

const supported = (session: LiveSession, capability: Capability = TRACES_CAPABILITY) =>
  session.capabilities.includes(capability);

const unsupported = new Unsupported({ capability: TRACES_CAPABILITY });

const live = (hostKey: string) =>
  HostDirectory.use((dir) => dir.connection(hostKey)).pipe(
    Effect.flatMap((connection) => connection.session)
  );

const onHost = <A, E extends Tagged>(
  hostKey: string,
  use: (session: LiveSession) => Effect.Effect<A, E>,
  capability: Capability = TRACES_CAPABILITY
) =>
  live(hostKey).pipe(
    Effect.flatMap((session): Effect.Effect<A, E | Unsupported> =>
      supported(session, capability) ? use(session) : Effect.fail(new Unsupported({ capability }))
    ),
    Effect.mapError(toTracesIpcError)
  );

export const tracesHandlers = {
  "traces.get": ({ hostKey, ...input }: RequestInput<"traces.get">) =>
    onHost(hostKey, (session) => session.client["traces.get"](input)),
  "traces.span": ({ hostKey, ...input }: RequestInput<"traces.span">) =>
    onHost(hostKey, (session) => session.client["traces.span"](input)),
  "traces.settings": ({ hostKey, ...input }: RequestInput<"traces.settings">) =>
    onHost(
      hostKey,
      (session) => session.client["traces.settings"](input),
      TRACES_SETTINGS_CAPABILITY
    ),
  "traces.setSettings": ({ hostKey, ...input }: RequestInput<"traces.setSettings">) =>
    onHost(
      hostKey,
      (session) => session.client["traces.setSettings"](input),
      TRACES_SETTINGS_CAPABILITY
    ),
};

/** Ends with the connection; the renderer resubscribes. */
export const tracesOpeners = {
  "traces.watch": ({ hostKey, ...input }: SubscriptionInput<"traces.watch">) =>
    Stream.unwrap(
      Effect.map(live(hostKey), (session) =>
        supported(session) ? session.client["traces.watch"](input) : Stream.fail(unsupported)
      )
    ).pipe(Stream.mapError(toTracesIpcError)),
};
