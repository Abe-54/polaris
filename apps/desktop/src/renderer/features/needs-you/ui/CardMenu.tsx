/**
 * A Needs You card's right-click menu (Paper M2): Open session · the card's own answers
 * (Approve, Always allow, Deny; or Retry, Take back, Continue) · Dismiss on this Mac, Archive.
 */
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuEntries,
  ContextMenuTrigger,
  MENU_SEPARATOR_ENTRY,
  type MenuEntryInput,
} from "@polaris/ui";
import type { SessionId } from "@polaris/protocol";
import type { ReactElement } from "react";
import { useApp, useSelection } from "../../../shell/hooks.ts";
import { menuShortcut } from "../../../shell/menu/index.ts";
import { archiveSession } from "../../session/archive.ts";
import { dismiss } from "../dismissed.ts";
import type { Dismissible } from "../model/dismissed.ts";
import { clientCopy } from "../../../../shared/clientCopy.ts";

export interface CardAction {
  readonly label: string;
  readonly run: () => void;
  /** Its KEYMAP command, whose chord shows when this card's session is the selected one. */
  readonly command?: "approval.approve" | "approval.deny";
}

export interface CardMenuProps {
  readonly item: Dismissible & { readonly hostKey: string };
  readonly sessionId: SessionId;
  readonly onOpen: () => void;
  readonly answers: ReadonlyArray<CardAction>;
  readonly children: ReactElement;
}

export const CardMenu = ({ item, sessionId, onOpen, answers, children }: CardMenuProps) => {
  const selection = useSelection();

  const online = useApp(
    (s) => s.hosts.find((h) => h.key === item.hostKey)?.status.state === "connected"
  );

  const title = useApp(
    (s) => s.hostModels[item.hostKey]?.sessions.get(sessionId)?.session.title ?? ""
  );

  const here = selection.pane === "session" && selection.sessionId === sessionId;

  const archive = () => void archiveSession(item.hostKey, sessionId, title);

  // Offline, an answer can't reach the Host: dimmed, with why, so the card's menu still reads.
  const entries: ReadonlyArray<MenuEntryInput> = [
    { kind: "item", label: "Open session", onSelect: onOpen },
    MENU_SEPARATOR_ENTRY,
    ...answers.map((a): MenuEntryInput => ({
      kind: "item",
      label: a.label,
      onSelect: a.run,
      disabled: !online,
      reason: online ? undefined : "Host offline",
      shortcut: here && a.command !== undefined ? menuShortcut(a.command) : undefined,
    })),
    MENU_SEPARATOR_ENTRY,
    { kind: "item", label: `Dismiss on ${clientCopy().machine}`, onSelect: () => dismiss([item]) },
    { kind: "item", label: "Archive session", onSelect: archive },
  ];

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid="needs-you-context-menu">
        <ContextMenuEntries entries={entries} />
      </ContextMenuContent>
    </ContextMenu>
  );
};
