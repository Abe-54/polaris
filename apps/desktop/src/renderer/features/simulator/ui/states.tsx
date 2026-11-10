/**
 * The Simulator pane's states without a stream (DESIGN.md, Simulator): setup per platform in the
 * Pane empty-state tier, the empty bezel while starting or booting, and the hub's failure.
 */
import type { HostSimulatorSupport } from "@polaris/protocol";
import { Button, CodeWell, CopyButton, EmptyState, MobileIcon, PixelAlertIcon } from "@polaris/ui";
import type { ReactNode } from "react";
import { polaris } from "../../bridge.ts";
import { checkAgain } from "../hostSimulators.ts";
import { emptyFact, isMac, type Setup } from "../model.ts";

const XCODE_URL = "https://apps.apple.com/app/xcode/id497799835";

const ANDROID_GUIDE_URL = "https://developer.android.com/studio";

/** The pane's centre: states sit in the middle of the panel ground. */
const Centre = ({
  children,
  testId,
}: {
  readonly children: ReactNode;
  readonly testId: string;
}) => (
  <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto" data-testid={testId}>
    {children}
  </div>
);

const Tile = <MobileIcon size={18} className="text-text-strong" />;

/** A command to paste, with Copy beside it. */
const Command = ({ command }: { readonly command: string }) => (
  <div className="flex w-full max-w-[320px] items-start gap-1.5">
    <CodeWell className="min-w-0 flex-1 text-left">
      <span className="text-text-faint select-none">$ </span>
      {command}
    </CodeWell>
    <CopyButton text={command} variant="icon" label="Copy command" />
  </div>
);

const open = (url: string) => void polaris().request("shell.openExternal", { url });

export interface SetupProps {
  readonly hostKey: string;
  readonly hostLabel: string;
  readonly support: HostSimulatorSupport;
  readonly setup: Setup;
  /** Opens the Terminal drawer with `command` typed, never run. */
  readonly onTypeInTerminal: ((command: string) => void) | null;
}

const ffmpegCommand = (support: HostSimulatorSupport) =>
  isMac(support) ? "brew install ffmpeg" : "sudo apt install ffmpeg";

const KVM_COMMAND = "sudo usermod -aG kvm $USER";

/** What a platform lacks, and the one way forward for each. */
export const SetupState = ({
  hostKey,
  hostLabel,
  support,
  setup,
  onTypeInTerminal,
}: SetupProps) => {
  const again = (
    <Button variant="ghost" onClick={() => checkAgain(hostKey)}>
      Check again
    </Button>
  );

  if (setup.kind === "updating")
    return (
      <Centre testId="simulator-setup">
        <EmptyState
          icon={Tile}
          title="Xcode is finishing an update"
          fact={`iOS Simulators on ${hostLabel} are ready when it's done.`}
        />
      </Centre>
    );

  switch (setup.requirement) {
    case "xcode":
      return (
        <Centre testId="simulator-setup">
          <EmptyState
            icon={Tile}
            title="iOS Simulators need Xcode"
            fact={`Xcode isn't installed on ${hostLabel}. Install it from the App Store and open it once to add a Simulator.`}
            action={
              <div className="flex gap-2">
                <Button onClick={() => open(XCODE_URL)}>Open the App Store</Button>
                {again}
              </div>
            }
          />
        </Centre>
      );
    case "android-sdk":
      return (
        <Centre testId="simulator-setup">
          <EmptyState
            icon={Tile}
            title="Android Simulators need the Android SDK"
            fact={`No Android SDK found on ${hostLabel}. Install Android Studio or its command-line tools, then set ANDROID_HOME.`}
            action={
              <div className="flex gap-2">
                <Button onClick={() => checkAgain(hostKey)}>Check again</Button>
                <Button variant="ghost" onClick={() => open(ANDROID_GUIDE_URL)}>
                  Setup guide
                </Button>
              </div>
            }
          />
        </Centre>
      );
    case "ffmpeg": {
      const command = ffmpegCommand(support);

      return (
        <Centre testId="simulator-setup">
          <EmptyState
            icon={Tile}
            title="Android Simulators need ffmpeg"
            fact={`${hostLabel} has the Android SDK, but not ffmpeg to stream it. Install it with one line:`}
            action={
              <div className="flex w-full flex-col items-center gap-3">
                <Command command={command} />
                <div className="flex gap-2">
                  {onTypeInTerminal === null ? null : (
                    <Button onClick={() => onTypeInTerminal(command)}>Run in terminal</Button>
                  )}
                  {again}
                </div>
              </div>
            }
          />
        </Centre>
      );
    }

    case "kvm":
      return (
        <Centre testId="simulator-setup">
          <EmptyState
            icon={Tile}
            title="Android Simulators need KVM"
            fact={`${hostLabel} can't open /dev/kvm. Add yourself to the kvm group, or turn on nested virtualization where this VM runs.`}
            action={
              <div className="flex w-full flex-col items-center gap-3">
                <Command command={KVM_COMMAND} />
                <p className="text-caption text-text-subtle">
                  Sign out and back in on {hostLabel} after joining the group.
                </p>
                <Button onClick={() => checkAgain(hostKey)}>Check again</Button>
              </div>
            }
          />
        </Centre>
      );
  }
};

