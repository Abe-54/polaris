/**
 * Archive and Unarchive from every surface (ENG-679): an Archive that lands says so in a
 * Polaris toast with Undo, so an accidental one is a click to take back.
 */
import type { SessionId } from "@polaris/protocol";
import { PixelArchiveIcon, showToast } from "@polaris/ui";
import { createElement } from "react";
import { Commands } from "../../commands.ts";
import { settingsStore } from "../settings/store.ts";
import { send } from "./dispatch.ts";
import { archiveCommand } from "./model/intent.ts";

export const unarchiveSession = (hostKey: string, sessionId: SessionId) =>
  send(hostKey, Commands.UnarchiveSession({ sessionId }), "Couldn't unarchive");

/** The toast after an Archive lands: "Archived {title}", with Undo. */
export const archivedToast = (title: string, undo: () => void) =>
  showToast({
    source: "starlight",
    icon: createElement(PixelArchiveIcon, { size: 16 }),
    title: `Archived ${title === "" ? "untitled session" : title}`,
    message: "It's under Archived at the foot of the sidebar.",
    action: { label: "Undo", onAction: undo },
  });

export const archiveSession = async (hostKey: string, sessionId: SessionId, title: string) => {
  const archived = await send(
    hostKey,
    archiveCommand(sessionId, settingsStore.getState().sessions.deleteMergedBranch),
    "Couldn't archive"
  );

  if (archived) archivedToast(title, () => void unarchiveSession(hostKey, sessionId));

  return archived;
};
