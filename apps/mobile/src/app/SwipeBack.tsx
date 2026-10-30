/**
 * The top of the stack over the screen beneath it. A pushed screen follows a swipe from the left
 * edge, uncovering the screen beneath as on iOS, and goes back when the swipe commits.
 */
import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import { Animated, PanResponder, StyleSheet, useWindowDimensions, View } from "react-native";
import { themedStyles } from "../theme/index.ts";
import type { Layer, Route } from "./navigation.tsx";
import { commitsSwipeBack, startsSwipeBack } from "./swipeBack.ts";

/** How far left the screen beneath sits while covered, as a share of the width. */
const PARALLAX = 0.3;

/** The dim over the screen beneath while covered. */
const SCRIM = 0.25;

export const SwipeBack = ({
  layers,
  render,
  onBack,
}: {
  readonly layers: ReadonlyArray<Layer>;
  readonly render: (route: Route) => ReactNode;
  readonly onBack: () => void;
}) => {
  const styles = useStyles();
  const { width } = useWindowDimensions();
  const offsets = useRef(new Map<number, Animated.Value>()).current;
  const latest = useRef({ onBack, width });
  latest.current = { onBack, width };
  const top = layers.at(-1);
  const topIndex = top?.index ?? 0;
  const swipeable = top !== undefined && top.route.screen !== "tabs";
  // Each screen has its own offset, so one uncovered by going back is already in place.
  const x = offsets.get(topIndex) ?? new Animated.Value(0);
  offsets.set(topIndex, x);

  useLayoutEffect(() => {
    for (const index of offsets.keys()) if (index > topIndex) offsets.delete(index);
  }, [offsets, topIndex]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_e, g) => startsSwipeBack(g.x0, g.dx, g.dy),
        onPanResponderMove: (_e, g) => x.setValue(Math.max(0, g.dx)),
        onPanResponderRelease: (_e, g) => {
          const { onBack: back, width: w } = latest.current;

          if (!commitsSwipeBack(g.dx, g.vx, w)) {
            Animated.spring(x, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();

            return;
          }

          Animated.timing(x, { toValue: w, duration: 180, useNativeDriver: true }).start(back);
        },
        onPanResponderTerminate: () =>
          Animated.spring(x, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start(),
      }),
    [x]
  );

  const covered = { inputRange: [0, width], extrapolate: "clamp" } as const;
  const beneathX = x.interpolate({ ...covered, outputRange: [-width * PARALLAX, 0] });
  const scrim = x.interpolate({ ...covered, outputRange: [SCRIM, 0] });

  return (
    <View style={styles.fill}>
      {layers.map(({ route, index }) => {
        const isTop = index === topIndex;

        return (
          <Animated.View
            key={index}
            style={[
              StyleSheet.absoluteFill,
              styles.screen,
              { transform: [{ translateX: isTop ? x : beneathX }] },
            ]}
            pointerEvents={isTop ? "auto" : "none"}
            accessibilityElementsHidden={!isTop}
            importantForAccessibility={isTop ? "auto" : "no-hide-descendants"}
            {...(isTop && swipeable ? responder.panHandlers : {})}
          >
            {render(route)}
            {isTop ? null : (
              <Animated.View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, styles.scrim, { opacity: scrim }]}
              />
            )}
          </Animated.View>
        );
      })}
    </View>
  );
};

const useStyles = themedStyles((colours) => ({
  fill: { flex: 1 },
  screen: { backgroundColor: colours.ground },
  scrim: { backgroundColor: "#000" },
}));
