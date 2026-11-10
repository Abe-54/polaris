/**
 * One pointer's touch on the Simulator, planned as the hub's touch messages with the time each
 * goes out. iOS reads the gap between begin and end: about 60 ms is a tap, a second is a long
 * press (spike surprise 9), so the user's own hold is kept, and only a too-quick click is held.
 */
import type { ScreenPoint } from "./geometry.ts";

export const TOUCH = {
  /** A pointer that stays within this many CSS pixels of where it went down hasn't moved. */
  slopPx: 6,
  /** A click shorter than this (a trackpad tap) is held this long, so iOS sees a touch. */
  minHoldMs: 50,
} as const;

export interface TouchMessage {
  readonly type: "begin" | "move" | "end";
  readonly x: number;
  readonly y: number;
  /** When to send it, on the caller's clock; never before the message ahead of it. */
  readonly at: number;
}

interface Pointer {
  /** Screen fraction, which the hub takes. */
  readonly point: ScreenPoint;
  /** CSS pixels, for the slop. */
  readonly client: { readonly x: number; readonly y: number };
}

interface Down {
  readonly origin: Pointer;
  readonly startedAt: number;
  readonly moved: boolean;
  readonly last: ScreenPoint;
}

export interface TouchTracker {
  readonly down: (pointer: Pointer, at: number) => ReadonlyArray<TouchMessage>;
  readonly move: (pointer: Pointer, at: number) => ReadonlyArray<TouchMessage>;
  readonly up: (pointer: Pointer, at: number) => ReadonlyArray<TouchMessage>;
  /** The pointer was lost (capture lost, window blurred): the touch ends where it last was. */
  readonly cancel: (at: number) => ReadonlyArray<TouchMessage>;
  readonly active: () => boolean;
}

const message = (type: TouchMessage["type"], point: ScreenPoint, at: number): TouchMessage => ({
  type,
  x: point.x,
  y: point.y,
  at,
});

const beyondSlop = (a: Pointer["client"], b: Pointer["client"]) =>
  Math.hypot(a.x - b.x, a.y - b.y) > TOUCH.slopPx;

export const touchTracker = (): TouchTracker => {
  let current: Down | null = null;

  const end = (point: ScreenPoint, at: number) => {
    if (current === null) return [];
    const startedAt = current.startedAt;

    current = null;

    return [message("end", point, Math.max(at, startedAt + TOUCH.minHoldMs))];
  };

  return {
    down: (pointer, at) => {
      // A second down without an up (a lost pointerup): finish the first touch first.
      const finished = current === null ? [] : end(current.last, at);

      current = { origin: pointer, startedAt: at, moved: false, last: pointer.point };

      return [...finished, message("begin", pointer.point, at)];
    },
    move: (pointer, at) => {
      if (current === null) return [];

      if (!current.moved && !beyondSlop(pointer.client, current.origin.client)) return [];
      current = { ...current, moved: true, last: pointer.point };

      return [message("move", pointer.point, at)];
    },
    up: (pointer, at) => {
      if (current === null) return [];

      // A tap ends where it began: a hand's wobble within the slop isn't a drag.
      return end(current.moved ? pointer.point : current.origin.point, at);
    },
    cancel: (at) => (current === null ? [] : end(current.last, at)),
    active: () => current !== null,
  };
};

/** Wheel or trackpad scrolling as the hub's scroll message: content follows the fingers. */
export const scrollOf = (
  delta: { readonly x: number; readonly y: number },
  screen: { readonly width: number; readonly height: number },
  at: ScreenPoint
) =>
  screen.width <= 0 || screen.height <= 0
    ? null
    : { dx: -delta.x / screen.width, dy: -delta.y / screen.height, x: at.x, y: at.y };
