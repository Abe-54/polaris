/**
 * Why the Simulator tools can't run on this Host now, in words an agent can pass on to the
 * user, from the Host's detected support (`simulator/support.ts`).
 */
import { Match } from "effect";
import type { SupportReport } from "../../simulator/index.ts";

export const NEEDS_XCODE =
  "iOS Simulators need Xcode on this Host: install Xcode, open it once to finish its setup, and select it (`sudo xcode-select -s /Applications/Xcode.app`). Then try again.";

export const NOT_A_MAC = "This Host can't run iOS Simulators: they need a Mac with Xcode.";

/** Null when iOS Simulators can start. */
export const setupBlocker = (report: SupportReport): string | null =>
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
