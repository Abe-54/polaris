/**
 * The shell's `NoSession` slot. A Workspace with no Agent Sessions is a stage
 * (scene, clearing, setup card: start a session, open a terminal); one whose
 * sessions just aren't selected is a pane: which sessions exist, K to jump. Either holds
 * this Mac's computer use first-run card (Paper CU3) until it's skipped or done.
 */
import type { Workspace, WorkspaceId } from "@polaris/protocol";
import {
  Button,
  EmptyState,
  Kbd,
  PixelSparkleIcon,
  PixelTerminalIcon,
  SetupCard,
  SetupRow,
} from "@polaris/ui";
import type { HostView } from "../../../../shared/api.ts";
import { activeSessions } from "../../../routes/topBar.ts";
import { emptyHostModel } from "../../../store/hostModel.ts";
import { useApp, useShellActions } from "../../../shell/hooks.ts";
import { toggleTerminal } from "../../terminal/index.ts";
import { useReadyLine } from "../hooks.ts";
import { captionPath, noSelectionFact, stageKicker } from "../model.ts";
import { Stage } from "./Stage.tsx";
import { LocalMacOnboarding } from "../../computer-use/index.ts";
import { shortcutLabel } from "../../../../shared/chord.ts";
import { TERMINAL_TOGGLE, commandShortcut } from "../../../../shared/keymap.ts";

export interface WorkspaceStageProps {
  readonly hostKey: string;
  readonly workspaceId: WorkspaceId;
}

interface EmptyWorkspaceProps extends WorkspaceStageProps {
  readonly host: HostView;
  readonly workspace: Workspace;
}

const EmptyWorkspace = ({ hostKey, workspaceId, host, workspace }: EmptyWorkspaceProps) => {
  const { startNewSession } = useShellActions();

  return (
    <Stage
      kicker={stageKicker(host.label, workspace.name)}
      title="Nothing is running here yet"
      line="Start an agent session, or open a terminal in this workspace"
      testId="workspace-stage"
    >
      <SetupCard className="shadow-float">
        <SetupRow
          icon={<PixelSparkleIcon size={20} />}
          title="Start a session"
          caption={useReadyLine(host)}
          action={
            <Button variant="primary" onClick={startNewSession} data-testid="stage-new-session">
              New session <Kbd variant="plain">{commandShortcut("session.new")}</Kbd>
            </Button>
          }
        />
        <SetupRow
          icon={<PixelTerminalIcon size={20} />}
          title="Open a terminal"
          caption={captionPath(workspace.path, host.status.host?.homeDir ?? null)}
          action={
            <Button
              onClick={() =>
                toggleTerminal({ hostKey, workspaceId }, workspace.path, workspace.name)
              }
            >
              Terminal <Kbd variant="plain">{shortcutLabel(TERMINAL_TOGGLE)}</Kbd>
            </Button>
          }
        />
      </SetupCard>
      <div className="pt-6">
        <LocalMacOnboarding host={host} />
      </div>
    </Stage>
  );
};

export const WorkspaceStage = ({ hostKey, workspaceId }: WorkspaceStageProps) => {
  const model = useApp((s) => s.hostModels[hostKey]) ?? emptyHostModel;
  const host = useApp((s) => s.hosts.find((h) => h.key === hostKey));
  const { startNewSession } = useShellActions();
  const workspace = model.workspaces.get(workspaceId);
  const sessions = activeSessions(model, workspaceId).length;

  if (workspace === undefined || host === undefined) return <div className="flex-1" />;

  if (sessions === 0) {
    return (
      <EmptyWorkspace
        hostKey={hostKey}
        workspaceId={workspaceId}
        host={host}
        workspace={workspace}
      />
    );
  }

  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-8 overflow-y-auto p-4"
      data-testid="no-session"
    >
      <LocalMacOnboarding host={host} />
      <EmptyState
        icon={<PixelSparkleIcon size={24} className="text-text-strong" />}
        title="No agent session open"
        fact={noSelectionFact(sessions, workspace.name)}
        action={
          <Button onClick={startNewSession}>
            New session <Kbd variant="plain">{commandShortcut("session.new")}</Kbd>
          </Button>
        }
      />
    </div>
  );
};
