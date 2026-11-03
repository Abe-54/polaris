/**
 * The sheet's motion on the UI thread: its visible height as a shared value, springs between
 * detents carrying the finger's velocity, and short fades instead under Reduce Motion.
 */
import { haptics } from "../motion/haptics.ts";
import { useEffect, useRef, useState } from "react";
import {
  cancelAnimation,
  Easing,
  ReduceMotion,
  type SharedValue,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import { FLICK_VELOCITY, type Settle } from "./detents.ts";

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/** A short fade or settle under Reduce Motion: no travel, no overshoot. */
const FADE = { duration: 200, easing: EASE_OUT, reduceMotion: ReduceMotion.Never };

const OPEN_SPRING = { duration: 400, dampingRatio: 1, reduceMotion: ReduceMotion.Never };

const DISMISS_SPRING = {
  duration: 300,
  dampingRatio: 1,
  overshootClamping: true,
  reduceMotion: ReduceMotion.Never,
};

/** Bounce only when the release carried momentum. */
const settleSpring = (velocity: number) => {
  "worklet";

  return {
    duration: 300,
    dampingRatio: Math.abs(velocity) >= FLICK_VELOCITY ? 0.8 : 1,
    velocity,
    reduceMotion: ReduceMotion.Never,
  };
};

// A detent catching is one light tap; a device without a Taptic Engine rejects it.
const tapDetent = haptics.detent;

export interface SheetMotion {
  /** The sheet's visible height in points; zero is closed. */
  readonly visible: SharedValue<number>;
  /** One, except while fading under Reduce Motion. */
  readonly opacity: SharedValue<number>;
  /** The detent the sheet rests at or is heading to; -1 while dismissing. */
  readonly index: SharedValue<number>;
  /** The height to lay the content out at: the taller of where it rests and where it goes. */
  readonly layoutHeight: number;
  /** The detent it rests at, on the React side. */
  readonly restingIndex: number;
  /** Drawn at all: open, or still closing. */
  readonly mounted: boolean;
  /** Settles a released drag; a worklet. */
  readonly settleTo: (settle: Settle, velocity: number) => void;
  /** Moves to a detent from React (VoiceOver's adjust actions). */
  readonly goTo: (index: number) => void;
}

export interface MotionInput {
  readonly open: boolean;
  /** The detent it opens at. */
  readonly initialIndex: number;
  readonly heights: readonly number[];
  readonly reduced: boolean;
  readonly dismissible: boolean;
  readonly onClose: () => void;
  readonly onDetentChange: ((index: number) => void) | undefined;
}

interface Values {
  readonly visible: SharedValue<number>;
  readonly opacity: SharedValue<number>;
  readonly index: SharedValue<number>;
}

const openingDetent = (heights: readonly number[], wanted: number) =>
  Math.max(0, Math.min(wanted, heights.length - 1));

/** Mounts on open and springs (or fades) in; springs (or fades) out, then unmounts. */
const useLifecycle = (input: MotionInput, { visible, opacity, index }: Values): boolean => {
  const { open, reduced } = input;
  const [mounted, setMounted] = useState(open);
  const latest = useRef(input);

  latest.current = input;

  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (!open || !mounted) return;

    const { heights, initialIndex } = latest.current;
    const first = openingDetent(heights, initialIndex);
    const opening = heights[first] ?? 0;

    index.set(first);

    if (latest.current.reduced) {
      visible.set(opening);
      opacity.set(0);
      opacity.set(withTiming(1, FADE));
    } else {
      opacity.set(1);
      visible.set(withSpring(opening, OPEN_SPRING));
    }
  }, [open, mounted, index, opacity, visible]);

  useEffect(() => {
    if (open || !mounted) return;

    const done = (finished?: boolean) => {
      "worklet";

      if (finished === true) scheduleOnRN(setMounted, false);
    };

    index.set(-1);

    if (reduced) opacity.set(withTiming(0, FADE, done));
    else visible.set(withSpring(0, DISMISS_SPRING, done));
  }, [open, mounted, reduced, index, opacity, visible]);

  return mounted;
};

/** Keeps the sheet at the same detent when the keyboard or a rotation moves the heights. */
const useFollowHeights = (heights: readonly number[], values: Values, mounted: boolean) => {
  const { visible, index } = values;
  const key = heights.join(",");
  const latest = useRef(heights);
  const followed = useRef(key);

  latest.current = heights;

  useEffect(() => {
    const at = index.get();
    const changed = followed.current !== key;

    followed.current = key;

    // Opening sets its own target; only a change of heights moves an open sheet.
    if (!mounted || !changed || at < 0) return;

    const target = latest.current[Math.min(at, latest.current.length - 1)] ?? 0;

    visible.set(withTiming(target, FADE));
  }, [key, mounted, index, visible]);
};

export const useSheetMotion = (input: MotionInput): SheetMotion => {
  const { heights, reduced, dismissible, onClose, onDetentChange } = input;
  const visible = useSharedValue(0);
  const opacity = useSharedValue(1);
  const index = useSharedValue(0);
  const values = { visible, opacity, index };
  const [resting, setResting] = useState(0);
  const [goingTo, setGoingTo] = useState(0);

  const rest = (next: number) => {
    setResting(next);
    onDetentChange?.(next);
  };

  const settleTo = (settle: Settle, velocity: number) => {
    "worklet";

    if (settle.kind === "dismiss" && dismissible) {
      index.set(-1);
      scheduleOnRN(onClose);

      if (reduced) opacity.set(withTiming(0, FADE));
      else visible.set(withSpring(0, { ...DISMISS_SPRING, velocity }));

      return;
    }

    const next = settle.kind === "detent" ? settle.index : 0;

    if (next !== index.get()) scheduleOnRN(tapDetent);

    index.set(next);
    scheduleOnRN(setGoingTo, next);

    const done = (finished?: boolean) => {
      "worklet";

      if (finished === true) scheduleOnRN(rest, next);
    };

    const height = heights[next] ?? 0;

    visible.set(
      reduced ? withTiming(height, FADE, done) : withSpring(height, settleSpring(velocity), done)
    );
  };

  const goTo = (next: number) => {
    cancelAnimation(visible);
    scheduleOnUI(settleTo, { kind: "detent", index: next }, 0);
  };

  const mounted = useLifecycle(input, values);
  const latest = useRef(input);

  latest.current = input;

  useEffect(() => {
    if (!input.open) return;

    const first = openingDetent(latest.current.heights, latest.current.initialIndex);

    setResting(first);
    setGoingTo(first);
  }, [input.open]);

  useFollowHeights(heights, values, mounted);

  return {
    visible,
    opacity,
    index,
    layoutHeight: Math.max(heights[resting] ?? 0, heights[goingTo] ?? 0),
    restingIndex: resting,
    mounted,
    settleTo,
    goTo,
  };
};
