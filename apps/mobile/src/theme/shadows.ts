import { Platform, type ViewStyle } from "react-native";

/** Android's blur radius is twice Core Animation's shadow radius (standard deviation). */
export const heroShadow: ViewStyle =
  Platform.OS === "android"
    ? { boxShadow: [{ offsetX: 0, offsetY: 16, blurRadius: 40, color: "#000000a0" }] }
    : {
        shadowColor: "#000000a0",
        shadowOpacity: 1,
        shadowRadius: 20,
        shadowOffset: { width: 0, height: 16 },
      };

export const sheetShadow: ViewStyle =
  Platform.OS === "android"
    ? { boxShadow: [{ offsetX: 0, offsetY: -12, blurRadius: 40, color: "#00000099" }] }
    : {
        shadowColor: "#000000",
        shadowOpacity: 0.6,
        shadowRadius: 20,
        shadowOffset: { width: 0, height: -12 },
      };
