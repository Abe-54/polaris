/** Opens what a widget was tapped for: the link that launched the app, then each one after. */
import { useEffect } from "react";
import { Linking } from "react-native";
import type { Navigation } from "../app/navigation.tsx";
import { followWidgetLinks } from "./followLinks.ts";

export const useWidgetLinks = (open: Navigation["open"]): void => {
  useEffect(() => {
    return followWidgetLinks(Linking, open);
  }, [open]);
};
