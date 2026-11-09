/**
 * Frames onto the canvas, never through React: WebCodecs for H.264 (AVCC from serve-sim, Annex B
 * from serve-emu), image decoding for the seed JPEG and the local MJPEG fallback.
 */
import { codecOfAnnexB, readAccessUnit } from "./annexb.ts";
import { AVCC_TAG, type AvccChunk, codecOfAvcc } from "./avcc.ts";
import type { Size } from "./geometry.ts";
import { admitRaster } from "../../../shared/raster/index.ts";

export interface Painter {
  /** Paints a frame or image, then closes a frame. */
  readonly paint: (source: VideoFrame | ImageBitmap) => void;
  /** Whether a decoded video frame has been painted since the last reset. */
  readonly painted: () => boolean;
  readonly reset: () => void;
}

/** Paints onto `canvas`, resizing its bitmap to each frame's; `resized` hears every change. */
export const canvasPainter = (
  canvas: HTMLCanvasElement,
  resized: (size: Size) => void
): Painter => {
  const context = canvas.getContext("2d", { alpha: false });
  let videoPainted = false;

  return {
    paint: (source) => {
      const isFrame = !(source instanceof ImageBitmap);
      const width = source instanceof ImageBitmap ? source.width : source.displayWidth;
      const height = source instanceof ImageBitmap ? source.height : source.displayHeight;

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        resized({ width, height });
      }

      context?.drawImage(source, 0, 0, width, height);
      source.close();

      if (isFrame) videoPainted = true;
    },
    painted: () => videoPainted,
    reset: () => {
      videoPainted = false;
    },
  };
};

/** A JPEG to the painter, unless a newer one finished first; decoding is off the main thread. */
export const jpegPainter = (painter: Painter, skipAfterVideo: boolean) => {
  let latest = 0;

  return (jpeg: Uint8Array) => {
    if (admitRaster(jpeg).kind !== "admitted") return;
    const ticket = ++latest;

    // SAFETY: the parsers hand out copies, whose buffers are plain ArrayBuffers.
    void createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }))
      .then((image) => {
        if (ticket !== latest || (skipAfterVideo && painter.painted())) return image.close();
        painter.paint(image);
      })
      .catch(() => undefined);
  };
};

export type DecoderFailure = "unsupported" | "error";

export interface H264Decoder {
  readonly close: () => void;
}

interface DecoderInput {
  readonly painter: Painter;
  readonly failed: (failure: DecoderFailure, message: string) => void;
}

const LATENCY: Pick<VideoDecoderConfig, "optimizeForLatency" | "hardwareAcceleration"> = {
  optimizeForLatency: true,
  hardwareAcceleration: "no-preference",
};

/** A VideoDecoder that paints each frame and reports its own failures once. */
const liveDecoder = ({ painter, failed }: DecoderInput) => {
  let broken = false;

  const fail = (failure: DecoderFailure, message: string) => {
    if (broken) return;
    broken = true;
    failed(failure, message);
  };

  const decoder =
    typeof VideoDecoder === "undefined"
      ? null
      : new VideoDecoder({
          output: (frame) => painter.paint(frame),
          error: (error) => fail("error", error.message),
        });

  if (decoder === null) fail("unsupported", "This app can't decode video (no WebCodecs).");

  let clock = 0;

  return {
    configure: async (config: VideoDecoderConfig) => {
      const full = { ...config, ...LATENCY };
      const support = await VideoDecoder.isConfigSupported(full).catch(() => null);

      if (broken || decoder === null || decoder.state === "closed") return false;

      if (support?.supported !== true) {
        fail("unsupported", `This Mac can't decode ${config.codec}.`);

        return false;
      }

      decoder.configure(full);

      return true;
    },
    decode: (type: "key" | "delta", data: Uint8Array) => {
      if (broken || decoder?.state !== "configured") return;
      // Timestamps only order frames here; the hub's own clock isn't needed to show them.
      clock += 1000;
      decoder.decode(new EncodedVideoChunk({ type, timestamp: clock, data }));
    },
    close: () => {
      broken = true;

      if (decoder !== null && decoder.state !== "closed") decoder.close();
    },
  };
};

const sameBytes = (a: Uint8Array | null, b: Uint8Array) =>
  a !== null && a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * serve-sim's AVCC chunks: each description (re)configures the decoder, deltas wait for the
 * keyframe after it, and the seed JPEG paints until the first decoded frame.
 */
export const avccDecoder = (input: DecoderInput) => {
  const decoder = liveDecoder(input);
  const seed = jpegPainter(input.painter, true);
  let description: Uint8Array | null = null;
  /** Configuring: chunks wait in order until it's settled. */
  let ready: Promise<boolean> = Promise.resolve(false);
  let needsKey = true;

  const decode = (chunk: AvccChunk) => {
    if (chunk.tag === AVCC_TAG.keyframe) {
      needsKey = false;
      decoder.decode("key", chunk.payload);
    } else if (chunk.tag === AVCC_TAG.delta && !needsKey) decoder.decode("delta", chunk.payload);
  };

  return {
    push: (chunk: AvccChunk) => {
      if (chunk.tag === AVCC_TAG.seed) {
        if (!input.painter.painted()) seed(chunk.payload);

        return;
      }

      if (chunk.tag === AVCC_TAG.description) {
        if (sameBytes(description, chunk.payload)) return;
        description = chunk.payload;
        const codec = codecOfAvcc(chunk.payload);

        if (codec === null) return input.failed("error", "The stream's description is unreadable.");
        needsKey = true;
        ready = ready.then(() => decoder.configure({ codec, description: chunk.payload }));

        return;
      }

      ready = ready.then((ok) => {
        if (ok) decode(chunk);

        return ok;
      });
    },
    close: decoder.close,
  };
};

/** serve-emu's access units: the decoder configures from the first keyframe's SPS (Annex B). */
export const annexBDecoder = (input: DecoderInput) => {
  const decoder = liveDecoder(input);
  let codec: string | null = null;
  let ready: Promise<boolean> = Promise.resolve(false);

  return {
    push: (message: Uint8Array) => {
      const unit = readAccessUnit(message);

      if (unit === null) return;

      if (unit.keyframe) {
        const next = codecOfAnnexB(unit.data);

        if (next !== null && next !== codec) {
          codec = next;
          ready = ready.then(() => decoder.configure({ codec: next }));
        }
      }

      ready = ready.then((ok) => {
        if (ok) decoder.decode(unit.keyframe ? "key" : "delta", unit.data);

        return ok;
      });
    },
    close: decoder.close,
  };
};
