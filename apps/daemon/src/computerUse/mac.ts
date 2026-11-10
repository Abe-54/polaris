/**
 * macOS setup: the helper app's two grants, read from agent-desktop's `status` run inside the
 * helper (preflight only, so it never prompts), and the Settings pane the user drags it into.
 */
import { type ComputerUsePermission, ComputerUseSetup } from "@polaris/protocol";
import type { ComputerUsePermissions } from "../service/computerUse/index.ts";

/** Null when both grants are held; a helper that can't answer is missing both. */
export const macSetup = (permissions: ComputerUsePermissions | null): ComputerUseSetup | null => {
  const missing = permissions?.missing ?? ["accessibility", "screen recording"];

  return missing.length === 0
    ? null
    : ComputerUseSetup.cases.MacPermissions.make({
        accessibility: !missing.includes("accessibility"),
        screenRecording: !missing.includes("screen recording"),
      });
};

const PRIVACY = "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension";

/**
 * The pane for a permission. Accessibility is Device Control and Data Access on macOS 27,
 * the one step for both grants, so `null` opens it too.
 */
export const settingsUrl = (permission: ComputerUsePermission | null): string =>
  permission === "screen-recording"
    ? `${PRIVACY}?Privacy_ScreenCapture`
    : `${PRIVACY}?Privacy_Accessibility`;

/** Reveals the helper in Finder, then opens the pane in front of it to drag the helper into. */
export const openSetupCommands = (
  permission: ComputerUsePermission | null,
  helper: string
): ReadonlyArray<ReadonlyArray<string>> => [
  ["open", "-R", helper],
  ["open", settingsUrl(permission)],
];
