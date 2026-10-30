/**
 * The host page's Daemon card (Paper HS-D, HS-D4): where tab completion runs, daemon upgrades,
 * the host's own settings in place, the service in the footer and Restart daemon…, whose
 * Confirm, Back and Failed states take the card's well.
 */
import {
  SettingsButton,
  SettingsCard,
  SettingsRow,
  SettingsToggleRow,
  SettingsWell,
} from "@polaris/ui";
import type { MachineView } from "../../../../shared/api.ts";
import { clientCopy } from "../../../../shared/clientCopy.ts";
import { RemoteSettings } from "../HostDetails.tsx";
import { call } from "../hooks.tsx";
import { PredictionPlacement } from "../PredictionPlacement.tsx";
import { type Platform, platformOf } from "../restart/model.ts";
import { BackPanel, ConfirmPanel, FailedPanel } from "../restart/panels.tsx";
import type { Restart } from "../restart/useRestart.ts";
import { uptime } from "../stats/model.ts";
import { setDaemonUpdateOverride } from "../updates/actions.ts";
import { OverrideSelect } from "../updates/Controls.tsx";
import { ChevronGlyph } from "./parts.tsx";

const SERVICE: Record<Platform, string> = {
  macos: "LAUNCHD · DEV.LUX.POLARIS",
  linux: "SYSTEMD --USER · POLARIS",
  windows: "SCHTASKS · POLARIS",
};

/** The footer's service line; after a restart, the manager and the new uptime. */
export const serviceLine = (platform: Platform | null, upMs: number | null, back: boolean) => {
  if (platform === null) return "";

  if (!back || upMs === null) return SERVICE[platform];

  return `${SERVICE[platform].split(" · ")[0]} · UP ${uptime(upMs)}`;
};

const HostSettings = ({
  machine,
  open,
  onToggle,
}: {
  readonly machine: MachineView;
  readonly open: boolean;
  readonly onToggle: () => void;
}) => {
  if (machine.alias === null)
    return (
      <SettingsToggleRow
        title={`Use ${clientCopy().machine} as a host`}
        wrap
        caption={`Off, Polaris only drives remote hosts and runs nothing on ${clientCopy().machine}`}
        checked={machine.enabled}
        onCheckedChange={(enabled) => void call("machines.setLocalEnabled", { enabled })}
      />
    );

  return (
    <>
      <SettingsRow title="Name, ssh-agent, remote command">
        <button
          type="button"
          aria-expanded={open}
          aria-label="Name, ssh-agent, remote command"
          onClick={onToggle}
          className="hover:bg-fill-hover flex size-6 cursor-default items-center justify-center rounded-full"
        >
          <span className={open ? "rotate-90" : undefined}>
            <ChevronGlyph />
          </span>
        </button>
      </SettingsRow>
      {open ? (
        <div className="flex flex-col gap-3 px-4 py-3" data-testid="host-settings">
          <RemoteSettings machine={machine} />
        </div>
      ) : null}
    </>
  );
};

export interface DaemonCardProps {
  readonly machine: MachineView;
  readonly restart: Restart;
  /** "Restarts once Mac Studio is connected"; null when it can restart now. */
  readonly unavailable: string | null;
  readonly command: string;
  readonly upMs: number | null;
  readonly settingsOpen: boolean;
  readonly onSettings: () => void;
  readonly onShowSessions: () => void;
}

const Rows = ({
  machine,
  settingsOpen,
  onSettings,
}: Pick<DaemonCardProps, "machine" | "settingsOpen" | "onSettings">) => (
  <SettingsWell>
    <PredictionPlacement hostKey={machine.key} />
    {machine.daemon === null || !machine.daemon.managed ? null : (
      <SettingsRow title="Daemon upgrades">
        <OverrideSelect
          daemon={machine.daemon}
          onChange={(enabled) => setDaemonUpdateOverride(machine.key, enabled)}
        />
      </SettingsRow>
    )}
    <HostSettings machine={machine} open={settingsOpen} onToggle={onSettings} />
  </SettingsWell>
);

export const DaemonCard = (props: DaemonCardProps) => {
  const { machine, restart, unavailable, command, upMs } = props;
  const { state } = restart;
  const platform = platformOf(machine.status?.host?.platform);
  const version = machine.daemon?.installedVersion ?? machine.status?.host?.daemonVersion ?? null;
  const busy = state.step === "confirm" || state.step === "restarting";

  return (
    <SettingsCard
      title="Daemon"
      data-testid="daemon-card"
      aside={
        version === null ? undefined : <span className="font-mono text-[11px]">{version}</span>
      }
      status={unavailable ?? serviceLine(platform, upMs, state.step === "back")}
      action={
        state.step === "confirm" || state.step === "failed" ? undefined : (
          <SettingsButton
            variant="quiet"
            disabled={busy || unavailable !== null}
            onClick={restart.begin}
          >
            Restart daemon…
          </SettingsButton>
        )
      }
    >
      {state.step === "confirm" ? (
        <ConfirmPanel
          label={machine.label}
          preview={state.preview}
          command={command}
          onCancel={restart.cancel}
          onConfirm={restart.confirm}
        />
      ) : null}
      {state.step === "back" ? (
        <BackPanel state={state} onShowSessions={props.onShowSessions} />
      ) : null}
      {state.step === "failed" ? (
        <FailedPanel
          label={machine.label}
          result={state.result}
          onReinstall={() => {
            restart.cancel();
            void call("machines.startDaemon", { hostKey: machine.key });
          }}
        />
      ) : null}
      {state.step === "confirm" || state.step === "failed" ? null : <Rows {...props} />}
    </SettingsCard>
  );
};
