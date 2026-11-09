/**
 * Requests' sidebar (DESIGN.md, Requests → Sidebar; Paper Q1): the Workspace header with its "+"
 * menu, the `Requests n | Send log n` switch, 8px, then the filter well and the files' Requests,
 * or the send log; "Agents in this worktree" at the foot. Dimmed while the Host is away.
 */
import type { HttpRequest, RequestsSnapshot } from "@polaris/protocol";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  PlusIcon,
  SegmentedControl,
} from "@polaris/ui";
import { useMemo, useState } from "react";
import { useApp } from "../../../shell/hooks.ts";
import type { Loaded } from "../data/hooks.tsx";
import { useSendLog } from "../data/sendLog.tsx";
import { refString } from "../model/draft.ts";
import { fileGroups, requestCount } from "../model/sidebar.ts";
import { setSidebarView, type SidebarView, toggleFile, useRequestsView } from "../model/store.ts";
import { AgentsHere } from "./sidebar/AgentsHere.tsx";
import { FilterWell } from "./sidebar/FilterWell.tsx";
import { Header } from "./sidebar/Header.tsx";
import { RequestList } from "./sidebar/RequestList.tsx";
import { SendLog, SendLogFilter } from "./SendLog.tsx";
import type { RequestsSlotProps } from "./slots.ts";

const Quiet = ({ children }: { readonly children: string }) => (
  <p className="text-caption text-text-subtle px-2 py-2" data-testid="requests-sidebar-quiet">
    {children}
  </p>
);

/** "+": a new Request, or one from a curl command on the clipboard. */
const AddMenu = ({
  onNew,
  onPasteCurl,
}: {
  readonly onNew: () => void;
  readonly onPasteCurl: () => void;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger
      aria-label="New request"
      data-testid="requests-add"
      className="text-text-subtle hover:bg-fill-hover hover:text-text-default focus-visible:ring-starlight flex size-[30px] shrink-0 cursor-default items-center justify-center rounded-full outline-none focus-visible:ring-2"
    >
      <PlusIcon size={14} />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem onSelect={onNew}>New request</DropdownMenuItem>
      <DropdownMenuItem onSelect={onPasteCurl}>Paste a curl command</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

const Count = ({ n }: { readonly n: number | null }) =>
  n === null ? undefined : (
    <span className="text-micro text-text-subtle tabular font-normal">{n}</span>
  );

export interface RequestsSidebarProps extends RequestsSlotProps {
  readonly snapshot: Loaded<RequestsSnapshot>;
  readonly openKey: string | null;
  readonly unsaved: (request: HttpRequest) => boolean;
  readonly onOpen: (request: HttpRequest) => void;
  readonly onNew: () => void;
  readonly onPasteCurl: () => void;
}

const Requests = (props: RequestsSidebarProps & { readonly filter: string }) => {
  const { snapshot, filter } = props;
  const view = useRequestsView(props.at);
  const files = snapshot.status === "ready" ? snapshot.value.files : null;
  const groups = useMemo(() => (files === null ? [] : fileGroups(files, filter)), [files, filter]);

  if (snapshot.status === "loading") return null;

  if (snapshot.status === "failed") return <Quiet>{snapshot.error.message}</Quiet>;

  if (snapshot.value.files.length === 0) return <Quiet>No .http files in this checkout</Quiet>;

  if (groups.length === 0) return <Quiet>No requests match the filter</Quiet>;

  return (
    <RequestList
      groups={groups}
      fileCount={snapshot.value.files.length}
      openKey={props.openKey}
      keyOf={refString}
      isUnsaved={props.unsaved}
      isClosed={(path) => filter === "" && view.closed[path] === true}
      onOpen={props.onOpen}
      onToggle={(path) => toggleFile(props.at, path)}
    />
  );
};

export const RequestsSidebar = (props: RequestsSidebarProps) => {
  const [filter, setFilter] = useState("");
  const { sidebar } = useRequestsView(props.at);
  const { snapshot } = props;
  const count = snapshot.status === "ready" ? requestCount(snapshot.value.files) : null;
  const log = useSendLog(props.at);

  const connected = useApp(
    (s) => s.hosts.find((h) => h.key === props.hostKey)?.status.state === "connected"
  );

  return (
    <aside
      aria-label="Requests"
      data-testid="requests-sidebar"
      className="flex min-h-0 w-[270px] flex-1 flex-col"
    >
      <div className="px-panel pt-panel flex flex-col gap-[calc(var(--spacing-panel)*0.75)] pb-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Header {...props} />
          </div>
          <AddMenu onNew={props.onNew} onPasteCurl={props.onPasteCurl} />
        </div>
        <div className="flex flex-col gap-2">
          <SegmentedControl<SidebarView>
            aria-label="Requests or send log"
            variant="fill"
            value={sidebar}
            onValueChange={(view) => setSidebarView(props.at, view)}
            options={[
              { value: "requests", label: "Requests", badge: <Count n={count} /> },
              {
                value: "send-log",
                label: "Send log",
                badge: <Count n={log.status === "ready" ? log.value.length : null} />,
              },
            ]}
          />
          {/* Hidden, not unmounted, so the filter survives the switch. */}
          <div hidden={sidebar !== "requests"}>
            <FilterWell text={filter} onText={setFilter} />
          </div>
          {sidebar === "send-log" ? <SendLogFilter {...props} /> : null}
        </div>
      </div>
      <div
        className={cn(
          "px-panel flex min-h-0 flex-1 flex-col overflow-y-auto pb-2",
          !connected && "opacity-(--opacity-dimmed)"
        )}
        data-testid="requests-sidebar-body"
      >
        {sidebar === "requests" ? (
          <Requests {...props} filter={filter} />
        ) : (
          <SendLog {...props} log={log} />
        )}
      </div>
      <AgentsHere at={props.at} />
    </aside>
  );
};
