/**
 * Traces (⌘5; DESIGN.md, Traces): Data's shell with no assistant panel. The Workspace bar, the
 * sidebar on the ground over the horizon, and one panel holding the trace bar, the waterfall or
 * Table with the span panel beside it, the open Profile and the drawer under them, and the status bar. Each slot is
 * its own file (slots.ts) so its owner replaces it alone.
 */
import type { SessionId } from "@polaris/protocol";
import { EmptyState, Horizon, PixelAlertIcon, PixelHourglassIcon } from "@polaris/ui";
import { TopBar } from "../../../shell/TopBar.tsx";
import { useApp, useSelection } from "../../../shell/hooks.ts";
import { useTraces } from "../data/hooks.tsx";
import { useTracesUnavailable } from "../model/availability.ts";
import { useMainView } from "../model/mainView.ts";
import type { TracesSessionKey } from "../model/session.ts";
import { setupState } from "../model/setup.ts";
import { useTracesSelection } from "../model/store.ts";
import { TracesDrawer } from "./Drawer.tsx";
import { ProfilePanel } from "./profile/ProfilePanel.tsx";
import { TracesSidebar } from "./Sidebar.tsx";
import type { TracesSlotProps } from "./slots.ts";
import { SpanPanel } from "./SpanPanel.tsx";
import { TracesStatusBar } from "./StatusBar.tsx";
import { TraceBar } from "./TraceBar.tsx";
import { TraceMain } from "./TraceMain.tsx";
import { TracesSetup } from "./setup/TracesSetup.tsx";

/** One trace is enough to know the checkout has some; the sidebar reads the list. */
const PROBE = { limit: 1 } as const;

/** What Traces shows in place of a trace (none once the checkout has traces), and the receiver. */
const useSetup = (at: TracesSessionKey) => {
  const snapshot = useTraces(at, PROBE);
  const label = useApp((s) => s.hosts.find((h) => h.key === at.hostKey)?.label);
  const state = useApp((s) => s.hosts.find((h) => h.key === at.hostKey)?.status.state);

  return {
    setup: setupState(
      snapshot,
      label === undefined || state === undefined ? undefined : { label, state }
    ),
    receiver: snapshot.status === "ready" ? snapshot.value : null,
  };
};

const Centered = ({
  testId,
  icon,
  title,
  fact,
}: {
  testId: string;
  icon: React.ReactNode;
  title: string;
  fact: string;
}) => (
  <div className="grid flex-1 place-items-center" data-testid={testId}>
    <EmptyState icon={icon} title={title} fact={fact} />
  </div>
);

const Workbench = ({ slot }: { slot: Omit<TracesSlotProps, "traceId" | "spanId"> }) => {
  const selection = useTracesSelection(slot.at);
  const props = { ...slot, ...selection };
  const { setup, receiver } = useSetup(slot.at);
  // The service map brings its own panel; the span panel waits for Waterfall or Table.
  const map = useMainView(slot.at) === "map";

  return (
    <div className="flex min-h-0 flex-1 gap-1.5 pr-1.5 pb-1.5" data-testid="traces-mode">
      <div className="relative isolate flex min-h-0 shrink-0 flex-col">
        <TracesSidebar {...props} />
        <Horizon moon={false} />
      </div>
      <section className="border-hairline bg-panel shadow-panel flex min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] border">
        {setup === null ? (
          <>
            <TraceBar {...props} />
            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                <TraceMain {...props} />
              </div>
              {map ? null : <SpanPanel {...props} />}
            </div>
            <ProfilePanel {...props} />
            <TracesDrawer {...props} />
          </>
        ) : (
          <TracesSetup state={setup} />
        )}
        <TracesStatusBar {...props} receiver={receiver} />
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
  const unavailable = useTracesUnavailable(hostKey);

  if (unavailable !== null)
    return (
      <Centered
        testId="traces-unsupported"
        icon={<PixelAlertIcon size={24} className="text-text-strong" />}
        title={unavailable}
        fact="Update the daemon in Settings → Hosts to see this checkout's traces"
      />
    );

  return <Workbench slot={{ at: { hostKey, sessionId }, hostKey, workspaceId }} />;
};

export const TracesMode = () => {
  const { hostKey, workspaceId, sessionId } = useSelection();

  return (
    <>
      <TopBar />
      <main className="flex min-h-0 flex-1 flex-col">
        {hostKey === null || workspaceId === null || sessionId === null ? (
          <Centered
            testId="traces-no-session"
            icon={<PixelHourglassIcon size={24} className="text-text-strong" />}
            title="No agent session to show traces for"
            fact="Traces shows what code run in the selected agent session's checkout sent"
          />
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
