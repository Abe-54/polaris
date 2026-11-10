/**
 * What computer use shows for a Host's status (Paper CU1–CU3; DESIGN.md, Computer use): the
 * host page's card, the local Mac's first-run card and the transcript's inline prompt.
 */
import type { ComputerUsePermission, ComputerUseSetup, ComputerUseState } from "@polaris/protocol";
import { Match, Predicate } from "effect";

export type HostPlatform = "macos" | "linux" | "windows" | null;

export interface HostFacts {
  /** The Host's label ("Mac Studio"). */
  readonly name: string;
  readonly platform: HostPlatform;
  /** This machine's own Host: setup opens here rather than on another Mac. */
  readonly local: boolean;
}

export const HELPER_APP = "Polaris Computer Use.app";

/** One of the helper's two macOS services, under the single "Allow computer use" step. */
export interface ServiceLine {
  readonly name: "Accessibility" | "Screen Recording";
  readonly on: boolean;
  readonly detail: string;
}

/**
 * One drag into Device Control and Data Access grants Accessibility only, so once it's on and
 * Screen Recording isn't, the step becomes Screen Recording's own pane (ENG-846, D4's finding).
 */
export interface AllowStep {
  readonly label: "Allow computer use" | "Allow Screen Recording";
  readonly detail: string;
  readonly button: string;
  /** What `computerUse.openSetup` opens: null is the Host's one step. */
  readonly permission: ComputerUsePermission | null;
  readonly services: ReadonlyArray<ServiceLine>;
}

/** The status well at the top of the host page's card. */
export interface StatusWell {
  readonly title: string;
  readonly line: string;
}

export type CardView =
  /** No desktop on a Linux or unknown Host: the card is one line. */
  | { readonly kind: "collapsed"; readonly line: string }
  | { readonly kind: "unavailable"; readonly well: StatusWell }
  | { readonly kind: "off"; readonly well: StatusWell }
  | { readonly kind: "mac-setup"; readonly well: StatusWell; readonly step: AllowStep }
  | {
      readonly kind: "linux-setup";
      readonly well: StatusWell;
      /** The install command to run on the Host, or null when Polaris doesn't know it. */
      readonly command: string | null;
    }
  | { readonly kind: "ready"; readonly well: StatusWell };

type MacPermissions = Extract<ComputerUseSetup, { readonly _tag: "MacPermissions" }>;

type Permissions = Pick<MacPermissions, "accessibility" | "screenRecording">;

const SERVICE_DETAIL = {
  Accessibility: "lets agents click, type and read the controls in an app",
  "Screen Recording": "lets agents see the app's window",
} as const;

export const servicesOf = (setup: Permissions): ReadonlyArray<ServiceLine> =>
  (
    [
      ["Accessibility", setup.accessibility],
      ["Screen Recording", setup.screenRecording],
    ] as const
  ).map(([name, on]) => ({
    name,
    on,
    detail: on ? `On · ${SERVICE_DETAIL[name]}` : "Off",
  }));

const missingOf = (setup: MacPermissions) =>
  servicesOf(setup)
    .filter((s) => !s.on)
    .map((s) => s.name);

/** "Accessibility and Screen Recording are on" / "Screen Recording is on". */
const missingClause = (setup: MacPermissions) => {
  const missing = missingOf(setup);

  return missing.length === 1 ? `${missing[0]} is on` : `${missing.join(" and ")} are on`;
};

/** Screen Recording is the step left once Accessibility is on. */
const screenRecordingNext = (setup: Permissions) => setup.accessibility && !setup.screenRecording;

const stepDetail = (host: HostFacts, setup: Permissions) => {
  const there = host.local ? "" : ` on ${host.name}`;

  return screenRecordingNext(setup)
    ? `Opens Screen & System Audio Recording${there}; turn on Polaris Computer Use there`
    : `Opens Device Control and Data Access${there} and shows ${HELPER_APP} to drag in`;
};

export const allowStep = (host: HostFacts, setup: Permissions): AllowStep => ({
  label: screenRecordingNext(setup) ? "Allow Screen Recording" : "Allow computer use",
  detail: stepDetail(host, setup),
  button: host.local ? "Open System Settings" : `Open System Settings on ${host.name}`,
  permission: screenRecordingNext(setup) ? "screen-recording" : null,
  services: servicesOf(setup),
});

/** Which setup pane the user opened from Polaris; undefined before they open one. */
export type Opened = ComputerUsePermission | null | undefined;

