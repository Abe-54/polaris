/**
 * A session row's right-click menu (C9, Paper X-F 06): Open, Open in Review, Open in terminal,
 * Rename… (F2 on the focused row too), Fork…, Pin or Unpin · MOVE: Archive · Copy session ID.
 * Rename edits in place.
 */
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuEntries,
  ContextMenuTrigger,
  Input,
  MENU_SEPARATOR_ENTRY,
  type MenuEntryInput,
} from "@polaris/ui";
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactElement,
  useRef,
  useState,
} from "react";
import { acceleratorLabel } from "../../../../shared/chord.ts";
import { Commands } from "../../../commands.ts";
import { openSessionReview } from "../../../routes/review.ts";
import { useShellActions } from "../../../shell/hooks.ts";
import { copyEntry } from "../../../shell/menu/index.ts";
import type { SessionEntry } from "../../../store/hostModel.ts";
import { send } from "../../session/dispatch.ts";
import { requestFork } from "../../session/forkRequest.ts";
import { hasCapability, useHost } from "../../session/hooks.ts";
import { archiveCommand, renameCommand } from "../../session/model/intent.ts";
import { settingsStore } from "../../settings/index.ts";
import { openInTerminalEntry } from "../../terminal/index.ts";
import { isReviewSession } from "../model/sections.ts";

/** A hover card's trigger around the menu passes its props through to the row. */
export interface SessionMenuProps extends Omit<
  ComponentProps<typeof ContextMenuTrigger>,
  "asChild" | "children"
> {
  readonly hostKey: string;
  readonly entry: SessionEntry;
  readonly onRename: () => void;
  readonly children: ReactElement;
}

/** Whether the menu offers Open in Review: the session has Turns of its own to review. */
const reviewable = (entry: SessionEntry) =>
  entry.session.turnCount > 0 && !isReviewSession(entry.session);

/** A focused session row's own keys, as the explorer's tree has (`TREE_CHORDS`). */
const SESSION_CHORDS = { rename: "F2" } as const;

/** F2 alone, as in Finder and Explorer; the rename field keeps its own keys. */
const isRenameKey = (event: KeyboardEvent) =>
  event.key === SESSION_CHORDS.rename &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.altKey &&
  !event.shiftKey;

export const SessionMenu = ({ hostKey, entry, onRename, children, ...slot }: SessionMenuProps) => {
  const actions = useShellActions();
  const host = useHost(hostKey);
  const { session } = entry;
  const pinned = session.pinnedAt != null;
  const archived = session.state === "archived";
  // Closing the menu refocuses the row, which would blur the rename field at once.
  const renamingNext = useRef(false);
  const open = () => actions.selectSession({ hostKey, sessionId: session.id });

  const pin = () =>
    void send(
      hostKey,
      Commands.PinSession({ sessionId: session.id, pinned: !pinned }),
      pinned ? "Couldn't unpin" : "Couldn't pin"
    );

  const archive = () =>
    void send(
      hostKey,
      archived
        ? Commands.UnarchiveSession({ sessionId: session.id })
        : archiveCommand(session.id, settingsStore.getState().sessions.deleteMergedBranch),
      archived ? "Couldn't unarchive" : "Couldn't archive"
    );

  const entries: ReadonlyArray<MenuEntryInput> = [
    // ↵ on the focused row opens it too.
    { kind: "item", label: "Open", shortcut: "↵", onSelect: open },
    reviewable(entry) && {
      kind: "item",
      label: "Open in Review",
      onSelect: () => {
        open();
        openSessionReview(actions, hostKey, session.id);
      },
    },
    openInTerminalEntry({
      hostKey,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      state: session.state,
      title: session.title === "" ? session.harness : session.title,
    }),
    {
      kind: "item",
      label: "Rename…",
      shortcut: acceleratorLabel(SESSION_CHORDS.rename),
      needsInput: true,
      onSelect: () => {
        renamingNext.current = true;
        onRename();
      },
    },
    session.turnCount > 0 &&
      !archived &&
      hasCapability(host, "session.fork") && {
        kind: "item",
        label: "Fork…",
        needsInput: true,
        onSelect: () => {
          open();
          requestFork(hostKey, session.id);
        },
      },
    hasCapability(host, "session.pin") && {
      kind: "item",
      label: pinned ? "Unpin" : "Pin",
      onSelect: pin,
    },
    MENU_SEPARATOR_ENTRY,
    { kind: "label", text: "Move" },
    { kind: "item", label: archived ? "Unarchive" : "Archive", onSelect: archive },
    MENU_SEPARATOR_ENTRY,
    copyEntry("Copy session ID", session.id),
  ];

  const keyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    slot.onKeyDown?.(event);

    if (event.defaultPrevented || !isRenameKey(event)) return;
    event.preventDefault();
    onRename();
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild {...slot} onKeyDown={keyDown}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        data-testid="session-context-menu"
        onCloseAutoFocus={(event) => {
          if (renamingNext.current) event.preventDefault();
          renamingNext.current = false;
        }}
      >
        <ContextMenuEntries entries={entries} />
      </ContextMenuContent>
    </ContextMenu>
  );
};

/** The row's title while it is being renamed: Enter saves, Esc or leaving it cancels. */
export const RenameField = ({
  hostKey,
  entry,
  onDone,
}: {
  readonly hostKey: string;
  readonly entry: SessionEntry;
  readonly onDone: () => void;
}) => {
  const [text, setText] = useState(entry.session.title);

  const commit = () => {
    const command = renameCommand(entry.session.id, text);

    onDone();

    if (command !== null && text.trim() !== entry.session.title)
      void send(hostKey, command, "Couldn't rename");
  };

  return (
    <Input
      autoFocus
      aria-label="Session title"
      value={text}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setText(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={onDone}
      onKeyDown={(event) => {
        // The row is a button: keep Space, Enter and the arrows inside the field.
        event.stopPropagation();

        if (event.key === "Enter") commit();
        else if (event.key === "Escape") onDone();
      }}
      className="h-6"
    />
  );
};

/** A row's rename state, shared by its menu and its title. */
export const useRenaming = () => {
  const [renaming, setRenaming] = useState(false);

  return { renaming, start: () => setRenaming(true), stop: () => setRenaming(false) };
};
