/**
 * The Simulator tab's decisions (DESIGN.md, Simulator): whether a Host shows it, which setup
 * state a platform is in, the picker's groups, and the Simulator a session shows.
 */
import type {
  HostSimulatorSupport,
  Simulator,
  SimulatorPlatform,
  SimulatorRequirement,
  SimulatorSupport,
} from "@polaris/protocol";
import { Match, Predicate } from "effect";

/** A platform the Host may run some day: not `Unsupported`. */
const offered = (support: SimulatorSupport) => !Predicate.isTagged(support, "Unsupported");

const isReady = Predicate.isTagged("Ready");

const lacksSdk = (support: SimulatorSupport) =>
  Predicate.isTagged(support, "NeedsSetup") && support.missing.includes("android-sdk");

/**
 * Every Mac shows the tab (iOS is never `Unsupported` there); another Host only once the Android
 * SDK's emulator is found, since the Daemon advertises `simulator` on any glibc x64 Linux.
 */
export const tabVisible = (support: HostSimulatorSupport | null) =>
  support !== null &&
  (offered(support.ios) || (offered(support.android) && !lacksSdk(support.android)));

/** The Host is a Mac: only a Mac can run iOS Simulators. */
export const isMac = (support: HostSimulatorSupport) => offered(support.ios);

export type Setup =
  | { readonly kind: "updating" }
  | { readonly kind: "needs"; readonly requirement: SimulatorRequirement };

/** Android's requirements in the order the user meets them. */
const ORDER: ReadonlyArray<SimulatorRequirement> = ["xcode", "android-sdk", "ffmpeg", "kvm"];

/** What stands between a platform and its Simulators, or null when it's ready or never runs. */
export const setupOf = (support: SimulatorSupport): Setup | null =>
  Match.value(support).pipe(
    Match.tagsExhaustive({
      Ready: () => null,
      Unsupported: () => null,
      Updating: (): Setup => ({ kind: "updating" }),
      NeedsSetup: ({ missing }): Setup | null => {
        const requirement = ORDER.find((r) => missing.includes(r));

        return requirement === undefined ? null : { kind: "needs", requirement };
      },
    })
  );

export const PLATFORMS: ReadonlyArray<SimulatorPlatform> = ["ios", "android"];

export const platformName = (platform: SimulatorPlatform) =>
  platform === "ios" ? "iOS" : "Android";

export interface PickerGroup {
  readonly platform: SimulatorPlatform;
  readonly simulators: ReadonlyArray<Simulator>;
  /** Set up first: the group offers the setup state instead of devices it can't run. */
  readonly setup: Setup | null;
}

/** Booted first, then booting, then by name: the ones you can use now lead. */
const RANK = { Booted: 0, Booting: 1, Shutdown: 2 } as const;

const byUse = (a: Simulator, b: Simulator) =>
  RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name, undefined, { numeric: true });

/** The picker's groups: iOS then Android, each only where the Host offers it. */
export const pickerGroups = (
  support: HostSimulatorSupport,
  simulators: ReadonlyArray<Simulator>
): ReadonlyArray<PickerGroup> =>
  PLATFORMS.flatMap((platform) => {
    const platformSupport = support[platform];

    if (!offered(platformSupport)) return [];

    // Off a Mac, Android without the SDK is the hidden tab's case; never a group.
    if (platform === "android" && lacksSdk(platformSupport) && !isMac(support)) return [];

    const setup = setupOf(platformSupport);

    const own = simulators.filter((s) => s.platform === platform).toSorted(byUse);

    return setup === null && own.length === 0 ? [] : [{ platform, simulators: own, setup }];
  });

/**
 * The Simulator a session shows: the Daemon's choice, else the one the user last picked here,
 * else the first booted one, else the first the picker lists.
 */
export const shownSimulator = (
  simulators: ReadonlyArray<Simulator>,
  showing: string | null,
  remembered: string | null
): Simulator | null => {
  const find = (id: string | null) =>
    id === null ? undefined : simulators.find((s) => s.id === id);

  return find(showing) ?? find(remembered) ?? simulators.toSorted(byUse)[0] ?? null;
};

/** The pane's body before a stream: what the Host lacks, or that it has nothing to show. */
export type Blocker =
  | { readonly kind: "setup"; readonly platform: SimulatorPlatform; readonly setup: Setup }
  | { readonly kind: "empty" };

/**
 * Why there's nothing to stream: a setup state when no platform can run (iOS first), and
 * "No Simulators" when the Host can but has none. Null once there is a Simulator.
 */
export const blockerOf = (
  support: HostSimulatorSupport,
  simulators: ReadonlyArray<Simulator>,
  asked: SimulatorPlatform | null
): Blocker | null => {
  const askedSetup = asked === null ? null : setupOf(support[asked]);

  if (asked !== null && askedSetup !== null)
    return { kind: "setup", platform: asked, setup: askedSetup };

  if (simulators.length > 0) return null;
  const ready = PLATFORMS.some((p) => isReady(support[p]));

  if (ready) return { kind: "empty" };

  for (const group of pickerGroups(support, simulators))
    if (group.setup !== null)
      return { kind: "setup", platform: group.platform, setup: group.setup };

  return { kind: "empty" };
};

/** The fact under "No Simulators on {Host}": which tools are there, and where to add one. */
export const emptyFact = (support: HostSimulatorSupport) => {
  const ios = isReady(support.ios);
  const android = isReady(support.android);

  if (ios && android)
    return "Xcode and the Android SDK are installed, but neither has a device yet. Add one in Xcode or Android Studio.";

  if (ios) return "Xcode is installed but has no Simulator yet. Add one in Xcode.";

  return android
    ? "The Android SDK is installed but has no virtual device yet. Add one in Android Studio."
    : "Set up Xcode or the Android SDK to add one.";
};

/** The picker row's state on the right. */
export const stateLabel = (state: Simulator["state"]) =>
  Match.value(state).pipe(
    Match.when("Booted", () => "Booted"),
    Match.when("Booting", () => "Booting"),
    Match.when("Shutdown", () => "Shut down"),
    Match.exhaustive
  );

/**
 * The picker's caption: Simulators are the Host's, so shutting one down reaches every session.
 * Which other sessions show one isn't known here: each session's feed is its own.
 */
export const sharedFact = (host: string) =>
  `Simulators belong to ${host}, shared by every session there.`;