/** After "Open System Settings": a remote Mac asks the person at it, this Mac waits for the drag. */
const macWell = (host: HostFacts, setup: MacPermissions, openedPane: Opened): StatusWell => {
  const opened = openedPane !== undefined && openedPane === allowStep(host, setup).permission;

  if (opened && !host.local)
    return {
      title: `On ${host.name}, approve the prompt`,
      line: `macOS asks on the Mac itself. Someone at ${host.name} allows ${HELPER_APP} in System Settings; this card updates when they do.`,
    };

  if (opened && screenRecordingNext(setup))
    return {
      title: "Turn on Screen Recording",
      line: `In Screen & System Audio Recording, turn on Polaris Computer Use. macOS may ask to reopen it; this card updates when it's on.`,
    };

  if (opened)
    return {
      title: "Drag it in, then turn it on",
      line: `In System Settings, drag ${HELPER_APP} into the list and turn it on. This card updates when it's on.`,
    };

  const granted = servicesOf(setup).filter((s) => s.on).length;

  return {
    title: `${granted} of 2 permissions`,
    line: `Agents can't use apps on ${host.name} until ${missingClause(setup)}.`,
  };
};

const linuxView = (host: HostFacts, setup: ComputerUseSetup): CardView =>
  Match.value(setup).pipe(
    Match.tag("LinuxPackages", ({ packages, command }): CardView => ({
      kind: "linux-setup",
      well: {
        title: `Install ${packages.join(" and ")}`,
        line:
          command === null
            ? `Agents can't use apps on ${host.name} until it's installed. Install it with ${host.name}'s package manager, then check again.`
            : `Agents can't use apps on ${host.name} until it's installed. Run this on ${host.name}, then check again.`,
      },
      command,
    })),
    Match.orElse((): CardView => ({
      kind: "linux-setup",
      well: {
        title: "The accessibility bus isn't running",
        line: `Agents on ${host.name} read apps through AT-SPI. Turn on assistive technologies in the desktop's settings, or sign out and in again, then check again.`,
      },
      command: null,
    }))
  );

const noDesktop = (host: HostFacts): CardView =>
  Match.value(host.platform).pipe(
    Match.when("windows", () => ({
      kind: "unavailable" as const,
      well: {
        title: `Not available on ${host.name}`,
        line: `The daemon runs before anyone signs in, so it has no desktop to use. Sign in on ${host.name} and this turns on.`,
      },
    })),
    Match.when("macos", () => ({
      kind: "unavailable" as const,
      well: {
        title: `Not available on ${host.name}`,
        line: `No one is signed in to ${host.name}'s desktop, or another user is. Sign in there, then check again.`,
      },
    })),
    Match.orElse(() => ({
      kind: "collapsed" as const,
      line: `No desktop on ${host.name} · agents there use the browser and terminals instead`,
    }))
  );

const readyLine = (host: HostFacts) =>
  Match.value(host.platform).pipe(
    Match.when(
      "macos",
      () => `Agents on ${host.name} can use its apps, asking before each new one.`
    ),
    Match.when(
      "linux",
      () =>
        `Agents use apps on ${host.name}'s desktop. Linux asks for no permissions; the live view shows the last frame.`
    ),
    Match.orElse(
      () => `Agents use apps on ${host.name}'s desktop; the live view shows the last frame.`
    )
  );

/** The host page's card for a status; `opened` is the pane the user last opened from Polaris. */
export const cardView = (host: HostFacts, state: ComputerUseState, opened?: Opened): CardView =>
  Match.value(state).pipe(
    Match.tagsExhaustive({
      NoDesktop: () => noDesktop(host),
      Off: (): CardView => ({
        kind: "off",
        well: {
          title: "Off",
          line: `Turn it on to let agents on ${host.name} see and use its apps, one app at a time, with your approval.`,
        },
      }),
      NeedsSetup: ({ setup }): CardView =>
        Match.value(setup).pipe(
          Match.tag("MacPermissions", (mac): CardView => ({
            kind: "mac-setup",
            well: macWell(host, mac, opened),
            step: allowStep(host, mac),
          })),
          Match.orElse(() => linuxView(host, setup))
        ),
      Ready: (): CardView => ({ kind: "ready", well: { title: "Ready", line: readyLine(host) } }),
    })
  );

/** The switch is on from the moment the user turns it on, whatever setup still needs. */
export const switchOf = (state: ComputerUseState) => ({
  on: Predicate.isTagged(state, "NeedsSetup") || Predicate.isTagged(state, "Ready"),
  disabled: Predicate.isTagged(state, "NoDesktop"),
});

/** "CHECKED 2S AGO": the age of the Daemon's last check, at whole seconds, minutes or hours. */
export const checkedAgo = (checkedAt: string, now: number): string => {
  const seconds = Math.max(0, Math.round((now - Date.parse(checkedAt)) / 1000));

  if (Number.isNaN(seconds)) return "checked";

  if (seconds < 60) return `checked ${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);

  return minutes < 60 ? `checked ${minutes}m ago` : `checked ${Math.floor(minutes / 60)}h ago`;
};

/** The card's footer: how many apps skip the approval. */
export const allowedLine = (count: number): string =>
  count === 0
    ? "No apps always allowed yet"
    : `${count} ${count === 1 ? "app" : "apps"} always allowed · others ask each time`;

/** "Allowed 3 Nov": when the app joined the list, in the user's locale. */
export const allowedOn = (allowedAt: string): string => {
  const date = new Date(allowedAt);

  return Number.isNaN(date.getTime())
    ? "Always allowed"
    : `Allowed ${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
};
