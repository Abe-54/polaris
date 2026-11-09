/**
 * The hub on a Host's loopback (ADR 0099): a TCP connection on a local Host, a Host-address
 * stream on a remote one (ADR 0093), then one HTTP response or one WebSocket over it.
 */
import { connect, type Socket } from "node:net";
import { Effect, Semaphore, Stream } from "effect";
import type { IpcError } from "../../shared/api.ts";
import { isLocalHost, openThroughHost } from "../hostAddress/open.ts";
import { writeTo, type HostAddressTransport } from "../hostAddress/server.ts";
import { bodyDecoder, concatBytes, getRequest, readHead, type BodyDecoder } from "./http.ts";
import {
  closePayload,
  encodeFrame,
  type Frame,
  frameDecoder,
  newKey,
  OPCODE,
  upgraded,
  upgradeRequest,
} from "./websocket.ts";

const failed = (code: string, message: string): IpcError => ({ code, message });

const unreachable = (port: number) =>
  failed("HubUnreachable", `Nothing answered on port ${port} of the Host's loopback.`);

const connectLocal = (port: number) =>
  Effect.acquireRelease(
    Effect.callback<Socket, IpcError>((resume) => {
      const socket = connect({ host: "127.0.0.1", port, noDelay: true });

      const onError = () => {
        socket.destroy();
        resume(Effect.fail(unreachable(port)));
      };

      socket.once("error", onError).once("connect", () => {
        socket.off("error", onError).on("error", () => socket.destroy());
        resume(Effect.succeed(socket));
      });

      return Effect.sync(() => socket.destroy());
    }),
    (socket) => Effect.sync(() => socket.destroy())
  ).pipe(
    Effect.map((socket): HostAddressTransport => ({
      incoming: Stream.fromAsyncIterable<Uint8Array, unknown>(socket, (error) => error),
      write: (bytes) => writeTo(socket, bytes),
    }))
  );

/** A byte stream to `port` on the Host's loopback, closed with the scope. */
export const openHub = (hostKey: string, port: number) =>
  Effect.flatMap(isLocalHost(hostKey), (local) =>
    local
      ? connectLocal(port)
      : openThroughHost(hostKey)({ hostname: "127.0.0.1", port }).pipe(
          Effect.mapError(() => unreachable(port))
        )
  );

type Reading =
  | { readonly phase: "head"; readonly buffer: Uint8Array }
  | { readonly phase: "body"; readonly decoder: BodyDecoder }
  | { readonly phase: "done" };

type BodyPiece =
  | { readonly kind: "data"; readonly data: Uint8Array }
  | { readonly kind: "end" }
  | { readonly kind: "error"; readonly error: IpcError };

const refused = (status: number) =>
  failed(status === 401 ? "HubUnauthorized" : "HubRefused", `The hub answered ${status}.`);

const readBody = (
  state: Reading,
  chunk: Uint8Array
): readonly [Reading, ReadonlyArray<BodyPiece>] => {
  if (state.phase === "done") return [state, []];

  if (state.phase === "body") {
    const read = state.decoder.push(chunk);
    const data = read.chunks.map((bytes): BodyPiece => ({ kind: "data", data: bytes }));

    if (read.invalid)
      return [{ phase: "done" }, [{ kind: "error", error: failed("HubBroken", "Bad framing") }]];

    return read.done ? [{ phase: "done" }, [...data, { kind: "end" }]] : [state, data];
  }

  const head = readHead(concatBytes(state.buffer, chunk));

  if (head.kind === "more")
    return [{ phase: "head", buffer: concatBytes(state.buffer, chunk) }, []];

  if (head.kind === "invalid")
    return [{ phase: "done" }, [{ kind: "error", error: failed("HubBroken", "Bad response") }]];

  if (head.head.status !== 200)
    return [{ phase: "done" }, [{ kind: "error", error: refused(head.head.status) }]];

  return readBody({ phase: "body", decoder: bodyDecoder(head.head) }, head.rest);
};

/** The body of `GET path`, as it arrives; fails when the hub refuses or the bytes break. */
export const getBody = (
  transport: HostAddressTransport,
  port: number,
  path: string,
  token: string
): Stream.Stream<Uint8Array, IpcError> =>
  Stream.unwrap(
    Effect.as(
      transport.write(getRequest(port, path, token)).pipe(Effect.mapError(() => unreachable(port))),
      transport.incoming.pipe(
        Stream.mapError(() => unreachable(port)),
        Stream.mapAccum((): Reading => ({ phase: "head", buffer: new Uint8Array() }), readBody),
        Stream.takeUntil((piece) => piece.kind !== "data"),
        Stream.mapEffect((piece) =>
          piece.kind === "error" ? Effect.fail(piece.error) : Effect.succeed(piece)
        ),
        Stream.map((piece) => (piece.kind === "data" ? [piece.data] : [])),
        Stream.flattenIterable
      )
    )
  );

