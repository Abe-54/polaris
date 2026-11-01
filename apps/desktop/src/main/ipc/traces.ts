/**
 * Desktop Traces calls (ADR 0094): only on a Host whose Daemon has the capability each needs,
 * `traces` for traces and spans, `traces.profiles` for Profiles.
 */
import type { LiveSession } from "@polaris/client";
import {
  type Capability,
  ProfileError,
  TRACES_CAPABILITY,
  TRACES_COMPARE_CAPABILITY,
  TRACES_PROFILES_CAPABILITY,
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

const TRACES_UPGRADE = "Traces need a newer daemon on this host";

const UPGRADE = new Map<string, string>([
  [TRACES_SETTINGS_CAPABILITY, "Traces settings need a newer daemon on this host"],
  [TRACES_COMPARE_CAPABILITY, "Comparing traces needs a newer daemon on this host"],
  ["traces.profiles.attach", "Inspector profiling needs a newer daemon on this host"],
  [TRACES_PROFILES_CAPABILITY, "Profiles need a newer daemon on this host"],
]);

/** A Daemon refusal keeps its code and fix; an older Daemon names the upgrade. */
export const toTracesIpcError = (error: Tagged): IpcError => {
  if (
    Schema.is(TraceError)(error) ||
    Schema.is(TraceSettingsError)(error) ||
    Schema.is(ProfileError)(error)
  )
    return { code: error.code, message: error.message, fix: error.fix };

  if (Schema.is(Unsupported)(error))
    return {
      code: "Unsupported",
      message: UPGRADE.get(error.capability) ?? TRACES_UPGRADE,
    };

  return toIpcError(error);
};

const live = (hostKey: string) =>
  HostDirectory.use((dir) => dir.connection(hostKey)).pipe(
    Effect.flatMap((connection) => connection.session)
  );

const onHost = <A, E extends Tagged>(
  hostKey: string,
  capability: Capability,
  use: (session: LiveSession) => Effect.Effect<A, E>
) =>
  live(hostKey).pipe(
    Effect.flatMap((session): Effect.Effect<A, E | Unsupported> =>
      session.capabilities.includes(capability)
        ? use(session)
        : Effect.fail(new Unsupported({ capability }))
    ),
    Effect.mapError(toTracesIpcError)
  );

/** Ends with the connection; the renderer resubscribes. */
const watchOnHost = <A, E extends Tagged>(
  hostKey: string,
  capability: Capability,
  open: (session: LiveSession) => Stream.Stream<A, E>
) =>
  Stream.unwrap(
    Effect.map(live(hostKey), (session): Stream.Stream<A, E | Unsupported> =>
      session.capabilities.includes(capability)
        ? open(session)
        : Stream.fail(new Unsupported({ capability }))
    )
  ).pipe(Stream.mapError(toTracesIpcError));

export const tracesHandlers = {
  "traces.get": ({ hostKey, ...input }: RequestInput<"traces.get">) =>
    onHost(hostKey, TRACES_CAPABILITY, (session) => session.client["traces.get"](input)),
  "traces.span": ({ hostKey, ...input }: RequestInput<"traces.span">) =>
    onHost(hostKey, TRACES_CAPABILITY, (session) => session.client["traces.span"](input)),
  "traces.settings": ({ hostKey, ...input }: RequestInput<"traces.settings">) =>
    onHost(hostKey, TRACES_SETTINGS_CAPABILITY, (session) =>
      session.client["traces.settings"](input)
    ),
  "traces.setSettings": ({ hostKey, ...input }: RequestInput<"traces.setSettings">) =>
    onHost(hostKey, TRACES_SETTINGS_CAPABILITY, (session) =>
      session.client["traces.setSettings"](input)
    ),
  "traces.compare": ({ hostKey, ...input }: RequestInput<"traces.compare">) =>
    onHost(hostKey, TRACES_COMPARE_CAPABILITY, (session) =>
      session.client["traces.compare"](input)
    ),
  "profiles.attach": ({ hostKey, ...input }: RequestInput<"profiles.attach">) =>
    onHost(hostKey, "traces.profiles.attach", (session) =>
      session.client["profiles.attach"](input)
    ),
  "profiles.get": ({ hostKey, ...input }: RequestInput<"profiles.get">) =>
    onHost(hostKey, TRACES_PROFILES_CAPABILITY, (session) => session.client["profiles.get"](input)),
  "profiles.restartWithProfiling": ({
    hostKey,
    ...input
  }: RequestInput<"profiles.restartWithProfiling">) =>
    onHost(hostKey, TRACES_PROFILES_CAPABILITY, (session) =>
      session.client["profiles.restartWithProfiling"](input)
    ),
};

export const tracesOpeners = {
  "traces.watch": ({ hostKey, ...input }: SubscriptionInput<"traces.watch">) =>
    watchOnHost(hostKey, TRACES_CAPABILITY, (session) => session.client["traces.watch"](input)),
  "profiles.watch": ({ hostKey, ...input }: SubscriptionInput<"profiles.watch">) =>
    watchOnHost(hostKey, TRACES_PROFILES_CAPABILITY, (session) =>
      session.client["profiles.watch"](input)
    ),
};
