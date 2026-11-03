import { ActionSheetIOS, Platform } from "react-native";
import { showChoice } from "./choiceStore.ts";

/** Short choices; Android's ChoiceSheetHost must be mounted inside the app's SheetHost. */
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

  showChoice({ title, message, options: [...options], onChoose, onCancel });
};
