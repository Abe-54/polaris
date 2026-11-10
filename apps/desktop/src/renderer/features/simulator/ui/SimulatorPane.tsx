/**
 * Output's Simulator tab body (DESIGN.md, Simulator; Paper "Simulator (ENG-829)" S1–S6): the
 * toolbar, the agent's strip, then setup, the empty bezel, or the live Simulator.
 */
import type { SessionId, Simulator, SimulatorPlatform } from "@polaris/protocol";
import { CursorIcon, type Harness, harnessHue, harnessTextVar } from "@polaris/ui";
import { useCallback, useRef, useState } from "react";
import { polaris } from "../../bridge.ts";
import { showRefusal as refused } from "../../session/dispatch.ts";
import { useHostSimulators, useLiveSimulators } from "../hostSimulators.ts";
import { blockerOf, pickerGroups, shownSimulator } from "../model.ts";
import type { SimulatorStreamHandle } from "../SimulatorStream.tsx";
import { rememberPick, setShowing, usePickedSimulator, useSimulatorUi } from "../state.ts";
import { LiveSimulator } from "./LiveSimulator.tsx";
import { EmptyBezel, NoSimulators, SetupState } from "./states.tsx";
import { Controls, DevicePicker } from "./Toolbar.tsx";

export interface SimulatorPaneProps {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  /** The session's key in the per-session stores. */
  readonly stateKey: string;
  readonly hostLabel: string;
  /** The Host is this machine: the stream may use MJPEG. */
  readonly local: boolean;
  readonly harness: Harness | null;
  readonly canAttach: boolean;
  /** Joins a PNG of the screen to the session's next message. */
  readonly onScreenshot: (png: Blob, device: Simulator) => void;
  readonly onTypeInTerminal: ((command: string) => void) | null;
}

/** A thin strip over the screen while an agent drives the Simulator (the Browser's, reused). */
const Driving = ({ harness }: { readonly harness: Harness | null }) => {
  const hue = harness === null ? undefined : harnessTextVar(harness);
  const name = harness === null ? "The agent" : harnessHue(harness).name;

  return (
    <div
      className="bg-surface-sunken text-caption flex h-7 shrink-0 items-center gap-2 border-b px-3"
      style={{
        borderColor: hue === undefined ? undefined : `color-mix(in srgb, ${hue} 28%, transparent)`,
      }}
      data-testid="simulator-driving"
    >
      <CursorIcon size={12} style={{ color: hue }} />
      <span className="truncate" style={{ color: hue }}>
        {name} is using this Simulator
      </span>
    </div>
  );
};

/** The pane's state between picking and streaming: boot, then restart and its epoch. */
const usePaneActions = (hostKey: string, stateKey: string) => {
  const [asked, setAsked] = useState<SimulatorPlatform | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [restarting, setRestarting] = useState(false);

  const pick = (simulator: Simulator) => {
    setAsked(null);
    rememberPick(stateKey, simulator.id);
    setShowing(stateKey, simulator.id);

    if (simulator.state === "Shutdown") boot(simulator);
  };

  const boot = (simulator: Simulator) =>
    void polaris()
      .request("simulator.boot", { hostKey, id: simulator.id })
      .then((r) => (r.ok ? undefined : refused(`Couldn't boot ${simulator.name}`, r.error)));

  const shutdown = (simulator: Simulator) =>
    void polaris()
      .request("simulator.shutdown", { hostKey, id: simulator.id })
      .then((r) => (r.ok ? undefined : refused(`Couldn't shut down ${simulator.name}`, r.error)));

  const restart = () => {
    setRestarting(true);
    void polaris()
      .request("simulator.restart", { hostKey })
      .then((r) => {
        setEpoch((e) => e + 1);

        if (r.ok) return;
        setRestarting(false);
        refused("Couldn't restart the stream", r.error);
      });
  };

  const attached = useCallback(() => setRestarting(false), []);

  return { asked, setAsked, epoch, restarting, pick, boot, shutdown, restart, attached };
};

