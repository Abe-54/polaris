/**
 * Why a platform's Simulators can't run on this Host now, in words an agent can pass on to the
 * user, from the Host's detected support (`simulator/support.ts`).
 */
import type { SimulatorRequirement, SimulatorSupport } from "@polaris/protocol";
import { Match, Predicate } from "effect";
import type { SupportReport } from "../../simulator/index.ts";
import type { Platform } from "./platforms.ts";

export const NEEDS_XCODE =
  "iOS Simulators need Xcode on this Host: install Xcode, open it once to finish its setup, and select it (`sudo xcode-select -s /Applications/Xcode.app`). Then try again.";

export const NOT_A_MAC = "This Host can't run iOS Simulators: they need a Mac with Xcode.";

export const NOT_ANDROID =
  "This Host can't run Android Emulators: they need a Mac or an x64 Linux Host.";

/** What each missing piece asks of the user, for Android. */
export const ANDROID_NEEDS: Record<Exclude<SimulatorRequirement, "xcode">, string> = {
  "android-sdk":
    "the Android SDK with its emulator, platform-tools and an Android Virtual Device (install Android Studio, or set ANDROID_HOME to the SDK)",
  ffmpeg: "ffmpeg built with libx264 on the PATH (or POLARIS_FFMPEG pointing at it)",
  kvm: "access to /dev/kvm for hardware acceleration (add this user to the kvm group)",
};

const iosBlocker = (report: SupportReport): string | null =>
  Match.value(report.support.ios).pipe(
    Match.tagsExhaustive({
      Ready: () => report.iosBlocked,
      NeedsSetup: () =>
        report.iosBlocked === null ? NEEDS_XCODE : `${report.iosBlocked}. ${NEEDS_XCODE}`,
      Updating: () =>
        `${report.iosBlocked ?? "Xcode is finishing an update"}. Try again in a few minutes.`,
      Unsupported: () => NOT_A_MAC,
    })
  );

const androidNeeds = (missing: ReadonlyArray<SimulatorRequirement>) => {
  const needs = missing.flatMap((item) => (item === "xcode" ? [] : [ANDROID_NEEDS[item]]));

  return `Android Emulators need ${needs.join("; and ")} on this Host. Then try again.`;
};

const androidBlocker = (support: SimulatorSupport): string | null =>
  Match.value(support).pipe(
    Match.tagsExhaustive({
      Ready: () => null,
      NeedsSetup: ({ missing }) => androidNeeds(missing),
      Updating: () => "The Android tools are finishing an update. Try again in a few minutes.",
      Unsupported: () => NOT_ANDROID,
    })
  );

/** Null when `platform`'s Simulators can start. */
export const setupBlocker = (report: SupportReport, platform: Platform): string | null =>
  platform === "ios" ? iosBlocker(report) : androidBlocker(report.support.android);

/** The platforms this Host could ever run: listed, and named in errors. */
export const possiblePlatforms = (report: SupportReport): ReadonlyArray<Platform> =>
  (["ios", "android"] as const).filter(
    (platform) => !Predicate.isTagged(report.support[platform], "Unsupported")
  );
