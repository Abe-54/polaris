/**
 * The pairing sky (Paper MX-AH to MX-AM): still pixel stars, the Polaris star up in the sky, and the
 * shared horizon resting on the scan sheet. Once linked, the hosts stand on its ridge as machines.
 */
import { mobileFont } from "@polaris/ui/tokens";
import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { Horizon, HORIZON_HEIGHT } from "../horizon/index.tsx";
import { PALETTES } from "../horizon/scene.ts";
import { CHROME_TEXT_SCALE } from "../theme/textScale.ts";
import { themedStyles, useReducedMotion, useTheme } from "../theme/index.ts";
import type { StarLight } from "./model.ts";
import { Star } from "./Star.tsx";

/** x, y, size and opacity of each still star, from MX-AH's 393-wide sky, 60pt down. */
const STARS: ReadonlyArray<readonly [number, number, number, number]> = [
  [40, 38, 1, 0.5],
  [96, 110, 2, 0.35],
  [151, 22, 1, 0.7],
  [262, 64, 1, 0.5],
  [331, 30, 2, 0.5],
  [358, 140, 1, 0.35],
  [22, 196, 1, 0.7],
  [300, 210, 1, 0.35],
  [214, 150, 1, 0.9],
  [70, 262, 2, 0.35],
  [345, 268, 1, 0.5],
  [128, 300, 1, 0.5],
  [250, 292, 1, 0.35],
  [180, 84, 1, 0.35],
];

const STARS_TOP = 60;

const PAPER_WIDTH = 393;

/** MX-AL's machines stand with their feet 133pt down the horizon's box, into the ridge. */
const MACHINE_FOOT = HORIZON_HEIGHT - 133;

/** The host that made the link is the Mac; the hosts it shares stand smaller beside it. */
const MAC = {
  width: 28,
  height: 16,
  viewBox: "0 0 14 8",
  body: "M1 0h12v1h-12zM0 1h14v6h-14z",
  top: "M1 1h12v1h-12z",
  light: "M2 5h1v1h-1z",
  foot: "M0 7h14v1h-14z",
} as const;

const SMALL = {
  width: 18,
  height: 10,
  viewBox: "0 0 9 5",
  body: "M0 0h9v4h-9z",
  top: "M0 0h9v1h-9z",
  light: "M7 2h1v1h-1z",
  foot: "M0 4h9v1h-9z",
} as const;

const MACHINE_TONES = { body: "#3A4266", top: "#5A6698", light: "#F4F5F7", foot: "#262C47" };

/** At most this many stand on the ridge; the sheet's line still counts every host. */
const MAX_MACHINES = 4;

/** Duration of the horizon following the sheet's height, as the sheet's own fade. */
const LIFT_MS = 240;

const EASE_OUT = Easing.bezier(0.215, 0.61, 0.355, 1);

const Machine = ({ name, mac }: { readonly name: string; readonly mac: boolean }) => {
  const styles = useStyles();
  const art = mac ? MAC : SMALL;

  return (
    <View style={styles.machine}>
      <Text maxFontSizeMultiplier={CHROME_TEXT_SCALE} style={styles.machineLabel} numberOfLines={1}>
        {name}
      </Text>
      <Svg width={art.width} height={art.height} viewBox={art.viewBox}>
        <Path d={art.body} fill={MACHINE_TONES.body} />
        <Path d={art.top} fill={MACHINE_TONES.top} />
        <Path d={art.light} fill={MACHINE_TONES.light} />
        <Path d={art.foot} fill={MACHINE_TONES.foot} />
      </Svg>
    </View>
  );
};

/** The hosts spread along the ridge, clear of Moonlit's moon at the right. */
const Machines = ({
  hosts,
  width,
}: {
  readonly hosts: ReadonlyArray<string>;
  readonly width: number;
}) => {
  const styles = useStyles();
  const shown = hosts.slice(0, MAX_MACHINES);
  const room = width - 96;
  const slot = room / shown.length;

  return (
    <View style={[styles.machines, { width: room }]} accessibilityElementsHidden>
      {shown.map((name, i) => (
        <View key={name} style={[styles.slot, { left: i * slot, width: slot }]}>
          <Machine name={name} mac={i === 0} />
        </View>
      ))}
    </View>
  );
};

const useLift = (lift: number): Animated.Value => {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(-lift)).current;

  useEffect(() => {
    if (reduced) {
      value.setValue(-lift);

      return;
    }

    const move = Animated.timing(value, {
      toValue: -lift,
      duration: LIFT_MS,
      easing: EASE_OUT,
      useNativeDriver: true,
    });

    move.start();

    return () => move.stop();
  }, [lift, reduced, value]);

  return value;
};

export interface SkyProps {
  readonly light: StarLight;
  /** The star's top in points: one place for every step. */
  readonly starTop: number;
  /** The sheet's height: the horizon rests on it. */
  readonly lift: number;
  /** Once linked, every host, the Mac first. */
  readonly hosts?: ReadonlyArray<string> | undefined;
  /** Each gives way when room is short (`skyShows`). */
  readonly star?: boolean;
  readonly moon?: boolean;
}

export const Sky = ({ light, starTop, lift, hosts, star = true, moon = true }: SkyProps) => {
  const { width } = useWindowDimensions();
  const { name } = useTheme();
  const palette = PALETTES[name];
  const translateY = useLift(lift);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" accessibilityElementsHidden>
      <Svg style={{ position: "absolute", top: STARS_TOP }} width={width} height={320}>
        {STARS.map(([x, y, size, opacity]) => (
          <Rect
            key={`${x},${y}`}
            x={Math.round((x / PAPER_WIDTH) * width)}
            y={y}
            width={size}
            height={size}
            fill={palette.star}
            fillOpacity={opacity * palette.starOpacity}
          />
        ))}
      </Svg>
      <Animated.View style={[fixed.horizon, { transform: [{ translateY }] }]}>
        <Horizon moon={moon} />
        {hosts === undefined || hosts.length === 0 ? null : (
          <Machines hosts={hosts} width={width} />
        )}
      </Animated.View>
      {star ? <Star light={light} top={starTop} /> : null}
    </View>
  );
};

const fixed = StyleSheet.create({
  horizon: { position: "absolute", left: 0, right: 0, bottom: 0, height: HORIZON_HEIGHT },
});

const useStyles = themedStyles((colours) => ({
  machines: { position: "absolute", left: 48, bottom: MACHINE_FOOT, height: 40 },
  slot: { position: "absolute", bottom: 0, alignItems: "center" },
  machine: { alignItems: "center", gap: 6, maxWidth: "100%" },
  machineLabel: {
    fontFamily: mobileFont.mono,
    fontSize: 11,
    lineHeight: 14,
    color: colours.textDefault,
  },
}));
