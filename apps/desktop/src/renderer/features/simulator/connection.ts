/**
 * One Simulator's live stream and input, outside React: video onto the canvas, input in order
 * once admitted, barriers for liveness, and reconnects. React hears only `SimulatorStatus`.
 */
import type { SimulatorSocketMessage } from "../../../shared/simulatorContract.ts";
import { avccDemuxer } from "./avcc.ts";
import type { Size } from "./geometry.ts";
import { ANDROID_SILENCE_MS, barrierWatch, LIVENESS } from "./liveness.ts";
import { freshFrames, mjpegParser } from "./mjpeg.ts";
import {
  androidInput,
  type HardwareButton,
  iosInput,
  type Orientation,
  readIos,
  rotatedLeft,
} from "./protocol.ts";
import type { HubTarget, InputSocket, SimulatorTransport } from "./transport.ts";
import {
  annexBDecoder,
  avccDecoder,
  canvasPainter,
  type DecoderFailure,
  jpegPainter,
} from "./video.ts";

export type StreamPhase = "connecting" | "live" | "reconnecting" | "failed";

export interface SimulatorStatus {
  readonly phase: StreamPhase;
  /** Input isn't reaching the Simulator (barrier unanswered or failed; Android: no frames). */
  readonly stalled: boolean;
  /** The frame's size in pixels, once one has painted. */
  readonly screen: Size | null;
  readonly format: "avcc" | "mjpeg" | "annexb";
  readonly orientation: Orientation | null;
  /** Why the stream failed or is reconnecting, as the hub or the bridge said it. */
  readonly detail: string | null;
}

/** Retries after a drop, then the stream fails until `reconnect`. */
const RETRY_MS = [500, 1000, 2000, 4000, 8000];

/** Input queued before admission past this is dropped: it would land long after it was meant. */
const MAX_QUEUED = 256;

const TICK_MS = 500;

export interface ConnectionInput {
  readonly transport: SimulatorTransport;
  readonly target: HubTarget;
  readonly canvas: HTMLCanvasElement;
  readonly status: (status: SimulatorStatus) => void;
  /** Set to skip WebCodecs and use MJPEG (local Hosts only). */
  readonly preferMjpeg?: boolean;
}

export interface SimulatorConnection {
  readonly send: (
    planned: ReadonlyArray<{ readonly at: number; readonly message: SimulatorSocketMessage }>
  ) => void;
  readonly touch: (type: "begin" | "move" | "end", x: number, y: number, at: number) => void;
  readonly button: (button: HardwareButton) => void;
  readonly rotate: () => void;
  readonly key: (
    type: "down" | "up",
    code: { usage: number | null; key: string; android: number | null }
  ) => void;
  readonly scroll: (scroll: { dx: number; dy: number; x: number; y: number }) => void;
  readonly reconnect: () => void;
  readonly dispose: () => void;
}

const same = (a: SimulatorStatus, b: SimulatorStatus) =>
  a.phase === b.phase &&
  a.stalled === b.stalled &&
  a.format === b.format &&
  a.orientation === b.orientation &&
  a.detail === b.detail &&
  a.screen?.width === b.screen?.width &&
  a.screen?.height === b.screen?.height;

