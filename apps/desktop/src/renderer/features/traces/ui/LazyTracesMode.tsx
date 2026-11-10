/**
 * Traces is its own chunk, so other modes never carry it. The app warms it after first paint
 * (ENG-905); until it has loaded, Traces' frames show empty in its place.
 */
import { type ComponentType, Suspense } from "react";
import { useSelection } from "../../../shell/hooks.ts";
import { ModeShell, SidebarFrame, WorkbenchPanel } from "../../../shell/ModeFrame.tsx";
import { type ModeChunk, modeChunk, useModeChunk } from "../../../shell/modeChunk.ts";

/** What the wrapper takes from the chunk. */
export interface TracesModeChunk {
  readonly TracesMode: ComponentType;
}

export const tracesChunk = modeChunk<TracesModeChunk>(() => import("./TracesMode.tsx"));

const View = ({ chunk }: { chunk: ModeChunk<TracesModeChunk> }) => {
  const { TracesMode: Loaded } = useModeChunk(chunk);

  return <Loaded />;
};

const TracesShell = () => {
  const { sessionId } = useSelection();

  return (
    <ModeShell mode="traces">
      {sessionId === null ? null : (
        <SidebarFrame label="Traces">
          <WorkbenchPanel label="Traces panel" status="h-7" />
        </SidebarFrame>
      )}
    </ModeShell>
  );
};

/** Traces mode over `chunk`; tests pass one whose import they control. */
export const tracesModeOver = (chunk: ModeChunk<TracesModeChunk>) => () => (
  <Suspense fallback={<TracesShell />}>
    <View chunk={chunk} />
  </Suspense>
);

export const TracesMode = tracesModeOver(tracesChunk);
