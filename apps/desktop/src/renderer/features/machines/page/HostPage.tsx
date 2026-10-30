/**
 * One host's page in Settings → Hosts (Paper HS-D, HS-D3; DESIGN.md, Settings → Hosts
 * redesign): the breadcrumb (esc goes back), the header, what needs the user first, then
 * Vitals, Harnesses beside Capacity, and Remote access beside Daemon, on one scrolling page.
 */
import { SettingsCard, SettingsGrid } from "@polaris/ui";
import { useState } from "react";
import type { MachineView } from "../../../../shared/api.ts";
import { clientCopy } from "../../../../shared/clientCopy.ts";
import { emptyHostModel, visibleWorkspaces } from "../../../store/hostModel.ts";
import { useApp, useShellActions } from "../../../shell/hooks.ts";
import { HostResources } from "../../settings/ui/HostResources.tsx";
import { Approval, Attention } from "../Attention.tsx";
import { call } from "../hooks.tsx";
import { attentionCard, outcomeNote } from "../model.ts";
import { channelWords, commandLine, managerFor, platformOf } from "../restart/model.ts";
import { type RestartState, useRestart } from "../restart/useRestart.ts";
import { useHostStats } from "../stats/hooks.ts";
import { updateDaemon } from "../updates/actions.ts";
import { updateLine } from "../updates/model.ts";
import { UpdateStrip } from "../updates/UpdateStrip.tsx";
import { CapacityCard } from "./CapacityCard.tsx";
import { DaemonCard } from "./DaemonCard.tsx";
import { useEscape } from "./escape.ts";
import { HarnessesCard } from "./HarnessesCard.tsx";
import { Breadcrumb, Header, RemoveConfirm } from "./Header.tsx";
import { RemoteAccessCard, routesOf } from "./RemoteAccessCard.tsx";
import { hostName, type Pill, pageLine, pill, type RestartPhase } from "./state.ts";
import { VitalsCard } from "./VitalsCard.tsx";

const phaseOf = (state: RestartState): RestartPhase => {
  if (state.step === "restarting") return "restarting";

  return state.step === "failed" ? "failed" : "idle";
};

/** What needs the user goes first: the approval or reason card, then the daemon update line. */
const NeedsYou = ({ machine, now }: { readonly machine: MachineView; readonly now: number }) => {
  const note = outcomeNote(machine);

  const line = updateLine({
    label: machine.label,
    alias: machine.alias,
    connected: machine.status?.state === "connected",
    daemon: machine.daemon,
    now,
  });
  // A connection the user must fix is told once, by its own card.

  const shown = line.kind === "failed" && attentionCard(machine) !== null ? null : line;

  return (
    <>
      {machine.install?.step === "approval" ? (
        <Approval machine={machine} />
      ) : (
        <Attention machine={machine} />
      )}
      {note === null ? null : (
        <p className="text-caption text-text-subtle" data-testid="install-outcome">
          {note}
        </p>
      )}
      {shown === null ? null : (
        <UpdateStrip
          line={shown}
          onUpdate={() => updateDaemon(machine.key)}
          onFailureAction={(action) => {
            if (action === "retry") updateDaemon(machine.key);
            else if (action === "open-ssh") void call("machines.openSsh", { hostKey: machine.key });
          }}
        />
      )}
    </>
  );
};

/** What the page derives from the machine view at `clock`. */
const factsOf = (machine: MachineView, clock: number) => {
  const connected = machine.status?.state === "connected";
  const local = machine.alias === null;
  const startedAt = machine.status?.host?.startedAt ?? null;

  return {
    connected,
    local,
    manager: managerFor(platformOf(machine.status?.host?.platform)),
    upMs: connected && startedAt !== null ? clock - Date.parse(startedAt) : null,
    version: machine.daemon?.installedVersion ?? machine.status?.host?.daemonVersion ?? null,
    // This Mac restarts locally even when its daemon won't answer.
    unavailable: !local && !connected ? `Restarts once ${machine.label} is connected` : null,
  };
};

type Facts = ReturnType<typeof factsOf>;

interface HeadProps {
  readonly machine: MachineView;
  readonly facts: Facts;
  readonly pill: Pill;
  readonly removing: boolean;
  readonly onRemoving: (asking: boolean) => void;
  readonly onRestart: () => void;
  readonly onRename: () => void;
  readonly onBack: () => void;
}