export const connectSimulator = (input: ConnectionInput): SimulatorConnection => {
  const { transport, target } = input;
  const ios = target.platform === "ios";

  let format: SimulatorStatus["format"] = !ios
    ? "annexb"
    : input.preferMjpeg === true && transport.local
      ? "mjpeg"
      : "avcc";

  let status: SimulatorStatus = {
    phase: "connecting",
    stalled: false,
    screen: null,
    format,
    orientation: null,
    detail: null,
  };

  const update = (patch: Partial<SimulatorStatus>) => {
    const next = { ...status, ...patch };

    if (same(status, next)) return;
    status = next;
    input.status(status);
  };

  const painter = canvasPainter(input.canvas, (screen) => update({ screen }));
  let disposed = false;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let stopVideo = () => {};

  let socket: InputSocket | null = null;
  let admitted = false;
  let queued: Array<SimulatorSocketMessage> = [];
  let watch = barrierWatch();
  let lastFrameAt = 0;
  let socketOpenedAt = 0;
  /** The hub's config says HID couldn't be set up for this Simulator. */
  let inputUnavailable = false;
  let lastSendAt = Promise.resolve();

  const deliver = (message: SimulatorSocketMessage) => {
    if (socket !== null && admitted) return socket.send(message);

    if (queued.length < MAX_QUEUED) queued.push(message);
  };

  /** iOS: admission overdue, input unavailable, or a barrier stuck or failed. */
  const stalledNow = (now = performance.now()) =>
    inputUnavailable ||
    (admitted ? watch.stalled(now) : now - socketOpenedAt >= LIVENESS.answerWithinMs);

  const barrier = () => {
    if (!ios || !admitted) return;
    deliver(iosInput.barrier(watch.sent(performance.now())));
  };

  const teardown = () => {
    generation++;
    stopVideo();
    stopVideo = () => {};

    socket?.close();
    socket = null;
    admitted = false;
    queued = [];
  };

  const dropped = (detail: string) => {
    if (disposed) return;
    teardown();

    if (attempt >= RETRY_MS.length) return update({ phase: "failed", detail });
    const wait = RETRY_MS[attempt++]!;

    update({ phase: "reconnecting", detail });
    retry = setTimeout(() => {
      retry = null;
      open();
    }, wait);
  };

  const decoderFailed = (failure: DecoderFailure, message: string) => {
    // MJPEG is the fallback on a local Host; a remote one never streams it (60× the bandwidth).
    if (failure === "unsupported" && ios && transport.local && format === "avcc") {
      format = "mjpeg";
      update({ format });
      teardown();

      return open();
    }

    dropped(message);
  };

  const live = (mine: number) => () => {
    if (mine !== generation) return false;
    lastFrameAt = performance.now();

    if (status.phase !== "live") {
      attempt = 0;
      update({ phase: "live", detail: null });
    }

    return true;
  };

  const openAvcc = (mine: number) => {
    const demux = avccDemuxer();
    const decoder = avccDecoder({ painter, failed: decoderFailed });
    const frame = live(mine);

    const stop = transport.video(target, "avcc", {
      bytes: (chunks) => {
        for (const bytes of chunks) {
          const read = demux.push(bytes);

          if (read.kind === "invalid") return dropped("The video stream broke.");

          for (const chunk of read.chunks) if (frame()) decoder.push(chunk);
        }
      },
      end: (error) => {
        if (mine === generation) dropped(error?.message ?? "The video stream ended.");
      },
    });

    return () => {
      stop();
      decoder.close();
    };
  };

  const openMjpeg = (mine: number) => {
    const parse = mjpegParser();
    const fresh = freshFrames();
    const paint = jpegPainter(painter, false);
    const frame = live(mine);

    return transport.video(target, "mjpeg", {
      bytes: (chunks) => {
        for (const bytes of chunks) {
          const read = parse.push(bytes);

          if (read.kind === "invalid") return dropped("The video stream broke.");

          for (const jpeg of fresh(read.frames)) if (frame()) paint(jpeg);
        }
      },
      end: (error) => {
        if (mine === generation) dropped(error?.message ?? "The video stream ended.");
      },
    });
  };

  const onIosMessage = (data: Uint8Array) => {
    const event = readIos(data);

    if (event.kind === "admitted") {
      admitted = true;
      watch = barrierWatch();
      queued.splice(0).forEach(deliver);
      barrier();
    } else if (event.kind === "config") {
      inputUnavailable = event.config.inputUnavailable;
      update({ orientation: event.config.orientation, stalled: stalledNow() });
    } else if (event.kind === "barrier") {
      watch.answered(event.requestId, event.ok);
      update({ stalled: stalledNow() });
    }
  };

  const openSocket = (mine: number, android: ReturnType<typeof annexBDecoder> | null) => {
    const frame = live(mine);

    socketOpenedAt = performance.now();
    inputUnavailable = false;
    socket = transport.socket(target, {
      open: () => {
        // Android admits at once; iOS waits for 0x83.
        if (!ios && mine === generation) {
          admitted = true;
          queued.splice(0).forEach(deliver);
        }
      },
      message: (message) => {
        if (mine !== generation || message.kind !== "binary") return;

        if (ios) return onIosMessage(message.data);

        if (frame()) android?.push(message.data);
      },
      closed: (code, reason) => {
        if (mine !== generation) return;
        // 1013: the session isn't running, or 8 input sockets are already open.
        dropped(
          code === 1013
            ? "The Simulator isn't taking input yet."
            : reason || `Input closed (${code}).`
        );
      },
    });
  };

  function open() {
    if (disposed) return;
    const mine = ++generation;

    painter.reset();
    update({ phase: status.phase === "live" ? "reconnecting" : status.phase, stalled: false });

    if (!ios) {
      const decoder = annexBDecoder({ painter, failed: decoderFailed });

      lastFrameAt = performance.now();
      openSocket(mine, decoder);
      stopVideo = decoder.close;

      return;
    }

    stopVideo = format === "mjpeg" ? openMjpeg(mine) : openAvcc(mine);
    openSocket(mine, null);
  }

  const tick = setInterval(() => {
    const now = performance.now();

    if (status.phase !== "live") return;

    if (!ios) return update({ stalled: now - lastFrameAt >= ANDROID_SILENCE_MS });

    if (watch.due(now)) barrier();
    update({ stalled: stalledNow(now) });
  }, TICK_MS);

  open();

  const send = (
    planned: ReadonlyArray<{ readonly at: number; readonly message: SimulatorSocketMessage }>
  ) => {
    for (const { at, message } of planned) {
      // Each waits for the one before, so a held tap's end can't pass a later begin.
      lastSendAt = lastSendAt.then(
        () =>
          new Promise<void>((done) => {
            const wait = at - performance.now();

            if (wait <= 0) return done(deliver(message));
            setTimeout(() => done(deliver(message)), wait);
          })
      );
    }
  };

  const touchMessage = (type: "begin" | "move" | "end", x: number, y: number) =>
    ios ? iosInput.touch(type, x, y) : androidInput.touch(type, x, y);

  return {
    send,
    touch: (type, x, y, at) => {
      send([{ at, message: touchMessage(type, x, y) }]);

      // The touch reached HID once this is answered (spike: within 3 ms).
      if (type === "end" && ios) lastSendAt = lastSendAt.then(barrier);
    },
    button: (button) => deliver(ios ? iosInput.button(button) : androidInput.button(button)),
    rotate: () => {
      if (ios) deliver(iosInput.orientation(rotatedLeft(status.orientation)));
    },
    key: (type, code) => {
      if (ios) {
        if (code.usage !== null)
          deliver(iosInput.key(type, code.usage, code.key.length === 1 ? code.key : undefined));

        return;
      }

      if (code.android !== null) deliver(androidInput.key(code.android, type));
      else if (type === "down" && code.key.length === 1) deliver(androidInput.text(code.key));
    },
    scroll: (scroll) => {
      if (ios) deliver(iosInput.scroll(scroll));
    },
    reconnect: () => {
      if (retry !== null) clearTimeout(retry);
      retry = null;
      attempt = 0;
      teardown();
      update({ phase: "connecting", detail: null });
      open();
    },
    dispose: () => {
      disposed = true;
      clearInterval(tick);

      if (retry !== null) clearTimeout(retry);
      teardown();
    },
  };
};
