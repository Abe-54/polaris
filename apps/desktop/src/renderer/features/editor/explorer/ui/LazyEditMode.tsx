/**
 * Edit mode is its own chunk (the explorer, the git gutter and CodeMirror's core), so
 * Orchestrate never carries it. The app warms it after first paint (ENG-905); until it has
 * loaded, Edit's frames show empty in its place.
 */
import { type ComponentType, Suspense } from "react";
import { useSelection } from "../../../../shell/hooks.ts";
import { EditorPanel, ModeShell, SidebarFrame } from "../../../../shell/ModeFrame.tsx";
import { type ModeChunk, modeChunk, useModeChunk } from "../../../../shell/modeChunk.ts";

/** What the wrapper takes from the chunk. */
export interface EditModeChunk {
  readonly EditMode: ComponentType;
}

export const editChunk = modeChunk<EditModeChunk>(() => import("./EditMode.tsx"));

const View = ({ chunk }: { chunk: ModeChunk<EditModeChunk> }) => {
  const { EditMode: Loaded } = useModeChunk(chunk);

  return <Loaded />;
};

const EditShell = () => {
  const { workspaceId } = useSelection();

  return (
    <ModeShell mode="edit">
      {workspaceId === null ? null : (
        <SidebarFrame label="Explorer" moon>
          <EditorPanel />
        </SidebarFrame>
      )}
    </ModeShell>
  );
};

/** Edit mode over `chunk`; tests pass one whose import they control. */
export const editModeOver = (chunk: ModeChunk<EditModeChunk>) => () => (
  <Suspense fallback={<EditShell />}>
    <View chunk={chunk} />
  </Suspense>
);

export const EditMode = editModeOver(editChunk);
