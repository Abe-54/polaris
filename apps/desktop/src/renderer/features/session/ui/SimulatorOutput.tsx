/**
 * Output's Simulator tab, after the Browser (Paper "Simulator (ENG-829)"): the tab with its
 * activity dot, and its body for the session's Host. The tab shows on every Mac, and on another
 * Host once the Android SDK's emulator is found.
 */
import type { SessionId, Simulator, TerminalId, WorkspaceId } from "@polaris/protocol";
import { type Harness, hueVar } from "@polaris/ui";
import { useApp } from "../../../shell/hooks.ts";
import { stageFile, thumbnail } from "../../attachments/stage.ts";
import { keepThumbnail } from "../../attachments/useUploads.ts";
import { polaris } from "../../bridge.ts";
import {
  SimulatorPane,
  tabVisible,
  useHostSimulators,
  useSimulatorUi,
} from "../../simulator/index.ts";
import { runInTerminal } from "../../terminal/index.ts";
import { hasCapability, useHost } from "../hooks.ts";
import { pickSimulator } from "../output/simulator.ts";
import { patchSessionUi, uiKey } from "../state.ts";
import { OutputTab } from "./SubagentOutput.tsx";

/** Whether the session's Host shows the Simulator tab and rail row at all. */
export const useSimulatorTab = (hostKey: string) => {
  const capable = hasCapability(useHost(hostKey), "simulator");

  return tabVisible(useHostSimulators(hostKey, capable)?.support ?? null);
};

/** True while the Simulator is the Output tab on screen (a Subagent's tab takes its place). */
export const useSimulatorShown = (hostKey: string, sessionId: string, subagentShown: boolean) => {
  const { shown } = useSimulatorUi(uiKey(hostKey, sessionId));
  const visible = useSimulatorTab(hostKey);

  return shown && visible && !subagentShown;
};

export const SimulatorOutputTab = ({
  hostKey,
  sessionId,
  on,
  harness,
}: {
  readonly hostKey: string;
  readonly sessionId: string;
  readonly on: boolean;
  readonly harness: Harness | null;
}) => {
  const { dot } = useSimulatorUi(uiKey(hostKey, sessionId));
  const visible = useSimulatorTab(hostKey);

  if (!visible) return null;

  return (
    <OutputTab id="simulator" on={on} onClick={() => pickSimulator(hostKey, sessionId)}>
      Simulator
      {dot && !on ? (
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: hueVar(harness ?? "starlight") }}
          aria-label="An agent opened a Simulator"
          data-testid="simulator-activity"
        />
      ) : null}
    </OutputTab>
  );
};

let shots = 0;

/** Stages the screen's PNG on the Host and adds it to the session's composer. */
const attachScreenshot = async (
  target: { hostKey: string; workspaceId: WorkspaceId; sessionId: SessionId },
  png: Blob,
  device: Simulator
) => {
  const name = `${device.name.replace(/[^\w.-]+/g, "-")}-${++shots}.png`;
  const file = new File([png], name, { type: "image/png" });
  const [staged, thumb] = await Promise.all([stageFile(target, file, name), thumbnail(file)]);

  if (staged === null) return;

  if (thumb !== null) keepThumbnail(staged.id, thumb);
  patchSessionUi(uiKey(target.hostKey, target.sessionId), (ui) => ({
    attachments: [
      ...ui.attachments,
      {
        id: staged.id,
        name: staged.name,
        mimeType: staged.mimeType,
        size: staged.size,
        hostPath: staged.hostPath,
        width: staged.width,
        height: staged.height,
      },
    ],
  }));
};

/** Opens a shell in the drawer with `command` typed at its prompt, never run. */
const typeInTerminal = async (
  place: { hostKey: string; workspaceId: WorkspaceId },
  cwd: string,
  command: string
) => {
  const terminalId = await runInTerminal(place, {
    key: `simulator-setup:${command}`,
    title: "Simulator setup",
    cwd,
    argv: null,
  });

  if (terminalId === null) return;
  void polaris().request("terminal.input", {
    hostKey: place.hostKey,
    // SAFETY: `runInTerminal` answers with the id `terminal.open` gave.
    terminalId: terminalId as TerminalId,
    data: new TextEncoder().encode(command),
  });
};

export const SessionSimulator = ({
  hostKey,
  sessionId,
  workspaceId,
  cwd,
  harness,
}: {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly cwd: string;
  readonly harness: Harness | null;
}) => {
  const host = useHost(hostKey);
  const hostLabel = useApp((s) => s.hosts.find((h) => h.key === hostKey)?.label ?? "the host");
  const target = { hostKey, workspaceId, sessionId };

  return (
    <SimulatorPane
      hostKey={hostKey}
      sessionId={sessionId}
      stateKey={uiKey(hostKey, sessionId)}
      hostLabel={hostLabel}
      local={host?.kind === "local"}
      harness={harness}
      canAttach={hasCapability(host, "attachments.stage")}
      onScreenshot={(png, device) => void attachScreenshot(target, png, device)}
      onTypeInTerminal={(command) => void typeInTerminal({ hostKey, workspaceId }, cwd, command)}
    />
  );
};