export const SimulatorPane = (props: SimulatorPaneProps) => {
  const { hostKey, stateKey, hostLabel, harness } = props;

  useLiveSimulators(hostKey, true);
  const host = useHostSimulators(hostKey, true);
  const ui = useSimulatorUi(stateKey);
  const picked = usePickedSimulator(stateKey);
  const actions = usePaneActions(hostKey, stateKey);
  const stream = useRef<SimulatorStreamHandle>(null);
  const [live, setLive] = useState(false);

  if (host === null) return <div className="flex-1" data-testid="simulator" />;
  const blocker = blockerOf(host.support, host.simulators, actions.asked);
  const device = blocker === null ? shownSimulator(host.simulators, ui.showing, picked) : null;
  const groups = pickerGroups(host.support, host.simulators);

  const screenshot = () =>
    void stream.current
      ?.snapshot()
      .then((png) => (png === null || device === null ? null : props.onScreenshot(png, device)));

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="simulator">
      <div className="border-hairline @container flex h-[34px] shrink-0 items-center gap-2 border-b px-2">
        <DevicePicker
          groups={groups}
          device={device}
          hostLabel={hostLabel}
          onPick={actions.pick}
          onSetup={actions.setAsked}
          onShutdown={actions.shutdown}
        />
        <span className="flex-1" />
        <Controls
          live={live && device?.state === "Booted"}
          platform={device?.platform ?? null}
          hostLabel={hostLabel}
          canAttach={props.canAttach}
          canRestart={device?.state === "Booted" && !actions.restarting}
          onHome={() => stream.current?.press("home")}
          onRotate={() => stream.current?.rotate()}
          onLock={() => stream.current?.press("lock")}
          onScreenshot={screenshot}
          onRestart={actions.restart}
        />
      </div>
      {ui.driving && device !== null ? <Driving harness={harness} /> : null}
      <Body
        {...props}
        host={host}
        blocker={blocker}
        device={device}
        actions={actions}
        stream={stream}
        setLive={setLive}
      />
    </div>
  );
};

interface BodyProps extends SimulatorPaneProps {
  readonly host: NonNullable<ReturnType<typeof useHostSimulators>>;
  readonly blocker: ReturnType<typeof blockerOf>;
  readonly device: Simulator | null;
  readonly actions: ReturnType<typeof usePaneActions>;
  readonly stream: React.RefObject<SimulatorStreamHandle | null>;
  readonly setLive: (live: boolean) => void;
}

const Body = ({
  hostKey,
  sessionId,
  hostLabel,
  local,
  host,
  blocker,
  device,
  actions,
  stream,
  setLive,
  onTypeInTerminal,
}: BodyProps) => {
  if (blocker?.kind === "setup")
    return (
      <SetupState
        hostKey={hostKey}
        hostLabel={hostLabel}
        support={host.support}
        setup={blocker.setup}
        onTypeInTerminal={onTypeInTerminal}
      />
    );

  if (blocker !== null || device === null)
    return <NoSimulators hostKey={hostKey} hostLabel={hostLabel} support={host.support} />;

  const fact = `${device.osVersion} · ${hostLabel}`;

  if (device.state === "Booting")
    return <EmptyBezel busy title={`Booting ${device.name}`} fact={fact} />;

  if (device.state === "Shutdown")
    return (
      <EmptyBezel
        busy={false}
        title={`${device.name} is shut down`}
        fact={fact}
        action={
          <button
            type="button"
            className="bg-fill-selected text-label text-text-default hover:bg-fill-selected/70 rounded-control h-7 cursor-default px-3"
            onClick={() => actions.boot(device)}
            data-testid="simulator-boot"
          >
            Boot
          </button>
        }
      />
    );

  return (
    <LiveSimulator
      key={device.id}
      hostKey={hostKey}
      sessionId={sessionId}
      hostLabel={hostLabel}
      local={local}
      device={device}
      epoch={actions.epoch}
      restarting={actions.restarting}
      onRestart={actions.restart}
      onLive={setLive}
      onAttached={actions.attached}
      streamRef={stream}
    />
  );
};
