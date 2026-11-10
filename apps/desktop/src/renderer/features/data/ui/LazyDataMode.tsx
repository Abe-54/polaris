/**
 * Data mode is its own chunk, so other modes never carry it. The app warms it after first paint
 * (ENG-905); until it has loaded, Data's frames show empty in its place.
 */
import { type ComponentType, Suspense } from "react";
import { useSelection } from "../../../shell/hooks.ts";
import { ModeShell, SidebarFrame, WorkbenchPanel } from "../../../shell/ModeFrame.tsx";
import { type ModeChunk, modeChunk, useModeChunk } from "../../../shell/modeChunk.ts";

/** What the wrapper takes from the chunk. */
export interface DataChunk {
  readonly DataMode: ComponentType;
  readonly openEditsShelf: () => void;
}

export const dataChunk = modeChunk<DataChunk>(() => import("./DataMode.tsx"));

const View = ({ chunk }: { chunk: ModeChunk<DataChunk> }) => {
  const loaded = useModeChunk(chunk);

  // Staged grid edits outlive a reload or quit: read once, when Data first opens, not warms.
  loaded.openEditsShelf();

  return <loaded.DataMode />;
};

const DataShell = () => {
  const { sessionId } = useSelection();

  return (
    <ModeShell mode="data">
      {sessionId === null ? null : (
        <SidebarFrame label="Data">
          <WorkbenchPanel label="Data panel" status="h-tree-row" />
        </SidebarFrame>
      )}
    </ModeShell>
  );
};

/** Data mode over `chunk`; tests pass one whose import they control. */
export const dataModeOver = (chunk: ModeChunk<DataChunk>) => () => (
  <Suspense fallback={<DataShell />}>
    <View chunk={chunk} />
  </Suspense>
);

export const DataMode = dataModeOver(dataChunk);