/** The breadcrumb, then the header, or Remove host's confirm in its place. */
const Head = ({
  machine,
  facts,
  pill,
  removing,
  onRemoving,
  onRestart,
  onRename,
  onBack,
}: HeadProps) => {
  const model = useApp((s) => s.hostModels[machine.key]);
  const workspaces = model === undefined ? null : visibleWorkspaces(model ?? emptyHostModel).length;
  const { version, local } = facts;

  return (
    <div className="flex flex-col gap-3.5 pb-2">
      <Breadcrumb label={hostName(machine)} onBack={onBack} />
      {removing ? (
        <RemoveConfirm
          label={machine.label}
          onCancel={() => onRemoving(false)}
          onRemove={() => {
            void call("machines.remove", { hostKey: machine.key });
            onBack();
          }}
        />
      ) : (
        <Header
          machine={machine}
          line={pageLine(machine, workspaces, version)}
          pill={pill}
          onRetry={() => void call("host.retryNow", { hostKey: machine.key })}
          onRestart={facts.unavailable === null ? onRestart : null}
          onUpgrade={
            machine.daemon?.updateAvailable === true ? () => updateDaemon(machine.key) : null
          }
          upgradeNote={version === null ? "" : `${version} is current`}
          onRename={onRename}
          onRemove={local ? null : () => onRemoving(true)}
        />
      )}
    </div>
  );
};

/** Harnesses beside Capacity, and the resources list when "Resources…" opened it. */
const Workers = ({ machine }: { readonly machine: MachineView }) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <SettingsGrid>
        <HarnessesCard machine={machine} />
        <CapacityCard
          hostKey={machine.key}
          resourcesOpen={open}
          onResources={() => setOpen((was) => !was)}
        />
      </SettingsGrid>
      {open ? (
        <SettingsCard title="Resources" data-testid="resources-card">
          <div className="px-gap pb-gap">
            <HostResources hostKey={machine.key} />
          </div>
        </SettingsCard>
      ) : null}
    </>
  );
};

const restartingOf = (state: RestartState, facts: Facts) =>
  state.step === "restarting"
    ? { stoppedAt: state.stoppedAt, turns: state.turns, manager: facts.manager }
    : null;

export interface HostPageProps {
  readonly machine: MachineView;
  readonly now: number;
  readonly onBack: () => void;
}

export const HostPage = ({ machine, now, onBack }: HostPageProps) => {
  const restart = useRestart(machine.key);
  const [removing, setRemoving] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { closeSettings } = useShellActions();
  const clock = Math.max(now, Date.now());
  const facts = factsOf(machine, clock);
  const stats = useHostStats(machine.key, facts.connected);
  const routes = routesOf(machine);

  useEscape(() => {
    if (removing) setRemoving(false);
    else if (restart.state.step === "confirm") restart.cancel();
    else onBack();
  });

  const rename = () => {
    setSettingsOpen(true);
    requestAnimationFrame(() =>
      document.querySelector<HTMLInputElement>('[data-testid="host-settings"] input')?.focus()
    );
  };

  return (
    <div
      data-testid="host-page"
      className="gap-gap mx-auto flex w-[860px] max-w-[calc(100%-2rem)] flex-col py-10"
    >
      <Head
        machine={machine}
        facts={facts}
        pill={pill(machine, clock, phaseOf(restart.state))}
        removing={removing}
        onRemoving={setRemoving}
        onRestart={restart.begin}
        onRename={rename}
        onBack={onBack}
      />
      <NeedsYou machine={machine} now={clock} />
      <VitalsCard
        stats={stats}
        connected={facts.connected}
        now={clock}
        upMs={facts.upMs}
        restarting={restartingOf(restart.state, facts)}
      />
      {facts.connected ? <Workers machine={machine} /> : null}
      <SettingsGrid>
        {routes.relay || routes.tailscale ? <RemoteAccessCard machine={machine} /> : null}
        <DaemonCard
          machine={machine}
          restart={restart}
          unavailable={facts.unavailable}
          command={commandLine(facts.manager, channelWords(machine.kind, clientCopy().machine))}
          upMs={facts.upMs}
          settingsOpen={settingsOpen}
          onSettings={() => setSettingsOpen((open) => !open)}
          onShowSessions={closeSettings}
        />
      </SettingsGrid>
    </div>
  );
};
