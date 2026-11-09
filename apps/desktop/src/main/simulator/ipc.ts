/** The `simulator.*` feeds and requests in `simulatorContract.ts`: the Daemon's RPCs, and `hub.ts`. */
import { randomUUID } from "node:crypto";
import type { LiveSession } from "@polaris/client";
import { Effect, Predicate, Stream } from "effect";
import type { IpcError } from "../../shared/api.ts";
import type {
  SimulatorRequestInputs,
  SimulatorSocketItem,
  SimulatorSubscriptionInputs,
} from "../../shared/simulatorContract.ts";
import { HostDirectory } from "../hosts.ts";
import { isLocalHost } from "../hostAddress/open.ts";
import type { Feed } from "../ipc/feeds.ts";
import type { Handler } from "../ipc/requests.ts";
import { getBody, type HubSocket, hubPaths, openHub, openSocket } from "./hub.ts";

/** Open input sockets by id; an id is random, so only the renderer that opened one knows it. */
const sockets = new Map<string, HubSocket["send"]>();

const remoteMjpeg: IpcError = {
  code: "Unsupported",
  message: "MJPEG is only for a local Host; a remote one streams AVCC.",
};

/** A Daemon error as the renderer gets it; `HubFailed` carries its account in `detail`. */
const daemonError = (error: { readonly _tag: string; readonly message: string }): IpcError => ({
  code: error._tag,
  message:
    Predicate.hasProperty(error, "detail") && Predicate.isString(error.detail)
      ? error.detail
      : error.message,
});

const session = (hostKey: string) =>
  Effect.flatMap(
    HostDirectory.use((dir) => dir.connection(hostKey)),
    (connection) => connection.session
  ).pipe(Effect.mapError(daemonError));

/** A Daemon stream on the Host's live connection: it ends when the connection drops. */
const onLive = <A, E extends { readonly _tag: string; readonly message: string }>(
  hostKey: string,
  use: (session: LiveSession) => Stream.Stream<A, E>
) => Stream.unwrap(Effect.map(session(hostKey), (s) => use(s).pipe(Stream.mapError(daemonError))));

/** A Daemon request on the Host's live connection, answered with null. */
const call = <A, E extends { readonly _tag: string; readonly message: string }>(
  hostKey: string,
  use: (session: LiveSession) => Effect.Effect<A, E>
) =>
  Effect.flatMap(session(hostKey), (s) => use(s).pipe(Effect.mapError(daemonError))).pipe(
    Effect.as(null)
  );

type Openers = {
  readonly [K in keyof typeof SimulatorSubscriptionInputs]: (
    input: (typeof SimulatorSubscriptionInputs)[K]["Type"]
  ) => Feed<K>;
};

export const simulatorOpeners: Openers = {
  "simulator.watch": ({ hostKey }) => onLive(hostKey, (s) => s.client["simulator.watch"]({})),
  "simulator.attach": ({ hostKey, sessionId, id }) =>
    onLive(hostKey, (s) => s.client["simulator.attach"]({ sessionId, id })),
  "simulator.sessionFeed": ({ hostKey, sessionId }) =>
    onLive(hostKey, (s) => s.client["simulator.sessionFeed"]({ sessionId })),
  "simulator.video": ({ hostKey, port, token, id, format }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (format === "mjpeg" && !(yield* isLocalHost(hostKey))) return Stream.fail(remoteMjpeg);
        const transport = yield* openHub(hostKey, port);

        return getBody(transport, port, hubPaths.video(id, format), token);
      })
    ),
  "simulator.socket": ({ hostKey, port, token, id, platform }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const transport = yield* openHub(hostKey, port);
        const socket = yield* openSocket(transport, port, hubPaths.socket(id, platform), token);
        const socketId = randomUUID();

        yield* Effect.acquireRelease(
          Effect.sync(() => sockets.set(socketId, socket.send)),
          () => Effect.sync(() => sockets.delete(socketId))
        );

        const open: SimulatorSocketItem = { kind: "open", socketId };

        return Stream.concat(Stream.succeed(open), socket.messages);
      })
    ),
};

type Handlers = { readonly [M in keyof typeof SimulatorRequestInputs]: Handler<M> };

export const simulatorHandlers: Handlers = {
  "simulator.boot": ({ hostKey, id }) => call(hostKey, (s) => s.client["simulator.boot"]({ id })),
  "simulator.shutdown": ({ hostKey, id }) =>
    call(hostKey, (s) => s.client["simulator.shutdown"]({ id, force: true })),
  "simulator.restart": ({ hostKey }) => call(hostKey, (s) => s.client["simulator.restart"]({})),
  "simulator.send": ({ socketId, message }) => {
    const send = sockets.get(socketId);

    return send === undefined
      ? Effect.fail<IpcError>({ code: "Closed", message: "The Simulator's input socket closed." })
      : Effect.as(send(message), null);
  },
};
