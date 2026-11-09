/**
 * The input socket's messages. iOS (serve-sim `/ws`): binary `[tag: u8][UTF-8 JSON]`. Android
 * (serve-emu `/ws`): text JSON gestures out, H.264 access units and text events in.
 */
import { Option, Schema } from "effect";
import type { SimulatorSocketMessage } from "../../../shared/simulatorContract.ts";

export const IOS_TAG = {
  touch: 0x03,
  button: 0x04,
  key: 0x06,
  orientation: 0x07,
  scroll: 0x0b,
  barrier: 0x11,
  /** Server: input admitted, one byte alone, before any input may go. */
  admitted: 0x83,
  /** Server: the screen's config, after admission and on every change. */
  config: 0x82,
  /** Server: a barrier's answer. */
  barrierDone: 0x91,
} as const;

export type Orientation =
  | "portrait"
  | "portrait_upside_down"
  | "landscape_left"
  | "landscape_right";

export type HardwareButton = "home" | "lock";

const encoder = new TextEncoder();

const decoder = new TextDecoder();

/** A JSON body the hub reads: a touch, button, key, orientation, scroll or barrier. */
type IosBody = Readonly<Record<string, string | number>>;

/** One of serve-emu's text gestures. */
interface AndroidGesture {
  readonly type: "touch" | "key" | "text" | "home" | "power";
  readonly [field: string]: string | number;
}

const ios = (tag: number, body?: IosBody): SimulatorSocketMessage => {
  const json = body === undefined ? new Uint8Array() : encoder.encode(JSON.stringify(body));
  const data = new Uint8Array(1 + json.length);

  data[0] = tag;
  data.set(json, 1);

  return { kind: "binary", data };
};

const android = (body: AndroidGesture): SimulatorSocketMessage => ({
  kind: "text",
  // Acks would only add traffic: liveness on Android is the frame flow.
  text: JSON.stringify({ ...body, ack: false }),
});

export const iosInput = {
  touch: (type: "begin" | "move" | "end", x: number, y: number) =>
    ios(IOS_TAG.touch, { type, x, y }),
  /** `lock` is the name serve-sim's native HID knows; on iOS 27.0 it had no visible effect. */
  button: (button: HardwareButton) => ios(IOS_TAG.button, { button }),
  key: (type: "down" | "up", usage: number, key?: string) =>
    ios(IOS_TAG.key, key === undefined ? { type, usage } : { type, usage, key }),
  orientation: (orientation: Orientation) => ios(IOS_TAG.orientation, { orientation }),
  scroll: (scroll: { dx: number; dy: number; x: number; y: number }) => ios(IOS_TAG.scroll, scroll),
  barrier: (requestId: number) => ios(IOS_TAG.barrier, { requestId }),
};

const ANDROID_TOUCH = { begin: "down", move: "move", end: "up" } as const;

export const androidInput = {
  touch: (type: "begin" | "move" | "end", x: number, y: number) =>
    android({ type: "touch", action: ANDROID_TOUCH[type], x, y }),
  button: (button: HardwareButton) => android({ type: button === "home" ? "home" : "power" }),
  key: (keycode: number, action: "down" | "up") => android({ type: "key", keycode, action }),
  text: (text: string) => android({ type: "text", text }),
};

export interface ScreenConfig {
  readonly width: number;
  readonly height: number;
  readonly orientation: Orientation | null;
  readonly inputUnavailable: boolean;
}

export type IosEvent =
  | { readonly kind: "admitted" }
  | { readonly kind: "config"; readonly config: ScreenConfig }
  | { readonly kind: "barrier"; readonly requestId: number | null; readonly ok: boolean }
  | { readonly kind: "other" };

const ORIENTATIONS = new Map<string, Orientation>(
  (["portrait", "portrait_upside_down", "landscape_left", "landscape_right"] as const).map(
    (orientation) => [orientation, orientation]
  )
);

const Config = Schema.fromJsonString(
  Schema.Struct({
    width: Schema.Number,
    height: Schema.Number,
    orientation: Schema.optional(Schema.String),
    inputUnavailable: Schema.optional(Schema.Unknown),
  })
);

const Barrier = Schema.fromJsonString(
  Schema.Struct({ requestId: Schema.optional(Schema.Number), ok: Schema.optional(Schema.Unknown) })
);

const decodeConfig = Schema.decodeUnknownOption(Config);

const decodeBarrier = Schema.decodeUnknownOption(Barrier);

const configOf = (rest: Uint8Array): IosEvent =>
  Option.match(decodeConfig(decoder.decode(rest)), {
    onNone: () => ({ kind: "other" }),
    onSome: ({ width, height, orientation, inputUnavailable }) => ({
      kind: "config",
      config: {
        width,
        height,
        orientation: ORIENTATIONS.get(orientation ?? "") ?? null,
        inputUnavailable: inputUnavailable === true,
      },
    }),
  });

/** A barrier's answer: `{ requestId, ok }`, or one byte 0 or 1 for a barrier without a body. */
const barrierOf = (rest: Uint8Array): IosEvent => {
  if (rest.length === 1 && (rest[0] === 0 || rest[0] === 1))
    return { kind: "barrier", requestId: null, ok: rest[0] === 1 };
  const body = Option.getOrNull(decodeBarrier(decoder.decode(rest)));

  return { kind: "barrier", requestId: body?.requestId ?? null, ok: body?.ok === true };
};

export const readIos = (data: Uint8Array): IosEvent => {
  const rest = data.subarray(1);

  switch (data[0]) {
    case IOS_TAG.admitted:
      return { kind: "admitted" };
    case IOS_TAG.config:
      return configOf(rest);
    case IOS_TAG.barrierDone:
      return barrierOf(rest);
    default:
      return { kind: "other" };
  }
};

/** The orientation after a quarter turn left (counterclockwise), as Simulator's Rotate Left. */
export const rotatedLeft = (from: Orientation | null): Orientation => {
  switch (from) {
    case "landscape_left":
      return "portrait_upside_down";
    case "portrait_upside_down":
      return "landscape_right";
    case "landscape_right":
      return "portrait";
    default:
      return "landscape_left";
  }
};
