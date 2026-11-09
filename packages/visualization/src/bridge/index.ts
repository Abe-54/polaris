/**
 * The app's side of the frame bridge, shared by both hosts (ENG-634): what a frame's messages may
 * cost before they are parsed, how often they are handled, and how often a frame may ask to open a link.
 * These are resource limits on a hostile frame, not a channel to the agent.
 */
import { Predicate } from "effect";
import type { FrameMessage } from "../index.ts";

/** A raw message longer than this (UTF-16 units, so UTF-8 bytes too) is dropped unparsed. */
export const FRAME_MESSAGE_MAX_BYTES = 72 * 1024;

/** Messages a frame may have handled per second; a kit slider drag stays well under it. */
export const FRAME_MESSAGE_RATE = 240;

export interface BridgeClock {
  readonly now: () => number;
  /** Runs `run` after `ms`; returns its cancel. */
  readonly schedule: (run: () => void, ms: number) => () => void;
}

export const timerClock: BridgeClock = {
  now: () => Date.now(),
  schedule: (run, ms) => {
    const timer = setTimeout(run, ms);

    return () => clearTimeout(timer);
  },
};

/**
 * Which kind a message says it is, read without parsing it. Over the rate, the latest `height` and
 * `state` wait for the next slot (so a flood can't lose a slider's last value); anything else is dropped.
 */
export type FrameLane = "height" | "state" | "other";

const LANES = new Map<string, FrameLane>([
  ["pv:height", "height"],
  ["pv:state", "state"],
]);

/** The lane of a message's `type` (Desktop: the posted object's own property). */
export const laneOfType = (type: string | undefined): FrameLane =>
  (type === undefined ? undefined : LANES.get(type)) ?? "other";

const LEADING_TYPE = /^\s*\{\s*"type"\s*:\s*"(pv:[a-z-]+)"/;

/** The lane a JSON message names first, as the kit writes it (Mobile); a guess, checked on parse. */
export const laneOfText = (text: string): FrameLane =>
  laneOfType(LEADING_TYPE.exec(text.slice(0, 64))?.[1]);

export interface FrameInbox<T> {
  readonly receive: (lane: FrameLane, message: T) => void;
  /** Drops what is waiting (the frame is going away); call `flush` first to keep it. */
  readonly dispose: () => void;
  /** Handles what is waiting now, whatever the rate. */
  readonly flush: () => void;
}

/** A token bucket of `rate` per second in front of `handle`, latest-wins per lane when full. */
export const frameInbox = <T>(
  handle: (message: T) => void,
  clock: BridgeClock = timerClock,
  rate: number = FRAME_MESSAGE_RATE
): FrameInbox<T> => {
  let tokens = rate;
  let at = clock.now();
  const waiting = new Map<FrameLane, T>();
  let cancel: (() => void) | null = null;

  const take = () => {
    const now = clock.now();

    tokens = Math.min(rate, tokens + ((now - at) * rate) / 1000);
    at = now;

    if (tokens < 1) return false;
    tokens -= 1;

    return true;
  };

  const drain = () => {
    cancel = null;

    for (const [lane, message] of waiting) {
      if (!take()) break;
      waiting.delete(lane);
      handle(message);
    }

    if (waiting.size > 0) cancel = clock.schedule(drain, Math.ceil(1000 / rate));
  };

  return {
    receive: (lane, message) => {
      if (lane === "other" || waiting.size === 0) {
        if (take()) {
          handle(message);

          return;
        }

        if (lane === "other") return;
      }

      // Re-inserted so lanes drain in the order their latest message arrived.
      waiting.delete(lane);
      waiting.set(lane, message);
      cancel ??= clock.schedule(drain, Math.ceil(1000 / rate));
    },
    dispose: () => {
      cancel?.();
      cancel = null;
      waiting.clear();
    },
    flush: () => {
      cancel?.();
      cancel = null;
      const pending = [...waiting.values()];

      waiting.clear();
      pending.forEach(handle);
    },
  };
};

export interface Coalesced<T> {
  readonly offer: (value: T) => void;
  readonly cancel: () => void;
}

/** Delivers only the latest value once per `schedule` tick (an animation frame), and only a change. */
export const coalesced = <T>(
  deliver: (value: T) => void,
  schedule: (run: () => void) => () => void
): Coalesced<T> => {
  let latest: { readonly value: T } | null = null;
  let delivered: { readonly value: T } | null = null;
  let cancel: (() => void) | null = null;

  const run = () => {
    cancel = null;

    if (latest === null || (delivered !== null && Object.is(delivered.value, latest.value))) return;
    delivered = latest;
    deliver(latest.value);
  };

  return {
    offer: (value) => {
      latest = { value };
      cancel ??= schedule(run);
    },
    cancel: () => {
      cancel?.();
      cancel = null;
    },
  };
};

/** A frame's posted `pv.state`, as structured clone delivered it. */
type PostedState = Extract<FrameMessage, { readonly type: "pv:state" }>["state"];

class TooLarge extends Error {}

/**
 * `value` as JSON, or null when it isn't JSON or its text would pass `maxBytes`: the walk stops
 * as soon as the count does, so a huge object costs about `maxBytes` of work, not its own size.
 */
export const boundedJson = (value: PostedState, maxBytes: number): string | null => {
  let count = 0;

  try {
    const text = JSON.stringify(value, (key: string, part: PostedState) => {
      count += key.length + 4 + (Predicate.isString(part) ? part.length : 0);

      if (count > maxBytes) throw new TooLarge();

      return part;
    });

    return text === undefined || text.length > maxBytes ? null : text;
  } catch {
    return null;
  }
};

/** After a confirm closes, how long before the same frame may ask again. */
export const LINK_CONFIRM_COOLDOWN_MS = 1000;

/** Confirms declined in a row after which a frame's link requests are dropped until it remounts. */
export const LINK_CONFIRM_MAX_DECLINED = 3;

export interface LinkConfirms {
  /** True when a confirm may be shown now; it then counts as open until `settled`. */
  readonly request: () => boolean;
  readonly settled: (opened: boolean) => void;
}

/**
 * One frame's "Open this link?" requests, bounded: one confirm at a time, a pause after each, and
 * none after `LINK_CONFIRM_MAX_DECLINED` declined in a row. An opened link resets the count.
 */
export const linkConfirms = (now: () => number = Date.now): LinkConfirms => {
  let open = false;
  let closedAt = Number.NEGATIVE_INFINITY;
  let declined = 0;

  return {
    request: () => {
      if (open || declined >= LINK_CONFIRM_MAX_DECLINED) return false;

      if (now() - closedAt < LINK_CONFIRM_COOLDOWN_MS) return false;
      open = true;

      return true;
    },
    settled: (opened) => {
      if (!open) return;
      open = false;
      closedAt = now();
      declined = opened ? 0 : declined + 1;
    },
  };
};
