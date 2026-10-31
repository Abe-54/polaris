/**
 * Data's sidebar (DESIGN.md, Data → Sidebar; Paper D1): the Workspace header, the `Sources |
 * Query log` switch, the source tree or the Query Log, and "Agents in this worktree". While the
 * Host is Reconnecting or Offline it shows the last known state, dimmed (rule/remote-is-normal).
 */
import type { QueryLogEntry } from "@polaris/protocol";
import { BranchIcon, cn, SegmentedControl } from "@polaris/ui";
import { useApp } from "../../../shell/hooks.ts";
import { useQueryLog } from "../data/hooks.tsx";
import { type SidebarView, setSidebarView, useSidebar } from "../model/sidebar.ts";
import { AgentsHere } from "./sidebar/AgentsHere.tsx";
import { QueryLogView } from "./sidebar/QueryLogView.tsx";
import { SourceFormDialog } from "./sidebar/SourceForm.tsx";
import { SourcesView } from "./sidebar/SourcesView.tsx";
import { useLogLookups } from "./sidebar/useLogLookups.ts";
import { useRefreshSources } from "./sidebar/useRefreshSources.ts";
import type { DataSlotProps } from "./slots.ts";
import { useBranch } from "./useBranch.ts";

const NO_ENTRIES: ReadonlyArray<QueryLogEntry> = [];

const Header = (props: DataSlotProps) => {
  const name = useApp((s) => s.hostModels[props.hostKey]?.workspaces.get(props.workspaceId)?.name);
  const host = useApp((s) => s.hosts.find((h) => h.key === props.hostKey));
  const branch = useBranch(props.at);
  const state = host?.status.state;
  const away = state === "reconnecting" || state === "offline";

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <h1 className="text-heading text-text-strong min-w-0 truncate" title={name}>
        {name ?? ""}
      </h1>
      <p
        className="text-caption text-text-subtle flex min-w-0 items-center gap-1"
        data-testid="data-where"
      >
        <span className="shrink-0">{host?.label}</span>
        {away ? (
          <span className="shrink-0">· {state === "offline" ? "Offline" : "Reconnecting"}</span>
        ) : null}
        {branch === null ? null : (
          <>
            <span className="shrink-0">·</span>
            <BranchIcon size={12} className="shrink-0" />
            <span className="min-w-0 truncate font-mono" title={branch}>
              {branch}
            </span>
          </>
        )}
      </p>
    </div>
  );
};

export const DataSidebar = (props: DataSlotProps) => {
  const { at, hostKey, active } = props;

  const connected = useApp(
    (s) => s.hosts.find((h) => h.key === hostKey)?.status.state === "connected"
  );

  useRefreshSources(at);
  const { view } = useSidebar(at);
  const log = useQueryLog(at);
  const lookups = useLogLookups(hostKey);
  const entries = log.status === "ready" ? log.value : NO_ENTRIES;

  return (
    <aside
      aria-label="Data"
      data-testid="data-sidebar"
      className="flex min-h-0 w-[270px] flex-1 flex-col"
    >
      <div className="px-panel pt-panel flex flex-col gap-[calc(var(--spacing-panel)*0.75)] pb-[calc(var(--spacing-panel)*0.5)]">
        <Header {...props} />
        <SegmentedControl<SidebarView>
          aria-label="Sources or query log"
          variant="fill"
          value={view}
          onValueChange={(next) => setSidebarView(at, next)}
          options={[
            { value: "sources", label: "Sources" },
            {
              value: "log",
              label: "Query log",
              badge:
                entries.length === 0 ? undefined : (
                  <span className="text-micro text-text-subtle tabular font-normal">
                    {entries.length}
                  </span>
                ),
            },
          ]}
        />
      </div>
      <div
        className={cn("flex min-h-0 flex-1 flex-col", !connected && "opacity-(--opacity-dimmed)")}
        data-testid="data-sidebar-body"
      >
        {view === "sources" ? (
          <SourcesView at={at} active={active} log={entries} lookups={lookups} canAdd={connected} />
        ) : (
          <QueryLogView at={at} log={log} lookups={lookups} />
        )}
      </div>
      <AgentsHere at={at} log={entries} lookups={lookups} />
      <SourceFormDialog at={at} />
    </aside>
  );
};
