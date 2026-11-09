/**
 * "Agents in this worktree" at the sidebar's foot (DESIGN.md, Requests), as in Traces and
 * the Editor: the sessions sharing the shown session's checkout; a row opens the session.
 */
import { Row } from "@polaris/ui";
import { useMemo, useState } from "react";
import { activeSessions, needsYou, shownState } from "../../../../routes/topBar.ts";
import { sessionOrder } from "../../../../routes/selection.ts";
import { age, sessionLine, sessionStateLabel } from "../../../../shell/copy.ts";
import { SessionTile } from "../../../../shell/glyphs.tsx";
import { useApp, useShellActions } from "../../../../shell/hooks.ts";
import { useNow } from "../../../../shell/useNow.ts";
import type { SessionEntry } from "../../../../store/hostModel.ts";
import type { RequestsSessionKey } from "../../model/session.ts";

/** Rows shown before "N more", as the Editor's. */
const SHOWN = 3;

const AgentRow = ({
  hostKey,
  entry,
  now,
}: {
  readonly hostKey: string;
  readonly entry: SessionEntry;
  readonly now: number;
}) => {
  const { selectSession } = useShellActions();
  const density = useApp((s) => s.density);
  const { session } = entry;
  const state = shownState(entry);
  const open = () => selectSession({ hostKey, sessionId: session.id });

  return (
    <Row
      role="button"
      tabIndex={0}
      data-testid="requests-agent"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      }}
      variant="session"
      tone={needsYou(entry) ? "needs-you" : session.state === "dormant" ? "quiet" : "default"}
      leading={
        <SessionTile
          state={state}
          harness={session.harness}
          density={density}
          celestial={session.celestial}
        />
      }
      title={session.title || "Untitled session"}
      description={sessionLine(entry)}
      meta={<span aria-label={sessionStateLabel[state]}>{age(session.createdAt, now)}</span>}
    />
  );
};

export const AgentsHere = ({ at }: { readonly at: RequestsSessionKey }) => {
  const model = useApp((s) => s.hostModels[at.hostKey]);
  const now = useNow();
  const [all, setAll] = useState(false);

  const sessions = useMemo(() => {
    const shown = model?.sessions.get(at.sessionId);

    if (model === undefined || shown === undefined) return [];
    const checkout = shown.session.worktreeId;

    return activeSessions(model, shown.session.workspaceId)
      .filter((e) => e.session.worktreeId === checkout)
      .sort(sessionOrder);
  }, [model, at.sessionId]);

  if (sessions.length === 0) return null;
  const shown = all ? sessions : sessions.slice(0, SHOWN);

  return (
    <section
      className="flex shrink-0 flex-col gap-0.5 px-2 pt-2 pb-2"
      aria-label="Agents in this worktree"
      data-testid="requests-agents"
    >
      <h2 className="text-micro text-text-subtle px-2 pt-2 pb-1.5 font-mono font-medium tracking-[0.06em]">
        AGENTS IN THIS WORKTREE · {sessions.length}
      </h2>
      <div className="flex max-h-[40vh] flex-col gap-0.5 overflow-y-auto">
        {shown.map((entry) => (
          <AgentRow key={entry.session.id} hostKey={at.hostKey} entry={entry} now={now} />
        ))}
      </div>
      {sessions.length > SHOWN ? (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="text-caption text-text-subtle hover:text-text-default cursor-default self-start px-2 py-1"
        >
          {all ? "Show fewer" : `${sessions.length - SHOWN} more`}
        </button>
      ) : null}
    </section>
  );
};
