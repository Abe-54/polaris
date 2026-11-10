/**
 * Computer use on a Host (ENG-846): its `computerUse.*` RPCs, only on a Host whose Daemon
 * announces `computer-use`, so a remote Host's setup runs on that Host.
 */
import type { LiveSession } from "@polaris/client";
import { Unsupported } from "@polaris/protocol";
import { Effect, Schema, Stream } from "effect";
import type { IpcError } from "../../shared/api.ts";
import type { RequestInput, SubscriptionInput } from "../../shared/contract.ts";
import { HostDirectory, toIpcError } from "../hosts.ts";

const CAPABILITY = "computer-use" as const;

type Tagged = { readonly _tag: string; readonly message: string };

const toComputerUseIpcError = (error: Tagged): IpcError =>
  Schema.is(Unsupported)(error)
    ? { code: "Unsupported", message: "Computer use needs a newer daemon on this host" }
    : toIpcError(error);

const live = (hostKey: string) =>
  HostDirectory.use((dir) => dir.connection(hostKey)).pipe(
    Effect.flatMap((connection) => connection.session)
  );

const supported = (session: LiveSession) => session.capabilities.includes(CAPABILITY);

const onHost = <A, E extends Tagged>(
  hostKey: string,
  use: (session: LiveSession) => Effect.Effect<A, E>
) =>
  live(hostKey).pipe(
    Effect.flatMap((session): Effect.Effect<A, E | Unsupported> =>
      supported(session) ? use(session) : Effect.fail(new Unsupported({ capability: CAPABILITY }))
    ),
    Effect.mapError(toComputerUseIpcError)
  );

export const computerUseHandlers = {
  "computerUse.status": ({ hostKey, refresh }: RequestInput<"computerUse.status">) =>
    onHost(hostKey, (session) => session.client["computerUse.status"]({ refresh })),
  "computerUse.enable": ({ hostKey }: RequestInput<"computerUse.enable">) =>
    onHost(hostKey, (session) => session.client["computerUse.enable"]({})),
  "computerUse.disable": ({ hostKey }: RequestInput<"computerUse.disable">) =>
    onHost(hostKey, (session) => session.client["computerUse.disable"]({})),
  "computerUse.openSetup": ({ hostKey, permission }: RequestInput<"computerUse.openSetup">) =>
    onHost(hostKey, (session) => session.client["computerUse.openSetup"]({ permission })),
  "computerUse.removeAllowedApp": ({
    hostKey,
    appId,
  }: RequestInput<"computerUse.removeAllowedApp">) =>
    onHost(hostKey, (session) => session.client["computerUse.removeAllowedApp"]({ appId })),
  "computerUse.allowedApps.add": ({
    hostKey,
    appId,
  }: RequestInput<"computerUse.allowedApps.add">) =>
    onHost(hostKey, (session) => session.client["computerUse.allowedApps.add"]({ appId })),
};

/** Ends with the connection, or at once on a Daemon without computer use; the renderer resubscribes. */
export const computerUseOpeners = {
  "computerUse.watch": ({ hostKey }: SubscriptionInput<"computerUse.watch">) =>
    Stream.unwrap(
      Effect.map(live(hostKey), (session) =>
        supported(session) ? session.client["computerUse.watch"]({}) : Stream.empty
      )
    ).pipe(Stream.mapError(toComputerUseIpcError)),
};
