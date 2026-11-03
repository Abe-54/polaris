/** Metro routes mobile token imports here so every type role uses native families. */
import { Platform } from "react-native";
import {
  createMobileType,
  resolveMobileFonts,
} from "../../../../packages/ui/src/tokens/mobile-type.ts";

export * from "../../../../packages/ui/src/tokens/index.ts";

export const mobileFont = resolveMobileFonts(Platform.OS);

export const mobileType = createMobileType(mobileFont);

/** Keep the celestial preview's existing iOS face. */
export const celestialLabelFont = Platform.OS === "android" ? mobileFont.mono : "Menlo";
