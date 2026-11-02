/**
 * The Working dither (DESIGN.md, Dither) as @polaris/ui's Dither draws it: 2pt cells in the hue,
 * every frame in one strip stepped by a native-driven translate at 12 fps on one shared clock.
 */
import { DITHER_EXIT_MS, DITHER_FRAME_MS, DITHER_FRAMES } from "@polaris/ui/dither";
import { memo, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { AccessibilityInfo, Animated, Easing, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { ditherClock } from "./clock.ts";
import { type DitherArt, ditherSteps, ditherStill, ditherStrip } from "./strip.ts";

const clock = ditherClock<Animated.Value>((interrupted) => {
  const value = new Animated.Value(0);

  const animation = Animated.timing(value, {
    toValue: 1,
    duration: DITHER_FRAMES * DITHER_FRAME_MS,
    easing: (t) => t,
    iterations: -1,
    useNativeDriver: true,
  });

  animation.start(({ finished }) => {
    if (!finished) interrupted();
  });

  return { value, stop: () => animation.stop() };
});

void AccessibilityInfo.isReduceMotionEnabled().then(clock.setReduceMotion);

AccessibilityInfo.addEventListener("reduceMotionChanged", clock.setReduceMotion);

/** DESIGN.md, Motion: `--ease-out`. */
const EASE_OUT = Easing.bezier(0.215, 0.61, 0.355, 1);

const Art = ({ art, color }: { readonly art: DitherArt; readonly color: string }) => (
  <Svg width={art.width} height={art.height} viewBox={`0 0 ${art.width} ${art.height}`}>
    {art.layers.map((layer) => (
      <Path key={layer.alpha} d={layer.d} fill={color} fillOpacity={layer.alpha} />
    ))}
  </Svg>
);

/** Fades in over 200ms on mount and out over 200ms once `leaving`; instant under Reduce Motion. */
const useFade = (moving: boolean, leaving: boolean, reduceMotion: boolean): Animated.Value => {
  const opacity = useRef(new Animated.Value(moving && !reduceMotion ? 0 : 1)).current;

  useEffect(() => {
    if (!moving) return;
    const target = leaving ? 0 : 1;

    if (reduceMotion) {
      opacity.setValue(target);

      return;
    }

    const fade = Animated.timing(opacity, {
      toValue: target,
      duration: DITHER_EXIT_MS,
      easing: EASE_OUT,
      useNativeDriver: true,
    });

    fade.start();

    return () => fade.stop();
  }, [leaving, moving, opacity, reduceMotion]);

  return opacity;
};

export interface DitherProps {
  /** The Harness's hue, or Starlight for Polaris's own work. */
  readonly color: string;
  /** Square, in points; a multiple of the 2pt cell. */
  readonly size?: number;
  /** Only a Working agent session moves; a still field is the Starting pattern. */
  readonly moving?: boolean;
  /** Starting draws the still pattern at 50%. */
  readonly dim?: boolean;
  /** Fading out over 200ms after leaving Working; it keeps stepping meanwhile. */
  readonly leaving?: boolean;
  /** How dense and bright the field is (0–1); unset is the Working glyph's own. */
  readonly intensity?: number;
}

/** The signature dither; Reduce Motion stills a moving one to its first frame. */
export const Dither = memo(function Dither({
  color,
  size = 16,
  moving = false,
  dim = false,
  leaving = false,
  intensity,
}: DitherProps) {
  const { reduceMotion, value } = useSyncExternalStore(clock.subscribe, clock.snapshot);
  const opacity = useFade(moving, leaving, reduceMotion);

  useEffect(() => {
    return moving ? clock.acquire() : undefined;
  }, [moving]);

  const strip = moving && value !== null ? value : null;

  const transform = useMemo(
    () => (strip === null ? [] : [{ translateX: strip.interpolate(ditherSteps(size)) }]),
    [strip, size]
  );

  return (
    <View
      style={{
        width: size,
        height: size,
        overflow: "hidden",
        opacity: dim ? 0.5 : 1,
        pointerEvents: "none",
      }}
    >
      <Animated.View style={{ opacity, transform }}>
        <Art
          art={strip === null ? ditherStill(size, intensity) : ditherStrip(size, intensity)}
          color={color}
        />
      </Animated.View>
    </View>
  );
});
