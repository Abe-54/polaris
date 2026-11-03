/** "Open this link?" (DESIGN.md, Visualizations V5) as the native action sheet; https only. */
import { Linking } from "react-native";
import { choose } from "../menus/choices.ts";
import { openableLink } from "./model.ts";

export const confirmLink = (title: string, url: string) => {
  const link = openableLink(url);

  // Anything but https is dropped without asking.
  if (link === null) return;

  choose(
    "Open this link?",
    ["Open in browser"],
    (index) => {
      if (index === 0) void Linking.openURL(link.href).catch(() => undefined);
    },
    `“${title}” wants to open a page in your browser.\n\n${link.host}\n${link.href}`
  );
};
