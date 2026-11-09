/**
 * The Simulator's 34px toolbar (DESIGN.md, Simulator, Chrome): the device picker, then home,
 * rotate, lock and screenshot, a hairline, and restart. They're off until the stream is live.
 */
import type { Simulator, SimulatorPlatform } from "@polaris/protocol";
import {
  CameraIcon,
  CheckIcon,
  ChevronDownIcon,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  HomeIcon,
  IconButton,
  LockIcon,
  MobileIcon,
  PowerIcon,
  RotateLeftIcon,
} from "@polaris/ui";
import { Fragment } from "react";
import { type PickerGroup, platformName, type Setup, sharedFact, stateLabel } from "../model.ts";
import { Spinner } from "./states.tsx";

const setupLabel = (platform: SimulatorPlatform, setup: Setup) =>
  setup.kind === "updating"
    ? "Xcode is finishing an update"
    : `Set up ${platformName(platform)} Simulators`;

const StateLabel = ({ state }: { readonly state: Simulator["state"] }) => (
  <span
    className={cn(
      "text-caption flex shrink-0 items-center gap-1.5 pl-3",
      state === "Shutdown" ? "text-text-faint" : "text-text-subtle"
    )}
  >
    {state === "Booting" ? <Spinner /> : null}
    {stateLabel(state)}
  </span>
);

const DeviceRow = ({
  simulator,
  current,
  onPick,
}: {
  readonly simulator: Simulator;
  readonly current: boolean;
  readonly onPick: (simulator: Simulator) => void;
}) => (
  <DropdownMenuItem
    onSelect={() => onPick(simulator)}
    className="gap-0"
    data-testid="simulator-picker-row"
    title={`${simulator.name} · ${simulator.osVersion}`}
  >
    <span className="grid w-6 shrink-0 place-items-start">
      {current ? <CheckIcon size={12} className="text-text-default" /> : null}
    </span>
    <span className="text-label text-text-default min-w-0 truncate">{simulator.name}</span>
    <span className="text-caption text-text-subtle shrink-0 pl-2">{simulator.osVersion}</span>
    <span className="min-w-2 flex-1" />
    <StateLabel state={simulator.state} />
  </DropdownMenuItem>
);

export interface PickerProps {
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly device: Simulator | null;
  readonly hostLabel: string;
  readonly onPick: (simulator: Simulator) => void;
  readonly onSetup: (platform: SimulatorPlatform) => void;
  readonly onShutdown: (simulator: Simulator) => void;
}

export const DevicePicker = ({
  groups,
  device,
  hostLabel,
  onPick,
  onSetup,
  onShutdown,
}: PickerProps) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        className="border-hairline hover:bg-fill-hover rounded-control flex h-7 min-w-0 cursor-default items-center gap-2 border pr-2 pl-2.5"
        data-testid="simulator-picker"
      >
        <MobileIcon size={14} className="text-text-subtle shrink-0" />
        <span className="text-label text-text-default min-w-0 truncate">
          {device?.name ?? "Pick a Simulator"}
        </span>
        {device === null ? null : (
          <span className="text-caption text-text-subtle shrink-0 @max-[28rem]:hidden">
            {device.osVersion}
          </span>
        )}
        <ChevronDownIcon size={10} className="text-text-subtle shrink-0" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      align="start"
      className="w-[min(380px,calc(100vw-32px))] overflow-y-auto"
      style={{ maxHeight: "min(520px, var(--radix-dropdown-menu-content-available-height))" }}
    >
      {groups.map((group, index) => (
        <Fragment key={group.platform}>
          {index === 0 ? null : <DropdownMenuSeparator />}
          <DropdownMenuLabel>{platformName(group.platform)}</DropdownMenuLabel>
          {group.setup === null ? (
            group.simulators.map((s) => (
              <DeviceRow key={s.id} simulator={s} current={s.id === device?.id} onPick={onPick} />
            ))
          ) : (
            <DropdownMenuItem
              onSelect={() => onSetup(group.platform)}
              className="text-text-subtle pl-8"
            >
              {setupLabel(group.platform, group.setup)}
            </DropdownMenuItem>
          )}
        </Fragment>
      ))}
      <DropdownMenuSeparator />
      {device?.state === "Booted" ? (
        <DropdownMenuItem onSelect={() => onShutdown(device)} className="gap-0">
          <span className="grid w-6 shrink-0 place-items-start">
            <PowerIcon size={12} className="text-text-subtle" />
          </span>
          <span className="min-w-0 truncate">Shut down {device.name}</span>
        </DropdownMenuItem>
      ) : null}
      <p className="text-caption text-text-subtle px-2 pt-1 pb-1.5 pl-8">{sharedFact(hostLabel)}</p>
    </DropdownMenuContent>
  </DropdownMenu>
);

export interface ControlsProps {
  /** The stream is live: the controls act. */
  readonly live: boolean;
  readonly platform: SimulatorPlatform | null;
  readonly hostLabel: string;
  /** The Host stages attachments: a screenshot can join the next message. */
  readonly canAttach: boolean;
  /** The hub can restart: a Simulator is booted and shown. */
  readonly canRestart: boolean;
  readonly onHome: () => void;
  readonly onRotate: () => void;
  readonly onLock: () => void;
  readonly onScreenshot: () => void;
  readonly onRestart: () => void;
}

export const Controls = ({
  live,
  platform,
  hostLabel,
  canAttach,
  canRestart,
  onHome,
  onRotate,
  onLock,
  onScreenshot,
  onRestart,
}: ControlsProps) => (
  <div className="flex shrink-0 items-center gap-0.5">
    <IconButton
      size="sm"
      label="Home"
      icon={<HomeIcon size={14} />}
      disabled={!live}
      onClick={onHome}
    />
    <IconButton
      size="sm"
      label={platform === "android" ? "Rotate (iOS only)" : "Rotate left"}
      icon={<RotateLeftIcon size={14} />}
      disabled={!live || platform !== "ios"}
      onClick={onRotate}
    />
    <IconButton
      size="sm"
      label="Lock"
      icon={<LockIcon size={14} />}
      disabled={!live}
      onClick={onLock}
    />
    <IconButton
      size="sm"
      label={canAttach ? "Attach a screenshot" : "Screenshots need a newer Daemon"}
      icon={<CameraIcon size={14} />}
      disabled={!live || !canAttach}
      onClick={onScreenshot}
      data-testid="simulator-screenshot"
    />
    <span className="bg-hairline mx-1 h-4 w-px" />
    <IconButton
      size="sm"
      label={`Restart streaming from ${hostLabel}`}
      icon={<PowerIcon size={14} />}
      disabled={!canRestart}
      onClick={onRestart}
      data-testid="simulator-restart"
    />
  </div>
);
