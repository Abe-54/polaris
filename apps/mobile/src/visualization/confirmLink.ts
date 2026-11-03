/** "Open this link?" (DESIGN.md, Visualizations V5) as the native action sheet; https only. */
import type { LinkConfirms } from "@polaris/visualization";
import { Linking } from "react-native";
import { choose } from "../menus/choices.ts";
import { openableLink } from "./model.ts";

/** Asks only when `confirms` allows one more (ENG-634): a frame can't stack or repeat sheets. */
export const confirmLink = (title: string, url: string, confirms: LinkConfirms) => {
  const link = openableLink(url);

  // Anything but https is dropped without asking.
  if (link === null || !confirms.request()) return;

  choose(
    "Open this link?",
    ["Open in browser"],
    (index) => {
      confirms.settled(index === 0);

      if (index === 0) void Linking.openURL(link.href).catch(() => undefined);
    },
    `“${title}” wants to open a page in your browser.\n\n${link.host}\n${link.href}`
  );
};
