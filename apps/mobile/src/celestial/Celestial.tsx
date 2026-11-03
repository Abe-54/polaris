/**
 * An agent session's celestial (DESIGN.md, Celestials) drawn natively: @polaris/ui's cells in tones
 * of its Harness hue. Working steps a strip on one shared native-driven clock, never a timer per row.
 */
import type { CelestialBody, HarnessKind } from "@polaris/protocol";
import {
  bodyHue,
  CELESTIAL_FRAME_MS,
  CELESTIAL_FRAMES,
  CELESTIAL_GRID,
} from "@polaris/ui/celestial";
import { memo, useEffect, useMemo, useSyncExternalStore } from "react";
import { Animated, AppState, Platform, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useReducedMotion, useTheme } from "../theme";
import { type CelestialArt, celestialSteps, celestialStill, celestialStrip } from "./art.ts";
import { frameClock } from "./clock.ts";
import { type CelestialPalette, celestialPalette, harnessColour } from "./tones.ts";

const clock = frameClock<Animated.Value>((interrupted) => {
  const value = new Animated.Value(0);

  const animation = Animated.timing(value, {
    toValue: 1,
    duration: CELESTIAL_FRAMES * CELESTIAL_FRAME_MS,
    easing: (t) => t,
    iterations: -1,
    useNativeDriver: true,
  });

  animation.start(({ finished }) => {
    if (!finished) interrupted();
  });

  return { value, stop: () => animation.stop() };
});

AppState.addEventListener("change", (state) => clock.setForeground(state === "active"));

/** celestial.css's `--celestial-dormant` in both darks. */
const DORMANT_OPACITY = 0.45;

const Art = memo(function Art({
  art,
  palette,
  size,
}: {
  readonly art: CelestialArt;
  readonly palette: CelestialPalette;
  readonly size: number;
}) {
  return (
    <Svg
      width={(size * art.width) / CELESTIAL_GRID}
      height={size}
      viewBox={`0 0 ${art.width} ${CELESTIAL_GRID}`}
    >
      {art.layers.map((layer) => (
        <Path key={layer.tone} d={layer.d} fill={palette[layer.tone]} />
      ))}
    </Svg>
  );
});

export interface CelestialProps {
  readonly body: CelestialBody;
  /** Square, in points; a multiple of 8 keeps the 16 grid on whole pixels at 2× and 3×. */
  readonly size: number;
  /** Animates inside the body at 12 fps; Reduce Motion keeps it still. */
  readonly working?: boolean;
  /** Drawn in its Harness's hue (the Death Star in grey); an unknown or unhued Harness is neutral. */
  readonly harness: HarnessKind;
  readonly dormant?: boolean;
}

export const Celestial = memo(function Celestial({
  body,
  size,
  working = false,
  harness,
  dormant = false,
}: CelestialProps) {
  const { colours } = useTheme();
  const reduced = useReducedMotion();
  const { value } = useSyncExternalStore(clock.subscribe, clock.snapshot);
  const moving = working && !reduced;

  useEffect(() => {
    clock.setReduceMotion(reduced);
  }, [reduced]);
  useEffect(() => {
    return moving ? clock.acquire() : undefined;
  }, [moving]);

  const strip = moving ? value : null;
  const palette = celestialPalette(bodyHue(body) ?? harnessColour(colours, harness));

  const transform = useMemo(
    () => (strip === null ? [] : [{ translateX: strip.interpolate(celestialSteps(size)) }]),
    [strip, size]
  );

  return (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        overflow: "hidden",
        opacity: dormant ? DORMANT_OPACITY : 1,
        pointerEvents: "none",
      }}
    >
      <Animated.View
        // Android's native driver can leave the strip's translation on a reused still view.
        key={Platform.OS === "android" ? (strip === null ? "still" : "strip") : undefined}
        style={{ transform }}
      >
        <Art
          art={strip === null ? celestialStill(body) : celestialStrip(body)}
          palette={palette}
          size={size}
        />
      </Animated.View>
    </View>
  );
});
