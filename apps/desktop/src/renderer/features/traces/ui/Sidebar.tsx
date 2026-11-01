/**
 * Traces' sidebar (DESIGN.md, Traces → Sidebar; Paper T1, T2): the Workspace header, the
 * `Traces | Profiles` switch, then the filter well and traces under Turn kickers newest first, or
 * the Profiles; "Agents in this worktree" at the foot. While the Host is Reconnecting or Offline it
 * shows the last answer, dimmed (rule/remote-is-normal).
 */
import type { TraceFilter } from "@polaris/protocol";
import { cn, SegmentedControl, Switch } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../../../shell/hooks.ts";
import { useTraces } from "../data/hooks.tsx";
import { useProfiles } from "../data/profiles.tsx";
import { useProfilesUnavailable } from "../model/availability.ts";
import { publishListed } from "../model/listed.ts";
import { refreshProfile } from "../model/profile/store.ts";
import { sessionKey, type TracesSessionKey } from "../model/session.ts";
import { selectTrace } from "../model/store.ts";
import { ProfileList } from "./profiles/ProfileList.tsx";
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

const emptyLabel = (at: TracesSessionKey, filter: TraceFilter | undefined) => {
  if (filter !== undefined) return "No traces match the filter";

  return at.scope === "self" ? "No self-traces yet" : "No traces yet";
};

/** Polaris's own Self-Traces in place of this checkout's (CONTEXT.md, Self-Trace). */
const PolarisSwitch = ({
  polaris,
}: {
  readonly polaris: NonNullable<TracesSlotProps["polaris"]>;
}) => (
  <label
    className="text-caption text-text-default flex h-6 items-center justify-between gap-2 px-1"
    data-testid="traces-polaris-switch"
  >
    <span className="min-w-0 truncate">
      Polaris <span className="text-text-subtle">· self-traces</span>
    </span>
    <Switch
      aria-label="Show Polaris's self-traces"
      checked={polaris.on}
      onCheckedChange={polaris.set}
    />
  </label>
);

const useLatestTurn = (at: TracesSessionKey) =>
  useApp((s) => s.hostModels[at.hostKey]?.sessions.get(at.sessionId)?.session.turnCount ?? null);

type SidebarView = "traces" | "profiles";

/** The checkout's recordings, kept here so the switch counts them and the open one stays fresh. */
const useSidebarProfiles = (at: TracesSessionKey) => {
  const snapshot = useProfiles(at);
  const unavailable = useProfilesUnavailable(at.hostKey);
  const profiles = snapshot.status === "ready" ? snapshot.value.profiles : null;
  const { hostKey, sessionId } = at;

  useEffect(() => {
    if (profiles !== null) refreshProfile({ hostKey, sessionId }, profiles);
  }, [hostKey, sessionId, profiles]);

  return { snapshot, unavailable, count: profiles?.length ?? 0 };
};

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
  const { hostKey, sessionId, scope } = at;

  useEffect(() => {
    const key = sessionKey(hostKey, sessionId, scope);
    publishListed(key, listed);

    return () => publishListed(key, null);
  }, [hostKey, sessionId, scope, listed]);

  const latestTurn = useLatestTurn(at);

  if (snapshot.status === "loading") return null;

  if (snapshot.status === "failed") return <Quiet>{snapshot.error.message}</Quiet>;
  const { traces, total } = snapshot.value;

  if (traces.length === 0) return <Quiet>{emptyLabel(at, filter)}</Quiet>;

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
  const [view, setView] = useState<SidebarView>("traces");
  const profiles = useSidebarProfiles(props.at);
  const latestTurn = useLatestTurn(props.at);

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
        {props.polaris === undefined ? null : <PolarisSwitch polaris={props.polaris} />}
        <SegmentedControl<SidebarView>
          aria-label="Traces or profiles"
          variant="fill"
          value={view}
          onValueChange={setView}
          options={[
            { value: "traces", label: "Traces" },
            {
              value: "profiles",
              label: "Profiles",
              badge:
                profiles.count === 0 ? undefined : (
                  <span className="text-micro text-text-subtle tabular font-normal">
                    {profiles.count}
                  </span>
                ),
            },
          ]}
        />
        {/* Hidden, not unmounted, so its words and the filter they made survive the switch. */}
        <div hidden={view !== "traces"}>
          <FilterWell onFilter={setFilter} />
        </div>
      </div>
      <div
        className={cn(
          "px-panel flex min-h-0 flex-1 flex-col overflow-y-auto pb-2",
          !connected && "opacity-(--opacity-dimmed)"
        )}
        data-testid="traces-sidebar-body"
      >
        {view === "traces" ? (
          <Body props={props} filter={filter} />
        ) : (
          <ProfileList
            at={props.at}
            traceId={props.traceId}
            snapshot={profiles.snapshot}
            unavailable={profiles.unavailable}
            latestTurn={latestTurn}
          />
        )}
      </div>
      <AgentsHere at={props.at} />
    </aside>
  );
};
