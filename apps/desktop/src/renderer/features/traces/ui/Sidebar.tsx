/**
 * Traces' sidebar (DESIGN.md, Traces → Sidebar; Paper T1): the Workspace header, the filter well,
 * traces under Turn kickers newest first, and "Agents in this worktree" at the foot. While the
 * Host is Reconnecting or Offline it shows the last answer, dimmed (rule/remote-is-normal).
 */
import type { TraceFilter } from "@polaris/protocol";
import { cn } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../../../shell/hooks.ts";
import { useTraces } from "../data/hooks.tsx";
import { publishListed } from "../model/listed.ts";
import { selectTrace } from "../model/store.ts";
import { AgentsHere } from "./sidebar/AgentsHere.tsx";
import { FilterWell } from "./sidebar/FilterWell.tsx";
import { Header } from "./sidebar/Header.tsx";
import { TraceList } from "./sidebar/TraceList.tsx";
import type { TracesSlotProps } from "./slots.ts";

const Quiet = ({ children }: { readonly children: string }) => (
  <p className="text-caption text-text-subtle px-2 py-2" data-testid="traces-sidebar-quiet">
    {children}
  </p>
);

const Body = ({
  props,
  filter,
}: {
  readonly props: TracesSlotProps;
  readonly filter: TraceFilter | undefined;
}) => {
  const { at, traceId } = props;
  const answer = useTraces(at, filter);
  // A new filter reads again; the last list stays until its answer comes.
  const last = useRef(answer);

  if (answer.status !== "loading") last.current = answer;
  const snapshot = last.current;

  const listed = snapshot.status === "ready" ? snapshot.value.traces : null;
  const { hostKey, sessionId } = at;

  useEffect(() => {
    publishListed({ hostKey, sessionId }, listed);

    return () => publishListed({ hostKey, sessionId }, null);
  }, [hostKey, sessionId, listed]);

  const latestTurn = useApp(
    (s) => s.hostModels[at.hostKey]?.sessions.get(at.sessionId)?.session.turnCount ?? null
  );

  if (snapshot.status === "loading") return null;

  if (snapshot.status === "failed") return <Quiet>{snapshot.error.message}</Quiet>;
  const { traces, total } = snapshot.value;

  if (traces.length === 0)
    return <Quiet>{filter === undefined ? "No traces yet" : "No traces match the filter"}</Quiet>;

  return (
    <>
      <TraceList
        at={at}
        traces={traces}
        openId={traceId}
        latestTurn={latestTurn}
        onOpen={(id) => selectTrace(at, id)}
      />
      {total > traces.length ? (
        <Quiet>{`The newest ${traces.length} of ${total}; filter to find older ones`}</Quiet>
      ) : null}
    </>
  );
};

export const TracesSidebar = (props: TracesSlotProps) => {
  const [filter, setFilter] = useState<TraceFilter | undefined>(undefined);

  const connected = useApp(
    (s) => s.hosts.find((h) => h.key === props.hostKey)?.status.state === "connected"
  );

  return (
    <aside
      aria-label="Traces"
      data-testid="traces-sidebar"
      className="flex min-h-0 w-[270px] flex-1 flex-col"
    >
      <div className="px-panel pt-panel flex flex-col gap-[calc(var(--spacing-panel)*0.75)] pb-1">
        <Header {...props} />
        <FilterWell onFilter={setFilter} />
      </div>
      <div
        className={cn(
          "px-panel flex min-h-0 flex-1 flex-col overflow-y-auto pb-2",
          !connected && "opacity-(--opacity-dimmed)"
        )}
        data-testid="traces-sidebar-body"
      >
        <Body props={props} filter={filter} />
      </div>
      <AgentsHere at={props.at} />
    </aside>
  );
};
