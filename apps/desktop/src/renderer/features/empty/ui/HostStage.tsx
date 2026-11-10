/**
 * A Host with no Workspaces, and first run (onboarding O2): "Where does your
 * code live?" with the setup card (Paper 57Q-1): add a workspace (the ⌘O
 * dialog, on this Host), connect a host, and start
 * a session, which with no workspace starts in the Host's home directory. This Mac's
 * computer use first-run card (Paper CU3) sits under it until skipped or done.
 */
import {
  Button,
  Kbd,
  PixelFolderIcon,
  PixelServerIcon,
  PixelSparkleIcon,
  SetupCard,
  SetupRow,
} from "@polaris/ui";
import type { HostView } from "../../../../shared/api.ts";
import { useApp, useSelection, useShellActions } from "../../../shell/hooks.ts";
import { useOnboardingState } from "../../onboarding/index.ts";
import { useReadyLine } from "../hooks.ts";
import {
  connectHostCaption,
  firstHostCaption,
  hostStageLine,
  noHostLine,
  stageKicker,
} from "../model.ts";
import { Stage } from "./Stage.tsx";
import { LocalMacOnboarding } from "../../computer-use/index.ts";
import { commandShortcut } from "../../../../shared/keymap.ts";
import { clientPlatform } from "../../../../shared/platform.ts";

/** Opens the ⌘O dialog on this Host: the folder is browsed on the Host's own Daemon. */
const AddWorkspaceRow = ({ host }: { readonly host: HostView }) => {
  const { openFolder } = useShellActions();
  const connected = host.status.state === "connected";

  return (
    <SetupRow
      icon={<PixelFolderIcon size={20} />}
      title="Add a workspace"
      caption={`A repository on ${host.label}`}
      action={
        <Button
          variant="primary"
          disabled={!connected}
          onClick={() => openFolder(host.key)}
          data-testid="add-workspace"
        >
          Choose folder <Kbd variant="plain">{commandShortcut("workspace.add")}</Kbd>
        </Button>
      }
    />
  );
};

const ConnectHostRow = ({ hostCount }: { readonly hostCount: number }) => {
  const sshHosts = useOnboardingState((s) => s.sshHosts?.length ?? 0);

  const caption = connectHostCaption(sshHosts, hostCount - 1);

  const { openSettings } = useShellActions();
  // The same add-a-host flow as Settings → Hosts, on day 1 and day 60 (DESIGN.md, Onboarding).
  const browse = () => openSettings("hosts", { adding: true });

  return (
    <SetupRow
      icon={<PixelServerIcon size={20} />}
      title="Connect a host"
      caption={caption}
      action={<Button onClick={browse}>Browse hosts</Button>}
    />
  );
};

/** Not locked on a workspace: with none, New session registers the Host's home (onboarding). */
const StartRow = ({ host }: { readonly host: HostView }) => {
  const { startNewSession } = useShellActions();
  const starting = useSelection().pane === "new-session";
  const readyLine = useReadyLine(host);

  if (host.status.host === null) {
    return (
      <SetupRow
        icon={<PixelSparkleIcon size={20} />}
        title="Start a session"
        caption={readyLine}
        locked="Needs a connected host"
      />
    );
  }

  return (
    <SetupRow
      icon={<PixelSparkleIcon size={20} />}
      title="Start a session"
      caption={readyLine}
      action={
        <Button data-testid="setup-start-session" disabled={starting} onClick={startNewSession}>
          {starting ? "Starting…" : "Start session"}
        </Button>
      }
    />
  );
};

/**
 * No Host at all (a Windows PC has no local one): adding a host is the only step, the
 * others wait on it, so the way in is plain rather than an empty scene.
 */
const NoHostStage = () => {
  const { openSettings } = useShellActions();
  const sshHosts = useOnboardingState((s) => s.sshHosts?.length ?? 0);
  const windows = clientPlatform() === "win32";

  return (
    <Stage
      kicker="Set up · Polaris"
      title="Where does your code live?"
      line={noHostLine(windows)}
      testId="no-host-stage"
    >
      <SetupCard className="shadow-float">
        <SetupRow
          icon={<PixelServerIcon size={20} />}
          title="Add a host"
          caption={firstHostCaption(windows, sshHosts)}
          action={
            <Button
              variant="primary"
              onClick={() => openSettings("hosts", { adding: true })}
              data-testid="add-first-host"
            >
              Add host
            </Button>
          }
        />
        <SetupRow
          icon={<PixelFolderIcon size={20} />}
          title="Add a workspace"
          caption="A repository on that host"
          locked="Needs a host"
        />
        <SetupRow
          icon={<PixelSparkleIcon size={20} />}
          title="Start a session"
          caption="On the host, with Claude Code, Codex or another harness"
          locked="Needs a host"
        />
      </SetupCard>
    </Stage>
  );
};

/** The Host in view, else the local one: a workspace needs a machine to live on. */
const useStageHost = (hostKey: string | null) =>
  useApp((s) => s.hosts.find((h) => h.key === hostKey) ?? s.hosts.find((h) => h.kind === "local"));

export const HostStage = ({ hostKey }: { readonly hostKey: string | null }) => {
  const host = useStageHost(hostKey);
  const hostCount = useApp((s) => s.hosts.length);

  if (host === undefined) return <NoHostStage />;

  return (
    <Stage
      kicker={stageKicker(host.label, null)}
      title="Where does your code live?"
      line={hostStageLine(hostCount)}
      testId="host-stage"
    >
      <SetupCard className="shadow-float">
        <AddWorkspaceRow host={host} />
        <ConnectHostRow hostCount={hostCount} />
        <StartRow host={host} />
      </SetupCard>
      <div className="pt-6">
        <LocalMacOnboarding host={host} />
      </div>
    </Stage>
  );
};