export const NoSimulators = ({
  hostKey,
  hostLabel,
  support,
}: {
  readonly hostKey: string;
  readonly hostLabel: string;
  readonly support: HostSimulatorSupport;
}) => (
  <Centre testId="simulator-empty">
    <EmptyState
      icon={Tile}
      title={`No Simulators on ${hostLabel}`}
      fact={emptyFact(support)}
      action={<Button onClick={() => checkAgain(hostKey)}>Check again</Button>}
    />
  </Centre>
);

/** A 14px ring that turns; Reduce Motion holds it still. */
export const Spinner = ({ className }: { readonly className?: string }) => (
  <svg
    viewBox="0 0 16 16"
    width={14}
    height={14}
    aria-hidden="true"
    className={`shrink-0 motion-safe:animate-spin ${className ?? ""}`}
  >
    <circle
      cx="8"
      cy="8"
      r="6"
      fill="none"
      stroke="currentColor"
      strokeOpacity="0.25"
      strokeWidth="1.5"
    />
    <path
      d="M8 2a6 6 0 0 1 6 6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

/** The device's outline with no frame in it: starting, booting, or shut down. */
export const EmptyBezel = ({
  title,
  fact,
  busy,
  action,
}: {
  readonly title: string;
  readonly fact: string;
  readonly busy: boolean;
  readonly action?: ReactNode;
}) => (
  <div
    className="flex min-h-0 flex-1 items-center justify-center p-6"
    data-testid="simulator-bezel"
  >
    <div className="bg-surface-sunken flex aspect-[9/19.5] h-full max-h-[640px] max-w-full flex-col items-center justify-center gap-1.5 rounded-[44px] border-[8px] border-(--simulator-bezel) px-4 text-center">
      {busy ? <Spinner className="text-text-subtle mb-1.5" /> : null}
      <p className="text-heading-sm text-text-strong" role="status">
        {title}
      </p>
      <p className="text-caption text-text-subtle">{fact}</p>
      {action === undefined ? null : <div className="mt-3">{action}</div>}
    </div>
  </div>
);

export interface FailedProps {
  readonly hostLabel: string;
  readonly device: string;
  readonly detail: string;
  readonly onRestart: () => void;
}

/** The hub stopped: the device is still booted, and Restart brings the stream back. */
export const Failed = ({ hostLabel, device, detail, onRestart }: FailedProps) => {
  const details = `Simulators stopped on ${hostLabel}\n${detail}`;

  return (
    <Centre testId="simulator-failed">
      <EmptyState
        hue="neutral"
        icon={<PixelAlertIcon size={24} className="text-text-strong" />}
        title={`Simulators stopped on ${hostLabel}`}
        fact={`${device} is still booted. Agents' Simulator tools fail until you restart.`}
        action={
          <div className="flex w-full flex-col items-center gap-3">
            {detail === "" ? null : (
              <CodeWell className="w-full max-w-[320px] text-left">{detail}</CodeWell>
            )}
            <div className="flex gap-2">
              <Button onClick={onRestart}>Restart</Button>
              <CopyButton
                text={details}
                label="Copy details"
                variant="button"
                buttonVariant="ghost"
              />
            </div>
          </div>
        }
      />
    </Centre>
  );
};
