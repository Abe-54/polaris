import { mobileType } from "@polaris/ui/tokens";
import { useSyncExternalStore } from "react";
import { Platform, Pressable, StyleSheet, Text } from "react-native";
import { InstrumentSheet, SheetHeader } from "../sheet/index.tsx";
import { useTheme } from "../theme/index.ts";
import { currentChoice, finishChoice, subscribeChoice } from "./choiceStore.ts";

/** Mount once under ThemeProvider and SheetHost to serve imperative Android choose() calls. */
export const ChoiceSheetHost = () => {
  const choice = useSyncExternalStore(subscribeChoice, currentChoice, currentChoice);
  const { colours } = useTheme();

  if (Platform.OS !== "android" || choice === null) return null;

  const cancel = () => finishChoice(choice, null);

  return (
    <InstrumentSheet open onClose={cancel}>
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
    </InstrumentSheet>
  );
};

const styles = StyleSheet.create({
  item: { minHeight: 48, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 10 },
  label: { ...mobileType.body },
  message: { ...mobileType.body, paddingHorizontal: 12, paddingVertical: 10 },
  cancel: { borderTopWidth: 1 },
});
