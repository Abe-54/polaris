/** One sheet as the host draws it: the scrim, the sheet at its detent, and its parts. */
import { useEffect } from "react";
import { sheetShadow } from "../theme/shadows.ts";
import {
  type AccessibilityActionEvent,
  BackHandler,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReducedMotion, useTheme } from "../theme";
import { DEFAULT_DETENTS, detentHeights, maxHeight } from "./detents.ts";
import { useSheetGesture } from "./gesture.ts";
import type { InstrumentSheetProps } from "./host.tsx";
import { GRABBER, SCRIM, SHEET_EDGE, sections } from "./layout.tsx";
import { type SheetMotion, useSheetMotion } from "./motion.ts";
import { type KeyboardFrame, useKeyboard } from "./useKeyboard.ts";

const KEYBOARD_EASING = Easing.bezier(0.17, 0.59, 0.4, 0.77);

const useBackCloses = (open: boolean, onClose: () => void) => {
  useEffect(() => {
    if (!open) return;

    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();

      return true;
    });

    return () => sub.remove();
  }, [open, onClose]);
};

/** The keyboard's height as a shared value, moving with the keyboard. */
const useKeyboardLift = ({ height, duration }: KeyboardFrame) => {
  const lift = useSharedValue(height);

  useEffect(() => {
    lift.set(withTiming(height, { duration, easing: KEYBOARD_EASING }));
  }, [height, duration, lift]);

  return lift;
};

/** The grabber, which VoiceOver adjusts between detents as iOS's own sheets do. */
const Grabber = ({ motion, count }: { readonly motion: SheetMotion; readonly count: number }) => {
  const at = motion.restingIndex;

  const onAction = ({ nativeEvent }: AccessibilityActionEvent) => {
    const next = nativeEvent.actionName === "increment" ? at + 1 : at - 1;

    if (next >= 0 && next < count) motion.goTo(next);
  };

  return (
    <View
      style={styles.grabberRow}
      accessible={count > 1}
      accessibilityRole="adjustable"
      accessibilityLabel="Sheet grabber"
      accessibilityValue={{ text: at === count - 1 ? "Expanded" : "Collapsed" }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={onAction}
    >
      <View style={styles.grabber} />
    </View>
  );
};

export const SheetFrame = ({
  open,
  onClose,
  detents = DEFAULT_DETENTS,
  initialIndex = 0,
  dismissible = true,
  scrim = true,
  onDetentChange,
  children,
}: InstrumentSheetProps) => {
  const { colours, name } = useTheme();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const keyboard = useKeyboard(open);
  const room = { height: window.height - keyboard.height, topInset: insets.top };
  const heights = detentHeights(detents, room);
  const frameHeight = maxHeight({ height: window.height, topInset: insets.top });

  const motion = useSheetMotion({
    open,
    initialIndex,
    heights,
    reduced,
    dismissible,
    onClose,
    onDetentChange,
  });

  const gesture = useSheetGesture({ motion, heights, room, dismissible });
  const { visible, opacity } = motion;
  const lowest = heights[0] ?? 1;

  const lift = useKeyboardLift(keyboard);

  useBackCloses(open, onClose);

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, visible.get() / lowest) * opacity.get(),
  }));

  const sheetStyle = useAnimatedStyle(() => ({
    opacity: opacity.get(),
    transform: [{ translateY: frameHeight - visible.get() - lift.get() }],
  }));

  if (!motion.mounted) return null;

  const { header, body, footer } = sections(children);

  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents={open ? (scrim ? "auto" : "box-none") : "none"}
    >
      {scrim ? (
        <Animated.View style={[StyleSheet.absoluteFill, scrimStyle]}>
          <Pressable
            accessible={false}
            importantForAccessibility="no"
            onPress={onClose}
            style={[StyleSheet.absoluteFill, { backgroundColor: SCRIM[name] }]}
          />
        </Animated.View>
      ) : null}
      <GestureDetector gesture={gesture.pan}>
        <Animated.View
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
          style={[
            styles.sheet,
            { height: frameHeight, backgroundColor: colours.panel },
            sheetStyle,
          ]}
        >
          <View
            style={[
              styles.content,
              {
                height: motion.layoutHeight,
                paddingBottom: keyboard.height > 0 ? 10 : Math.max(insets.bottom, 16),
              },
            ]}
          >
            <Grabber motion={motion} count={heights.length} />
            {header}
            <GestureDetector gesture={gesture.native}>
              <Animated.ScrollView
                ref={gesture.scrollRef}
                onScroll={gesture.onScroll}
                scrollEventThrottle={16}
                bounces={false}
                keyboardShouldPersistTaps="handled"
                style={styles.body}
                contentContainerStyle={styles.bodyContent}
                onLayout={({ nativeEvent }) =>
                  gesture.setBounds(nativeEvent.layout.y, nativeEvent.layout.height)
                }
                onContentSizeChange={(_w, h) => gesture.setContentHeight(h)}
              >
                {body}
              </Animated.ScrollView>
            </GestureDetector>
            {footer}
          </View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
};

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    borderTopWidth: 1,
    borderColor: SHEET_EDGE,
    ...sheetShadow,
  },
  content: { paddingTop: 8, paddingHorizontal: 10, gap: 10 },
  grabberRow: { alignItems: "center", paddingBottom: 4 },
  grabber: { width: 36, height: 5, borderRadius: 3, backgroundColor: GRABBER },
  body: { flex: 1, marginHorizontal: -10 },
  bodyContent: { gap: 10, paddingHorizontal: 10 },
});
