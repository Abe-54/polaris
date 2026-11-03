import { ActionSheetIOS, Alert, Platform } from "react-native";

/** Short native choices. Android's dialog supports at most three choices; Back cancels. */
export const choose = (
  title: string | undefined,
  options: ReadonlyArray<string>,
  onChoose: (index: number) => void,
  message?: string,
  onCancel: () => void = () => {}
) => {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      { title, message, options: [...options, "Cancel"], cancelButtonIndex: options.length },
      (index) => (index === options.length ? onCancel() : onChoose(index))
    );

    return;
  }

  Alert.alert(
    title,
    message,
    options.map((text, index) => ({ text, onPress: () => onChoose(index) })),
    { cancelable: true, onDismiss: onCancel }
  );
};
