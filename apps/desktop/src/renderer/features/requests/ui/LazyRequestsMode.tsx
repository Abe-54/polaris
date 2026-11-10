/**
 * Requests is its own chunk, so other modes never carry it. The app warms it after first paint
 * (ENG-905); until it has loaded, Requests' frames show empty in its place.
 */
import { type ComponentType, Suspense } from "react";
import { useSelection } from "../../../shell/hooks.ts";
import { ModeShell, SidebarFrame, WorkbenchPanel } from "../../../shell/ModeFrame.tsx";
import { type ModeChunk, modeChunk, useModeChunk } from "../../../shell/modeChunk.ts";

/** What the wrapper takes from the chunk. */
export interface RequestsModeChunk {
  readonly RequestsMode: ComponentType;
}

export const requestsChunk = modeChunk<RequestsModeChunk>(() => import("./RequestsMode.tsx"));

const View = ({ chunk }: { chunk: ModeChunk<RequestsModeChunk> }) => {
  const { RequestsMode: Loaded } = useModeChunk(chunk);

  return <Loaded />;
};

const RequestsShell = () => {
  const { sessionId } = useSelection();

  return (
    <ModeShell mode="requests">
      {sessionId === null ? null : (
        <SidebarFrame label="Requests">
          <WorkbenchPanel label="Requests panel" status="h-7" />
        </SidebarFrame>
      )}
    </ModeShell>
  );
};

/** Requests mode over `chunk`; tests pass one whose import they control. */
export const requestsModeOver = (chunk: ModeChunk<RequestsModeChunk>) => () => (
  <Suspense fallback={<RequestsShell />}>
    <View chunk={chunk} />
  </Suspense>
);

export const RequestsMode = requestsModeOver(requestsChunk);
