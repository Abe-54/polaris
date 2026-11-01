/**
 * The main slot (DESIGN.md, Traces → Waterfall, Service map): the open trace as the waterfall,
 * Table or Service map under their toolbar. Selecting a span sets the selection the span panel
 * reads (model/store.ts); the view is kept per Agent Session (model/mainView.ts).
 */
import type { TraceDetail } from "@polaris/protocol";
import { EmptyState, PixelAlertIcon, PixelHourglassIcon } from "@polaris/ui";
import { useCallback, useEffect, useMemo } from "react";
import { useTrace, useTraces } from "../data/hooks.tsx";
import { type MainView, setMainView, useMainView } from "../model/mainView.ts";
import { useListedVersion } from "../model/listed.ts";
import { publishOpenTrace } from "../model/openTrace.ts";
import { openTraceNs } from "../model/profile/openTrace.ts";
import { overlap } from "../model/profile/overlap.ts";
import { useProfileSelection } from "../model/profile/store.ts";
import { sessionKey, type TracesSessionKey } from "../model/session.ts";
import { selectSpan } from "../model/store.ts";
import { ServiceMap } from "./map/ServiceMap.tsx";
import type { TracesSlotProps } from "./slots.ts";
import { TableView } from "./waterfall/TableView.tsx";
import { Toolbar } from "./waterfall/Toolbar.tsx";
import { useTraceView } from "./waterfall/useTraceView.ts";
import { Waterfall } from "./waterfall/Waterfall.tsx";

const Shown = ({
  at,
  detail,
  spanId,
  view,
  onView,
}: {
  readonly at: TracesSessionKey;
  readonly detail: TraceDetail;
  readonly spanId: string | null;
  readonly view: MainView;
  readonly onView: (view: MainView) => void;
}) => {
  const trace = useTraceView(detail);
  const { hostKey, sessionId, scope } = at;
  const { profile } = useProfileSelection(at);

  const mark = useMemo(() => {
    if (profile === null) return null;
    const { startNs, endNs } = openTraceNs(detail);

    return overlap(profile, startNs, endNs)?.stretch ?? null;
  }, [profile, detail]);

  const onSelect = useCallback(
    (id: string | null) => selectSpan(sessionKey(hostKey, sessionId, scope), id),
    [hostKey, sessionId, scope]
  );

  const onOpenSpan = useCallback(
    (id: string) => {
      setMainView({ hostKey, sessionId }, "waterfall");
      selectSpan(sessionKey(hostKey, sessionId, scope), id);
    },
    [hostKey, sessionId, scope]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="traces-main" data-view={view}>
      <Toolbar view={view} onView={onView} trace={trace} />
      {view === "waterfall" ? (
        <Waterfall trace={trace} mark={mark} spanId={spanId} onSelect={onSelect} />
      ) : null}
      {view === "table" ? <TableView trace={trace} spanId={spanId} onSelect={onSelect} /> : null}
      {view === "map" ? <ServiceMap trace={trace} onOpenSpan={onOpenSpan} /> : null}
    </div>
  );
};

const Centered = ({ children }: { readonly children: React.ReactNode }) => (
  <div className="grid min-h-0 flex-1 place-items-center" data-testid="traces-main">
    {children}
  </div>
);

const Open = ({
  at,
  traceId,
  spanId,
  view,
  onView,
}: {
  readonly at: TracesSessionKey;
  readonly traceId: string;
  readonly spanId: string | null;
  readonly view: MainView;
  readonly onView: (view: MainView) => void;
}) => {
  const loaded = useTrace(at, traceId, useListedVersion(at, traceId));
  const detail = loaded.status === "ready" ? loaded.value : null;

  const { hostKey, sessionId, scope } = at;

  useEffect(() => {
    const key = sessionKey(hostKey, sessionId, scope);
    publishOpenTrace(key, detail);

    return () => publishOpenTrace(key, null);
  }, [hostKey, sessionId, scope, detail]);

  if (loaded.status === "loading") return <Centered>{null}</Centered>;

  if (loaded.status === "failed")
    return (
      <Centered>
        <EmptyState
          icon={<PixelAlertIcon size={24} className="text-text-strong" />}
          title={loaded.error.message}
          fact={loaded.error.fix ?? "Choose another trace in the sidebar"}
        />
      </Centered>
    );

  return (
    <Shown
      key={loaded.value.summary.id}
      at={at}
      detail={loaded.value}
      spanId={spanId}
      view={view}
      onView={onView}
    />
  );
};

const NoTrace = ({ at }: { readonly at: TracesSessionKey }) => {
  const snapshot = useTraces(at);
  const none = snapshot.status === "ready" && snapshot.value.total === 0;

  return (
    <Centered>
      <EmptyState
        icon={<PixelHourglassIcon size={24} className="text-text-strong" />}
        title={none ? "No traces yet" : "No trace open"}
        fact={
          none
            ? "Code run in this agent session's checkout sends its traces here"
            : "Choose a trace in the sidebar"
        }
      />
    </Centered>
  );
};

export const TraceMain = ({ at, traceId, spanId }: TracesSlotProps) => {
  const view = useMainView(at);
  const { hostKey, sessionId } = at;

  const onView = useCallback(
    (next: MainView) => setMainView({ hostKey, sessionId }, next),
    [hostKey, sessionId]
  );

  if (traceId === null) return <NoTrace at={at} />;

  return <Open at={at} traceId={traceId} spanId={spanId} view={view} onView={onView} />;
};
