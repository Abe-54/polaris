/**
 * The conversation's header (Paper X-D): the session's Celestial, its title (click to rename),
 * and "Claude Code · Working · turn 24 · ⑂ main"; a menu for Fork, Open in terminal and
 * Archive. Context and the permission mode live in the composer's footer.
 */
import {
  cn,
  Button,
  ChevronDownIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  BranchIcon,
  Celestial,
  type Harness,
  harnessHue,
  harnessTextVar,
  Input,
  sessionCelestial,
} from "@polaris/ui";
import { useState } from "react";
import type { SessionData } from "../../../store/plain.ts";
import { sessionStateLabel, usageLimitLine } from "../../../shell/copy.ts";
import { keepTerminalFocus, OpenInTerminalItem } from "../../terminal/index.ts";
import { send } from "../dispatch.ts";
import { renameCommand } from "../model/intent.ts";
import { archiveSession, unarchiveSession } from "../archive.ts";
import { waitingOn, waitingPhrase } from "../model/background.ts";
import { BackgroundTasksHover } from "./background.tsx";
import { useLeadConstellation } from "../../constellation/hooks.ts";

export interface SessionHeaderProps {
  readonly hostKey: string;
  readonly session: SessionData;
  readonly harness: Harness | null;
  readonly turnNumber: number | null;
  readonly canFork: boolean;
  readonly onFork: () => void;
  /** The branch or worktree the session runs on, in full. */
  readonly branch?: string | undefined;
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const Title = ({ hostKey, session }: { hostKey: string; session: SessionData }) => {
  const [editing, setEditing] = useState<string | null>(null);
  const title = session.title === "" ? "Untitled session" : session.title;

  const commit = () => {
    const command = editing === null ? null : renameCommand(session.id, editing);

    setEditing(null);

    if (command !== null && editing?.trim() !== session.title)
      void send(hostKey, command, "Couldn't rename");
  };

  if (editing !== null) {
    return (
      <Input
        autoFocus
        aria-label="Session title"
        value={editing}
        onChange={(event) => setEditing(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          else if (event.key === "Escape") setEditing(null);
        }}
        className="text-heading h-7"
      />
    );
  }

  return (
    <h1
      className="text-heading text-text-strong cursor-text truncate leading-[21px] tracking-[-0.01em]"
      title={`${title}\nClick to rename`}
      data-testid="session-title"
      onClick={() => setEditing(session.title)}
    >
      {title}
    </h1>
  );
};

const SessionMenu = ({
  hostKey,
  session,
  canFork,
  onFork,
}: Omit<SessionHeaderProps, "harness" | "turnNumber" | "branch">) => {
  const archived = session.state === "archived";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Session actions"
          data-testid="session-menu"
        >
          <ChevronDownIcon size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52" onCloseAutoFocus={keepTerminalFocus}>
        <DropdownMenuItem needsInput disabled={!canFork} onSelect={onFork}>
          Fork…
        </DropdownMenuItem>
        <OpenInTerminalItem
          session={{
            hostKey,
            workspaceId: session.workspaceId,
            sessionId: session.id,
            state: session.state,
            title: session.title === "" ? session.harness : session.title,
          }}
        />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid="archive-session"
          onSelect={() =>
            void (archived
              ? unarchiveSession(hostKey, session.id)
              : archiveSession(hostKey, session.id, session.title))
          }
        >
          {archived ? "Unarchive" : "Archive"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** "⑂ main": the branch in mono at full length; it truncates only when the panel is narrow. */
const Branch = ({ name }: { readonly name: string }) => (
  <span className="flex min-w-0 items-center gap-1" data-testid="session-branch" title={name}>
    <BranchIcon size={12} className="text-text-subtle shrink-0" />
    <span className="text-code-inline text-text-subtle min-w-0 truncate font-mono">{name}</span>
  </span>
);

export const SessionHeader = (props: SessionHeaderProps) => {
  const { hostKey, session, harness, turnNumber, branch } = props;
  const waiting = waitingOn(session);
  const lead = useLeadConstellation(hostKey, session.id) !== null;

  const state =
    waiting.length > 0
      ? waitingPhrase(waiting)
      : session.state === "limited"
        ? usageLimitLine(session.limitResetsAt)
        : capitalized(sessionStateLabel[session.state]);

  const stateLine = (
    <span
      className={cn(
        "text-body text-text-subtle tabular",
        waiting.length > 0 ? "min-w-0 truncate" : "shrink-0"
      )}
      data-testid="session-state"
    >
      {turnNumber === null || session.state === "limited" ? state : `${state} · turn ${turnNumber}`}
    </span>
  );

  return (
    <header className="gap-row-x pr-section flex shrink-0 items-center pt-3 pb-2 pl-5">
      <Celestial
        body={sessionCelestial(session.celestial, lead)}
        harness={session.harness}
        size={24}
        working={session.state === "working"}
        dormant={session.state === "dormant" || session.state === "archived"}
        data-testid="session-celestial"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <Title hostKey={hostKey} session={session} />
        <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          {harness === null ? (
            <span className="text-body text-text-default shrink-0">{session.harness}</span>
          ) : (
            <span
              className="text-body shrink-0 font-medium"
              style={{ color: harnessTextVar(harness) }}
            >
              {harnessHue(harness).name}
            </span>
          )}
          <span className="text-body text-text-subtle shrink-0" aria-hidden="true">
            ·
          </span>
          {waiting.length > 0 ? (
            <BackgroundTasksHover tasks={waiting}>{stateLine}</BackgroundTasksHover>
          ) : (
            stateLine
          )}
          {branch === undefined ? null : (
            <>
              <span className="text-body text-text-subtle shrink-0" aria-hidden="true">
                ·
              </span>
              <Branch name={branch} />
            </>
          )}
        </div>
      </div>
      <SessionMenu {...props} />
    </header>
  );
};
