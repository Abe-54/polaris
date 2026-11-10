import type { Worktree } from "@polaris/protocol";
import { BranchIcon, cn, Row } from "@polaris/ui";
import type { KeyboardEvent, ReactElement } from "react";
import { slots } from "../../app/slots.tsx";
import { waitingOn } from "../../features/session/model/background.ts";
import { useLeadConstellation } from "../../features/constellation/hooks.ts";
import {
  ConstellationPeek,
  LivePeek,
  useLiveRun,
  useSpacePeek,
} from "../../features/constellation/ui/peek.tsx";
import { BackgroundTasksHover } from "../../features/session/ui/background.tsx";
import { RenameField, SessionMenu, useRenaming } from "../../features/sessions/ui/SessionMenu.tsx";
import type { SessionEntry } from "../../store/hostModel.ts";
import { needsYou, shownState } from "../../routes/topBar.ts";
import { activityOf, age, sessionLine, sessionStateLabel } from "../copy.ts";
import { SessionGlyph, SessionTile } from "../glyphs.tsx";
import { sessionKey } from "../../store/store.ts";
import { useApp, useSelection, useShellActions } from "../hooks.ts";

export interface SessionRowProps {
  readonly hostKey: string;
  readonly entry: SessionEntry;
  readonly now: number;
}

/** Row's `asChild` can't slot (it renders several children), so the row itself is the button. */
/** ↑/↓ move focus to the previous or next session row in the same sidebar. */
const moveFocus = (from: HTMLElement, by: number) => {
  const rows = [
    ...(from.closest("aside")?.querySelectorAll<HTMLElement>("[data-session-row]") ?? []),
  ];

  const next = rows[rows.indexOf(from) + by];

  next?.focus();
};

export const buttonProps = (select: () => void) => ({
  role: "button",
  tabIndex: 0,
  "data-session-row": "",
  onClick: select,
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);

      return;
    }

    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    select();
  },
});

/** Background tasks an Idle row waits on; none while it needs you. */
const waitingFor = (entry: SessionEntry) => (needsYou(entry) ? [] : waitingOn(entry.session));

/**
 * A row that needs you gets its hover card (the NeedsYouHover slot); one waiting on
 * background tasks lists them.
 */
export const WithHover = ({
  hostKey,
  entry,
  children,
}: {
  readonly hostKey: string;
  readonly entry: SessionEntry;
  readonly children: ReactElement;
}) => {
  if (needsYou(entry))
    return (
      <slots.NeedsYouHover hostKey={hostKey} sessionId={entry.session.id}>
        {children}
      </slots.NeedsYouHover>
    );
  const waiting = waitingFor(entry);

  return waiting.length === 0 ? (
    children
  ) : (
    <BackgroundTasksHover tasks={waiting} side="right">
      {children}
    </BackgroundTasksHover>
  );
};

/**
 * A row whose session is using an app previews its live view on Space (Paper CU5); a Lead's
 * Space stays the Constellation's.
 */
const useLivePeekRow = (hostKey: string, entry: SessionEntry, lead: boolean) => {
  const peek = useSpacePeek();
  const run = useLiveRun(hostKey, entry.session.id);
  const on = !lead && run !== null;

  return {
    rowProps: (onKeyDown: (event: KeyboardEvent<HTMLElement>) => void) =>
      on ? { ...peek.rowProps, onKeyDown: peek.keyDown(onKeyDown) } : {},
    wrap: (row: ReactElement) =>
      on ? (
        <LivePeek
          hostKey={hostKey}
          sessionId={entry.session.id}
          run={run}
          open={peek.open}
          onOpenChange={peek.setOpen}
        >
          {row}
        </LivePeek>
      ) : (
        row
      ),
  };
};

const useSelectedSession = (hostKey: string, entry: SessionEntry) => {
  const selection = useSelection();

  return (
    selection.pane === "session" &&
    selection.hostKey === hostKey &&
    selection.sessionId === entry.session.id
  );
};

