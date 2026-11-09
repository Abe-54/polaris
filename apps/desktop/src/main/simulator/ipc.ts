/** The `simulator.*` feeds and request in `simulatorContract.ts`, over `hub.ts`. */
import { randomUUID } from "node:crypto";
import { Effect, Stream } from "effect";
import type { IpcError } from "../../shared/api.ts";
import type {
  SimulatorRequestInputs,
  SimulatorSocketItem,
  SimulatorSubscriptionInputs,
} from "../../shared/simulatorContract.ts";
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

type Openers = {
  readonly [K in keyof typeof SimulatorSubscriptionInputs]: (
    input: (typeof SimulatorSubscriptionInputs)[K]["Type"]
  ) => Feed<K>;
};

export const simulatorOpeners: Openers = {
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
  "simulator.send": ({ socketId, message }) => {
    const send = sockets.get(socketId);

    return send === undefined
      ? Effect.fail<IpcError>({ code: "Closed", message: "The Simulator's input socket closed." })
      : Effect.as(send(message), null);
  },
};
