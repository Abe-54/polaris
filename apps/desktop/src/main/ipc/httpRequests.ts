/**
 * Desktop Requests calls (ADR 0098): `requests.*` RPCs, only on a Host whose Daemon announces
 * `requests`. Named apart from requests.ts, which holds every IPC request handler.
 */
import type { LiveSession } from "@polaris/client";
import { REQUESTS_CAPABILITY, RequestsError, Unsupported } from "@polaris/protocol";
import { Effect, Schema, Stream } from "effect";
import type { IpcError } from "../../shared/api.ts";
import type { RequestInput, SubscriptionInput } from "../../shared/contract.ts";
import { HostDirectory, toIpcError } from "../hosts.ts";

type Tagged = { readonly _tag: string; readonly message: string };

/** A Daemon refusal keeps its code and fix; an older Daemon names the upgrade. */
export const toRequestsIpcError = (error: Tagged): IpcError => {
  if (Schema.is(RequestsError)(error))
    return { code: error.code, message: error.message, fix: error.fix };

  if (Schema.is(Unsupported)(error))
    return { code: "Unsupported", message: "Requests need a newer daemon on this host" };

  return toIpcError(error);
};

const live = (hostKey: string) =>
  HostDirectory.use((dir) => dir.connection(hostKey)).pipe(
    Effect.flatMap((connection) => connection.session)
  );

const onHost = <A, E extends Tagged>(
  hostKey: string,
  use: (session: LiveSession) => Effect.Effect<A, E>
) =>
  live(hostKey).pipe(
    Effect.flatMap((session): Effect.Effect<A, E | Unsupported> =>
      session.capabilities.includes(REQUESTS_CAPABILITY)
        ? use(session)
        : Effect.fail(new Unsupported({ capability: REQUESTS_CAPABILITY }))
    ),
    Effect.mapError(toRequestsIpcError)
  );

/** Ends with the connection; the renderer resubscribes. */
const watchOnHost = <A, E extends Tagged>(
  hostKey: string,
  open: (session: LiveSession) => Stream.Stream<A, E>
) =>
  Stream.unwrap(
    Effect.map(live(hostKey), (session): Stream.Stream<A, E | Unsupported> =>
      session.capabilities.includes(REQUESTS_CAPABILITY)
        ? open(session)
        : Stream.fail(new Unsupported({ capability: REQUESTS_CAPABILITY }))
    )
  ).pipe(Stream.mapError(toRequestsIpcError));

export const httpRequestsHandlers = {
  "requests.save": ({ hostKey, ...input }: RequestInput<"requests.save">) =>
    onHost(hostKey, (session) => session.client["requests.save"](input)),
  "requests.send": ({ hostKey, ...input }: RequestInput<"requests.send">) =>
    onHost(hostKey, (session) => session.client["requests.send"](input)),
  "requests.variables": ({ hostKey, ...input }: RequestInput<"requests.variables">) =>
    onHost(hostKey, (session) => session.client["requests.variables"](input)),
  "requests.sendLog.page": ({ hostKey, ...input }: RequestInput<"requests.sendLog.page">) =>
    onHost(hostKey, (session) => session.client["requests.sendLog.page"](input)),
  "requests.send.get": ({ hostKey, ...input }: RequestInput<"requests.send.get">) =>
    onHost(hostKey, (session) => session.client["requests.send.get"](input)),
  "requests.curl.parse": ({ hostKey, ...input }: RequestInput<"requests.curl.parse">) =>
    onHost(hostKey, (session) => session.client["requests.curl.parse"](input)),
  "requests.curl.format": ({ hostKey, ...input }: RequestInput<"requests.curl.format">) =>
    onHost(hostKey, (session) => session.client["requests.curl.format"](input)),
};

export const httpRequestsOpeners = {
  "requests.watch": ({ hostKey, ...input }: SubscriptionInput<"requests.watch">) =>
    watchOnHost(hostKey, (session) => session.client["requests.watch"](input)),
  "requests.sendLog.watch": ({ hostKey, ...input }: SubscriptionInput<"requests.sendLog.watch">) =>
    watchOnHost(hostKey, (session) => session.client["requests.sendLog.watch"](input)),
};