/** DESIGN.md, Session rows: Harness tile with the state inside, title, what it's doing, age. */
export const SessionRow = ({ hostKey, entry, now }: SessionRowProps) => {
  const { selectSession } = useShellActions();
  const density = useApp((s) => s.density);
  const selected = useSelectedSession(hostKey, entry);
  const { session } = entry;
  const state = shownState(entry);
  const waiting = waitingFor(entry).length > 0;

  // What a Working session is doing now, from its feed if open; a string, so deltas don't re-render.
  const activity = useApp((s) =>
    session.state === "working" ? activityOf(s.sessions[sessionKey(hostKey, session.id)]) : null
  );

  const rename = useRenaming();
  const lead = useLeadConstellation(hostKey, session.id) !== null;
  const livePeek = useLivePeekRow(hostKey, entry, lead);
  const button = buttonProps(() => selectSession({ hostKey, sessionId: session.id }));

  return (
    <WithHover hostKey={hostKey} entry={entry}>
      <SessionMenu hostKey={hostKey} entry={entry} onRename={rename.start}>
        {livePeek.wrap(
          <Row
            {...button}
            {...livePeek.rowProps(button.onKeyDown)}
            aria-current={selected}
            data-state={state}
            variant="session"
            selected={selected}
            tone={needsYou(entry) ? "needs-you" : session.state === "dormant" ? "quiet" : "default"}
            leading={
              <SessionTile
                state={state}
                harness={session.harness}
                density={density}
                celestial={session.celestial}
                lead={lead}
              />
            }
            title={
              rename.renaming ? (
                <RenameField hostKey={hostKey} entry={entry} onDone={rename.stop} />
              ) : (
                session.title || "Untitled session"
              )
            }
            description={sessionLine(entry, activity)}
            meta={
              <span
                data-testid="row-state"
                data-state={state}
                aria-label={waiting ? "waiting" : sessionStateLabel[state]}
              >
                {/* Compact drops the second line, so the wait takes the age's place. */}
                {waiting && density === "compact" ? "waiting" : age(session.createdAt, now)}
              </span>
            }
          />
        )}
      </SessionMenu>
    </WithHover>
  );
};

/** A compact one-line session row (machine groups, "Needs you elsewhere"). */
export const CompactSessionRow = ({
  hostKey,
  entry,
  meta,
}: SessionRowProps & { readonly meta: string }) => {
  const { selectSession } = useShellActions();
  const selected = useSelectedSession(hostKey, entry);
  const state = shownState(entry);
  const rename = useRenaming();
  // A Lead outside its group (machine groups, Pinned, Needs you elsewhere) still previews on Space.
  const lead = useLeadConstellation(hostKey, entry.session.id) !== null;
  const peek = useSpacePeek();
  const livePeek = useLivePeekRow(hostKey, entry, lead);
  const button = buttonProps(() => selectSession({ hostKey, sessionId: entry.session.id }));

  const row = (
    <Row
      {...button}
      {...livePeek.rowProps(button.onKeyDown)}
      {...(lead ? { ...peek.rowProps, onKeyDown: peek.keyDown(button.onKeyDown) } : {})}
      aria-current={selected}
      data-state={state}
      selected={selected}
      // DESIGN.md Session rows: the selected row is the raised card, grouped rows too.
      className={cn(selected && "border-hairline bg-row-selected hover:bg-row-selected")}
      tone={needsYou(entry) ? "needs-you" : "default"}
      leading={
        <span className="flex size-4 items-center justify-center">
          <SessionGlyph state={state} harness={entry.session.harness} size={14} />
        </span>
      }
      title={
        rename.renaming ? (
          <RenameField hostKey={hostKey} entry={entry} onDone={rename.stop} />
        ) : (
          entry.session.title || "Untitled session"
        )
      }
      meta={meta}
    />
  );

  return (
    <WithHover hostKey={hostKey} entry={entry}>
      <SessionMenu hostKey={hostKey} entry={entry} onRename={rename.start}>
        {lead ? (
          <ConstellationPeek
            hostKey={hostKey}
            leadSessionId={entry.session.id}
            open={peek.open}
            onOpenChange={peek.setOpen}
          >
            {row}
          </ConstellationPeek>
        ) : (
          livePeek.wrap(row)
        )}
      </SessionMenu>
    </WithHover>
  );
};

/** Worktrees a session created, nested under its row as tree rows. */
export const WorktreeRows = ({ worktrees }: { readonly worktrees: ReadonlyArray<Worktree> }) =>
  worktrees.length === 0 ? null : (
    <ul className="flex flex-col pl-[calc(var(--density-harness-tile)+var(--density-row-x))]">
      {worktrees.map((wt) => (
        <li
          key={wt.id}
          title={wt.path}
          className={cn(
            "flex h-tree-row items-center gap-1.5 px-row-x text-caption text-text-subtle"
          )}
        >
          <BranchIcon size={12} className="text-text-faint shrink-0" />
          <span className="text-code-inline truncate font-mono">
            {wt.branch ?? wt.head.slice(0, 7)}
          </span>
        </li>
      ))}
    </ul>
  );
