/**
 * Edit mode (⌘3, the title bar's Edit; DESIGN.md, Chrome redesign → Editor): the Workspace bar,
 * then the explorer on the ground over the horizon, and the editor and terminal as panels 6px
 * apart. Choosing another Workspace keeps Edit; tabs are per Workspace.
 */
import { EmptyState, Horizon, PixelFolderIcon } from "@polaris/ui";
import { useEffect } from "react";
import { TerminalPanels } from "../../../terminal/index.ts";
import { TopBar } from "../../../../shell/TopBar.tsx";
import { useApp, useSelection } from "../../../../shell/hooks.ts";
import { explorerKey, useExplorerState } from "../data/store.ts";
import { EditorPane, EditorStatus, registerEditorExtensions } from "../../index.ts";
import { gitGutter } from "../gutter/gitGutter.ts";
import { Explorer } from "./Explorer.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { commandShortcut } from "../../../../../shared/keymap.ts";

const NoWorkspace = () => (
  <div className="grid flex-1 place-items-center" data-testid="edit-no-workspace">
    <EmptyState
      icon={<PixelFolderIcon size={24} className="text-text-strong" />}
      title="No workspace to edit"
      fact={`Choose one in the bar above, or ${commandShortcut("workspace.add")} opens a folder`}
    />
  </div>
);

const Workbench = ({
  hostKey,
  workspaceId,
}: {
  readonly hostKey: string;
  readonly workspaceId: string;
}) => {
  const host = useApp((s) => s.hosts.find((h) => h.key === hostKey));
  const workspace = useApp((s) => s.hostModels[hostKey]?.workspaces.get(workspaceId));
  const explorer = useExplorerState(explorerKey(hostKey, workspaceId));

  if (host === undefined || workspace === undefined) return <NoWorkspace />;
  const root = explorer.root ?? workspace.path;

  return (
    <div className="flex min-h-0 flex-1 gap-1.5 pr-1.5 pb-1.5" data-testid="edit-mode">
      <div className="relative isolate flex min-h-0 shrink-0 flex-col">
        <Explorer host={host} workspace={workspace} />
        <Horizon />
      </div>
      <TerminalPanels
        hostKey={hostKey}
        workspaceId={workspaceId}
        status={
          <StatusBar
            host={host}
            place={{ key: explorerKey(hostKey, workspaceId), hostKey, workspaceId, root }}
            git={explorer.git}
            right={<EditorStatus hostKey={hostKey} workspaceId={workspaceId} />}
          />
        }
      >
        <EditorPane hostKey={hostKey} workspaceId={workspaceId} root={root} />
      </TerminalPanels>
    </div>
  );
};

export const EditMode = () => {
  const { hostKey, workspaceId } = useSelection();

  // The git gutter rides on every tab's editor while Edit is open.
  useEffect(() => {
    return registerEditorExtensions(gitGutter);
  }, []);

  return (
    <>
      <TopBar />
      <main className="flex min-h-0 flex-1 flex-col">
        {hostKey === null || workspaceId === null ? (
          <NoWorkspace />
        ) : (
          // Keyed so a Workspace switch starts its own explorer, never a blend of two.
          <Workbench
            key={`${hostKey}\u0000${workspaceId}`}
            hostKey={hostKey}
            workspaceId={workspaceId}
          />
        )}
      </main>
    </>
  );
};
