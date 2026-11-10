/**
 * What this Host can run (ADR 0099): iOS needs a Mac with full Xcode selected and `simctl`
 * answering; Android needs the SDK's emulator and adb, ffmpeg with libx264, and KVM on Linux.
 * Every fact comes through `SupportProbe`, so tests describe a Host instead of needing one.
 */
import {
  type HostSimulatorSupport,
  type SimulatorRequirement,
  SimulatorSupport,
} from "@polaris/protocol";
// Android runs only on macOS and Linux, so its SDK paths are POSIX paths.
import { posix } from "node:path";
import type { PlatformFacts } from "../platform/index.ts";
import { androidPossible, iosPossible } from "./service.ts";

export { androidPossible, iosPossible, simulatorCapable } from "./service.ts";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/** The Host as detection sees it; `run` gives null when the program can't start. */
export interface SupportProbe {
  readonly run: (
    argv: ReadonlyArray<string>,
    timeoutMs: number
  ) => Promise<CommandResult | "timeout" | null>;
  readonly which: (program: string) => string | null;
  readonly isFile: (path: string) => boolean;
  /** Whether this user may open `path` for reading and writing (`/dev/kvm`). */
  readonly canReadWrite: (path: string) => boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}

export interface SupportReport {
  readonly support: HostSimulatorSupport;
  /**
   * Why iOS can't start now although Xcode is installed: it is `Updating`, or `simctl` hung
   * (`NeedsSetup` `xcode`). Boot and attach fail with this as `SimulatorUnavailable`.
   */
  readonly iosBlocked: string | null;
  /** The Android SDK the checks found, so the hub can be given its `platform-tools` (adb). */
  readonly androidSdk: string | null;
}

export const XCODE_SELECT_TIMEOUT_MS = 5_000;

/** `simctl` waits on `xcodebuild -runFirstLaunch` after an Xcode update; that took ~6 min. */
export const SIMCTL_TIMEOUT_MS = 20_000;

export const FFMPEG_TIMEOUT_MS = 5_000;

export const FIRST_LAUNCH_MESSAGE =
  "Xcode is finishing an update; iOS Simulators can start once it's done";

const ready = SimulatorSupport.cases.Ready.make({});

const unsupported = SimulatorSupport.cases.Unsupported.make({});

const needs = (missing: ReadonlyArray<SimulatorRequirement>) =>
  missing.length === 0 ? ready : SimulatorSupport.cases.NeedsSetup.make({ missing });

const answered = (result: CommandResult | "timeout" | null): result is CommandResult =>
  result !== null && result !== "timeout";

const firstLaunchRunning = async (probe: SupportProbe): Promise<boolean> => {
  const ps = await probe.run(["/bin/ps", "-axo", "command"], XCODE_SELECT_TIMEOUT_MS);

  return (
    answered(ps) &&
    ps.stdout
      .split("\n")
      .some((line) => line.includes("xcodebuild") && line.includes("-runFirstLaunch"))
  );
};

const updating = {
  support: SimulatorSupport.cases.Updating.make({ reason: "xcode-first-launch" }),
  iosBlocked: FIRST_LAUNCH_MESSAGE,
};

/** simctl hung for another reason: Xcode is there but broken, and the message says how. */
const hung = {
  support: needs(["xcode"]),
  iosBlocked: `Xcode's simctl didn't answer within ${SIMCTL_TIMEOUT_MS / 1000} s`,
};

const checkIos = async (
  facts: PlatformFacts,
  probe: SupportProbe
): Promise<{ support: SimulatorSupport; iosBlocked: string | null }> => {
  if (!iosPossible(facts)) return { support: unsupported, iosBlocked: null };
  const selected = await probe.run(["/usr/bin/xcode-select", "-p"], XCODE_SELECT_TIMEOUT_MS);

  if (!answered(selected) || selected.exitCode !== 0)
    return { support: needs(["xcode"]), iosBlocked: null };

  // The Command Line Tools have no simctl and no Simulator runtimes.
  if (selected.stdout.includes("CommandLineTools"))
    return { support: needs(["xcode"]), iosBlocked: null };

  if (await firstLaunchRunning(probe)) return updating;

  const simctl = await probe.run(
    ["/usr/bin/xcrun", "simctl", "list", "runtimes", "--json"],
    SIMCTL_TIMEOUT_MS
  );

  if (simctl === "timeout") return (await firstLaunchRunning(probe)) ? updating : hung;

  return answered(simctl) && simctl.exitCode === 0
    ? { support: ready, iosBlocked: null }
    : { support: needs(["xcode"]), iosBlocked: null };
};

/** Where serve-emu looks: the environment first, then the IDE's default for this OS. */
const sdkCandidates = (facts: PlatformFacts, probe: SupportProbe): ReadonlyArray<string> => [
  ...[probe.env.ANDROID_HOME, probe.env.ANDROID_SDK_ROOT].filter(
    (root): root is string => root !== undefined && root !== ""
  ),
  ...(facts.os === "darwin"
    ? [posix.join(probe.home, "Library", "Android", "sdk")]
    : [posix.join(probe.home, "Android", "Sdk"), posix.join(probe.home, "Android", "sdk")]),
];

/** An SDK with both the emulator and adb, which serve-emu runs by name. */
const findSdk = (facts: PlatformFacts, probe: SupportProbe): string | null =>
  sdkCandidates(facts, probe).find(
    (root) =>
      probe.isFile(posix.join(root, "emulator", "emulator")) &&
      probe.isFile(posix.join(root, "platform-tools", "adb"))
  ) ?? null;

/** serve-emu encodes with the user's own ffmpeg, and only through libx264. */
const hasFfmpeg = async (probe: SupportProbe): Promise<boolean> => {
  const configured = probe.env.SERVE_EMU_FFMPEG;
  const ffmpeg = configured !== undefined && configured !== "" ? configured : probe.which("ffmpeg");

  if (ffmpeg === null) return false;
  const encoders = await probe.run([ffmpeg, "-hide_banner", "-encoders"], FFMPEG_TIMEOUT_MS);

  return answered(encoders) && encoders.exitCode === 0 && encoders.stdout.includes("libx264");
};

const checkAndroid = async (
  facts: PlatformFacts,
  probe: SupportProbe
): Promise<{ support: SimulatorSupport; androidSdk: string | null }> => {
  if (!androidPossible(facts)) return { support: unsupported, androidSdk: null };
  const androidSdk = findSdk(facts, probe);
  const missing: Array<SimulatorRequirement> = [];

  if (androidSdk === null) missing.push("android-sdk");

  if (!(await hasFfmpeg(probe))) missing.push("ffmpeg");

  if (facts.os === "linux" && !probe.canReadWrite("/dev/kvm")) missing.push("kvm");

  return { support: needs(missing), androidSdk };
};

export const detectSupport = async (
  facts: PlatformFacts,
  probe: SupportProbe
): Promise<SupportReport> => {
  const [ios, android] = await Promise.all([checkIos(facts, probe), checkAndroid(facts, probe)]);

  return {
    support: { ios: ios.support, android: android.support },
    iosBlocked: ios.iosBlocked,
    androidSdk: android.androidSdk,
  };
};
