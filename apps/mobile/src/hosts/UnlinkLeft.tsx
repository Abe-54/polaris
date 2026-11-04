/**
 * Under the Hosts list after an Unlink some Hosts didn't answer: which still trust this iPhone,
 * and a button to forget them here anyway, confirmed first; they stay trusting until the Mac unlinks.
 */
import { mobileType } from "@polaris/ui/tokens";
import { Alert, Pressable, Text, View } from "react-native";
import { themedStyles } from "../theme/index.ts";
import { CONTENT_TEXT_SCALE } from "../theme/textScale.ts";
import { forgetCopy, unlinkNote } from "./model.ts";

/** What the last Unlink left: Hosts still trusting this iPhone, and whether they were forgotten. */
export interface UnlinkLeftState {
  readonly hostIds: ReadonlyArray<string>;
  readonly names: ReadonlyArray<string>;
  readonly forgotten: boolean;
}

export const UnlinkLeft = ({
  left,
  onForget,
}: {
  readonly left: UnlinkLeftState | null;
  readonly onForget: () => void;
}) => {
  const styles = useStyles();

  if (left === null || left.names.length === 0) return null;
  const copy = forgetCopy(left.names);

  if (left.forgotten)
    return (
      <Text style={styles.note} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
        {copy.done}
      </Text>
    );

  const confirm = () =>
    Alert.alert(copy.title, copy.message, [
      { text: "Cancel", style: "cancel" },
      { text: copy.confirm, style: "destructive", onPress: onForget },
    ]);

  return (
    <View style={styles.left}>
      <Text style={styles.note} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
        {unlinkNote(left.names)}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={confirm}
        style={({ pressed }) => [styles.forget, pressed ? styles.pressed : null]}
      >
        <Text style={styles.forgetText} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
          {copy.button}
        </Text>
      </Pressable>
    </View>
  );
};

const useStyles = themedStyles((colours) => ({
  left: { gap: 10, alignItems: "flex-start" },
  note: { ...mobileType.footnote, color: colours.textFaint, paddingHorizontal: 14 },
  forget: {
    minHeight: 34,
    marginHorizontal: 14,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.raised,
    justifyContent: "center",
  },
  pressed: { transform: [{ scale: 0.98 }] },
  forgetText: { ...mobileType.footnote, fontWeight: "600", color: colours.failedText },
}));
