import { mobileType } from "@polaris/ui/tokens";
import { useState, useSyncExternalStore } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { InstrumentSheet, SheetHeader } from "../sheet/index.tsx";
import { useTheme } from "../theme/index.ts";
import { currentChoice, finishChoice, subscribeChoice } from "./choiceStore.ts";

/** The grabber row, the frame's top padding and the gap above the body. */
const SHEET_CHROME = 8 + 9 + 10;

/** A first guess at the choices' height, before they have laid out. */
const ESTIMATE = 220;

/** Mount once under ThemeProvider and SheetHost to serve imperative Android choose() calls. */
export const ChoiceSheetHost = () => {
  const choice = useSyncExternalStore(subscribeChoice, currentChoice, currentChoice);
  const { colours } = useTheme();
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(ESTIMATE);

  if (Platform.OS !== "android" || choice === null) return null;

  const cancel = () => finishChoice(choice, null);

  return (
    // Sized to its choices, as iOS sizes an action sheet.
    <InstrumentSheet
      open
      onClose={cancel}
      detents={[height + SHEET_CHROME + Math.max(insets.bottom, 16)]}
    >
      <View onLayout={({ nativeEvent }) => setHeight(Math.ceil(nativeEvent.layout.height))}>
        {choice.title ? <SheetHeader title={choice.title} titleLines={3} onClose={cancel} /> : null}
        {choice.message ? (
          <Text style={[styles.message, { color: colours.textSubtle }]}>{choice.message}</Text>
        ) : null}
        {choice.options.map((option, index) => (
          <Pressable
            key={index}
            accessibilityRole="button"
            accessibilityLabel={option}
            onPress={() => finishChoice(choice, index)}
            style={styles.item}
          >
            <Text style={[styles.label, { color: colours.textStrong }]}>{option}</Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={cancel}
          style={[styles.item, styles.cancel, { borderColor: colours.hairline }]}
        >
          <Text style={[styles.label, { color: colours.textStrong }]}>Cancel</Text>
        </Pressable>
      </View>
    </InstrumentSheet>
  );
};

const styles = StyleSheet.create({
  item: { minHeight: 48, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 10 },
  label: { ...mobileType.body },
  message: { ...mobileType.body, paddingHorizontal: 12, paddingVertical: 10 },
  cancel: { borderTopWidth: 1 },
});
