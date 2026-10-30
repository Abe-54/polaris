/** Reachable update-row copy from DESIGN.md, Updates (U1–U3). */
import { clientCopy } from "../../../../shared/clientCopy.ts";
import { clientPlatform } from "../../../../shared/platform.ts";
import type { AppUpdateView } from "../../../../shared/appUpdates.ts";

export interface AppUpdateRow {
  readonly title: string;
  readonly caption: string;
  readonly glyph: "working" | "check" | "star" | "folder" | "failed" | "off";
  readonly action: "check" | "restart" | "finder" | null;
  readonly actionLabel: string;
}

export const checkedAt = (at: number | null): string =>
  at === null
    ? "Not checked yet"
    : new Date(at).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

const checkRow = (
  title: string,
  caption: string,
  glyph: AppUpdateRow["glyph"] = "check"
): AppUpdateRow => ({ title, caption, glyph, action: "check", actionLabel: "Check now" });

/** The row's caption never repeats when it checked: the card's footer carries that (SR-12). */
export const appUpdateRow = (view: AppUpdateView): AppUpdateRow => {
  const release = view.availableVersion === null ? "Polaris" : `Polaris ${view.availableVersion}`;

  const copy = platformCopy(view.platform);

  switch (view.phase) {
    case "checking":
      return {
        title: "Checking for updates…",
        caption: "Asking polaris.lux.dev for the latest release",
        glyph: "working",
        action: null,
        actionLabel: "",
      };
    case "downloading":
      return {
        title: `Downloading ${release}`,
        caption: "In the background · nothing to do yet",
        glyph: "working",
        action: null,
        actionLabel: "",
      };
    case "ready":
      return {
        title: `${release} is ready`,
        caption: "Installs when you restart or quit; agent sessions keep working",
        glyph: "star",
        action: "restart",
        actionLabel: "Restart to update",
      };
    case "blocked":
      return {
        title: `${release} can't install here`,
        caption: copy.install,
        glyph: "folder",
        action: "finder",
        actionLabel: copy.reveal,
      };
    case "failed":
      return {
        title: "Couldn't check for updates",
        caption: `polaris.lux.dev didn't answer · ${view.automatic ? "tries again in 6 hours" : "check again when you're ready"}`,
        glyph: "failed",
        action: "check",
        actionLabel: "Try again",
      };
    case "idle":
    case "current":
      if (!view.supported)
        return checkRow(copy.unsupported, "This build doesn't check the update feed", "off");

      if (!view.automatic)
        return checkRow("Automatic checks are off", `You're on ${view.version}`, "off");

      return checkRow(
        view.phase === "current" ? "Polaris is up to date" : "Check for a new release",
        view.lastCheckedAt === null
          ? "Polaris downloads updates in the background"
          : `${view.version} is the latest release`
      );
  }
};

/** The update's platform, as main reports it; the Client's own when it doesn't say. */
const platformCopy = (platform: string = clientPlatform()) => {
  const reveal = clientCopy(platform).showApp;

  return platform === "win32"
    ? {
        install: "Install Polaris with Setup.exe, then check again",
        reveal,
        unsupported: "Updates are available in the installed Windows app",
      }
    : {
        install: "Move Polaris to Applications, then check again",
        reveal,
        unsupported: "Updates are available in the installed Mac app",
      };
};