export type SocketMessage =
  | { readonly kind: "binary"; readonly data: Uint8Array }
  | { readonly kind: "text"; readonly text: string };

export type SocketEvent =
  | SocketMessage
  | { readonly kind: "close"; readonly code: number; readonly reason: string };

const closed = (code: number, reason: string): SocketEvent => ({ kind: "close", code, reason });

export interface HubSocket {
  /** The server's messages, then its close code. */
  readonly messages: Stream.Stream<SocketEvent, IpcError>;
  readonly send: (message: SocketMessage) => Effect.Effect<void, IpcError>;
}

type Upgrade =
  | { readonly phase: "head"; readonly buffer: Uint8Array }
  | { readonly phase: "open"; readonly decode: (bytes: Uint8Array) => ReadonlyArray<Frame> };

/** Opens a WebSocket to `path` over `transport`; the scope closes it. */
export const openSocket = (
  transport: HostAddressTransport,
  port: number,
  path: string,
  token: string
): Effect.Effect<HubSocket, IpcError> =>
  Effect.gen(function* () {
    const key = newKey();
    const lock = yield* Semaphore.make(1);

    const write = (opcode: number, payload: Uint8Array) =>
      lock
        .withPermits(1)(transport.write(encodeFrame(opcode, payload)))
        .pipe(Effect.mapError(() => failed("Closed", "The Simulator's input socket closed.")));

    yield* transport
      .write(upgradeRequest(port, path, token, key))
      .pipe(Effect.mapError(() => unreachable(port)));

    const step = (state: Upgrade, chunk: Uint8Array): readonly [Upgrade, ReadonlyArray<Frame>] => {
      if (state.phase === "open") return [state, state.decode(chunk)];
      const buffer = concatBytes(state.buffer, chunk);
      const head = readHead(buffer);

      if (head.kind === "more") return [{ phase: "head", buffer }, []];

      if (head.kind === "invalid" || !upgraded(head.head, key))
        return [
          state,
          [
            {
              kind: "invalid",
              reason: head.kind === "done" ? `HTTP ${head.head.status}` : "bad upgrade response",
            },
          ],
        ];
      const decode = frameDecoder();

      return [{ phase: "open", decode }, decode(head.rest)];
    };

    const reply = (opcode: number, payload: Uint8Array) => Effect.ignore(write(opcode, payload));

    const handle = (frame: Frame): Effect.Effect<ReadonlyArray<SocketEvent>> => {
      switch (frame.kind) {
        case "ping":
          return Effect.as(reply(OPCODE.pong, frame.data), []);
        case "pong":
          return Effect.succeed([]);
        case "close":
          return Effect.as(reply(OPCODE.close, closePayload(1000)), [frame]);
        case "invalid":
          return Effect.as(reply(OPCODE.close, closePayload(1002)), [closed(1002, frame.reason)]);
        default:
          return Effect.succeed([frame]);
      }
    };

    const messages = transport.incoming.pipe(
      Stream.mapError(() => unreachable(port)),
      Stream.mapAccum((): Upgrade => ({ phase: "head", buffer: new Uint8Array() }), step),
      Stream.mapEffect(handle),
      Stream.flattenIterable,
      // A connection that ends without a close frame closes abnormally (1006).
      Stream.concat(Stream.succeed(closed(1006, ""))),
      Stream.takeUntil((event) => event.kind === "close")
    );

    return {
      messages,
      send: (message) =>
        message.kind === "text"
          ? write(OPCODE.text, Buffer.from(message.text, "utf8"))
          : write(OPCODE.binary, message.data),
    };
  });

/** The paths the renderer may reach, all built here: never the hub's other routes. */
export const hubPaths = {
  video: (id: string, format: "avcc" | "mjpeg") =>
    `/vendor/serve-sim/helper/${encodeURIComponent(id)}/stream.${format}`,
  socket: (id: string, platform: "ios" | "android") =>
    platform === "ios"
      ? `/vendor/serve-sim/helper/ws?device=${encodeURIComponent(id)}`
      : `/vendor/serve-emu/ws?device=${encodeURIComponent(id)}&frame-meta=1`,
};
