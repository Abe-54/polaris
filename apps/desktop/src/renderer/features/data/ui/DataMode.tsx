/**
 * Data mode (⌘4; DESIGN.md, Data): the Workspace bar, then the sidebar on the ground over the
 * horizon and one panel holding the connection bar, tabs, the tab's body, the Query Log drawer
 * and the status bar. Each slot is its own file (slots.ts) so its owner replaces it alone.
 */
import type { SessionId } from "@polaris/protocol";
import { Button, EmptyState, Horizon, PixelServerIcon } from "@polaris/ui";
import { useEffect } from "react";
import { TopBar } from "../../../shell/TopBar.tsx";
import { useSelection } from "../../../shell/hooks.ts";
import { useDataSources } from "../data/hooks.tsx";
import { type DataSessionKey, openSqlTab, showDataSession, useDataTabs } from "../model/store.ts";
import { ConnectionBar } from "./ConnectionBar.tsx";
import { QueryLogDrawer } from "./QueryLogDrawer.tsx";
import { DataSidebar } from "./Sidebar.tsx";
import type { DataSlotProps } from "./slots.ts";
import { DataStatusBar } from "./StatusBar.tsx";
import { TabStrip } from "./TabStrip.tsx";
import { tabBody } from "./tabKinds.tsx";
import { useCloseTab } from "./useCloseTab.ts";
import { useNewSqlTab } from "./useNewSqlTab.ts";
import { WorkingStrip } from "./WorkingStrip.tsx";

const NoSession = () => (
  <div className="grid flex-1 place-items-center" data-testid="data-no-session">
    <EmptyState
      icon={<PixelServerIcon size={24} className="text-text-strong" />}
      title="No agent session to show data for"
      fact="Data shows the data sources of the selected agent session's checkout"
    />
  </div>
);

const NoTab = ({ at }: { at: DataSessionKey }) => {
  const sources = useDataSources(at);
  const first = sources.status === "ready" ? sources.value[0] : undefined;

  return (
    <div className="grid flex-1 place-items-center" data-testid="data-no-tab">
      <EmptyState
        icon={<PixelServerIcon size={24} className="text-text-strong" />}
        title="No table open"
        fact="Choose a table in the sidebar, or write a query"
        action={
          first === undefined ? undefined : (
            <Button variant="secondary" onClick={() => openSqlTab("", first.name, at)}>
              New SQL tab
            </Button>
          )
        }
      />
    </div>
  );
};

const Workbench = ({ slot }: { slot: Omit<DataSlotProps, "active"> }) => {
  const { at } = slot;
  const state = useDataTabs(at);
  const active = state.tabs.find((t) => t.id === state.active) ?? null;
  const props = { ...slot, active };

  useNewSqlTab(at, active);
  useCloseTab(at, state.active);

  return (
    <div className="flex min-h-0 flex-1 gap-1.5 pr-1.5 pb-1.5" data-testid="data-mode">
      <div className="relative isolate flex min-h-0 shrink-0 flex-col">
        <DataSidebar {...props} />
        <Horizon moon={false} />
      </div>
      <section className="border-hairline bg-panel shadow-panel flex min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] border">
        <ConnectionBar {...props} />
        {state.tabs.length > 0 && <TabStrip at={at} state={state} />}
        {active?.kind === "table" && <WorkingStrip at={at} hostKey={slot.hostKey} tab={active} />}
        <div className="flex min-h-0 flex-1 flex-col" role="tabpanel">
          {active === null ? <NoTab at={at} /> : tabBody(at, active)}
        </div>
        <QueryLogDrawer {...props} />
        <DataStatusBar {...props} />
      </section>
    </div>
  );
};

const Shown = ({
  hostKey,
  workspaceId,
  sessionId,
}: {
  hostKey: string;
  workspaceId: string;
  sessionId: SessionId;
}) => {
  useEffect(() => {
    showDataSession({ hostKey, sessionId });

    return () => showDataSession(null);
  }, [hostKey, sessionId]);

  return <Workbench slot={{ at: { hostKey, sessionId }, hostKey, workspaceId }} />;
};

export { openEditsShelf } from "./table/edits/store.ts";

export const DataMode = () => {
  const { hostKey, workspaceId, sessionId } = useSelection();

  return (
    <>
      <TopBar />
      <main className="flex min-h-0 flex-1 flex-col">
        {hostKey === null || workspaceId === null || sessionId === null ? (
          <NoSession />
        ) : (
          <Shown
            key={`${hostKey}\u0000${sessionId}`}
            hostKey={hostKey}
            workspaceId={workspaceId}
            sessionId={sessionId}
          />
        )}
      </main>
    </>
  );
};
