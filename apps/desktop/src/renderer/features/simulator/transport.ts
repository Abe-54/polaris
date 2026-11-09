/**
 * How the stream reaches the hub. The renderer's CSP keeps it off loopback, so the bridge is
 * main's (`main/simulator`): a local socket for a local Host, a Host-address stream otherwise.
 */
import type { IpcError } from "../../../shared/api.ts";
import type { SimulatorPlatform } from "@polaris/protocol";
import type {
  SimulatorSocketMessage,
  SimulatorVideoFormat,
} from "../../../shared/simulatorContract.ts";
import { polaris } from "../bridge.ts";

/** What `simulator.attach` gave, and the Simulator to show. */
export interface HubTarget {
  readonly port: number;
  readonly token: string;
  readonly id: string;
  readonly platform: SimulatorPlatform;
}

export interface VideoSink {
  readonly bytes: (chunks: ReadonlyArray<Uint8Array>) => void;
  /** The body ended or failed; null for a clean end. */
  readonly end: (error: IpcError | null) => void;
}

export interface SocketSink {
  readonly open: () => void;
  readonly message: (message: SimulatorSocketMessage) => void;
  /** The socket closed (`code` as the hub sent it) or never opened. */
  readonly closed: (code: number, reason: string) => void;
}

export interface InputSocket {
  /** Sends in order; doesn't wait for earlier sends to be acknowledged. */
  readonly send: (message: SimulatorSocketMessage) => void;
  readonly close: () => void;
}

export interface SimulatorTransport {
  /** The Host's loopback is this machine's: only then may the stream fall back to MJPEG. */
  readonly local: boolean;
  readonly video: (target: HubTarget, format: SimulatorVideoFormat, sink: VideoSink) => () => void;
  readonly socket: (target: HubTarget, sink: SocketSink) => InputSocket;
}

/** The transport through main for the Host `hostKey`. */
export const bridgeTransport = (hostKey: string, local: boolean): SimulatorTransport => ({
  local,
  video: (target, format, sink) =>
    polaris().subscribe(
      "simulator.video",
      { hostKey, port: target.port, token: target.token, id: target.id, format },
      { items: sink.bytes, end: (error) => sink.end(error ?? null) }
    ),
  socket: (target, sink) => {
    let socketId: string | null = null;
    let closed = false;
    const queued: Array<SimulatorSocketMessage> = [];

    const send = (message: SimulatorSocketMessage) => {
      if (closed) return;

      if (socketId === null) return void queued.push(message);
      // Not awaited: a tap's end must not wait for its begin's round trip to a remote Host.
      void polaris().request("simulator.send", { socketId, message });
    };

    const close = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      sink.closed(code, reason);
    };

    const unsubscribe = polaris().subscribe(
      "simulator.socket",
      {
        hostKey,
        port: target.port,
        token: target.token,
        id: target.id,
        platform: target.platform,
      },
      {
        items: (items) => {
          for (const item of items) {
            if (item.kind === "open") {
              socketId = item.socketId;
              sink.open();
              queued.splice(0).forEach(send);
            } else if (item.kind === "close") close(item.code, item.reason);
            else sink.message(item);
          }
        },
        end: (error) => close(1006, error?.message ?? ""),
      }
    );

    return {
      send,
      close: () => {
        closed = true;
        unsubscribe();
      },
    };
  },
});
