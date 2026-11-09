/**
 * The app's end of one mounted frame (ENG-634): raw WebView messages are size- and rate-limited
 * before they are parsed, heights land once per animation frame, and `pv.state` goes to the shared writer.
 */
import {
  type BridgeClock,
  coalesced,
  FRAME_MESSAGE_MAX_BYTES,
  frameInbox,
  laneOfText,
  timerClock,
} from "@polaris/visualization";
import { Match } from "effect";
import { clampHeight, parseFrameMessage } from "./model.ts";
import type { VisualizationStateStore } from "./stateStore.ts";
import { holdWriter } from "./stateWriter.ts";

export interface BridgeHandlers {
  readonly onHeight: (height: number) => void;
  readonly onOpenLink: (url: string) => void;
}

export interface FrameBridge {
  /** A WebView message's raw `data`. */
  readonly receive: (data: string) => void;
  /** Unmount or sheet close: the latest state still waiting is written, then the writer let go. */
  readonly close: () => void;
}

/** Runs `run` on the next animation frame; returns its cancel. */
export type NextFrame = (run: () => void) => () => void;

const animationFrame: NextFrame = (run) => {
  const frame = requestAnimationFrame(run);

  return () => cancelAnimationFrame(frame);
};

export const openBridge = (
  id: string,
  store: VisualizationStateStore,
  handlers: () => BridgeHandlers,
  nextFrame: NextFrame = animationFrame,
  clock: BridgeClock = timerClock
): FrameBridge => {
  const held = holdWriter(id, store, clock.schedule);
  const heights = coalesced<number>((height) => handlers().onHeight(height), nextFrame);

  const inbox = frameInbox<string>((data) => {
    const message = parseFrameMessage(data);

    if (message === null) return;
    Match.value(message).pipe(
      Match.discriminatorsExhaustive("type")({
        "pv:height": ({ height }) => {
          const clamped = clampHeight(height);

          if (clamped !== null) heights.offer(clamped);
        },
        "pv:open-link": ({ url }) => handlers().onOpenLink(url),
        "pv:state": ({ state }) => {
          held.writer.offer(state);
        },
      })
    );
  }, clock);

  let closed = false;

  return {
    receive: (data) => {
      if (closed || data.length > FRAME_MESSAGE_MAX_BYTES) return;
      inbox.receive(laneOfText(data), data);
    },
    close: () => {
      if (closed) return;
      closed = true;
      heights.cancel();
      inbox.flush();
      held.release();
      inbox.dispose();
    },
  };
};
